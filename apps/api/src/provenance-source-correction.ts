import { randomUUID } from 'node:crypto';
import type {
  ProvenanceConfidence,
  ProvenanceSourceKind,
  StoredProvenanceNode,
  StoredProvenanceSource,
} from '@orc/core/provenance';
import type { DatabaseConnection } from '@orc/db';
import { SqliteProvenanceRepository } from '@orc/db/provenance';
import type { AuditService } from './audit.js';

export interface ProvenanceSourceCorrectionInput {
  readonly sourceKind?: unknown;
  readonly sourceReference?: unknown;
  readonly confidence?: unknown;
  readonly note?: unknown;
  readonly supersedesSourceId?: unknown;
}

export class ProvenanceSourceCorrectionError extends Error {
  constructor(
    readonly code: string,
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

const SOURCE_KINDS = new Set<ProvenanceSourceKind>(['huggingface', 'ollama', 'url', 'unknown']);
const KNOWN_CONFIDENCE = new Set<ProvenanceConfidence>(['high', 'medium', 'low']);

function optionalBoundedText(value: unknown, max: number, label: string): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new ProvenanceSourceCorrectionError('PROVENANCE_CORRECTION_INVALID', 400, `${label} must be text.`);
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max || /[\u0000-\u001f\u007f]/u.test(trimmed)) {
    throw new ProvenanceSourceCorrectionError('PROVENANCE_CORRECTION_INVALID', 400, `${label} is invalid.`);
  }
  return trimmed;
}

function parseSourceKind(value: unknown): ProvenanceSourceKind {
  if (typeof value !== 'string' || !SOURCE_KINDS.has(value as ProvenanceSourceKind)) {
    throw new ProvenanceSourceCorrectionError('PROVENANCE_CORRECTION_INVALID', 400, 'Source kind is invalid.');
  }
  return value as ProvenanceSourceKind;
}

function parseCorrection(input: ProvenanceSourceCorrectionInput): {
  sourceKind: ProvenanceSourceKind;
  sourceReference: string | null;
  confidence: ProvenanceConfidence;
  note: string | null;
  supersedesSourceId: string | null;
} {
  const sourceKind = parseSourceKind(input.sourceKind);
  const sourceReference = optionalBoundedText(input.sourceReference, 2048, 'Source reference');
  const note = optionalBoundedText(input.note, 1024, 'Note');
  const supersedesSourceId = optionalBoundedText(input.supersedesSourceId, 256, 'Superseded source ID');

  if (sourceKind === 'unknown') {
    if (sourceReference !== null) {
      throw new ProvenanceSourceCorrectionError('PROVENANCE_CORRECTION_INVALID', 400, 'Unknown source must not include a reference.');
    }
    if (input.confidence !== undefined && input.confidence !== null && input.confidence !== 'unknown') {
      throw new ProvenanceSourceCorrectionError('PROVENANCE_CORRECTION_INVALID', 400, 'Unknown source requires unknown confidence.');
    }
    return { sourceKind, sourceReference: null, confidence: 'unknown', note, supersedesSourceId };
  }

  if (sourceReference === null) {
    throw new ProvenanceSourceCorrectionError('PROVENANCE_CORRECTION_INVALID', 400, 'Known source requires an HTTPS reference.');
  }
  if (typeof input.confidence !== 'string' || !KNOWN_CONFIDENCE.has(input.confidence as ProvenanceConfidence)) {
    throw new ProvenanceSourceCorrectionError('PROVENANCE_CORRECTION_INVALID', 400, 'Known source confidence must be high, medium, or low.');
  }
  return { sourceKind, sourceReference, confidence: input.confidence as ProvenanceConfidence, note, supersedesSourceId };
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

export class ProvenanceSourceCorrectionService {
  private readonly repository: SqliteProvenanceRepository;

  constructor(
    private readonly database: DatabaseConnection,
    private readonly audit: AuditService,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.repository = new SqliteProvenanceRepository(database);
  }

  correct(actorUserId: string, nodeId: string, input: ProvenanceSourceCorrectionInput): StoredProvenanceSource {
    const node = mapNode(this.database.prepare(`
      SELECT id, identity_key, kind, target_id, model_name, model_digest, revision_id, created_at
      FROM provenance_nodes WHERE id = ?
    `).get(nodeId));
    if (!node) throw new ProvenanceSourceCorrectionError('PROVENANCE_NODE_NOT_FOUND', 404, 'Persisted provenance node was not found.');
    if (node.kind !== 'installed-model' || !node.targetId || !node.modelName || !node.modelDigest) {
      throw new ProvenanceSourceCorrectionError('PROVENANCE_NODE_NOT_CORRECTABLE', 409, 'Only persisted installed-model nodes can receive manual source corrections.');
    }

    const correction = parseCorrection(input);
    const current = this.database.prepare(`
      SELECT source.id
      FROM provenance_sources source
      WHERE source.subject_kind = 'installed-model'
        AND source.target_id = ? AND source.model_name = ? AND source.model_digest = ?
        AND NOT EXISTS (
          SELECT 1 FROM provenance_sources newer WHERE newer.supersedes_source_id = source.id
        )
      ORDER BY source.created_at DESC, source.id DESC
      LIMIT 1
    `).get(node.targetId, node.modelName, node.modelDigest);
    const currentId = current ? String(current.id) : null;
    if (correction.supersedesSourceId !== currentId) {
      throw new ProvenanceSourceCorrectionError(
        'PROVENANCE_CORRECTION_STALE',
        409,
        'Source evidence changed; reload the current provenance before correcting it.',
      );
    }

    const source: StoredProvenanceSource = {
      id: randomUUID(),
      subjectKind: 'installed-model',
      targetId: node.targetId,
      modelName: node.modelName,
      modelDigest: node.modelDigest,
      revisionId: null,
      sourceKind: correction.sourceKind,
      sourceReference: correction.sourceReference,
      origin: 'operator',
      confidence: correction.confidence,
      actorUserId,
      supersedesSourceId: currentId,
      note: correction.note,
      createdAt: this.now().toISOString(),
    };

    this.repository.appendSource(source);
    this.audit.record({
      actorUserId,
      targetId: node.targetId,
      action: 'provenance.source.correct',
      parameters: {
        nodeId: node.id,
        sourceKind: source.sourceKind,
        confidence: source.confidence,
        supersedesSourceId: source.supersedesSourceId,
        hasReference: source.sourceReference !== null,
        hasNote: source.note !== null,
      },
      result: 'succeeded',
    });
    return source;
  }
}
