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
} from '../dist/index.js';

const NOW = '2026-08-08T08:50:00.000Z';

function seed(database) {
  database.prepare(`INSERT INTO users(id, username, password_hash, role, created_at) VALUES (?, ?, ?, 'admin', ?)`).run('user-1', 'admin', 'hash', NOW);
  database.prepare(`INSERT INTO hosts(id, display_name, hostname, port, username, host_key_fingerprint, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`).run('host-1', 'Host', 'host.internal', 22, 'admin', 'SHA256:test', NOW, NOW);
  database.prepare(`INSERT INTO ollama_targets(id, host_id, display_name, selected_container_id, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)`).run('target-1', 'host-1', 'Ollama', 'container-1', NOW, NOW);
}

function job(id, mutating, state = 'queued') {
  return {
    id,
    targetId: 'target-1',
    actorUserId: 'user-1',
    kind: mutating ? 'container.restart' : 'target.status',
    mutating,
    state,
    createdAt: NOW,
    startedAt: null,
    finishedAt: null,
    resultJson: null,
    errorClass: null,
    exitCode: null,
  };
}

function event(id, jobId, state) {
  return { id, jobId, eventType: 'state', payloadJson: JSON.stringify({ state }), createdAt: NOW };
}

test('database enforces one active mutation per target while allowing read jobs and releases the lock at terminal state', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orc-jobs-lock-'));
  const database = openDatabase(path.join(directory, 'jobs.sqlite'));
  try {
    applyMigrations(database);
    seed(database);
    const jobs = new SqliteJobRepository(database);

    assert.equal(jobs.createWithInitialEvent(job('mutation-1', true), event('event-1', 'mutation-1', 'queued')), true);
    assert.equal(jobs.createWithInitialEvent(job('mutation-2', true), event('event-2', 'mutation-2', 'queued')), false);

    assert.equal(jobs.createWithInitialEvent(job('read-1', false), event('event-3', 'read-1', 'queued')), true);
    assert.equal(jobs.createWithInitialEvent(job('read-2', false), event('event-4', 'read-2', 'queued')), true);

    assert.equal(jobs.transitionWithEvent('mutation-1', 'queued', {
      state: 'cancelled', startedAt: null, finishedAt: NOW, resultJson: null, errorClass: null, exitCode: null,
    }, event('event-5', 'mutation-1', 'cancelled')), true);

    assert.equal(jobs.createWithInitialEvent(job('mutation-2', true), event('event-6', 'mutation-2', 'queued')), true);
    assert.deepEqual(jobs.listEvents('mutation-1').map((item) => item.sequence), [1, 2]);
    assert.equal(jobs.appendEvent({ id: 'event-7', jobId: 'mutation-1', eventType: 'note', payloadJson: '{}', createdAt: NOW }).sequence, 3);
    assert.deepEqual(jobs.listEvents('mutation-1').map((item) => item.sequence), [1, 2, 3]);
  } finally {
    database.close();
  }
});

test('non-terminal jobs and audit rows survive database reopen for later reconciliation', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orc-jobs-reopen-'));
  const databasePath = path.join(directory, 'jobs.sqlite');
  let database = openDatabase(databasePath);
  applyMigrations(database);
  seed(database);
  let jobs = new SqliteJobRepository(database);
  let audit = new SqliteAuditRepository(database);

  assert.equal(jobs.createWithInitialEvent(job('job-running', true), event('event-running', 'job-running', 'queued')), true);
  assert.equal(jobs.transitionWithEvent('job-running', 'queued', {
    state: 'running', startedAt: NOW, finishedAt: null, resultJson: null, errorClass: null, exitCode: null,
  }, event('event-running-2', 'job-running', 'running')), true);
  audit.append({
    id: 'audit-1', timestamp: NOW, actorUserId: 'user-1', hostId: 'host-1', targetId: 'target-1',
    action: 'container.restart.requested', parametersRedactedJson: '{"confirmed":true}', result: 'queued',
    exitCode: null, errorClass: null, jobId: 'job-running',
  });
  database.close();

  database = openDatabase(databasePath);
  try {
    applyMigrations(database);
    jobs = new SqliteJobRepository(database);
    audit = new SqliteAuditRepository(database);
    const recoverable = jobs.findNonTerminal();
    assert.equal(recoverable.length, 1);
    assert.equal(recoverable[0].id, 'job-running');
    assert.equal(recoverable[0].state, 'running');
    assert.deepEqual(jobs.listEvents('job-running').map((item) => item.sequence), [1, 2]);
    const rows = audit.listByTarget('target-1');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].jobId, 'job-running');
  } finally {
    database.close();
  }
});
