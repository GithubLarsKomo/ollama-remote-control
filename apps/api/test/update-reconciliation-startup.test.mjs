import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  applyMigrations,
  openDatabase,
} from '@orc/db';
import { buildServer } from '../dist/server.js';
import { UpdateReconciliationError } from '../dist/update-reconciliation.js';

const NOW = '2026-08-08T14:30:00.000Z';

function databasePath() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orc-startup-recovery-'));
  return path.join(directory, 'app.sqlite');
}

function seedInterruptedUpdate(filename, { forwardStarted = false, unrelated = false } = {}) {
  const database = openDatabase(filename);
  applyMigrations(database);
  database.prepare(`
    INSERT INTO users(id, username, password_hash, role, created_at)
    VALUES ('user-1', 'startup-admin', 'test-hash', 'admin', ?)
  `).run(NOW);
  database.prepare(`
    INSERT INTO hosts(id, display_name, hostname, port, username, host_key_fingerprint, enabled, created_at, updated_at)
    VALUES ('host-1', 'Startup host', '127.0.0.1', 22, 'orc', ?, 1, ?, ?)
  `).run(`SHA256:${'A'.repeat(43)}`, NOW, NOW);
  database.prepare(`
    INSERT INTO ollama_targets(id, host_id, display_name, selected_container_id, enabled, created_at, updated_at)
    VALUES ('target-1', 'host-1', 'Startup target', 'old-container-id', 1, ?, ?)
  `).run(NOW, NOW);
  database.prepare(`
    INSERT INTO jobs(id, target_id, actor_user_id, kind, mutating, state, created_at, started_at)
    VALUES ('update-job', 'target-1', 'user-1', 'container.update', 1, 'running', ?, ?)
  `).run(NOW, NOW);
  database.prepare(`
    INSERT INTO job_events(id, job_id, sequence, event_type, payload_json, created_at)
    VALUES ('update-running', 'update-job', 1, 'state', ?, ?)
  `).run(JSON.stringify({ state: 'running' }), NOW);
  if (forwardStarted) {
    database.prepare(`
      INSERT INTO job_events(id, job_id, sequence, event_type, payload_json, created_at)
      VALUES ('forward-stage', 'update-job', 2, 'stage', ?, ?)
    `).run(JSON.stringify({ stage: 'forward_started', candidateDigest: `sha256:${'2'.repeat(64)}` }), NOW);
  }
  if (unrelated) {
    database.prepare(`
      INSERT INTO jobs(id, target_id, actor_user_id, kind, mutating, state, created_at, started_at)
      VALUES ('read-job', 'target-1', 'user-1', 'diagnostic.read', 0, 'running', ?, ?)
    `).run(NOW, NOW);
    database.prepare(`
      INSERT INTO job_events(id, job_id, sequence, event_type, payload_json, created_at)
      VALUES ('read-running', 'read-job', 1, 'state', ?, ?)
    `).run(JSON.stringify({ state: 'running' }), NOW);
  }
  database.close();
}

function readJobs(filename) {
  const database = openDatabase(filename);
  try {
    return database.prepare(`
      SELECT id, kind, state, error_class, result_json
      FROM jobs ORDER BY id
    `).all();
  } finally {
    database.close();
  }
}

test('Fastify onReady reconciles a pre-forward interrupted update before the server becomes ready', async () => {
  const filename = databasePath();
  seedInterruptedUpdate(filename, { unrelated: true });
  const app = buildServer({ databasePath: filename, environment: {} });
  try {
    await app.ready();
  } finally {
    await app.close();
  }

  const jobs = readJobs(filename);
  const update = jobs.find((job) => job.id === 'update-job');
  const unrelated = jobs.find((job) => job.id === 'read-job');
  assert.equal(update.state, 'failed');
  assert.equal(update.error_class, 'UPDATE_RECOVERY_INTERRUPTED_BEFORE_MUTATION');
  assert.equal(JSON.parse(update.result_json).outcome, 'recovered_interrupted_before_mutation');
  assert.equal(unrelated.state, 'running');
});

test('Fastify readiness fails closed for unresolved post-forward recovery and preserves the mutation lock', async () => {
  const filename = databasePath();
  seedInterruptedUpdate(filename, { forwardStarted: true });
  const app = buildServer({ databasePath: filename, environment: {} });
  try {
    await assert.rejects(
      () => app.ready(),
      (error) => error instanceof UpdateReconciliationError && error.code === 'UPDATE_RECOVERY_AUTHORITY_INVALID',
    );
  } finally {
    await app.close().catch(() => {});
  }

  const [update] = readJobs(filename);
  assert.equal(update.id, 'update-job');
  assert.equal(update.state, 'running');
  assert.equal(update.error_class, null);
});
