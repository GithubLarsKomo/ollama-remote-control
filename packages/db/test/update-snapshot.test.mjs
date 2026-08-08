import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  applyMigrations,
  openDatabase,
  SqliteUpdateSnapshotRepository,
} from '../dist/index.js';

const NOW = '2026-08-08T09:20:00.000Z';

function seed(database) {
  database.prepare(`INSERT INTO users(id, username, password_hash, role, created_at) VALUES (?, ?, ?, 'admin', ?)`).run('user-1', 'admin', 'hash', NOW);
  database.prepare(`INSERT INTO hosts(id, display_name, hostname, port, username, host_key_fingerprint, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`).run('host-1', 'Host', 'host.internal', 22, 'admin', 'SHA256:test', NOW, NOW);
  database.prepare(`INSERT INTO ollama_targets(id, host_id, display_name, selected_container_id, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)`).run('target-1', 'host-1', 'Ollama', 'container-1', NOW, NOW);
}

test('update snapshots persist ciphertext and public metadata and are update-immutable', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orc-update-snapshot-'));
  const database = openDatabase(path.join(directory, 'snapshots.sqlite'));
  try {
    applyMigrations(database);
    seed(database);
    const repository = new SqliteUpdateSnapshotRepository(database);
    repository.save({
      id: 'snapshot-1',
      targetId: 'target-1',
      actorUserId: 'user-1',
      createdAt: NOW,
      publicMetadataJson: '{"imageReference":"ollama/ollama:latest"}',
      encryptedPayload: {
        algorithm: 'aes-256-gcm',
        keyVersion: 1,
        nonce: 'nonce-base64',
        ciphertext: 'ciphertext-base64',
        authTag: 'tag-base64',
      },
    });

    const stored = repository.findById('snapshot-1');
    assert.equal(stored?.targetId, 'target-1');
    assert.equal(stored?.encryptedPayload.ciphertext, 'ciphertext-base64');
    assert.equal(repository.listByTarget('target-1').length, 1);
    assert.throws(() => database.prepare(`UPDATE update_snapshots SET public_metadata_json = '{}' WHERE id = ?`).run('snapshot-1'));
  } finally {
    database.close();
  }
});
