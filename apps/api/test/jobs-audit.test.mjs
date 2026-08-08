import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  applyMigrations,
  openDatabase,
  SqliteAuditRepository,
  SqliteJobRepository,
} from '@orc/db';
import { AuditService } from '../dist/audit.js';
import { JobService } from '../dist/jobs.js';

const times = [
  '2026-08-08T09:00:00.000Z',
  '2026-08-08T09:00:01.000Z',
  '2026-08-08T09:00:02.000Z',
  '2026-08-08T09:00:03.000Z',
  '2026-08-08T09:00:04.000Z',
  '2026-08-08T09:00:05.000Z',
  '2026-08-08T09:00:06.000Z',
  '2026-08-08T09:00:07.000Z',
  '2026-08-08T09:00:08.000Z',
];

function setup(prefix) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const database = openDatabase(path.join(directory, 'jobs.sqlite'));
  applyMigrations(database);
  database.prepare(`INSERT INTO users(id, username, password_hash, role, created_at) VALUES (?, ?, ?, 'admin', ?)`).run('user-1', 'admin', 'hash', times[0]);
  database.prepare(`INSERT INTO hosts(id, display_name, hostname, port, username, host_key_fingerprint, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`).run('host-1', 'Host', 'host.internal', 22, 'admin', 'SHA256:test', times[0], times[0]);
  database.prepare(`INSERT INTO ollama_targets(id, host_id, display_name, selected_container_id, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)`).run('target-1', 'host-1', 'Ollama', 'container-1', times[0], times[0]);
  let index = 0;
  const now = () => new Date(times[Math.min(index++, times.length - 1)]);
  return { database, jobs: new JobService(new SqliteJobRepository(database), now), audit: new AuditService(new SqliteAuditRepository(database), now) };
}

test('job service enforces target mutation conflicts and valid state transitions', () => {
  const { database, jobs } = setup('orc-job-service-');
  try {
    const mutation = jobs.create({ targetId: 'target-1', actorUserId: 'user-1', kind: 'container.restart', mutating: true });
    assert.equal(mutation.state, 'queued');
    assert.throws(
      () => jobs.create({ targetId: 'target-1', actorUserId: 'user-1', kind: 'container.stop', mutating: true }),
      (error) => error?.code === 'JOB_CONFLICT' && error?.statusCode === 409,
    );

    const read1 = jobs.create({ targetId: 'target-1', actorUserId: 'user-1', kind: 'target.status', mutating: false });
    const read2 = jobs.create({ targetId: 'target-1', actorUserId: 'user-1', kind: 'target.logs', mutating: false });
    assert.equal(read1.mutating, false);
    assert.equal(read2.mutating, false);

    const running = jobs.transition(mutation.id, 'running');
    assert.equal(running.state, 'running');
    assert.notEqual(running.startedAt, null);
    assert.throws(
      () => jobs.transition(mutation.id, 'cancelled'),
      (error) => error?.code === 'JOB_STATE_CONFLICT',
    );
    assert.equal(jobs.transition(mutation.id, 'cancelling').state, 'cancelling');
    const cancelled = jobs.transition(mutation.id, 'cancelled', { result: { verified: true }, exitCode: 143 });
    assert.equal(cancelled.state, 'cancelled');
    assert.notEqual(cancelled.finishedAt, null);
    assert.deepEqual(JSON.parse(cancelled.resultJson), { verified: true });
    assert.throws(
      () => jobs.transition(mutation.id, 'running'),
      (error) => error?.code === 'JOB_STATE_CONFLICT',
    );

    const events = jobs.events(mutation.id);
    assert.deepEqual(events.map((event) => event.sequence), [1, 2, 3, 4]);
    assert.deepEqual(events.map((event) => JSON.parse(event.payloadJson).state), ['queued', 'running', 'cancelling', 'cancelled']);

    const nextMutation = jobs.create({ targetId: 'target-1', actorUserId: 'user-1', kind: 'container.start', mutating: true });
    assert.equal(nextMutation.state, 'queued');
    assert(jobs.jobsNeedingReconciliation().some((job) => job.id === nextMutation.id));
  } finally {
    database.close();
  }
});

test('audit service recursively redacts credentials before persistence', () => {
  const { database, audit } = setup('orc-audit-service-');
  try {
    const event = audit.record({
      actorUserId: 'user-1',
      hostId: 'host-1',
      targetId: 'target-1',
      action: 'container.restart.requested',
      parameters: {
        confirmed: true,
        privateKey: 'PRIVATE-KEY-PLAINTEXT',
        nested: {
          masterKey: 'MASTER-KEY-PLAINTEXT',
          sessionToken: 'SESSION-TOKEN-PLAINTEXT',
          safe: 'ollama-container-id',
        },
        list: [{ credential: 'CREDENTIAL-PLAINTEXT', safe: 42 }],
      },
      result: 'queued',
    });
    const serialized = event.parametersRedactedJson;
    for (const secret of ['PRIVATE-KEY-PLAINTEXT', 'MASTER-KEY-PLAINTEXT', 'SESSION-TOKEN-PLAINTEXT', 'CREDENTIAL-PLAINTEXT']) {
      assert.equal(serialized.includes(secret), false);
    }
    const redacted = JSON.parse(serialized);
    assert.equal(redacted.privateKey, '[REDACTED]');
    assert.equal(redacted.nested.masterKey, '[REDACTED]');
    assert.equal(redacted.nested.sessionToken, '[REDACTED]');
    assert.equal(redacted.nested.safe, 'ollama-container-id');
    assert.equal(redacted.list[0].credential, '[REDACTED]');
    assert.equal(redacted.list[0].safe, 42);

    const stored = audit.forTarget('target-1');
    assert.equal(stored.length, 1);
    assert.equal(stored[0].id, event.id);
    assert.equal(stored[0].parametersRedactedJson, serialized);
  } finally {
    database.close();
  }
});
