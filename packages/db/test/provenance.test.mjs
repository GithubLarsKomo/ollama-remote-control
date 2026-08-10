import assert from 'node:assert/strict';
import test from 'node:test';
import { applyMigrations, openDatabase } from '../dist/index.js';
import { SqliteProvenanceRepository } from '../dist/provenance.js';

const digest = 'a'.repeat(64);
const revisionHash = 'b'.repeat(64);

function seeded() {
  const database = openDatabase(':memory:');
  applyMigrations(database);
  database.prepare(`INSERT INTO users(id, username, password_hash, role, created_at) VALUES (?, ?, ?, 'admin', ?)`)
    .run('user-1', 'admin', 'hash', '2026-08-10T16:00:00.000Z');
  database.prepare(`INSERT INTO hosts(id, display_name, hostname, port, username) VALUES (?, ?, ?, ?, ?)`)
    .run('host-1', 'Host', 'host.internal', 22, 'orc');
  database.prepare(`INSERT INTO ollama_targets(id, host_id, display_name, selected_container_id) VALUES (?, ?, ?, ?)`)
    .run('target-1', 'host-1', 'Target', 'container-1');
  database.prepare(`INSERT INTO modelfiles(id, display_name, created_by_user_id, updated_by_user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .run('mf-1', 'Example', 'user-1', 'user-1', '2026-08-10T16:00:00.000Z', '2026-08-10T16:00:00.000Z');
  database.prepare(`INSERT INTO modelfile_revisions(id, modelfile_id, revision_number, parent_revision_id, raw_text, content_sha256, source_kind, created_by_user_id, created_at) VALUES (?, ?, 1, NULL, ?, ?, 'manual', ?, ?)`)
    .run('rev-1', 'mf-1', 'FROM llama3.2:latest\n', revisionHash, 'user-1', '2026-08-10T16:00:00.000Z');
  return { database, repository: new SqliteProvenanceRepository(database) };
}

test('persists exact-digest sources and preserves explicit unknown without guessing', () => {
  const { database, repository } = seeded();
  try {
    repository.appendSource({
      id: 'source-observed', subjectKind: 'installed-model', targetId: 'target-1', modelName: 'derived:latest', modelDigest: digest,
      revisionId: null, sourceKind: 'huggingface', sourceReference: 'https://huggingface.co/org/model', origin: 'observed', confidence: 'high',
      actorUserId: 'user-1', supersedesSourceId: null, note: null, createdAt: '2026-08-10T16:01:00.000Z',
    });
    repository.appendSource({
      id: 'source-unknown', subjectKind: 'modelfile-revision', targetId: null, modelName: null, modelDigest: null,
      revisionId: 'rev-1', sourceKind: 'unknown', sourceReference: null, origin: 'observed', confidence: 'unknown',
      actorUserId: 'user-1', supersedesSourceId: null, note: 'No evidenced external source', createdAt: '2026-08-10T16:02:00.000Z',
    });

    assert.equal(repository.listSourcesForInstalledModel('target-1', 'derived:latest', digest)[0].sourceReference, 'https://huggingface.co/org/model');
    const unknown = repository.listSourcesForRevision('rev-1')[0];
    assert.equal(unknown.sourceKind, 'unknown');
    assert.equal(unknown.sourceReference, null);
    assert.equal(unknown.confidence, 'unknown');
  } finally { database.close(); }
});

test('manual correction appends same-subject evidence and cannot rewrite history', () => {
  const { database, repository } = seeded();
  try {
    const original = {
      id: 'source-1', subjectKind: 'installed-model', targetId: 'target-1', modelName: 'derived:latest', modelDigest: digest,
      revisionId: null, sourceKind: 'url', sourceReference: 'https://example.com/original', origin: 'observed', confidence: 'medium',
      actorUserId: 'user-1', supersedesSourceId: null, note: null, createdAt: '2026-08-10T16:01:00.000Z',
    };
    repository.appendSource(original);
    repository.appendSource({ ...original, id: 'source-2', sourceReference: 'https://example.com/corrected', origin: 'operator', confidence: 'high', supersedesSourceId: 'source-1', createdAt: '2026-08-10T16:02:00.000Z' });
    assert.deepEqual(repository.listSourcesForInstalledModel('target-1', 'derived:latest', digest).map((source) => source.id), ['source-2', 'source-1']);
    assert.throws(() => database.prepare(`UPDATE provenance_sources SET note = 'rewritten' WHERE id = 'source-1'`).run(), /immutable/u);
    assert.throws(() => repository.appendSource({ ...original, id: 'source-bad', modelDigest: 'c'.repeat(64), supersedesSourceId: 'source-1' }), /same subject/u);
  } finally { database.close(); }
});

test('supports deterministic multi-parent lineage and rejects identity collisions', () => {
  const { database, repository } = seeded();
  try {
    const child = repository.ensureNode({ id: 'node-child', identityKey: `installed:target-1:derived:latest:${digest}`, kind: 'installed-model', targetId: 'target-1', modelName: 'derived:latest', modelDigest: digest, revisionId: null, createdAt: '2026-08-10T16:01:00.000Z' });
    const base = repository.ensureNode({ id: 'node-base', identityKey: 'model:llama3.2:latest', kind: 'model-reference', targetId: null, modelName: 'llama3.2:latest', modelDigest: null, revisionId: null, createdAt: '2026-08-10T16:01:00.000Z' });
    const adapter = repository.ensureNode({ id: 'node-adapter', identityKey: 'model:org/adapter:latest', kind: 'model-reference', targetId: null, modelName: 'org/adapter:latest', modelDigest: null, revisionId: null, createdAt: '2026-08-10T16:01:00.000Z' });
    const revision = repository.ensureNode({ id: 'node-revision', identityKey: 'revision:rev-1', kind: 'modelfile-revision', targetId: null, modelName: null, modelDigest: null, revisionId: 'rev-1', createdAt: '2026-08-10T16:01:00.000Z' });

    repository.appendEdge({ id: 'edge-base', fromNodeId: base.id, toNodeId: child.id, relation: 'base-model', origin: 'observed', confidence: 'high', sourceJobId: null, actorUserId: 'user-1', createdAt: '2026-08-10T16:02:00.000Z' });
    repository.appendEdge({ id: 'edge-adapter', fromNodeId: adapter.id, toNodeId: child.id, relation: 'adapter', origin: 'observed', confidence: 'high', sourceJobId: null, actorUserId: 'user-1', createdAt: '2026-08-10T16:03:00.000Z' });
    repository.appendEdge({ id: 'edge-revision', fromNodeId: revision.id, toNodeId: child.id, relation: 'created-from-revision', origin: 'observed', confidence: 'high', sourceJobId: null, actorUserId: 'user-1', createdAt: '2026-08-10T16:04:00.000Z' });

    assert.deepEqual(repository.listEdgesForNode(child.id).map((edge) => edge.relation), ['created-from-revision', 'adapter', 'base-model']);
    assert.equal(repository.ensureNode({ ...base, id: 'ignored-second-id' }).id, 'node-base');
    assert.throws(() => repository.ensureNode({ ...base, id: 'node-conflict', modelName: 'different:latest' }), /identity key conflicts/u);
    assert.throws(() => repository.appendEdge({ id: 'edge-loop', fromNodeId: child.id, toNodeId: child.id, relation: 'base-model', origin: 'operator', confidence: 'low', sourceJobId: null, actorUserId: 'user-1', createdAt: '2026-08-10T16:05:00.000Z' }));
    assert.throws(() => database.prepare(`DELETE FROM provenance_edges WHERE id = 'edge-base'`).run(), /append-only/u);
  } finally { database.close(); }
});

test('fails closed for credential-bearing or non-HTTPS source references', () => {
  const { database, repository } = seeded();
  const base = {
    id: 'source-bad', subjectKind: 'installed-model', targetId: 'target-1', modelName: 'derived:latest', modelDigest: digest,
    revisionId: null, sourceKind: 'url', origin: 'operator', confidence: 'low', actorUserId: 'user-1', supersedesSourceId: null, note: null,
    createdAt: '2026-08-10T16:01:00.000Z',
  };
  try {
    assert.throws(() => repository.appendSource({ ...base, sourceReference: 'http://example.com/model' }), /HTTPS/u);
    assert.throws(() => repository.appendSource({ ...base, sourceReference: 'https://user:secret@example.com/model' }), /Credential-bearing/u);
    assert.throws(() => repository.appendSource({ ...base, sourceKind: 'unknown', sourceReference: null, confidence: 'low' }), /unknown confidence/u);
  } finally { database.close(); }
});
