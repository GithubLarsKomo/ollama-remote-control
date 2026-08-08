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
import { SqliteTargetContainerBindingRepository } from '../dist/target-binding.js';

function seedTarget(database, id, containerId) {
  const repository = new SqliteOllamaTargetRepository(database);
  repository.saveSelection({
    id,
    hostId: 'host-1',
    displayName: id,
    selectedContainerId: containerId,
    containerNameOverride: null,
    enabled: true,
    createdAt: '2026-08-08T00:00:00.000Z',
    updatedAt: '2026-08-08T00:00:00.000Z',
  });
}

function createDatabase(filename) {
  const database = openDatabase(filename);
  applyMigrations(database);
  database.prepare('INSERT OR IGNORE INTO hosts(id, display_name, hostname, port, username, host_key_fingerprint) VALUES (?, ?, ?, ?, ?, ?)')
    .run('host-1', 'Host', 'ollama.internal', 22, 'orc', `SHA256:${'A'.repeat(43)}`);
  return database;
}

test('target binding compare-and-swap changes only the expected current container and persists across reopen', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orc-target-binding-'));
  const filename = path.join(directory, 'binding.sqlite');
  let database = createDatabase(filename);
  try {
    seedTarget(database, 'target-1', 'container-old');
    const binding = new SqliteTargetContainerBindingRepository(database);
    assert.equal(binding.rebindContainer(
      'target-1', 'container-old', 'container-new', '2026-08-08T01:00:00.000Z',
    ), true);
    const target = new SqliteOllamaTargetRepository(database).findById('target-1');
    assert.equal(target.selectedContainerId, 'container-new');
    assert.equal(target.updatedAt, '2026-08-08T01:00:00.000Z');

    assert.equal(binding.rebindContainer(
      'target-1', 'container-old', 'container-stale-write', '2026-08-08T02:00:00.000Z',
    ), false);
    assert.equal(new SqliteOllamaTargetRepository(database).findById('target-1').selectedContainerId, 'container-new');
  } finally {
    database.close();
  }

  database = openDatabase(filename);
  try {
    const target = new SqliteOllamaTargetRepository(database).findById('target-1');
    assert.equal(target.selectedContainerId, 'container-new');
    assert.equal(target.updatedAt, '2026-08-08T01:00:00.000Z');
  } finally {
    database.close();
  }
});

test('target binding compare-and-swap fails closed on no-op and unique container conflicts', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orc-target-binding-conflict-'));
  const database = createDatabase(path.join(directory, 'binding.sqlite'));
  try {
    seedTarget(database, 'target-1', 'container-one');
    seedTarget(database, 'target-2', 'container-two');
    const binding = new SqliteTargetContainerBindingRepository(database);

    assert.equal(binding.rebindContainer(
      'target-1', 'container-one', 'container-one', '2026-08-08T01:00:00.000Z',
    ), false);
    assert.equal(binding.rebindContainer(
      'target-1', 'container-one', 'container-two', '2026-08-08T01:00:00.000Z',
    ), false);

    const repository = new SqliteOllamaTargetRepository(database);
    assert.equal(repository.findById('target-1').selectedContainerId, 'container-one');
    assert.equal(repository.findById('target-2').selectedContainerId, 'container-two');
  } finally {
    database.close();
  }
});
