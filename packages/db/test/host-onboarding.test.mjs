import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { SecretCipher } from '@orc/security';
import {
  applyMigrations,
  openDatabase,
  SqliteHostOnboardingRepository,
} from '../dist/index.js';

function host(id, hostname = 'ollama.internal') {
  return {
    id,
    displayName: 'Ollama Host',
    hostname,
    port: 22,
    username: 'orc-admin',
    hostKeyFingerprint: `SHA256:${'A'.repeat(43)}`,
    enabled: true,
    createdAt: '2026-08-08T00:00:00.000Z',
    updatedAt: '2026-08-08T00:00:00.000Z',
  };
}

function credential(hostId, credentialId = 'credential-1') {
  const encryptedPrivateKey = new SecretCipher(Buffer.alloc(32, 0x71)).encrypt(
    { credentialId, hostId },
    'private-key-material',
  );
  return {
    id: credentialId,
    hostId,
    encryptedPrivateKey,
    createdAt: '2026-08-08T00:00:00.000Z',
    updatedAt: '2026-08-08T00:00:00.000Z',
  };
}

test('host and SSH credential creation is atomic and duplicate-safe', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orc-host-atomic-'));
  const database = openDatabase(path.join(directory, 'hosts.sqlite'));
  const repository = new SqliteHostOnboardingRepository(database);

  try {
    applyMigrations(database);

    const invalidCredential = credential('host-invalid', 'credential-invalid');
    invalidCredential.encryptedPrivateKey = {
      ...invalidCredential.encryptedPrivateKey,
      algorithm: 'invalid-algorithm',
    };
    assert.throws(() => repository.createHostWithCredential(
      host('host-invalid', 'invalid.internal'),
      invalidCredential,
    ));
    assert.equal(
      database.prepare('SELECT COUNT(*) AS count FROM hosts WHERE id = ?').get('host-invalid').count,
      0,
    );

    assert.equal(repository.createHostWithCredential(
      host('host-1'),
      credential('host-1'),
    ), true);
    assert.equal(repository.findHostById('host-1').hostname, 'ollama.internal');

    assert.equal(repository.createHostWithCredential(
      host('host-2', 'OLLAMA.INTERNAL'),
      credential('host-2', 'credential-2'),
    ), false);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM hosts').get().count, 1);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM ssh_credentials').get().count, 1);
  } finally {
    database.close();
  }
});
