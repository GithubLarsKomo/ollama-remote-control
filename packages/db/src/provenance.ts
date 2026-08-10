import type {
  ProvenanceRepository,
  StoredProvenanceEdge,
  StoredProvenanceNode,
  StoredProvenanceSource,
} from '@orc/core/provenance';
import type { DatabaseConnection } from './index.js';

const MAX_ROWS = 200;
const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_MODEL = /^[A-Za-z0-9][A-Za-z0-9._/:@+-]*$/u;
const SAFE_REFERENCE = /^https:\/\/[^\s\u0000-\u001f\u007f]+$/u;

function boundedText(value: string, max: number, label: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max || /[\u0000-\u001f\u007f]/u.test(trimmed)) throw new Error(`${label} is invalid.`);
  return trimmed;
}

function validateDigest(value: string): string {
  if (!SHA256.test(value)) throw new Error('Provenance digest must be lowercase SHA-256 hex.');
  return value;
}

function validateModel(value: string): string {
  const model = boundedText(value, 512, 'Model name');
  if (!SAFE_MODEL.test(model)) throw new Error('Model name is invalid.');
  return model;
}

function validateReference(value: string): string {
  const reference = boundedText(value, 2048, 'Source reference');
  if (!SAFE_REFERENCE.test(reference)) throw new Error('Source reference must be a bounded HTTPS URL.');
  const url = new URL(reference);
  if (url.username || url.password) throw new Error('Credential-bearing source URLs are forbidden.');
  return url.toString();
}

function mapSource(row: Record<string, unknown> | undefined): StoredProvenanceSource | null {
  if (!row) return null;
  return {
    id: String(row.id),
    subjectKind: String(row.subject_kind) as StoredProvenanceSource['subjectKind'],
    targetId: row.target_id === null ? null : String(row.target_id),
    modelName: row.model_name === null ? null : String(row.model_name),
    modelDigest: row.model_digest === null ? null : String(row.model_digest),
    revisionId: row.revision_id === null ? null : String(row.revision_id),
    sourceKind: String(row.source_kind) as StoredProvenanceSource['sourceKind'],
    sourceReference: row.source_reference === null ? null : String(row.source_reference),
    origin: String(row.origin) as StoredProvenanceSource['origin'],
    confidence: String(row.confidence) as StoredProvenanceSource['confidence'],
    actorUserId: String(row.actor_user_id),
    supersedesSourceId: row.supersedes_source_id === null ? null : String(row.supersedes_source_id),
    note: row.note === null ? null : String(row.note),
    createdAt: String(row.created_at),
  };
}

function mapNode(row: Record<string, unknown> | undefined): StoredProvenanceNode | null {
  if (!row) return null;
  return {
    id: String(row.id),
    identityKey: String(row.identity_key),
    kind: String(row.kind) as StoredProvenanceNode['kind'],
    targetId: row.target_id === null ? null : String(row.target_id),
    modelName: row.model_name === null ? null : String(row.model_name),
    modelDigest: row.model_digest === null ? null : String(row.model_digest),
    revisionId: row.revision_id === null ? null : String(row.revision_id),
    createdAt: String(row.created_at),
  };
}

function mapEdge(row: Record<string, unknown>): StoredProvenanceEdge {
  return {
    id: String(row.id),
    fromNodeId: String(row.from_node_id),
    toNodeId: String(row.to_node_id),
    relation: String(row.relation) as StoredProvenanceEdge['relation'],
    origin: String(row.origin) as StoredProvenanceEdge['origin'],
    confidence: String(row.confidence) as StoredProvenanceEdge['confidence'],
    sourceJobId: row.source_job_id === null ? null : String(row.source_job_id),
    actorUserId: String(row.actor_user_id),
    createdAt: String(row.created_at),
  };
}

function normalizeSource(source: StoredProvenanceSource): StoredProvenanceSource {
  const id = boundedText(source.id, 256, 'Source ID');
  const actorUserId = boundedText(source.actorUserId, 256, 'Actor ID');
  const createdAt = boundedText(source.createdAt, 80, 'Created timestamp');
  const supersedesSourceId = source.supersedesSourceId === null ? null : boundedText(source.supersedesSourceId, 256, 'Superseded source ID');
  const note = source.note === null ? null : boundedText(source.note, 1024, 'Source note');

  if (source.subjectKind === 'installed-model') {
    if (!source.targetId || !source.modelName || !source.modelDigest || source.revisionId !== null) throw new Error('Installed-model source identity is incomplete.');
  } else if (source.subjectKind === 'modelfile-revision') {
    if (!source.revisionId || source.targetId !== null || source.modelName !== null || source.modelDigest !== null) throw new Error('Modelfile-revision source identity is incomplete.');
  } else throw new Error('Unsupported provenance subject kind.');

  let sourceReference: string | null = null;
  if (source.sourceKind === 'unknown') {
    if (source.sourceReference !== null || source.confidence !== 'unknown') throw new Error('Unknown source must retain unknown confidence and no reference.');
  } else {
    if (!['huggingface', 'ollama', 'url'].includes(source.sourceKind) || source.sourceReference === null) throw new Error('Unsupported provenance source kind.');
    sourceReference = validateReference(source.sourceReference);
  }
  if (!['observed', 'operator'].includes(source.origin)) throw new Error('Unsupported provenance origin.');
  if (!['high', 'medium', 'low', 'unknown'].includes(source.confidence)) throw new Error('Unsupported provenance confidence.');

  return {
    ...source,
    id,
    actorUserId,
    createdAt,
    supersedesSourceId,
    note,
    targetId: source.targetId === null ? null : boundedText(source.targetId, 256, 'Target ID'),
    modelName: source.modelName === null ? null : validateModel(source.modelName),
    modelDigest: source.modelDigest === null ? null : validateDigest(source.modelDigest),
    revisionId: source.revisionId === null ? null : boundedText(source.revisionId, 256, 'Revision ID'),
    sourceReference,
  };
}

function normalizeNode(node: StoredProvenanceNode): StoredProvenanceNode {
  const normalized: StoredProvenanceNode = {
    ...node,
    id: boundedText(node.id, 256, 'Node ID'),
    identityKey: boundedText(node.identityKey, 1024, 'Node identity key'),
    targetId: node.targetId === null ? null : boundedText(node.targetId, 256, 'Target ID'),
    modelName: node.modelName === null ? null : validateModel(node.modelName),
    modelDigest: node.modelDigest === null ? null : validateDigest(node.modelDigest),
    revisionId: node.revisionId === null ? null : boundedText(node.revisionId, 256, 'Revision ID'),
    createdAt: boundedText(node.createdAt, 80, 'Created timestamp'),
  };
  if (node.kind === 'installed-model') {
    if (!normalized.targetId || !normalized.modelName || !normalized.modelDigest || normalized.revisionId !== null) throw new Error('Installed-model node identity is incomplete.');
  } else if (node.kind === 'model-reference') {
    if (normalized.targetId !== null || !normalized.modelName || normalized.modelDigest !== null || normalized.revisionId !== null) throw new Error('Model-reference node identity is invalid.');
  } else if (node.kind === 'modelfile-revision') {
    if (normalized.targetId !== null || normalized.modelName !== null || normalized.modelDigest !== null || !normalized.revisionId) throw new Error('Modelfile-revision node identity is invalid.');
  } else throw new Error('Unsupported provenance node kind.');
  return normalized;
}

export class SqliteProvenanceRepository implements ProvenanceRepository {
  constructor(private readonly database: DatabaseConnection) {}

  appendSource(input: StoredProvenanceSource): void {
    const source = normalizeSource(input);
    this.database.prepare(`INSERT INTO provenance_sources(
      id, subject_kind, target_id, model_name, model_digest, revision_id,
      source_kind, source_reference, origin, confidence, actor_user_id,
      supersedes_source_id, note, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      source.id, source.subjectKind, source.targetId, source.modelName, source.modelDigest, source.revisionId,
      source.sourceKind, source.sourceReference, source.origin, source.confidence, source.actorUserId,
      source.supersedesSourceId, source.note, source.createdAt,
    );
  }

  findSourceById(sourceId: string): StoredProvenanceSource | null {
    return mapSource(this.database.prepare('SELECT * FROM provenance_sources WHERE id = ?').get(sourceId));
  }

  listSourcesForInstalledModel(targetId: string, modelName: string, modelDigest: string): readonly StoredProvenanceSource[] {
    return this.database.prepare(`SELECT * FROM provenance_sources
      WHERE subject_kind = 'installed-model' AND target_id = ? AND model_name = ? AND model_digest = ?
      ORDER BY created_at DESC, id DESC LIMIT ${MAX_ROWS}`)
      .all(targetId, validateModel(modelName), validateDigest(modelDigest)).map((row) => mapSource(row)!).filter(Boolean);
  }

  listSourcesForRevision(revisionId: string): readonly StoredProvenanceSource[] {
    return this.database.prepare(`SELECT * FROM provenance_sources
      WHERE subject_kind = 'modelfile-revision' AND revision_id = ?
      ORDER BY created_at DESC, id DESC LIMIT ${MAX_ROWS}`)
      .all(revisionId).map((row) => mapSource(row)!).filter(Boolean);
  }

  ensureNode(input: StoredProvenanceNode): StoredProvenanceNode {
    const node = normalizeNode(input);
    const existing = this.findNodeByIdentityKey(node.identityKey);
    if (existing) {
      const comparable = (value: StoredProvenanceNode) => JSON.stringify({
        kind: value.kind, targetId: value.targetId, modelName: value.modelName,
        modelDigest: value.modelDigest, revisionId: value.revisionId,
      });
      if (comparable(existing) !== comparable(node)) throw new Error('Provenance node identity key conflicts with different evidence.');
      return existing;
    }
    this.database.prepare(`INSERT INTO provenance_nodes(
      id, identity_key, kind, target_id, model_name, model_digest, revision_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      node.id, node.identityKey, node.kind, node.targetId, node.modelName, node.modelDigest, node.revisionId, node.createdAt,
    );
    return node;
  }

  findNodeByIdentityKey(identityKey: string): StoredProvenanceNode | null {
    return mapNode(this.database.prepare('SELECT * FROM provenance_nodes WHERE identity_key = ?').get(identityKey));
  }

  appendEdge(edge: StoredProvenanceEdge): void {
    if (!['base-model', 'adapter', 'quantized-from', 'created-from-revision', 'captured-as-revision'].includes(edge.relation)) throw new Error('Unsupported provenance relation.');
    if (!['observed', 'operator'].includes(edge.origin)) throw new Error('Unsupported provenance origin.');
    if (!['high', 'medium', 'low', 'unknown'].includes(edge.confidence)) throw new Error('Unsupported provenance confidence.');
    this.database.prepare(`INSERT INTO provenance_edges(
      id, from_node_id, to_node_id, relation, origin, confidence, source_job_id, actor_user_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      boundedText(edge.id, 256, 'Edge ID'),
      boundedText(edge.fromNodeId, 256, 'From node ID'),
      boundedText(edge.toNodeId, 256, 'To node ID'),
      edge.relation,
      edge.origin,
      edge.confidence,
      edge.sourceJobId === null ? null : boundedText(edge.sourceJobId, 256, 'Source job ID'),
      boundedText(edge.actorUserId, 256, 'Actor ID'),
      boundedText(edge.createdAt, 80, 'Created timestamp'),
    );
  }

  listEdgesForNode(nodeId: string): readonly StoredProvenanceEdge[] {
    return this.database.prepare(`SELECT * FROM provenance_edges
      WHERE from_node_id = ? OR to_node_id = ?
      ORDER BY created_at DESC, id DESC LIMIT ${MAX_ROWS}`)
      .all(nodeId, nodeId).map(mapEdge);
  }
}
