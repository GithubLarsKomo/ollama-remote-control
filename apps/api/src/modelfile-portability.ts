import { createHash, randomUUID } from 'node:crypto';
import type {
  ModelfileRepository,
  StoredModelfileArtifact,
  StoredModelfileRevision,
} from '@orc/core/modelfiles';
import { AuditService } from './audit.js';

const MAX_NAME_LENGTH = 160;
const MAX_DESCRIPTION_LENGTH = 2_000;

export class ModelfilePortabilityError extends Error {
  constructor(
    readonly code: string,
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

export interface CloneModelfileInput {
  readonly displayName?: unknown;
  readonly description?: unknown;
}

export interface ClonedModelfileView {
  readonly id: string;
  readonly displayName: string;
  readonly description: string | null;
  readonly currentRevisionId: string;
  readonly currentRevisionNumber: 1;
  readonly currentSourceKind: 'manual';
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly currentRevision: StoredModelfileRevision;
}

function sha256(rawText: string): string {
  return createHash('sha256').update(rawText, 'utf8').digest('hex');
}

function normalizeName(value: unknown): string {
  if (typeof value !== 'string') {
    throw new ModelfilePortabilityError('INVALID_MODEFILE_NAME', 400, 'Clone display name is required.');
  }
  const name = value.trim();
  if (!name || name.length > MAX_NAME_LENGTH || /[\u0000-\u001f\u007f]/u.test(name)) {
    throw new ModelfilePortabilityError('INVALID_MODEFILE_NAME', 400, 'Clone display name is invalid.');
  }
  return name;
}

function normalizeDescription(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > MAX_DESCRIPTION_LENGTH || /[\u0000\u007f]/u.test(value)) {
    throw new ModelfilePortabilityError('INVALID_MODEFILE_DESCRIPTION', 400, 'Clone description is invalid.');
  }
  return value;
}

function view(artifact: StoredModelfileArtifact, revision: StoredModelfileRevision): ClonedModelfileView {
  return {
    id: artifact.id,
    displayName: artifact.displayName,
    description: artifact.description,
    currentRevisionId: artifact.currentRevisionId,
    currentRevisionNumber: 1,
    currentSourceKind: 'manual',
    createdAt: artifact.createdAt,
    updatedAt: artifact.updatedAt,
    currentRevision: revision,
  };
}

export class ModelfilePortabilityService {
  constructor(
    private readonly repository: ModelfileRepository,
    private readonly audit: AuditService,
    private readonly now: () => Date = () => new Date(),
  ) {}

  clone(
    actorUserId: string,
    sourceModelfileId: string,
    sourceRevisionId: string,
    input: CloneModelfileInput,
  ): ClonedModelfileView {
    const sourceArtifact = this.repository.findById(sourceModelfileId);
    if (!sourceArtifact) throw new ModelfilePortabilityError('MODEFILE_NOT_FOUND', 404, 'Source Modelfile was not found.');
    const sourceRevision = this.repository.findRevisionById(sourceRevisionId);
    if (!sourceRevision || sourceRevision.modelfileId !== sourceModelfileId) {
      throw new ModelfilePortabilityError('MODEFILE_REVISION_NOT_FOUND', 404, 'Source Modelfile revision was not found.');
    }

    const displayName = normalizeName(input?.displayName);
    const description = normalizeDescription(input?.description);
    const timestamp = this.now().toISOString();
    const artifactId = randomUUID();
    const revisionId = randomUUID();
    const revision: StoredModelfileRevision = {
      id: revisionId,
      modelfileId: artifactId,
      revisionNumber: 1,
      parentRevisionId: null,
      rawText: sourceRevision.rawText,
      contentSha256: sha256(sourceRevision.rawText),
      sourceKind: 'manual',
      importedTargetId: null,
      importedModel: null,
      importedDigest: null,
      createdByUserId: actorUserId,
      createdAt: timestamp,
    };
    const artifact: StoredModelfileArtifact = {
      id: artifactId,
      displayName,
      description,
      currentRevisionId: revisionId,
      createdByUserId: actorUserId,
      updatedByUserId: actorUserId,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    if (!this.repository.createWithInitialRevision(artifact, revision)) {
      throw new ModelfilePortabilityError('MODEFILE_CREATE_FAILED', 500, 'Cloned Modelfile could not be persisted.');
    }

    this.audit.record({
      actorUserId,
      action: 'modelfile.cloned',
      parameters: {
        modelfileId: artifactId,
        revisionId,
        sourceModelfileId,
        sourceRevisionId,
        sourceRevisionSha256: sourceRevision.contentSha256,
        sourceRevisionNumber: sourceRevision.revisionNumber,
      },
      result: 'created',
    });
    return view(artifact, revision);
  }
}
