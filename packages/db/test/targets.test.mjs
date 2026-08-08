import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  applyMigrations,
  openDatabase,
  SqliteOllamaTargetRepository,
} from '../dist/index.js';

test('Ollama target selections are unique per host and container', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orc-targets-'));
  const database = openDatabase(path.join(directory, 'targets.sqlite'));
  try {
    applyMigrations(database);
    database.prepare('INSERT INTO hosts(id, display_name, hostname, port, username, host_key_fingerprint) VALUES (?, ?, ?, ?, ?, ?)')
      .run('host-1', 'Host', 'ollama.internal', 22, 'orc', `SHA256:${'A'.repeat(43)}`);
    const repository = new SqliteOllamaTargetRepository(database);
    repository.saveSelection({
      id: 'target-1', hostId: 'host-1', displayName: 'Ollama', selectedContainerId: 'container-1',
      containerNameOverride: null, enabled: true,
      createdAt: '2026-08-08T00:00:00.000Z', updatedAt: '2026-08-08T00:00:00.000Z',
    });
    repository.saveSelection({
      id: 'target-replacement', hostId: 'host-1', displayName: 'Ollama renamed', selectedContainerId: 'container-1',
      containerNameOverride: null, enabled: true,
      createdAt: '2026-08-08T00:01:00.000Z', updatedAt: '2026-08-08T00:01:00.000Z',
    });
    const targets = repository.findByHostId('host-1');
    assert.equal(targets.length, 1);
    assert.equal(targets[0].id, 'target-1');
    assert.equal(targets[0].displayName, 'Ollama renamed');
    assert.equal(targets[0].selectedContainerId, 'container-1');
  } finally {
    database.close();
  }
});
