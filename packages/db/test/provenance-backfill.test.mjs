import assert from 'node:assert/strict';
import test from 'node:test';
import { applyMigrations, openDatabase } from '../dist/index.js';
import { backfillVerifiedProvenanceEvidence, readPersistedProvenanceGraph } from '../dist/provenance-backfill.js';

const importedDigest = 'a'.repeat(64);
const revisionHash = 'b'.repeat(64);
const deployedDigest = 'c'.repeat(64);

function seeded() {
  const database = openDatabase(':memory:');
  applyMigrations(database);
  database.prepare(`INSERT INTO users(id, username, password_hash, role, created_at) VALUES ('user-1', 'admin', 'hash', 'admin', ?)`)
    .run('2026-08-10T16:00:00.000Z');
  database.prepare(`INSERT INTO hosts(id, display_name, hostname, port, username) VALUES ('host-1', 'Host', 'host.internal', 22, 'orc')`).run();
  database.prepare(`INSERT INTO ollama_targets(id, host_id, display_name, selected_container_id) VALUES ('target-1', 'host-1', 'Target', 'container-1')`).run();
  database.prepare(`INSERT INTO modelfiles(id, display_name, created_by_user_id, updated_by_user_id, created_at, updated_at) VALUES ('mf-1', 'Imported', 'user-1', 'user-1', ?, ?)`)
    .run('2026-08-10T16:01:00.000Z', '2026-08-10T16:01:00.000Z');
  database.prepare(`INSERT INTO modelfile_revisions(
    id, modelfile_id, revision_number, parent_revision_id, raw_text, content_sha256,
    source_kind, imported_target_id, imported_model, imported_digest, created_by_user_id, created_at
  ) VALUES ('rev-1', 'mf-1', 1, NULL, ?, ?, 'installed-model-import', 'target-1', 'base:latest', ?, 'user-1', ?)`)
    .run(
      'FROM base:latest\nADAPTER hf.co/example/adapter:Q4_K_M\nADAPTER /srv/local/adapter.gguf\n',
      revisionHash,
      importedDigest,
      '2026-08-10T16:01:00.000Z',
    );
  database.prepare(`INSERT INTO jobs(id, target_id, actor_user_id, kind, mutating, state, created_at, started_at, finished_at, result_json)
    VALUES ('job-create-1', 'target-1', 'user-1', 'model-create', 1, 'succeeded', ?, ?, ?, '{}')`)
    .run('2026-08-10T16:02:00.000Z', '2026-08-10T16:02:00.000Z', '2026-08-10T16:03:00.000Z');
  database.prepare(`INSERT INTO modelfile_deployments(
    id, target_id, modelfile_id, revision_id, revision_sha256, output_model, model_digest,
    size_bytes, base_model, source_create_job_id, actor_user_id, selected_container_id, verified_at
  ) VALUES ('deployment-1', 'target-1', 'mf-1', 'rev-1', ?, 'derived:latest', ?, 1234, 'base:latest', 'job-create-1', 'user-1', 'container-1', ?)`)
    .run(revisionHash, deployedDigest, '2026-08-10T16:03:00.000Z');
  return database;
}

test('backfill is idempotent and materializes import, create and explicit adapter evidence', () => {
  const database = seeded();
  try {
    assert.deepEqual(backfillVerifiedProvenanceEvidence(database), { importsProcessed: 1, deploymentsProcessed: 1 });
    assert.deepEqual(backfillVerifiedProvenanceEvidence(database), { importsProcessed: 1, deploymentsProcessed: 1 });

    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM provenance_nodes').get().count, 5);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM provenance_edges').get().count, 5);

    const created = readPersistedProvenanceGraph(database, { targetId: 'target-1', model: 'derived:latest', digest: deployedDigest });
    assert.notEqual(created.currentNodeId, null);
    assert.deepEqual(created.edges.map((edge) => edge.relation).sort(), ['adapter', 'base-model', 'created-from-revision']);
    assert.equal(created.nodes.some((node) => node.kind === 'modelfile-revision' && node.revisionId === 'rev-1'), true);
    assert.equal(created.nodes.some((node) => node.kind === 'model-reference' && node.modelName === 'base:latest'), true);
    assert.equal(created.nodes.some((node) => node.kind === 'model-reference' && node.modelName === 'hf.co/example/adapter:Q4_K_M'), true);
    assert.equal(created.nodes.some((node) => node.kind === 'model-reference' && node.modelName === '/srv/local/adapter.gguf'), false);

    const imported = readPersistedProvenanceGraph(database, { targetId: 'target-1', model: 'base:latest', digest: importedDigest });
    assert.deepEqual(imported.edges.map((edge) => edge.relation).sort(), ['adapter', 'captured-as-revision']);
    assert.equal(imported.edges.find((edge) => edge.relation === 'adapter')?.origin, 'observed');
    assert.equal(imported.edges.find((edge) => edge.relation === 'adapter')?.confidence, 'high');
  } finally { database.close(); }
});

test('adapter backfill fails closed for malformed imported Modelfile evidence', () => {
  const database = seeded();
  try {
    database.exec('DROP TRIGGER trg_modelfile_revisions_no_update');
    database.prepare(`UPDATE modelfile_revisions SET raw_text = 'FROM base:latest\nADAPTER """unterminated\n' WHERE id = 'rev-1'`).run();
    backfillVerifiedProvenanceEvidence(database);
    assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM provenance_edges WHERE relation = 'adapter'`).get().count, 0);
  } finally { database.close(); }
});

test('persisted graph remains exact-digest bound and never attaches stale evidence', () => {
  const database = seeded();
  try {
    backfillVerifiedProvenanceEvidence(database);
    const stale = readPersistedProvenanceGraph(database, { targetId: 'target-1', model: 'derived:latest', digest: 'd'.repeat(64) });
    assert.deepEqual(stale, { currentNodeId: null, nodes: [], edges: [] });
  } finally { database.close(); }
});

test('conflicting deterministic edge identity fails closed instead of rewriting evidence', () => {
  const database = seeded();
  try {
    backfillVerifiedProvenanceEvidence(database);
    const edge = database.prepare(`SELECT id FROM provenance_edges WHERE relation = 'base-model'`).get();
    database.exec('DROP TRIGGER trg_provenance_edges_no_update');
    database.prepare(`UPDATE provenance_edges SET confidence = 'low' WHERE id = ?`).run(edge.id);
    assert.throws(() => backfillVerifiedProvenanceEvidence(database), /conflicts with different evidence/u);
  } finally { database.close(); }
});
