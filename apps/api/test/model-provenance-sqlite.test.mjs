import assert from 'node:assert/strict';
import test from 'node:test';
import { applyMigrations, openDatabase } from '@orc/db';
import {
  buildModelProvenanceGraph,
  SqliteModelProvenanceEvidenceStore,
} from '../dist/model-provenance-graph.js';

const NOW = '2026-08-10T02:00:00.000Z';
const DIGEST = 'd'.repeat(64);
const IMPORT_SHA = 'b'.repeat(64);
const CREATE_SHA = 'a'.repeat(64);

function seed(database) {
  database.prepare(`INSERT INTO users(id, username, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)`)
    .run('user-1', 'admin', 'unused-hash', 'admin', NOW);
  database.prepare(`
    INSERT INTO hosts(id, display_name, hostname, port, username, host_key_fingerprint, enabled, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
  `).run('host-1', 'Host', '127.0.0.1', 22, 'tester', 'SHA256:test', NOW, NOW);
  database.prepare(`
    INSERT INTO ollama_targets(id, host_id, display_name, container_name_override, selected_container_id, enabled, created_at, updated_at)
    VALUES (?, ?, ?, NULL, ?, 1, ?, ?)
  `).run('target-1', 'host-1', 'Target', 'ollama-container-id', NOW, NOW);

  database.prepare(`
    INSERT INTO modelfiles(id, display_name, description, current_revision_id, created_by_user_id, updated_by_user_id, created_at, updated_at)
    VALUES (?, ?, NULL, NULL, ?, ?, ?, ?)
  `).run('artifact-import', 'Imported snapshot', 'user-1', 'user-1', NOW, NOW);
  database.prepare(`
    INSERT INTO modelfile_revisions(
      id, modelfile_id, revision_number, parent_revision_id, raw_text, content_sha256,
      source_kind, imported_target_id, imported_model, imported_digest, created_by_user_id, created_at
    ) VALUES (?, ?, 1, NULL, ?, ?, 'installed-model-import', ?, ?, ?, ?, ?)
  `).run(
    'revision-import', 'artifact-import', 'FROM /root/.ollama/models/blobs/sha256:deadbeef\n', IMPORT_SHA,
    'target-1', 'custom:latest', DIGEST, 'user-1', NOW,
  );
  database.prepare(`UPDATE modelfiles SET current_revision_id = ? WHERE id = ?`).run('revision-import', 'artifact-import');

  database.prepare(`
    INSERT INTO modelfiles(id, display_name, description, current_revision_id, created_by_user_id, updated_by_user_id, created_at, updated_at)
    VALUES (?, ?, NULL, NULL, ?, ?, ?, ?)
  `).run('artifact-create', 'Create source', 'user-1', 'user-1', NOW, NOW);
  database.prepare(`
    INSERT INTO modelfile_revisions(
      id, modelfile_id, revision_number, parent_revision_id, raw_text, content_sha256,
      source_kind, imported_target_id, imported_model, imported_digest, created_by_user_id, created_at
    ) VALUES (?, ?, 1, NULL, ?, ?, 'manual', NULL, NULL, NULL, ?, ?)
  `).run('revision-create', 'artifact-create', 'FROM hf.co/example/base:Q4_K_M\n', CREATE_SHA, 'user-1', NOW);
  database.prepare(`UPDATE modelfiles SET current_revision_id = ? WHERE id = ?`).run('revision-create', 'artifact-create');

  database.prepare(`
    INSERT INTO jobs(
      id, target_id, actor_user_id, kind, mutating, state, created_at, started_at, finished_at, result_json, error_class, exit_code
    ) VALUES (?, ?, ?, 'model-create', 1, 'succeeded', ?, ?, ?, ?, NULL, NULL)
  `).run(
    'job-create', 'target-1', 'user-1', NOW, NOW, '2026-08-10T02:01:00.000Z',
    JSON.stringify({
      verified: true,
      outputModel: 'custom:latest',
      baseModel: 'hf.co/example/base:Q4_K_M',
      digest: DIGEST,
      modelfileId: 'artifact-create',
      revisionId: 'revision-create',
      revisionSha256: CREATE_SHA,
      system: 'SECRET-MUST-NOT-LEAK',
    }),
  );

  database.prepare(`
    INSERT INTO jobs(
      id, target_id, actor_user_id, kind, mutating, state, created_at, started_at, finished_at, result_json, error_class, exit_code
    ) VALUES (?, ?, ?, 'model-create', 1, 'succeeded', ?, ?, ?, ?, NULL, NULL)
  `).run(
    'job-stale', 'target-1', 'user-1', NOW, NOW, '2026-08-10T02:02:00.000Z',
    JSON.stringify({
      verified: true,
      outputModel: 'custom:latest',
      baseModel: 'wrong-base:latest',
      digest: 'e'.repeat(64),
      modelfileId: 'artifact-create',
      revisionId: 'revision-create',
      revisionSha256: CREATE_SHA,
    }),
  );
}

test('SQLite evidence store reconstructs only digest-matched immutable import/create lineage', () => {
  const database = openDatabase(':memory:');
  try {
    applyMigrations(database);
    seed(database);
    const graph = buildModelProvenanceGraph(new SqliteModelProvenanceEvidenceStore(database), {
      targetId: 'target-1',
      model: 'custom:latest',
      digest: DIGEST,
    });

    assert.deepEqual(graph.edges.map((edge) => [edge.relation, edge.evidence, edge.jobId]), [
      ['captured-as-revision', 'persisted-import', null],
      ['created-from-revision', 'verified-create', 'job-create'],
      ['base-model', 'verified-create', 'job-create'],
    ]);
    assert.equal(graph.nodes.some((node) => node.kind === 'modelfile-revision' && node.displayName === 'Imported snapshot'), true);
    assert.equal(graph.nodes.some((node) => node.kind === 'modelfile-revision' && node.displayName === 'Create source'), true);
    assert.equal(graph.nodes.some((node) => node.kind === 'model-reference' && node.model === 'hf.co/example/base:Q4_K_M'), true);
    assert.equal(JSON.stringify(graph).includes('job-stale'), false);
    assert.equal(JSON.stringify(graph).includes('wrong-base'), false);
    assert.equal(JSON.stringify(graph).includes('SECRET-MUST-NOT-LEAK'), false);
  } finally {
    database.close();
  }
});
