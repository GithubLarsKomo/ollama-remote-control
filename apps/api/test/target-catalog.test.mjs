import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  openDatabase,
  SqliteHostOnboardingRepository,
  SqliteOllamaTargetRepository,
} from '@orc/db';
import { SecretCipher } from '@orc/security';
import { buildServer } from '../dist/server.js';

const MASTER_KEY = Buffer.alloc(32, 0x31);
const PASSWORD = 'catalog-admin-password!';
const NOW = '2026-08-08T15:30:00.000Z';

function databasePath() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'orc-target-catalog-')), 'app.sqlite');
}

function cookiesFrom(response) {
  const header = response.headers['set-cookie'];
  const values = Array.isArray(header) ? header : header ? [header] : [];
  return values.map((value) => value.split(';')[0]).join('; ');
}

async function bootstrap(app) {
  const setup = await app.inject({
    method: 'POST', url: '/api/v1/setup/admin', payload: { username: 'admin', password: PASSWORD },
  });
  assert.equal(setup.statusCode, 201);
  const login = await app.inject({
    method: 'POST', url: '/api/v1/session', payload: { username: 'admin', password: PASSWORD },
  });
  assert.equal(login.statusCode, 200);
  return cookiesFrom(login);
}

function seedTargets(filename) {
  const database = openDatabase(filename);
  try {
    const hosts = new SqliteHostOnboardingRepository(database);
    const targets = new SqliteOllamaTargetRepository(database);
    hosts.createHostWithCredential(
      {
        id: 'host-secret-id',
        displayName: 'Internal Host',
        hostname: 'secret.internal.example',
        port: 2222,
        username: 'secret-ssh-user',
        hostKeyFingerprint: 'SHA256:SECRET-FINGERPRINT',
        enabled: true,
        createdAt: NOW,
        updatedAt: NOW,
      },
      {
        id: 'credential-secret-id',
        hostId: 'host-secret-id',
        encryptedPrivateKey: new SecretCipher(MASTER_KEY).encrypt(
          { credentialId: 'credential-secret-id', hostId: 'host-secret-id' },
          'TARGET-CATALOG-PRIVATE-KEY-SECRET',
        ),
        createdAt: NOW,
        updatedAt: NOW,
      },
    );
    targets.saveSelection({
      id: 'target-b', hostId: 'host-secret-id', displayName: 'Zulu', selectedContainerId: 'container-b',
      containerNameOverride: null, enabled: true, createdAt: NOW, updatedAt: NOW,
    });
    targets.saveSelection({
      id: 'target-a', hostId: 'host-secret-id', displayName: 'Alpha', selectedContainerId: 'container-a',
      containerNameOverride: null, enabled: true, createdAt: NOW, updatedAt: NOW,
    });
    targets.saveSelection({
      id: 'target-disabled', hostId: 'host-secret-id', displayName: 'Disabled', selectedContainerId: 'container-disabled',
      containerNameOverride: null, enabled: false, createdAt: NOW, updatedAt: NOW,
    });
  } finally {
    database.close();
  }
}

test('GET /api/v1/targets requires authentication and returns only enabled safe catalog fields', async () => {
  const filename = databasePath();
  const app = buildServer({
    databasePath: filename,
    environment: { ORC_MASTER_KEY: MASTER_KEY.toString('base64') },
  });
  try {
    const cookie = await bootstrap(app);
    seedTargets(filename);

    let response = await app.inject({ method: 'GET', url: '/api/v1/targets' });
    assert.equal(response.statusCode, 401);

    response = await app.inject({ method: 'GET', url: '/api/v1/targets', headers: { cookie } });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), {
      targets: [
        { id: 'target-a', hostId: 'host-secret-id', displayName: 'Alpha', selectedContainerId: 'container-a' },
        { id: 'target-b', hostId: 'host-secret-id', displayName: 'Zulu', selectedContainerId: 'container-b' },
      ],
    });
    for (const secret of [
      'secret.internal.example',
      'secret-ssh-user',
      'SECRET-FINGERPRINT',
      'credential-secret-id',
      'TARGET-CATALOG-PRIVATE-KEY-SECRET',
    ]) assert.equal(response.body.includes(secret), false);
  } finally {
    await app.close();
  }
});
