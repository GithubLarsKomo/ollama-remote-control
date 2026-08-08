import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { SecretCipher } from '@orc/security';
import {
  applyMigrations,
  openDatabase,
  SqliteSshCredentialRepository,
} from '../dist/index.js';

const PRIVATE_KEY = '-----BEGIN OPENSSH PRIVATE KEY-----\nprivate-key-must-not-appear-in-db\n-----END OPENSSH PRIVATE KEY-----';
const CONTEXT = { credentialId: 'credential-1', hostId: 'host-1' };

test('SQLite stores only authenticated ciphertext for SSH private keys', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orc-ssh-credential-'));
  const databasePath = path.join(directory, 'credentials.sqlite');
  const database = openDatabase(databasePath);
  const cipher = new SecretCipher(Buffer.alloc(32, 0x4d));

  try {
    applyMigrations(database);
    database
      .prepare('INSERT INTO hosts(id, display_name, hostname, port, username) VALUES (?, ?, ?, ?, ?)')
      .run('host-1', 'Primary host', 'ollama.internal', 22, 'orc-admin');

    const encryptedPrivateKey = cipher.encrypt(CONTEXT, PRIVATE_KEY);
    const repository = new SqliteSshCredentialRepository(database);
    repository.save({
      id: CONTEXT.credentialId,
      hostId: CONTEXT.hostId,
      encryptedPrivateKey,
      createdAt: '2026-08-08T00:00:00.000Z',
      updatedAt: '2026-08-08T00:00:00.000Z',
    });

    const raw = database
      .prepare('SELECT algorithm, nonce, ciphertext, auth_tag FROM ssh_credentials WHERE host_id = ?')
      .get(CONTEXT.hostId);
    assert.equal(raw.algorithm, 'aes-256-gcm');
    assert.equal(JSON.stringify(raw).includes(PRIVATE_KEY), false);
    assert.equal(fs.readFileSync(databasePath).includes(Buffer.from(PRIVATE_KEY, 'utf8')), false);

    const stored = repository.findByHostId(CONTEXT.hostId);
    assert(stored);
    assert.equal(
      cipher.decrypt(
        { credentialId: stored.id, hostId: stored.hostId },
        stored.encryptedPrivateKey,
      ),
      PRIVATE_KEY,
    );
  } finally {
    database.close();
  }
});
