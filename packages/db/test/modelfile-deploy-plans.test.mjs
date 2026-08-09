import assert from 'node:assert/strict';
import test from 'node:test';
import { applyMigrations, openDatabase } from '../dist/index.js';
import { SqliteModelfileDeployPlanRepository } from '../dist/modelfile-deploy-plans.js';

const SHA = 'a'.repeat(64);
const PAYLOAD_SHA = 'b'.repeat(64);
const TOKEN_SHA = 'c'.repeat(64);

function seed(database) {
  database.prepare(`INSERT INTO users(id, username, password_hash, role, created_at) VALUES (?, ?, ?, 'admin', ?)`)
    .run('user-1', 'admin', 'hash', '2026-08-10T00:00:00.000Z');
  database.prepare(`INSERT INTO hosts(id, display_name, hostname, port, username) VALUES (?, ?, ?, ?, ?)`)
    .run('host-1', 'Primary', 'ollama.internal', 22, 'orc');
  database.prepare(`INSERT INTO ollama_targets(id, host_id, display_name, selected_container_id) VALUES (?, ?, ?, ?)`)
    .run('target-1', 'host-1', 'Ollama', 'container-1');
  database.prepare(`
    INSERT INTO modelfiles(id, display_name, current_revision_id, created_by_user_id, updated_by_user_id, created_at, updated_at)
    VALUES (?, ?, NULL, ?, ?, ?, ?)
  `).run('modelfile-1', 'Deploy source', 'user-1', 'user-1', '2026-08-10T00:00:00.000Z', '2026-08-10T00:00:00.000Z');
  database.prepare(`
    INSERT INTO modelfile_revisions(
      id, modelfile_id, revision_number, parent_revision_id, raw_text, content_sha256,
      source_kind, imported_target_id, imported_model, imported_digest, created_by_user_id, created_at
    ) VALUES (?, ?, 1, NULL, ?, ?, 'manual', NULL, NULL, NULL, ?, ?)
  `).run('revision-1', 'modelfile-1', 'FROM base:latest\n', SHA, 'user-1', '2026-08-10T00:00:00.000Z');
  database.prepare(`UPDATE modelfiles SET current_revision_id = ? WHERE id = ?`).run('revision-1', 'modelfile-1');
}

function plan(overrides = {}) {
  return {
    id: 'plan-1',
    targetId: 'target-1',
    modelfileId: 'modelfile-1',
    revisionId: 'revision-1',
    revisionSha256: SHA,
    actorUserId: 'user-1',
    selectedContainerId: 'container-1',
    outputModel: 'custom:latest',
    baseModel: 'base:latest',
    payloadSha256: PAYLOAD_SHA,
    confirmationTokenHash: TOKEN_SHA,
    createdAt: '2026-08-10T00:00:00.000Z',
    expiresAt: '2026-08-10T00:05:00.000Z',
    consumedAt: null,
    ...overrides,
  };
}

test('deploy plan is persisted without raw payload and consumed exactly once', () => {
  const database = openDatabase(':memory:');
  try {
    applyMigrations(database);
    seed(database);
    const repository = new SqliteModelfileDeployPlanRepository(database);
    assert.equal(repository.create(plan()), true);
    assert.deepEqual(repository.findById('plan-1'), plan());

    const consumed = repository.consumeIfUsable(
      'plan-1', 'user-1', TOKEN_SHA,
      '2026-08-10T00:01:00.000Z', '2026-08-10T00:01:00.000Z',
    );
    assert(consumed);
    assert.equal(consumed.consumedAt, '2026-08-10T00:01:00.000Z');
    assert.equal(repository.consumeIfUsable(
      'plan-1', 'user-1', TOKEN_SHA,
      '2026-08-10T00:01:01.000Z', '2026-08-10T00:01:01.000Z',
    ), null);

    const columns = database.prepare(`PRAGMA table_info(modelfile_deploy_plans)`).all().map((row) => row.name);
    assert.equal(columns.includes('raw_text'), false);
    assert.equal(columns.includes('payload_json'), false);
    assert.equal(columns.includes('confirmation_token'), false);
  } finally {
    database.close();
  }
});

test('wrong actor/token and expired plan cannot be consumed', () => {
  const database = openDatabase(':memory:');
  try {
    applyMigrations(database);
    seed(database);
    const repository = new SqliteModelfileDeployPlanRepository(database);
    assert.equal(repository.create(plan()), true);
    assert.equal(repository.consumeIfUsable('plan-1', 'other-user', TOKEN_SHA, '2026-08-10T00:01:00.000Z', '2026-08-10T00:01:00.000Z'), null);
    assert.equal(repository.consumeIfUsable('plan-1', 'user-1', 'd'.repeat(64), '2026-08-10T00:01:00.000Z', '2026-08-10T00:01:00.000Z'), null);
    assert.equal(repository.consumeIfUsable('plan-1', 'user-1', TOKEN_SHA, '2026-08-10T00:05:00.000Z', '2026-08-10T00:05:00.000Z'), null);
    assert.equal(repository.findById('plan-1').consumedAt, null);
  } finally {
    database.close();
  }
});

test('migration trigger binds plan revision ID, artifact ID and revision hash', () => {
  const database = openDatabase(':memory:');
  try {
    applyMigrations(database);
    seed(database);
    const repository = new SqliteModelfileDeployPlanRepository(database);
    assert.throws(() => repository.create(plan({ revisionSha256: 'e'.repeat(64) })), /deploy plan revision identity is invalid/u);
    assert.equal(repository.findById('plan-1'), null);
  } finally {
    database.close();
  }
});
