import assert from 'node:assert/strict';
import test from 'node:test';
import { applyMigrations, openDatabase } from '../dist/index.js';
import { SqliteUpdateHistoryRepository } from '../dist/update-history.js';

function insertJob(database, { id, kind = 'container.update', state, finishedAt }) {
  database.prepare(`
    INSERT INTO jobs(
      id, target_id, actor_user_id, kind, mutating, state, created_at,
      started_at, finished_at, result_json, error_class, exit_code
    ) VALUES (?, 'target-1', 'user-1', ?, 1, ?, ?, ?, ?, '{}', NULL, NULL)
  `).run(id, kind, state, finishedAt ?? '2026-08-10T09:00:00.000Z', finishedAt ?? null, finishedAt ?? null);
}

test('update history selects only the latest succeeded container update for a target', () => {
  const database = openDatabase(':memory:');
  try {
    applyMigrations(database);
    database.prepare(`INSERT INTO users(id, username, password_hash, role, created_at) VALUES ('user-1', 'admin', 'hash', 'admin', '2026-08-10T08:00:00.000Z')`).run();
    database.prepare(`INSERT INTO hosts(id, display_name, hostname, port, username, host_key_fingerprint, enabled, created_at, updated_at) VALUES ('host-1', 'Host', 'host', 22, 'orc', 'SHA256:test', 1, '2026-08-10T08:00:00.000Z', '2026-08-10T08:00:00.000Z')`).run();
    database.prepare(`INSERT INTO ollama_targets(id, host_id, display_name, selected_container_id, enabled, created_at, updated_at) VALUES ('target-1', 'host-1', 'Target', 'container-1', 1, '2026-08-10T08:00:00.000Z', '2026-08-10T08:00:00.000Z')`).run();

    insertJob(database, { id: 'old-success', state: 'succeeded', finishedAt: '2026-08-10T09:00:00.000Z' });
    insertJob(database, { id: 'newer-failed', state: 'failed', finishedAt: '2026-08-10T11:00:00.000Z' });
    insertJob(database, { id: 'other-kind', kind: 'container.rollback', state: 'succeeded', finishedAt: '2026-08-10T12:00:00.000Z' });
    insertJob(database, { id: 'new-success', state: 'succeeded', finishedAt: '2026-08-10T10:00:00.000Z' });

    const latest = new SqliteUpdateHistoryRepository(database).latestSuccessfulUpdate('target-1');
    assert.equal(latest?.id, 'new-success');
    assert.equal(latest?.kind, 'container.update');
    assert.equal(latest?.state, 'succeeded');
    assert.equal(new SqliteUpdateHistoryRepository(database).latestSuccessfulUpdate('missing-target'), null);
  } finally {
    database.close();
  }
});
