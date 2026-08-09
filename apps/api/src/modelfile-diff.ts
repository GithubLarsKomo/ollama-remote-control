import type {
  ModelfileRepository,
  StoredModelfileRevision,
} from '@orc/core/modelfiles';
import {
  diffModelfileText,
  type ModelfileTextDiff,
} from '@orc/core/modelfile-diff';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export interface ModelfileDiffRevisionIdentity {
  readonly id: string;
  readonly revisionNumber: number;
  readonly contentSha256: string;
  readonly sourceKind: StoredModelfileRevision['sourceKind'];
  readonly importedTargetId: string | null;
  readonly importedModel: string | null;
  readonly importedDigest: string | null;
  readonly createdAt: string;
}

export interface ModelfileRevisionDiffView {
  readonly modelfileId: string;
  readonly from: ModelfileDiffRevisionIdentity;
  readonly to: ModelfileDiffRevisionIdentity;
  readonly diff: ModelfileTextDiff;
}

export class ModelfileDiffError extends Error {
  constructor(
    readonly code: string,
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

function validateId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new ModelfileDiffError('INVALID_MODEFILE_DIFF_ID', 400, `${label} is invalid.`);
  }
  return value.toLowerCase();
}

function identity(revision: StoredModelfileRevision): ModelfileDiffRevisionIdentity {
  return {
    id: revision.id,
    revisionNumber: revision.revisionNumber,
    contentSha256: revision.contentSha256,
    sourceKind: revision.sourceKind,
    importedTargetId: revision.importedTargetId,
    importedModel: revision.importedModel,
    importedDigest: revision.importedDigest,
    createdAt: revision.createdAt,
  };
}

export class ModelfileDiffService {
  constructor(private readonly repository: ModelfileRepository) {}

  compare(
    modelfileIdValue: unknown,
    fromRevisionIdValue: unknown,
    toRevisionIdValue: unknown,
  ): ModelfileRevisionDiffView {
    const modelfileId = validateId(modelfileIdValue, 'Modelfile ID');
    const fromRevisionId = validateId(fromRevisionIdValue, 'From revision ID');
    const toRevisionId = validateId(toRevisionIdValue, 'To revision ID');

    if (!this.repository.findById(modelfileId)) {
      throw new ModelfileDiffError('MODEFILE_NOT_FOUND', 404, 'Local Modelfile was not found.');
    }
    const from = this.repository.findRevisionById(fromRevisionId);
    const to = this.repository.findRevisionById(toRevisionId);
    if (!from || from.modelfileId !== modelfileId) {
      throw new ModelfileDiffError('MODEFILE_REVISION_NOT_FOUND', 404, 'From revision was not found for this Modelfile.');
    }
    if (!to || to.modelfileId !== modelfileId) {
      throw new ModelfileDiffError('MODEFILE_REVISION_NOT_FOUND', 404, 'To revision was not found for this Modelfile.');
    }

    return {
      modelfileId,
      from: identity(from),
      to: identity(to),
      diff: diffModelfileText(from.rawText, to.rawText),
    };
  }
}
