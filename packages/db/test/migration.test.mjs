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
    assert.equal(applyMigrations(database), 9);
    assert.equal(applyMigrations(database), 9);
    assert.equal(getSchemaVersion(database), 9);

    database
      .prepare('INSERT INTO hosts(id, display_name, hostname, port, username) VALUES (?, ?, ?, ?, ?)')
      .run('host-1', 'Primary host', 'ollama.internal', 22, 'orc-admin');

    assert.throws(() => {
      database
        .prepare('INSERT INTO hosts(id, display_name, hostname, port, username) VALUES (?, ?, ?, ?, ?)')
        .run('host-duplicate', 'Duplicate', 'OLLAMA.INTERNAL', 22, 'ORC-ADMIN');
    });

    database
      .prepare('INSERT INTO ollama_targets(id, host_id, display_name, selected_container_id) VALUES (?, ?, ?, ?)')
      .run('target-1', 'host-1', 'Primary Ollama', 'container-1');

    const target = database
      .prepare('SELECT host_id, display_name, selected_container_id FROM ollama_targets WHERE id = ?')
      .get('target-1');
    assert.deepEqual(target, {
      host_id: 'host-1',
      display_name: 'Primary Ollama',
      selected_container_id: 'container-1',
    });

    assert.throws(() => {
      database
        .prepare('INSERT INTO ollama_targets(id, host_id, display_name, selected_container_id) VALUES (?, ?, ?, ?)')
        .run('target-duplicate', 'host-1', 'Duplicate binding', 'container-1');
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
        WHERE type = 'table' AND name IN (
          'users', 'sessions', 'ssh_credentials', 'jobs', 'job_events', 'audit_events', 'update_snapshots',
          'modelfiles', 'modelfile_revisions', 'modelfile_deploy_plans'
        )
      `)
      .get();
    assert.equal(tables.count, 10);

    assert.throws(() => {
      database
        .prepare(`
          INSERT INTO ssh_credentials(
            id, host_id, algorithm, key_version, nonce, ciphertext, auth_tag,
            created_at, updated_at
          ) VALUES (?, ?, 'aes-256-gcm', 1, ?, ?, ?, ?, ?)
        `)
        .run(
          'credential-orphan',
          'missing-host',
          'nonce',
          'ciphertext',
          'tag',
          '2026-08-08T00:00:00.000Z',
          '2026-08-08T00:00:00.000Z',
        );
    });
  } finally {
    database.close();
  }
});
