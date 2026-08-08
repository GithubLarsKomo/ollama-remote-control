import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  openDatabase,
  SqliteSshCredentialRepository,
} from '@orc/db';
import { SecretCipher } from '@orc/security';
import { buildServer } from '../dist/server.js';

const SSH_HOST = process.env.SSH_HOST;
const SSH_PORT = Number(process.env.SSH_PORT ?? '2222');
const SSH_USER = process.env.SSH_USER;
const SSH_PRIVATE_KEY_PATH = process.env.SSH_PRIVATE_KEY_PATH;
const HAS_SSH_FIXTURE = Boolean(SSH_HOST && SSH_USER && SSH_PRIVATE_KEY_PATH);
const MASTER_KEY = Buffer.alloc(32, 0x6c);
const ADMIN_PASSWORD = 'host-onboarding-admin-password!';

function cookieValues(response) {
  const header = response.headers['set-cookie'];
  const values = Array.isArray(header) ? header : header ? [header] : [];
  const result = {};
  for (const value of values) {
    const [pair] = value.split(';');
    const separator = pair.indexOf('=');
    result[pair.slice(0, separator)] = decodeURIComponent(pair.slice(separator + 1));
  }
  return result;
}

function authHeaders(cookies) {
  return {
    cookie: Object.entries(cookies)
      .map(([name, value]) => `${name}=${encodeURIComponent(value)}`)
      .join('; '),
    'x-csrf-token': cookies.orc_csrf,
  };
}

function wrongFingerprint(fingerprint) {
  const final = fingerprint.at(-1);
  return `${fingerprint.slice(0, -1)}${final === 'A' ? 'B' : 'A'}`;
}

test('TOFU host onboarding verifies pin and key before atomic encrypted persistence', {
  skip: !HAS_SSH_FIXTURE,
}, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orc-host-onboarding-'));
  const databasePath = path.join(directory, 'app.sqlite');
  const app = buildServer({
    databasePath,
    environment: { ORC_MASTER_KEY: MASTER_KEY.toString('base64') },
  });
  const privateKey = fs.readFileSync(SSH_PRIVATE_KEY_PATH, 'utf8');

  try {
    await app.inject({
      method: 'POST',
      url: '/api/v1/setup/admin',
      payload: { username: 'admin', password: ADMIN_PASSWORD },
    });
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/session',
      payload: { username: 'admin', password: ADMIN_PASSWORD },
    });
    const cookies = cookieValues(login);

    const unauthenticatedProbe = await app.inject({
      method: 'POST',
      url: '/api/v1/hosts/probe',
      payload: { hostname: SSH_HOST, port: SSH_PORT },
    });
    assert.equal(unauthenticatedProbe.statusCode, 401);

    const missingCsrfProbe = await app.inject({
      method: 'POST',
      url: '/api/v1/hosts/probe',
      headers: {
        cookie: `orc_session=${encodeURIComponent(cookies.orc_session)}`,
      },
      payload: { hostname: SSH_HOST, port: SSH_PORT },
    });
    assert.equal(missingCsrfProbe.statusCode, 403);

    const probe = await app.inject({
      method: 'POST',
      url: '/api/v1/hosts/probe',
      headers: authHeaders(cookies),
      payload: { hostname: SSH_HOST, port: SSH_PORT },
    });
    assert.equal(probe.statusCode, 200);
    const observed = probe.json();
    assert.match(observed.fingerprint, /^SHA256:[A-Za-z0-9+/]{43}$/u);
    assert.match(observed.algorithm, /^ssh-|^ecdsa-/u);

    const basePayload = {
      displayName: 'CI Ollama Host',
      hostname: SSH_HOST,
      port: SSH_PORT,
      username: SSH_USER,
      privateKey,
    };

    const mismatch = await app.inject({
      method: 'POST',
      url: '/api/v1/hosts',
      headers: authHeaders(cookies),
      payload: {
        ...basePayload,
        confirmedFingerprint: wrongFingerprint(observed.fingerprint),
      },
    });
    assert.equal(mismatch.statusCode, 409);
    assert.equal(mismatch.json().error.code, 'SSH_HOST_KEY_MISMATCH');

    const { privateKey: wrongKeyObject } = generateKeyPairSync('ed25519');
    const wrongPrivateKey = wrongKeyObject.export({
      format: 'pem',
      type: 'pkcs8',
    }).toString();
    const badAuth = await app.inject({
      method: 'POST',
      url: '/api/v1/hosts',
      headers: authHeaders(cookies),
      payload: {
        ...basePayload,
        privateKey: wrongPrivateKey,
        confirmedFingerprint: observed.fingerprint,
      },
    });
    assert.equal(badAuth.statusCode, 422);
    assert.equal(badAuth.json().error.code, 'AUTH_FAILED');

    const beforeSuccess = openDatabase(databasePath);
    try {
      assert.equal(beforeSuccess.prepare('SELECT COUNT(*) AS count FROM hosts').get().count, 0);
      assert.equal(beforeSuccess.prepare('SELECT COUNT(*) AS count FROM ssh_credentials').get().count, 0);
    } finally {
      beforeSuccess.close();
    }

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/hosts',
      headers: authHeaders(cookies),
      payload: {
        ...basePayload,
        confirmedFingerprint: observed.fingerprint,
      },
    });
    assert.equal(created.statusCode, 201);
    const host = created.json().host;
    assert.equal(host.hostKeyFingerprint, observed.fingerprint);
    assert.equal(host.hostname, SSH_HOST);
    assert.equal(host.username, SSH_USER);
    assert.equal(Object.hasOwn(host, 'privateKey'), false);

    const inspection = openDatabase(databasePath);
    try {
      assert.equal(inspection.prepare('SELECT COUNT(*) AS count FROM hosts').get().count, 1);
      assert.equal(inspection.prepare('SELECT COUNT(*) AS count FROM ssh_credentials').get().count, 1);
      const stored = new SqliteSshCredentialRepository(inspection).findByHostId(host.id);
      assert(stored);
      assert.equal(
        new SecretCipher(MASTER_KEY).decrypt(
          { credentialId: stored.id, hostId: host.id },
          stored.encryptedPrivateKey,
        ),
        privateKey,
      );
    } finally {
      inspection.close();
    }

    const duplicate = await app.inject({
      method: 'POST',
      url: '/api/v1/hosts',
      headers: authHeaders(cookies),
      payload: {
        ...basePayload,
        displayName: 'Duplicate',
        confirmedFingerprint: observed.fingerprint,
      },
    });
    assert.equal(duplicate.statusCode, 409);
    assert.equal(duplicate.json().error.code, 'HOST_ALREADY_EXISTS');
  } finally {
    await app.close();
  }
});
