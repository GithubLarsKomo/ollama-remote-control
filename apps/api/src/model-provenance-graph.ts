import { createHash } from 'node:crypto';
import { canonicalOllamaModelName } from '@orc/core/modelfile-deploy';
import type { DatabaseConnection } from '@orc/db';

const MAX_EVIDENCE_ROWS = 50;
const SHA256 = /^[a-f0-9]{64}$/u;

export type ModelProvenanceEvidence = 'persisted-import' | 'verified-create';
export type ModelProvenanceRelation = 'captured-as-revision' | 'created-from-revision' | 'base-model';

export type ModelProvenanceNode =
  | {
      readonly id: string;
      readonly kind: 'installed-model';
      readonly model: string;
      readonly digest: string;
    }
  | {
      readonly id: string;
      readonly kind: 'modelfile-revision';
      readonly modelfileId: string;
      readonly revisionId: string;
      readonly revisionNumber: number;
      readonly revisionSha256: string;
      readonly displayName: string;
    }
  | {
      readonly id: string;
      readonly kind: 'model-reference';
      readonly model: string;
    };

export interface ModelProvenanceEdge {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly relation: ModelProvenanceRelation;
  readonly evidence: ModelProvenanceEvidence;
  readonly observedAt: string;
  readonly jobId: string | null;
}

export interface ModelProvenanceGraph {
  readonly currentNodeId: string;
  readonly nodes: readonly ModelProvenanceNode[];
  readonly edges: readonly ModelProvenanceEdge[];
}

interface ImportEvidenceRow {
  readonly revisionId: string;
  readonly modelfileId: string;
  readonly revisionNumber: number;
  readonly revisionSha256: string;
  readonly displayName: string;
  readonly importedModel: string;
  readonly importedDigest: string;
  readonly createdAt: string;
}

interface CreateEvidenceRow {
  readonly jobId: string;
  readonly resultJson: string;
  readonly finishedAt: string;
}

interface RevisionEvidenceRow {
  readonly revisionId: string;
  readonly modelfileId: string;
  readonly revisionNumber: number;
  readonly revisionSha256: string;
  readonly displayName: string;
}

export interface ModelProvenanceEvidenceStore {
  listImports(targetId: string, digest: string): readonly ImportEvidenceRow[];
  listSuccessfulCreates(targetId: string): readonly CreateEvidenceRow[];
  findRevision(revisionId: string, modelfileId: string, revisionSha256: string): RevisionEvidenceRow | null;
}

function text(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null;
  const result = value.trim();
  if (!result || result.length > maxLength || /[\u0000-\u001f\u007f]/u.test(result)) return null;
  return result;
}

function model(value: unknown): string | null {
  const valueText = text(value, 512);
  if (!valueText || !/^[A-Za-z0-9][A-Za-z0-9._/:@+-]*$/u.test(valueText)) return null;
  try { return canonicalOllamaModelName(valueText); }
  catch { return null; }
}

function hashNodeId(prefix: string, value: string): string {
  return `${prefix}:${createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 24)}`;
}

function parseCreateResult(row: CreateEvidenceRow): {
  readonly outputModel: string;
  readonly baseModel: string;
  readonly digest: string;
  readonly modelfileId: string;
  readonly revisionId: string;
  readonly revisionSha256: string;
} | null {
  let parsed: unknown;
  try { parsed = JSON.parse(row.resultJson); }
  catch { return null; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const object = parsed as Record<string, unknown>;
  if (object.verified !== true) return null;
  const outputModel = model(object.outputModel);
  const baseModel = model(object.baseModel);
  const digest = text(object.digest, 64);
  const modelfileId = text(object.modelfileId, 256);
  const revisionId = text(object.revisionId, 256);
  const revisionSha256 = text(object.revisionSha256, 64);
  if (!outputModel || !baseModel || !digest || !SHA256.test(digest) || !modelfileId || !revisionId || !revisionSha256 || !SHA256.test(revisionSha256)) return null;
  return { outputModel, baseModel, digest, modelfileId, revisionId, revisionSha256 };
}

export class SqliteModelProvenanceEvidenceStore implements ModelProvenanceEvidenceStore {
  constructor(private readonly database: DatabaseConnection) {}

  listImports(targetId: string, digest: string): readonly ImportEvidenceRow[] {
    return this.database.prepare(`
      SELECT
        revision.id AS revisionId,
        revision.modelfile_id AS modelfileId,
        revision.revision_number AS revisionNumber,
        revision.content_sha256 AS revisionSha256,
        artifact.display_name AS displayName,
        revision.imported_model AS importedModel,
        revision.imported_digest AS importedDigest,
        revision.created_at AS createdAt
      FROM modelfile_revisions revision
      JOIN modelfiles artifact ON artifact.id = revision.modelfile_id
      WHERE revision.source_kind = 'installed-model-import'
        AND revision.imported_target_id = ?
        AND revision.imported_digest = ?
      ORDER BY revision.created_at DESC, revision.id DESC
      LIMIT ${MAX_EVIDENCE_ROWS}
    `).all(targetId, digest).map((row) => ({
      revisionId: String(row.revisionId),
      modelfileId: String(row.modelfileId),
      revisionNumber: Number(row.revisionNumber),
      revisionSha256: String(row.revisionSha256),
      displayName: String(row.displayName),
      importedModel: String(row.importedModel),
      importedDigest: String(row.importedDigest),
      createdAt: String(row.createdAt),
    }));
  }

  listSuccessfulCreates(targetId: string): readonly CreateEvidenceRow[] {
    return this.database.prepare(`
      SELECT id AS jobId, result_json AS resultJson, finished_at AS finishedAt
      FROM jobs
      WHERE target_id = ?
        AND kind = 'model-create'
        AND state = 'succeeded'
        AND result_json IS NOT NULL
        AND finished_at IS NOT NULL
      ORDER BY finished_at DESC, id DESC
      LIMIT ${MAX_EVIDENCE_ROWS}
    `).all(targetId).map((row) => ({
      jobId: String(row.jobId),
      resultJson: String(row.resultJson),
      finishedAt: String(row.finishedAt),
    }));
  }

  findRevision(revisionId: string, modelfileId: string, revisionSha256: string): RevisionEvidenceRow | null {
    const row = this.database.prepare(`
      SELECT
        revision.id AS revisionId,
        revision.modelfile_id AS modelfileId,
        revision.revision_number AS revisionNumber,
        revision.content_sha256 AS revisionSha256,
        artifact.display_name AS displayName
      FROM modelfile_revisions revision
      JOIN modelfiles artifact ON artifact.id = revision.modelfile_id
      WHERE revision.id = ?
        AND revision.modelfile_id = ?
        AND revision.content_sha256 = ?
      LIMIT 1
    `).get(revisionId, modelfileId, revisionSha256);
    if (!row) return null;
    return {
      revisionId: String(row.revisionId),
      modelfileId: String(row.modelfileId),
      revisionNumber: Number(row.revisionNumber),
      revisionSha256: String(row.revisionSha256),
      displayName: String(row.displayName),
    };
  }
}

function addRevisionNode(nodes: Map<string, ModelProvenanceNode>, revision: RevisionEvidenceRow): string {
  const id = `revision:${revision.revisionId}`;
  if (!nodes.has(id)) {
    nodes.set(id, {
      id,
      kind: 'modelfile-revision',
      modelfileId: revision.modelfileId,
      revisionId: revision.revisionId,
      revisionNumber: revision.revisionNumber,
      revisionSha256: revision.revisionSha256,
      displayName: revision.displayName,
    });
  }
  return id;
}

function addModelReferenceNode(nodes: Map<string, ModelProvenanceNode>, modelName: string): string {
  const id = hashNodeId('model-reference', modelName);
  if (!nodes.has(id)) nodes.set(id, { id, kind: 'model-reference', model: modelName });
  return id;
}

export function buildModelProvenanceGraph(
  store: ModelProvenanceEvidenceStore,
  input: { readonly targetId: string; readonly model: string; readonly digest: string },
): ModelProvenanceGraph {
  const canonicalModel = canonicalOllamaModelName(input.model);
  if (!SHA256.test(input.digest)) throw new Error('Current model digest must be a lowercase SHA-256 hex string.');

  const currentNodeId = `installed:${input.digest}`;
  const nodes = new Map<string, ModelProvenanceNode>([[currentNodeId, {
    id: currentNodeId,
    kind: 'installed-model',
    model: canonicalModel,
    digest: input.digest,
  }]]);
  const edges: ModelProvenanceEdge[] = [];

  for (const imported of store.listImports(input.targetId, input.digest)) {
    if (
      !Number.isSafeInteger(imported.revisionNumber)
      || imported.revisionNumber < 1
      || !SHA256.test(imported.revisionSha256)
      || imported.importedDigest !== input.digest
      || model(imported.importedModel) !== canonicalModel
      || !text(imported.createdAt, 80)
    ) continue;
    const revisionId = addRevisionNode(nodes, imported);
    edges.push({
      id: `import:${imported.revisionId}`,
      from: currentNodeId,
      to: revisionId,
      relation: 'captured-as-revision',
      evidence: 'persisted-import',
      observedAt: imported.createdAt,
      jobId: null,
    });
  }

  for (const row of store.listSuccessfulCreates(input.targetId)) {
    const result = parseCreateResult(row);
    if (!result || result.outputModel !== canonicalModel || result.digest !== input.digest || !text(row.finishedAt, 80)) continue;
    const revision = store.findRevision(result.revisionId, result.modelfileId, result.revisionSha256);
    if (!revision || !Number.isSafeInteger(revision.revisionNumber) || revision.revisionNumber < 1) continue;
    const revisionNodeId = addRevisionNode(nodes, revision);
    edges.push({
      id: `create:${row.jobId}:revision`,
      from: revisionNodeId,
      to: currentNodeId,
      relation: 'created-from-revision',
      evidence: 'verified-create',
      observedAt: row.finishedAt,
      jobId: row.jobId,
    });
    const baseNodeId = addModelReferenceNode(nodes, result.baseModel);
    edges.push({
      id: `create:${row.jobId}:base`,
      from: baseNodeId,
      to: currentNodeId,
      relation: 'base-model',
      evidence: 'verified-create',
      observedAt: row.finishedAt,
      jobId: row.jobId,
    });
  }

  return {
    currentNodeId,
    nodes: [...nodes.values()],
    edges,
  };
}
