import { createHash, randomUUID } from 'node:crypto';
import type {
  ModelfileRepository,
  ModelfileSourceKind,
  StoredModelfileArtifact,
  StoredModelfileRevision,
} from '@orc/core/modelfiles';
import { AuditService } from './audit.js';
import type { OllamaModelDetailResult } from './ollama-model-details.js';

const MAX_DISPLAY_NAME = 160;
const MAX_DESCRIPTION = 1000;
const MAX_MODEFILE_BYTES = 512 * 1024;
const MAX_REMOTE_MODEL_NAME = 512;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export interface ModelDetailReader {
  read(targetId: string, requestedModel: unknown): Promise<OllamaModelDetailResult>;
}

export interface ModelfileSummaryView {
  readonly id: string;
  readonly displayName: string;
  readonly description: string | null;
  readonly currentRevisionId: string;
  readonly currentRevisionNumber: number;
  readonly currentSourceKind: ModelfileSourceKind;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ModelfileRevisionSummaryView {
  readonly id: string;
  readonly revisionNumber: number;
  readonly parentRevisionId: string | null;
  readonly contentSha256: string;
  readonly sourceKind: ModelfileSourceKind;
  readonly importedTargetId: string | null;
  readonly importedModel: string | null;
  readonly importedDigest: string | null;
  readonly createdAt: string;
}

export interface ModelfileRevisionView extends ModelfileRevisionSummaryView {
  readonly rawText: string;
}

export interface ModelfileView extends ModelfileSummaryView {
  readonly currentRevision: ModelfileRevisionView;
}

export interface CreateModelfileInput {
  readonly displayName?: unknown;
  readonly description?: unknown;
  readonly rawText?: unknown;
}

export interface AppendModelfileRevisionInput {
  readonly expectedCurrentRevisionId?: unknown;
  readonly rawText?: unknown;
}

export interface ImportInstalledModelfileInput {
  readonly targetId?: unknown;
  readonly model?: unknown;
  readonly displayName?: unknown;
  readonly description?: unknown;
}

export class ModelfileLibraryError extends Error {
  constructor(
    readonly code: string,
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

function sha256(rawText: string): string {
  return createHash('sha256').update(rawText, 'utf8').digest('hex');
}

function validateId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new ModelfileLibraryError('INVALID_MODEFILE_ID', 400, `${label} is invalid.`);
  }
  return value.toLowerCase();
}

function validateDisplayName(value: unknown): string {
  if (typeof value !== 'string') {
    throw new ModelfileLibraryError('INVALID_MODEFILE_NAME', 400, 'Modelfile display name is required.');
  }
  const text = value.trim();
  if (!text || text.length > MAX_DISPLAY_NAME || /[\u0000-\u001f\u007f]/u.test(text)) {
    throw new ModelfileLibraryError('INVALID_MODEFILE_NAME', 400, `Modelfile display name must be 1-${MAX_DISPLAY_NAME} visible characters.`);
  }
  return text;
}

function validateDescription(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') {
    throw new ModelfileLibraryError('INVALID_MODEFILE_DESCRIPTION', 400, 'Modelfile description must be text.');
  }
  const text = value.trim();
  if (text.length > MAX_DESCRIPTION || /[\u0000\u007f]/u.test(text)) {
    throw new ModelfileLibraryError('INVALID_MODEFILE_DESCRIPTION', 400, `Modelfile description must be at most ${MAX_DESCRIPTION} characters.`);
  }
  return text || null;
}

function validateRawText(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ModelfileLibraryError('INVALID_MODEFILE_TEXT', 400, 'Modelfile raw text is required.');
  }
  if (value.includes('\u0000') || Buffer.byteLength(value, 'utf8') > MAX_MODEFILE_BYTES) {
    throw new ModelfileLibraryError('INVALID_MODEFILE_TEXT', 400, `Modelfile raw text must be at most ${MAX_MODEFILE_BYTES} UTF-8 bytes and contain no NUL characters.`);
  }
  return value;
}

function validateTargetId(value: unknown): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 256 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new ModelfileLibraryError('INVALID_TARGET_ID', 400, 'Target ID is invalid.');
  }
  return value;
}

function validateRemoteModel(value: unknown): string {
  if (
    typeof value !== 'string'
    || value.length < 1
    || value.length > MAX_REMOTE_MODEL_NAME
    || !/^[A-Za-z0-9][A-Za-z0-9._/:@+-]*$/u.test(value)
  ) {
    throw new ModelfileLibraryError('INVALID_MODEL_NAME', 400, 'Installed model name is invalid.');
  }
  return value;
}

function defaultImportedDisplayName(model: string): string {
  if (model.length <= MAX_DISPLAY_NAME) return model;
  return `${model.slice(0, MAX_DISPLAY_NAME - 1)}…`;
}

function revisionSummary(revision: StoredModelfileRevision): ModelfileRevisionSummaryView {
  return {
    id: revision.id,
    revisionNumber: revision.revisionNumber,
    parentRevisionId: revision.parentRevisionId,
    contentSha256: revision.contentSha256,
    sourceKind: revision.sourceKind,
    importedTargetId: revision.importedTargetId,
    importedModel: revision.importedModel,
    importedDigest: revision.importedDigest,
    createdAt: revision.createdAt,
  };
}

function revisionView(revision: StoredModelfileRevision): ModelfileRevisionView {
  return { ...revisionSummary(revision), rawText: revision.rawText };
}

function summaryView(artifact: StoredModelfileArtifact, current: StoredModelfileRevision): ModelfileSummaryView {
  return {
    id: artifact.id,
    displayName: artifact.displayName,
    description: artifact.description,
    currentRevisionId: artifact.currentRevisionId,
    currentRevisionNumber: current.revisionNumber,
    currentSourceKind: current.sourceKind,
    createdAt: artifact.createdAt,
    updatedAt: artifact.updatedAt,
  };
}

export class ModelfileLibraryService {
  constructor(
    private readonly repository: ModelfileRepository,
    private readonly audit: AuditService,
    private readonly modelDetails: ModelDetailReader,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private currentFor(artifact: StoredModelfileArtifact): StoredModelfileRevision {
    const revision = this.repository.findRevisionById(artifact.currentRevisionId);
    if (!revision || revision.modelfileId !== artifact.id) {
      throw new ModelfileLibraryError('MODEFILE_INTEGRITY_ERROR', 500, 'Stored Modelfile current revision is inconsistent.');
    }
    return revision;
  }

  private buildInitial(
    actorUserId: string,
    displayName: string,
    description: string | null,
    rawText: string,
    source: {
      readonly kind: ModelfileSourceKind;
      readonly targetId: string | null;
      readonly model: string | null;
      readonly digest: string | null;
    },
  ): { artifact: StoredModelfileArtifact; revision: StoredModelfileRevision } {
    const timestamp = this.now().toISOString();
    const artifactId = randomUUID();
    const revisionId = randomUUID();
    return {
      artifact: {
        id: artifactId,
        displayName,
        description,
        currentRevisionId: revisionId,
        createdByUserId: actorUserId,
        updatedByUserId: actorUserId,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      revision: {
        id: revisionId,
        modelfileId: artifactId,
        revisionNumber: 1,
        parentRevisionId: null,
        rawText,
        contentSha256: sha256(rawText),
        sourceKind: source.kind,
        importedTargetId: source.targetId,
        importedModel: source.model,
        importedDigest: source.digest,
        createdByUserId: actorUserId,
        createdAt: timestamp,
      },
    };
  }

  list(): readonly ModelfileSummaryView[] {
    return this.repository.list().map((artifact) => summaryView(artifact, this.currentFor(artifact)));
  }

  read(modelfileId: unknown): ModelfileView {
    const id = validateId(modelfileId, 'Modelfile ID');
    const artifact = this.repository.findById(id);
    if (!artifact) throw new ModelfileLibraryError('MODEFILE_NOT_FOUND', 404, 'Local Modelfile was not found.');
    const current = this.currentFor(artifact);
    return { ...summaryView(artifact, current), currentRevision: revisionView(current) };
  }

  listRevisions(modelfileId: unknown): readonly ModelfileRevisionSummaryView[] {
    const id = validateId(modelfileId, 'Modelfile ID');
    if (!this.repository.findById(id)) throw new ModelfileLibraryError('MODEFILE_NOT_FOUND', 404, 'Local Modelfile was not found.');
    return this.repository.listRevisions(id).map(revisionSummary);
  }

  readRevision(modelfileId: unknown, revisionId: unknown): ModelfileRevisionView {
    const artifactId = validateId(modelfileId, 'Modelfile ID');
    const id = validateId(revisionId, 'Revision ID');
    const revision = this.repository.findRevisionById(id);
    if (!revision || revision.modelfileId !== artifactId) {
      throw new ModelfileLibraryError('MODEFILE_REVISION_NOT_FOUND', 404, 'Modelfile revision was not found.');
    }
    return revisionView(revision);
  }

  createManual(actorUserId: string, input: CreateModelfileInput): ModelfileView {
    const displayName = validateDisplayName(input?.displayName);
    const description = validateDescription(input?.description);
    const rawText = validateRawText(input?.rawText);
    const created = this.buildInitial(actorUserId, displayName, description, rawText, {
      kind: 'manual', targetId: null, model: null, digest: null,
    });
    if (!this.repository.createWithInitialRevision(created.artifact, created.revision)) {
      throw new ModelfileLibraryError('MODEFILE_CREATE_CONFLICT', 409, 'Local Modelfile could not be created because its generated identity already exists.');
    }
    this.audit.record({
      actorUserId,
      action: 'modelfile.create',
      parameters: {
        modelfileId: created.artifact.id,
        revisionId: created.revision.id,
        contentSha256: created.revision.contentSha256,
        sourceKind: created.revision.sourceKind,
      },
      result: 'succeeded',
    });
    return { ...summaryView(created.artifact, created.revision), currentRevision: revisionView(created.revision) };
  }

  append(actorUserId: string, modelfileId: unknown, input: AppendModelfileRevisionInput): ModelfileView {
    const id = validateId(modelfileId, 'Modelfile ID');
    const expectedCurrentRevisionId = validateId(input?.expectedCurrentRevisionId, 'Expected current revision ID');
    const rawText = validateRawText(input?.rawText);
    const artifact = this.repository.findById(id);
    if (!artifact) throw new ModelfileLibraryError('MODEFILE_NOT_FOUND', 404, 'Local Modelfile was not found.');
    if (artifact.currentRevisionId !== expectedCurrentRevisionId) {
      throw new ModelfileLibraryError('MODEFILE_REVISION_CONFLICT', 409, 'Local Modelfile changed since the supplied base revision.');
    }
    const current = this.currentFor(artifact);
    const timestamp = this.now().toISOString();
    const revision: StoredModelfileRevision = {
      id: randomUUID(),
      modelfileId: artifact.id,
      revisionNumber: current.revisionNumber + 1,
      parentRevisionId: current.id,
      rawText,
      contentSha256: sha256(rawText),
      sourceKind: 'manual',
      importedTargetId: null,
      importedModel: null,
      importedDigest: null,
      createdByUserId: actorUserId,
      createdAt: timestamp,
    };
    if (!this.repository.appendRevision(artifact.id, expectedCurrentRevisionId, revision, timestamp, actorUserId)) {
      throw new ModelfileLibraryError('MODEFILE_REVISION_CONFLICT', 409, 'Local Modelfile changed before the new revision could be committed.');
    }
    const updated = this.repository.findById(artifact.id);
    if (!updated) throw new ModelfileLibraryError('MODEFILE_INTEGRITY_ERROR', 500, 'Stored Modelfile disappeared after revision commit.');
    this.audit.record({
      actorUserId,
      action: 'modelfile.revision.create',
      parameters: {
        modelfileId: artifact.id,
        revisionId: revision.id,
        parentRevisionId: revision.parentRevisionId,
        contentSha256: revision.contentSha256,
        sourceKind: revision.sourceKind,
      },
      result: 'succeeded',
    });
    return { ...summaryView(updated, revision), currentRevision: revisionView(revision) };
  }

  async importInstalled(actorUserId: string, input: ImportInstalledModelfileInput): Promise<ModelfileView> {
    const targetId = validateTargetId(input?.targetId);
    const requestedModel = validateRemoteModel(input?.model);
    const description = validateDescription(input?.description);
    const detail = await this.modelDetails.read(targetId, requestedModel);
    if (!detail.modelfile) {
      throw new ModelfileLibraryError('MODEFILE_IMPORT_UNAVAILABLE', 409, 'Installed model does not expose a generated Modelfile that can be imported.');
    }
    const rawText = validateRawText(detail.modelfile);
    const displayName = input?.displayName === undefined || input.displayName === null || input.displayName === ''
      ? defaultImportedDisplayName(detail.identity.model)
      : validateDisplayName(input.displayName);
    const created = this.buildInitial(actorUserId, displayName, description, rawText, {
      kind: 'installed-model-import',
      targetId: detail.targetId,
      model: detail.identity.model,
      digest: detail.identity.digest,
    });
    if (!this.repository.createWithInitialRevision(created.artifact, created.revision)) {
      throw new ModelfileLibraryError('MODEFILE_CREATE_CONFLICT', 409, 'Imported Modelfile could not be created because its generated identity already exists.');
    }
    this.audit.record({
      actorUserId,
      targetId: detail.targetId,
      action: 'modelfile.import-installed',
      parameters: {
        modelfileId: created.artifact.id,
        revisionId: created.revision.id,
        model: detail.identity.model,
        digest: detail.identity.digest,
        contentSha256: created.revision.contentSha256,
      },
      result: 'succeeded',
    });
    return { ...summaryView(created.artifact, created.revision), currentRevision: revisionView(created.revision) };
  }
}
