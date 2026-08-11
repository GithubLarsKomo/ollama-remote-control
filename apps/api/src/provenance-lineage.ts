import { createHash, randomUUID } from 'node:crypto';
import type { ProvenanceConfidence, ProvenanceRelation, StoredProvenanceEdge, StoredProvenanceNode } from '@orc/core/provenance';
import { SqliteProvenanceRepository, type DatabaseConnection } from '@orc/db';
import { AuditService } from './audit.js';

const SAFE_MODEL = /^[A-Za-z0-9][A-Za-z0-9._/:@+-]*$/u;

export interface ProvenanceLineageInput {
  readonly relation?: unknown;
  readonly parentModel?: unknown;
  readonly confidence?: unknown;
}

export interface RecordedProvenanceLineage {
  readonly parentNode: StoredProvenanceNode;
  readonly edge: StoredProvenanceEdge;
}

export class ProvenanceLineageError extends Error {
  constructor(readonly code: string, readonly statusCode: number, message: string) {
    super(message);
  }
}

function bounded(value: unknown, max: number, label: string): string {
  if (typeof value !== 'string') throw new ProvenanceLineageError('PROVENANCE_LINEAGE_INVALID', 400, `${label} is required.`);
  const text = value.trim();
  if (!text || text.length > max || /[\u0000-\u001f\u007f]/u.test(text)) {
    throw new ProvenanceLineageError('PROVENANCE_LINEAGE_INVALID', 400, `${label} is invalid.`);
  }
  return text;
}

function parentModel(value: unknown): string {
  const model = bounded(value, 512, 'Parent model');
  const lower = model.toLowerCase();
  if (
    !SAFE_MODEL.test(model)
    || model.startsWith('/')
    || model.startsWith('./')
    || model.startsWith('../')
    || /^[A-Za-z]:\//u.test(model)
    || lower.startsWith('sha256:')
    || lower.includes('/blobs/sha256:')
  ) throw new ProvenanceLineageError('PROVENANCE_LINEAGE_INVALID', 400, 'Parent model must be an explicit model reference, not a local path or blob.');
  return model;
}

function relation(value: unknown): Extract<ProvenanceRelation, 'adapter' | 'quantized-from'> {
  if (value !== 'adapter' && value !== 'quantized-from') {
    throw new ProvenanceLineageError('PROVENANCE_LINEAGE_INVALID', 400, 'Operator lineage relation must be adapter or quantized-from.');
  }
  return value;
}

function confidence(value: unknown): Exclude<ProvenanceConfidence, 'unknown'> {
  if (value !== 'high' && value !== 'medium' && value !== 'low') {
    throw new ProvenanceLineageError('PROVENANCE_LINEAGE_INVALID', 400, 'Operator lineage confidence must be high, medium or low.');
  }
  return value;
}

function hashId(prefix: string, value: string): string {
  return `${prefix}:${createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 32)}`;
}

export class ProvenanceLineageService {
  private readonly repository: SqliteProvenanceRepository;

  constructor(
    private readonly database: DatabaseConnection,
    private readonly audit: AuditService,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.repository = new SqliteProvenanceRepository(database);
  }

  record(actorUserId: string, installedNodeId: string, input: ProvenanceLineageInput): RecordedProvenanceLineage {
    const nodeId = bounded(installedNodeId, 256, 'Installed node ID');
    const actor = bounded(actorUserId, 256, 'Actor ID');
    const selectedRelation = relation(input.relation);
    const selectedParent = parentModel(input.parentModel);
    const selectedConfidence = confidence(input.confidence);

    const installedRow = this.database.prepare(`SELECT * FROM provenance_nodes WHERE id = ?`).get(nodeId);
    if (!installedRow) throw new ProvenanceLineageError('PROVENANCE_NODE_NOT_FOUND', 404, 'Persisted provenance node was not found.');
    if (String(installedRow.kind) !== 'installed-model') {
      throw new ProvenanceLineageError('PROVENANCE_NODE_NOT_CORRECTABLE', 409, 'Operator lineage can only be attached to an installed-model node.');
    }
    if (String(installedRow.model_name) === selectedParent) {
      throw new ProvenanceLineageError('PROVENANCE_LINEAGE_INVALID', 400, 'Parent model must differ from the installed model.');
    }

    const createdAt = this.now().toISOString();
    const parent = this.repository.ensureNode({
      id: hashId('prov-reference', `model-reference:${selectedParent}`),
      identityKey: `model-reference:${selectedParent}`,
      kind: 'model-reference',
      targetId: null,
      modelName: selectedParent,
      modelDigest: null,
      revisionId: null,
      createdAt,
    });
    const edge: StoredProvenanceEdge = {
      id: hashId('prov-operator-edge', `${nodeId}:${selectedRelation}:${selectedParent}`),
      fromNodeId: parent.id,
      toNodeId: nodeId,
      relation: selectedRelation,
      origin: 'operator',
      confidence: selectedConfidence,
      sourceJobId: null,
      actorUserId: actor,
      createdAt,
    };

    const existing = this.database.prepare(`SELECT id FROM provenance_edges WHERE id = ?`).get(edge.id);
    if (existing) {
      throw new ProvenanceLineageError('PROVENANCE_LINEAGE_EXISTS', 409, 'The same operator lineage evidence is already recorded.');
    }

    this.repository.appendEdge(edge);
    this.audit.record({
      id: randomUUID(),
      timestamp: createdAt,
      actorUserId: actor,
      targetId: installedRow.target_id === null ? null : String(installedRow.target_id),
      action: 'provenance.lineage.record',
      parameters: {
        installedNodeId: nodeId,
        relation: selectedRelation,
        parentModel: selectedParent,
        confidence: selectedConfidence,
      },
      result: 'succeeded',
      errorClass: null,
    });

    return { parentNode: parent, edge };
  }
}
