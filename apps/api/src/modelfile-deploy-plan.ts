import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { OllamaTargetRepository } from '@orc/core';
import {
  compileModelfileForDeploy,
  ModelfileDeployCompileError,
  type CompiledModelfileDeploy,
} from '@orc/core/modelfile-deploy';
import type {
  ModelfileDeployPlanRepository,
  StoredModelfileDeployPlan,
} from '@orc/core/modelfile-deploy-plans';
import type { ModelfileRepository } from '@orc/core/modelfiles';
import { AuditService } from './audit.js';
import type { OllamaHealthResult } from './ollama-health.js';
import type { InstalledOllamaModelView, OllamaModelInventoryResult } from './ollama-models.js';

const PLAN_TTL_MS = 5 * 60_000;
const MAX_MODEL_NAME = 512;
const MODEL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/:@+-]*$/u;

export interface ModelfileDeployPlanView {
  readonly planId: string;
  readonly confirmationToken: string;
  readonly targetId: string;
  readonly selectedContainerId: string;
  readonly modelfileId: string;
  readonly revisionId: string;
  readonly revisionSha256: string;
  readonly outputModel: string;
  readonly baseModel: string;
  readonly replacement: null | {
    readonly existingDigest: string;
    readonly existingSizeBytes: number;
  };
  readonly apiVersion: string;
  readonly directiveCounts: Readonly<Record<string, number>>;
  readonly expectedFields: readonly string[];
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface CreateModelfileDeployPlanInput {
  readonly outputModel?: unknown;
  readonly replaceExisting?: unknown;
}

interface HealthReader {
  read(targetId: string): Promise<OllamaHealthResult>;
}

interface InventoryReader {
  read(targetId: string): Promise<OllamaModelInventoryResult>;
}

export class ModelfileDeployPlanError extends Error {
  constructor(
    readonly code: string,
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function canonicalModelName(value: string): string {
  const slash = value.lastIndexOf('/');
  const colon = value.lastIndexOf(':');
  return colon > slash ? value : `${value}:latest`;
}

function outputModel(value: unknown): string {
  if (typeof value !== 'string') {
    throw new ModelfileDeployPlanError('DEPLOY_OUTPUT_MODEL_REQUIRED', 400, 'Destination model name is required.');
  }
  const text = value.trim();
  if (!text || text.length > MAX_MODEL_NAME || !MODEL_NAME_PATTERN.test(text)) {
    throw new ModelfileDeployPlanError('DEPLOY_OUTPUT_MODEL_INVALID', 400, 'Destination model name is invalid.');
  }
  return canonicalModelName(text);
}

function replacementIntent(value: unknown): boolean {
  if (value === undefined || value === false) return false;
  if (value === true) return true;
  throw new ModelfileDeployPlanError('DEPLOY_REPLACE_INTENT_INVALID', 400, 'Replace/rebuild intent must be an explicit boolean.');
}

function publicCompileError(error: unknown): ModelfileDeployPlanError {
  if (error instanceof ModelfileDeployCompileError) {
    return new ModelfileDeployPlanError(error.code, 422, error.message);
  }
  if (error && typeof error === 'object' && 'code' in error && 'statusCode' in error) {
    const candidate = error as { code?: unknown; statusCode?: unknown; message?: unknown };
    if (typeof candidate.code === 'string' && typeof candidate.statusCode === 'number') {
      return new ModelfileDeployPlanError(
        candidate.code,
        candidate.statusCode,
        typeof candidate.message === 'string' ? candidate.message : 'Deploy-plan prerequisite failed.',
      );
    }
  }
  return new ModelfileDeployPlanError('MODEFILE_DEPLOY_PLAN_FAILED', 500, 'Modelfile deploy plan creation failed.');
}

function matchingInstalledModel(models: readonly InstalledOllamaModelView[], requested: string): InstalledOllamaModelView | null {
  const canonical = canonicalModelName(requested);
  return models.find((model) => (
    canonicalModelName(model.model) === canonical || canonicalModelName(model.name) === canonical
  )) ?? null;
}

export function deployPlanAuthorityHash(
  compiled: CompiledModelfileDeploy,
  existing: Pick<InstalledOllamaModelView, 'digest' | 'sizeBytes'> | null,
): string {
  return sha256(JSON.stringify({
    payload: compiled.payload,
    destinationAuthority: existing
      ? { mode: 'replace', digest: existing.digest.toLowerCase(), sizeBytes: existing.sizeBytes }
      : { mode: 'create' },
  }));
}

export class ModelfileDeployPlanService {
  constructor(
    private readonly modelfiles: ModelfileRepository,
    private readonly plans: ModelfileDeployPlanRepository,
    private readonly targets: OllamaTargetRepository,
    private readonly health: HealthReader,
    private readonly inventory: InventoryReader,
    private readonly audit: AuditService,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async create(
    targetId: string,
    modelfileId: string,
    revisionId: string,
    actorUserId: string,
    input: CreateModelfileDeployPlanInput,
  ): Promise<ModelfileDeployPlanView> {
    const destination = outputModel(input.outputModel);
    const replaceExisting = replacementIntent(input.replaceExisting);
    const artifact = this.modelfiles.findById(modelfileId);
    if (!artifact) throw new ModelfileDeployPlanError('MODEFILE_NOT_FOUND', 404, 'Local Modelfile was not found.');
    const revision = this.modelfiles.findRevisionById(revisionId);
    if (!revision || revision.modelfileId !== artifact.id) {
      throw new ModelfileDeployPlanError('MODEFILE_REVISION_NOT_FOUND', 404, 'Modelfile revision was not found for this artifact.');
    }

    let compiled: CompiledModelfileDeploy;
    try { compiled = compileModelfileForDeploy(revision.rawText); }
    catch (error) { throw publicCompileError(error); }

    const before = this.targets.findById(targetId);
    if (!before || !before.enabled) {
      throw new ModelfileDeployPlanError('TARGET_NOT_FOUND', 404, 'Ollama target was not found or is disabled.');
    }

    try {
      const health = await this.health.read(targetId);
      if (!health.ollama.versionMatch) {
        throw new ModelfileDeployPlanError('OLLAMA_VERSION_MISMATCH', 409, 'Ollama CLI/API versions differ; deploy plan is refused.');
      }
      const inventory = await this.inventory.read(targetId);
      const after = this.targets.findById(targetId);
      if (!after || !after.enabled || after.selectedContainerId !== before.selectedContainerId) {
        throw new ModelfileDeployPlanError('TARGET_BINDING_CHANGED', 409, 'Ollama target container binding changed during deploy planning.');
      }

      if (!matchingInstalledModel(inventory.installed, compiled.summary.baseModel)) {
        throw new ModelfileDeployPlanError('DEPLOY_BASE_MODEL_NOT_INSTALLED', 409, 'FROM base model is not installed on the selected target.');
      }
      const existing = matchingInstalledModel(inventory.installed, destination);
      if (existing && !replaceExisting) {
        throw new ModelfileDeployPlanError('DEPLOY_DESTINATION_EXISTS', 409, 'Destination model already exists; request an explicit replace/rebuild plan to continue.');
      }
      if (!existing && replaceExisting) {
        throw new ModelfileDeployPlanError('DEPLOY_REPLACE_TARGET_MISSING', 409, 'Replace/rebuild was requested but the destination model is not currently installed.');
      }

      const createdAt = this.now();
      const expiresAt = new Date(createdAt.getTime() + PLAN_TTL_MS);
      const confirmationToken = randomBytes(32).toString('base64url');
      const plan: StoredModelfileDeployPlan = {
        id: randomUUID(),
        targetId: after.id,
        modelfileId: artifact.id,
        revisionId: revision.id,
        revisionSha256: revision.contentSha256,
        actorUserId,
        selectedContainerId: after.selectedContainerId,
        outputModel: destination,
        baseModel: compiled.summary.baseModel,
        payloadSha256: deployPlanAuthorityHash(compiled, existing),
        confirmationTokenHash: sha256(confirmationToken),
        createdAt: createdAt.toISOString(),
        expiresAt: expiresAt.toISOString(),
        consumedAt: null,
      };
      if (!this.plans.create(plan)) {
        throw new ModelfileDeployPlanError('DEPLOY_PLAN_CONFLICT', 409, 'Deploy plan ID collided; retry plan creation.');
      }

      this.audit.record({
        actorUserId,
        hostId: null,
        targetId: after.id,
        action: 'modelfile.deploy_plan.created',
        parameters: {
          planId: plan.id,
          modelfileId: artifact.id,
          revisionId: revision.id,
          revisionSha256: revision.contentSha256,
          outputModel: destination,
          baseModel: compiled.summary.baseModel,
          selectedContainerId: after.selectedContainerId,
          replacement: existing ? {
            existingDigest: existing.digest,
            existingSizeBytes: existing.sizeBytes,
          } : null,
          expectedFields: compiled.summary.expectedFields,
          directiveCounts: compiled.summary.directiveCounts,
          expiresAt: plan.expiresAt,
        },
        result: 'succeeded',
      });

      return {
        planId: plan.id,
        confirmationToken,
        targetId: plan.targetId,
        selectedContainerId: plan.selectedContainerId,
        modelfileId: plan.modelfileId,
        revisionId: plan.revisionId,
        revisionSha256: plan.revisionSha256,
        outputModel: plan.outputModel,
        baseModel: compiled.summary.baseModel,
        replacement: existing ? {
          existingDigest: existing.digest,
          existingSizeBytes: existing.sizeBytes,
        } : null,
        apiVersion: health.ollama.apiVersion,
        directiveCounts: compiled.summary.directiveCounts,
        expectedFields: compiled.summary.expectedFields,
        createdAt: plan.createdAt,
        expiresAt: plan.expiresAt,
      };
    } catch (error) {
      throw publicCompileError(error);
    }
  }
}
