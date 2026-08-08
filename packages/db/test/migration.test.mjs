import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  applyMigrations,
  getSchemaVersion,
  openDatabase,
} from '../dist/index.js';

test('migrations are idempotent and preserve host-target ownership', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orc-db-'));
  const databasePath = path.join(directory, 'foundation.sqlite');
  const database = openDatabase(databasePath);

  try {
    assert.equal(applyMigrations(database), 2);
    assert.equal(applyMigrations(database), 2);
    assert.equal(getSchemaVersion(database), 2);

    database
      .prepare('INSERT INTO hosts(id, display_name, hostname, port, username) VALUES (?, ?, ?, ?, ?)')
      .run('host-1', 'Primary host', 'ollama.internal', 22, 'orc-admin');

    database
      .prepare('INSERT INTO ollama_targets(id, host_id, display_name) VALUES (?, ?, ?)')
      .run('target-1', 'host-1', 'Primary Ollama');

    const target = database
      .prepare('SELECT host_id, display_name FROM ollama_targets WHERE id = ?')
      .get('target-1');
    assert.deepEqual(target, {
      host_id: 'host-1',
      display_name: 'Primary Ollama',
    });

    assert.throws(() => {
      database
        .prepare('INSERT INTO ollama_targets(id, host_id, display_name) VALUES (?, ?, ?)')
        .run('target-orphan', 'missing-host', 'Invalid target');
    });

    const tables = database
      .prepare(`
        SELECT COUNT(*) AS count
        FROM sqlite_master
        WHERE type = 'table' AND name IN ('users', 'sessions')
      `)
      .get();
    assert.equal(tables.count, 2);
  } finally {
    database.close();
  }
});
