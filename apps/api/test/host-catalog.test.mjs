import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openDatabase, SqliteHostOnboardingRepository } from '@orc/db';
import { SecretCipher } from '@orc/security';
import { buildServer } from '../dist/server.js';

const MASTER_KEY = Buffer.alloc(32, 0x41);
const PASSWORD = 'host-catalog-admin-password!';
const NOW = '2026-08-08T18:00:00.000Z';

function databasePath() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'orc-host-catalog-')), 'app.sqlite');
}

function cookiesFrom(response) {
  const header = response.headers['set-cookie'];
  const values = Array.isArray(header) ? header : header ? [header] : [];
  return values.map((value) => value.split(';')[0]).join('; ');
}

async function login(app) {
  await app.inject({ method: 'POST', url: '/api/v1/setup/admin', payload: { username: 'admin', password: PASSWORD } });
  const response = await app.inject({ method: 'POST', url: '/api/v1/session', payload: { username: 'admin', password: PASSWORD } });
  assert.equal(response.statusCode, 200);
  return cookiesFrom(response);
}

function seedHost(filename) {
  const database = openDatabase(filename);
  try {
    const hosts = new SqliteHostOnboardingRepository(database);
    const credentialId = 'credential-secret-id';
    const hostId = 'host-resumable-id';
    hosts.createHostWithCredential({
      id: hostId,
      displayName: 'Primary Ollama Host',
      hostname: 'ollama.internal.example',
      port: 2222,
      username: 'ollama-admin',
      hostKeyFingerprint: `SHA256:${'A'.repeat(43)}`,
      enabled: true,
      createdAt: NOW,
      updatedAt: NOW,
    }, {
      id: credentialId,
      hostId,
      encryptedPrivateKey: new SecretCipher(MASTER_KEY).encrypt(
        { credentialId, hostId },
        'PRIVATE-KEY-MATERIAL-MUST-NOT-LEAK',
      ),
      createdAt: NOW,
      updatedAt: NOW,
    });
  } finally {
    database.close();
  }
}

test('GET /api/v1/hosts is authenticated, deterministic and excludes credential material', async () => {
  const filename = databasePath();
  const app = buildServer({
    databasePath: filename,
    environment: { ORC_MASTER_KEY: MASTER_KEY.toString('base64') },
  });
  try {
    const cookie = await login(app);
    seedHost(filename);

    let response = await app.inject({ method: 'GET', url: '/api/v1/hosts' });
    assert.equal(response.statusCode, 401);

    response = await app.inject({ method: 'GET', url: '/api/v1/hosts', headers: { cookie } });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), {
      hosts: [{
        id: 'host-resumable-id',
        displayName: 'Primary Ollama Host',
        hostname: 'ollama.internal.example',
        port: 2222,
        username: 'ollama-admin',
        hostKeyFingerprint: `SHA256:${'A'.repeat(43)}`,
      }],
    });
    for (const secret of ['credential-secret-id', 'PRIVATE-KEY-MATERIAL-MUST-NOT-LEAK', 'ciphertext', 'authTag']) {
      assert.equal(response.body.includes(secret), false, secret);
    }
  } finally {
    await app.close();
  }
});
