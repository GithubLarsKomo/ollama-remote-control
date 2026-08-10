import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyMigrations,
  openDatabase,
} from '../dist/index.js';
import { SqliteAuditQueryRepository } from '../dist/audit-query.js';

function insertAudit(database, event) {
  database.prepare(`
    INSERT INTO audit_events(
      id, timestamp, actor_user_id, host_id, target_id, action,
      parameters_redacted_json, result, exit_code, error_class, job_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    event.id,
    event.timestamp,
    event.actorUserId,
    event.hostId ?? null,
    event.targetId ?? null,
    event.action,
    event.parametersRedactedJson ?? '{}',
    event.result,
    event.exitCode ?? null,
    event.errorClass ?? null,
    event.jobId ?? null,
  );
}

test('audit query is parameterized, filtered and deterministically newest-first', () => {
  const database = openDatabase(':memory:');
  try {
    applyMigrations(database);
    insertAudit(database, {
      id: 'a', timestamp: '2026-08-10T08:00:00.000Z', actorUserId: 'user-1', hostId: 'host-1', targetId: 'target-1',
      action: 'container.restart.requested', result: 'queued',
    });
    insertAudit(database, {
      id: 'b', timestamp: '2026-08-10T09:00:00.000Z', actorUserId: 'user-2', hostId: 'host-2', targetId: 'target-2',
      action: 'model.pull.completed', result: 'succeeded',
    });
    insertAudit(database, {
      id: 'c', timestamp: '2026-08-10T09:00:00.000Z', actorUserId: 'user-1', hostId: 'host-1', targetId: 'target-1',
      action: 'container.restart.completed', result: 'succeeded',
    });
    insertAudit(database, {
      id: 'd', timestamp: '2026-08-10T10:00:00.000Z', actorUserId: 'user-1', hostId: 'host-1', targetId: 'target-1',
      action: 'container.restart.completed', result: 'failed', errorClass: 'REMOTE_FAILED',
    });

    const audit = new SqliteAuditQueryRepository(database);
    assert.deepEqual(audit.query({ limit: 10, offset: 0 }).map((row) => row.id), ['d', 'c', 'b', 'a']);
    assert.deepEqual(audit.query({ targetId: 'target-1', actorUserId: 'user-1', result: 'succeeded', limit: 10, offset: 0 }).map((row) => row.id), ['c']);
    assert.deepEqual(audit.query({ fromTimestamp: '2026-08-10T09:00:00.000Z', toTimestamp: '2026-08-10T10:00:00.000Z', limit: 2, offset: 1 }).map((row) => row.id), ['c', 'b']);
    assert.deepEqual(audit.query({ action: "x' OR 1=1 --", limit: 10, offset: 0 }), []);
  } finally {
    database.close();
  }
});

test('audit retention deletes only rows strictly older than the cutoff and is bounded', () => {
  const database = openDatabase(':memory:');
  try {
    applyMigrations(database);
    for (const [id, timestamp] of [
      ['old-1', '2026-05-10T00:00:00.000Z'],
      ['old-2', '2026-05-11T00:00:00.000Z'],
      ['cutoff', '2026-05-12T00:00:00.000Z'],
      ['new', '2026-05-13T00:00:00.000Z'],
    ]) {
      insertAudit(database, { id, timestamp, actorUserId: 'user-1', action: 'test', result: 'ok' });
    }

    const audit = new SqliteAuditQueryRepository(database);
    assert.equal(audit.purgeOlderThan('2026-05-12T00:00:00.000Z', 1), 1);
    assert.deepEqual(audit.query({ limit: 10, offset: 0 }).map((row) => row.id), ['new', 'cutoff', 'old-2']);
    assert.equal(audit.purgeOlderThan('2026-05-12T00:00:00.000Z', 10), 1);
    assert.deepEqual(audit.query({ limit: 10, offset: 0 }).map((row) => row.id), ['new', 'cutoff']);
  } finally {
    database.close();
  }
});
