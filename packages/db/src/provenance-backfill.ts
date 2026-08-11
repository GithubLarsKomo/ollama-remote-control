import { createHash } from 'node:crypto';
import { parseModelfile } from '@orc/core/modelfile-parser';
import type { StoredProvenanceEdge, StoredProvenanceNode } from '@orc/core/provenance';
import type { DatabaseConnection } from './index.js';
import { SqliteProvenanceRepository } from './provenance.js';

const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_EVIDENCE_ROWS = 1000;

function hashId(prefix: string, value: string): string {
  return `${prefix}:${createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 32)}`;
}

function safeModel(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const model = value.trim();
  if (!model || model.length > 512 || !/^[A-Za-z0-9][A-Za-z0-9._/:@+-]*$/u.test(model)) return null;
  return model;
}

function safeLineageModelReference(value: unknown): string | null {
  const model = safeModel(value);
  if (!model) return null;
  const lower = model.toLowerCase();
  if (
    model.startsWith('/')
    || model.startsWith('./')
    || model.startsWith('../')
    || /^[A-Za-z]:\//u.test(model)
    || lower.startsWith('sha256:')
    || lower.includes('/blobs/sha256:')
  ) return null;
  return model;
}

function safeText(value: unknown, max = 256): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text || text.length > max || /[\u0000-\u001f\u007f]/u.test(text)) return null;
  return text;
}

function safeDigest(value: unknown): string | null {
  const digest = safeText(value, 64);
  return digest && SHA256.test(digest) ? digest : null;
}

function installedIdentity(targetId: string, model: string, digest: string): string {
  return `installed:${targetId}:${model}:${digest}`;
}

function referenceIdentity(model: string): string {
  return `model-reference:${model}`;
}

function revisionIdentity(revisionId: string): string {
  return `revision:${revisionId}`;
}

function explicitAdapterReferences(rawText: unknown): readonly string[] {
  if (typeof rawText !== 'string') return [];
  try {
    const parsed = parseModelfile(rawText);
    if (parsed.diagnostics.some((item) => item.severity === 'error')) return [];
    const adapters = new Set<string>();
    for (const node of parsed.nodes) {
      if (node.kind !== 'directive' || node.name !== 'ADAPTER') continue;
      const reference = safeLineageModelReference(node.argument);
      if (reference) adapters.add(reference);
    }
    return [...adapters].sort();
  } catch {
    return [];
  }
}

function ensureExactEdge(database: DatabaseConnection, edge: StoredProvenanceEdge): void {
  const existing = database.prepare(`SELECT id, from_node_id, to_node_id, relation, origin, confidence, source_job_id, actor_user_id, created_at FROM provenance_edges WHERE id = ?`).get(edge.id);
  if (existing) {
    const actual = JSON.stringify({
      fromNodeId: String(existing.from_node_id),
      toNodeId: String(existing.to_node_id),
      relation: String(existing.relation),
      origin: String(existing.origin),
      confidence: String(existing.confidence),
      sourceJobId: existing.source_job_id === null ? null : String(existing.source_job_id),
      actorUserId: String(existing.actor_user_id),
      createdAt: String(existing.created_at),
    });
    const expected = JSON.stringify({
      fromNodeId: edge.fromNodeId,
      toNodeId: edge.toNodeId,
      relation: edge.relation,
      origin: edge.origin,
      confidence: edge.confidence,
      sourceJobId: edge.sourceJobId,
      actorUserId: edge.actorUserId,
      createdAt: edge.createdAt,
    });
    if (actual !== expected) throw new Error('Persisted provenance edge ID conflicts with different evidence.');
    return;
  }
  new SqliteProvenanceRepository(database).appendEdge(edge);
}

function materializeAdapters(
  database: DatabaseConnection,
  repository: SqliteProvenanceRepository,
  installed: StoredProvenanceNode,
  rawText: unknown,
  evidenceKey: string,
  actorUserId: string,
  createdAt: string,
  sourceJobId: string | null,
): void {
  for (const adapterModel of explicitAdapterReferences(rawText)) {
    const adapter = repository.ensureNode({
      id: hashId('prov-reference', referenceIdentity(adapterModel)),
      identityKey: referenceIdentity(adapterModel),
      kind: 'model-reference', targetId: null, modelName: adapterModel, modelDigest: null, revisionId: null, createdAt,
    });
    ensureExactEdge(database, {
      id: hashId('prov-adapter-edge', `${evidenceKey}:${adapterModel}`),
      fromNodeId: adapter.id,
      toNodeId: installed.id,
      relation: 'adapter',
      origin: 'observed',
      confidence: 'high',
      sourceJobId,
      actorUserId,
      createdAt,
    });
  }
}

export interface ProvenanceBackfillResult {
  readonly importsProcessed: number;
  readonly deploymentsProcessed: number;
}

export function backfillVerifiedProvenanceEvidence(database: DatabaseConnection): ProvenanceBackfillResult {
  const repository = new SqliteProvenanceRepository(database);
  let importsProcessed = 0;
  let deploymentsProcessed = 0;

  const imports = database.prepare(`
    SELECT id AS revision_id, imported_target_id, imported_model, imported_digest,
           raw_text, created_by_user_id, created_at
    FROM modelfile_revisions
    WHERE source_kind = 'installed-model-import'
      AND imported_target_id IS NOT NULL
      AND imported_model IS NOT NULL
      AND imported_digest IS NOT NULL
    ORDER BY created_at, id
    LIMIT ${MAX_EVIDENCE_ROWS}
  `).all();

  for (const row of imports) {
    const revisionId = safeText(row.revision_id);
    const targetId = safeText(row.imported_target_id);
    const model = safeModel(row.imported_model);
    const digest = safeDigest(row.imported_digest);
    const actorUserId = safeText(row.created_by_user_id);
    const createdAt = safeText(row.created_at, 80);
    if (!revisionId || !targetId || !model || !digest || !actorUserId || !createdAt) continue;

    const installed = repository.ensureNode({
      id: hashId('prov-installed', installedIdentity(targetId, model, digest)),
      identityKey: installedIdentity(targetId, model, digest),
      kind: 'installed-model', targetId, modelName: model, modelDigest: digest, revisionId: null, createdAt,
    });
    const revision = repository.ensureNode({
      id: hashId('prov-revision', revisionIdentity(revisionId)),
      identityKey: revisionIdentity(revisionId),
      kind: 'modelfile-revision', targetId: null, modelName: null, modelDigest: null, revisionId, createdAt,
    });
    ensureExactEdge(database, {
      id: hashId('prov-import-edge', `${revisionId}:${targetId}:${model}:${digest}`),
      fromNodeId: installed.id,
      toNodeId: revision.id,
      relation: 'captured-as-revision',
      origin: 'observed',
      confidence: 'high',
      sourceJobId: null,
      actorUserId,
      createdAt,
    });
    materializeAdapters(database, repository, installed, row.raw_text, `import:${revisionId}:${targetId}:${model}:${digest}`, actorUserId, createdAt, null);
    importsProcessed += 1;
  }

  const deployments = database.prepare(`
    SELECT deployment.target_id, deployment.revision_id, deployment.output_model,
           deployment.model_digest, deployment.base_model, deployment.source_create_job_id,
           deployment.actor_user_id, deployment.verified_at, revision.raw_text
    FROM modelfile_deployments deployment
    JOIN modelfile_revisions revision ON revision.id = deployment.revision_id
    ORDER BY deployment.verified_at, deployment.id
    LIMIT ${MAX_EVIDENCE_ROWS}
  `).all();

  for (const row of deployments) {
    const targetId = safeText(row.target_id);
    const revisionId = safeText(row.revision_id);
    const outputModel = safeModel(row.output_model);
    const digest = safeDigest(row.model_digest);
    const baseModel = safeLineageModelReference(row.base_model);
    const sourceJobId = safeText(row.source_create_job_id);
    const actorUserId = safeText(row.actor_user_id);
    const verifiedAt = safeText(row.verified_at, 80);
    if (!targetId || !revisionId || !outputModel || !digest || !baseModel || !sourceJobId || !actorUserId || !verifiedAt) continue;

    const installed = repository.ensureNode({
      id: hashId('prov-installed', installedIdentity(targetId, outputModel, digest)),
      identityKey: installedIdentity(targetId, outputModel, digest),
      kind: 'installed-model', targetId, modelName: outputModel, modelDigest: digest, revisionId: null, createdAt: verifiedAt,
    });
    const revision = repository.ensureNode({
      id: hashId('prov-revision', revisionIdentity(revisionId)),
      identityKey: revisionIdentity(revisionId),
      kind: 'modelfile-revision', targetId: null, modelName: null, modelDigest: null, revisionId, createdAt: verifiedAt,
    });
    const base = repository.ensureNode({
      id: hashId('prov-reference', referenceIdentity(baseModel)),
      identityKey: referenceIdentity(baseModel),
      kind: 'model-reference', targetId: null, modelName: baseModel, modelDigest: null, revisionId: null, createdAt: verifiedAt,
    });
    ensureExactEdge(database, {
      id: hashId('prov-create-revision', sourceJobId),
      fromNodeId: revision.id,
      toNodeId: installed.id,
      relation: 'created-from-revision', origin: 'observed', confidence: 'high', sourceJobId, actorUserId, createdAt: verifiedAt,
    });
    ensureExactEdge(database, {
      id: hashId('prov-create-base', sourceJobId),
      fromNodeId: base.id,
      toNodeId: installed.id,
      relation: 'base-model', origin: 'observed', confidence: 'high', sourceJobId, actorUserId, createdAt: verifiedAt,
    });
    materializeAdapters(database, repository, installed, row.raw_text, `create:${sourceJobId}`, actorUserId, verifiedAt, sourceJobId);
    deploymentsProcessed += 1;
  }

  return { importsProcessed, deploymentsProcessed };
}

export interface PersistedProvenanceGraph {
  readonly currentNodeId: string | null;
  readonly nodes: readonly StoredProvenanceNode[];
  readonly edges: readonly StoredProvenanceEdge[];
}

export function readPersistedProvenanceGraph(
  database: DatabaseConnection,
  input: { readonly targetId: string; readonly model: string; readonly digest: string },
): PersistedProvenanceGraph {
  const repository = new SqliteProvenanceRepository(database);
  const current = repository.findNodeByIdentityKey(installedIdentity(input.targetId, input.model, input.digest));
  if (!current) return { currentNodeId: null, nodes: [], edges: [] };
  const edges = repository.listEdgesForNode(current.id);
  const nodeIds = new Set<string>([current.id]);
  for (const edge of edges) { nodeIds.add(edge.fromNodeId); nodeIds.add(edge.toNodeId); }
  const nodes: StoredProvenanceNode[] = [];
  for (const nodeId of [...nodeIds].sort()) {
    const row = database.prepare(`SELECT id, identity_key, kind, target_id, model_name, model_digest, revision_id, created_at FROM provenance_nodes WHERE id = ?`).get(nodeId);
    if (!row) throw new Error('Persisted provenance edge references a missing node.');
    nodes.push({
      id: String(row.id), identityKey: String(row.identity_key), kind: String(row.kind) as StoredProvenanceNode['kind'],
      targetId: row.target_id === null ? null : String(row.target_id), modelName: row.model_name === null ? null : String(row.model_name),
      modelDigest: row.model_digest === null ? null : String(row.model_digest), revisionId: row.revision_id === null ? null : String(row.revision_id),
      createdAt: String(row.created_at),
    });
  }
  return { currentNodeId: current.id, nodes, edges };
}
