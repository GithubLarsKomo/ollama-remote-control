import type { OllamaTargetRepository } from '@orc/core';
import {
  compileModelfileForDeploy,
  ModelfileDeployCompileError,
} from '@orc/core/modelfile-deploy';
import type {
  ModelfileDeploymentRepository,
  StoredModelfileDeployment,
} from '@orc/core/modelfile-deployments';
import type { ModelfileRepository } from '@orc/core/modelfiles';

const MODEL_MAX_LENGTH = 512;
const MODEL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/:@+-]*$/u;

export interface StoredDeployPlanEvidence {
  readonly id: string;
  readonly targetId: string;
  readonly modelfileId: string;
  readonly revisionId: string;
  readonly revisionSha256: string;
  readonly selectedContainerId: string;
  readonly outputModel: string;
  readonly baseModel: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly consumedAt: string | null;
}

export interface DeployPlanEvidenceReader {
  latestForRevisionTargetModel(
    modelfileId: string,
    revisionId: string,
    revisionSha256: string,
    targetId: string,
    outputModel: string,
  ): StoredDeployPlanEvidence | null;
}

export class ModelfileValidationError extends Error {
  constructor(
    readonly code: string,
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

export type DeployPlanAuthorityState = 'usable' | 'consumed' | 'expired' | 'stale-binding';

export interface LocalValidationPassed {
  readonly state: 'passed';
  readonly revisionSha256: string;
  readonly baseModel: string;
  readonly expectedFields: readonly string[];
  readonly directiveCounts: Readonly<Record<string, number>>;
}

export interface LocalValidationFailed {
  readonly state: 'failed';
  readonly revisionSha256: string;
  readonly code: string;
  readonly message: string;
}

export interface PreflightValidationNotRequested { readonly state: 'not-requested'; }
export interface PreflightValidationNotRun { readonly state: 'not-run'; }
export interface PreflightValidationPassed {
  readonly state: 'passed';
  readonly planId: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly consumedAt: string | null;
  readonly selectedContainerId: string;
  readonly baseModel: string;
  readonly authorityState: DeployPlanAuthorityState;
}

export interface TargetValidationNotRequested { readonly state: 'not-requested'; }
export interface TargetValidationNotRun { readonly state: 'not-run'; }
export interface TargetValidationVerified {
  readonly state: 'verified';
  readonly deploymentId: string;
  readonly sourceCreateJobId: string;
  readonly modelDigest: string;
  readonly sizeBytes: number;
  readonly selectedContainerId: string;
  readonly verifiedAt: string;
}

export interface ModelfileValidationView {
  readonly modelfileId: string;
  readonly revisionId: string;
  readonly revisionSha256: string;
  readonly local: LocalValidationPassed | LocalValidationFailed;
  readonly preflight: PreflightValidationNotRequested | PreflightValidationNotRun | PreflightValidationPassed;
  readonly targetVerification: TargetValidationNotRequested | TargetValidationNotRun | TargetValidationVerified;
}

function canonicalModel(value: unknown): string {
  if (typeof value !== 'string') {
    throw new ModelfileValidationError('MODEL_REQUIRED', 400, 'Model is required when target validation evidence is requested.');
  }
  const text = value.trim();
  if (!text || text.length > MODEL_MAX_LENGTH || !MODEL_NAME_PATTERN.test(text)) {
    throw new ModelfileValidationError('MODEL_INVALID', 400, 'Model name is invalid.');
  }
  const slash = text.lastIndexOf('/');
  const colon = text.lastIndexOf(':');
  return colon > slash ? text : `${text}:latest`;
}

function latestMatchingDeployment(
  deployments: readonly StoredModelfileDeployment[],
  targetId: string,
  outputModel: string,
): StoredModelfileDeployment | null {
  return deployments.find((entry) => entry.targetId === targetId && entry.outputModel === outputModel) ?? null;
}

export class ModelfileValidationService {
  constructor(
    private readonly modelfiles: ModelfileRepository,
    private readonly plans: DeployPlanEvidenceReader,
    private readonly deployments: ModelfileDeploymentRepository,
    private readonly targets: OllamaTargetRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  read(
    modelfileId: string,
    revisionId: string,
    targetIdInput?: unknown,
    modelInput?: unknown,
  ): ModelfileValidationView {
    const artifact = this.modelfiles.findById(modelfileId);
    if (!artifact) throw new ModelfileValidationError('MODELFILE_NOT_FOUND', 404, 'Modelfile was not found.');
    const revision = this.modelfiles.findRevisionById(revisionId);
    if (!revision || revision.modelfileId !== artifact.id) {
      throw new ModelfileValidationError('MODELFILE_REVISION_NOT_FOUND', 404, 'Modelfile revision was not found.');
    }

    let local: LocalValidationPassed | LocalValidationFailed;
    try {
      const compiled = compileModelfileForDeploy(revision.rawText);
      local = {
        state: 'passed',
        revisionSha256: revision.contentSha256,
        baseModel: compiled.summary.baseModel,
        expectedFields: compiled.summary.expectedFields,
        directiveCounts: compiled.summary.directiveCounts,
      };
    } catch (error) {
      local = {
        state: 'failed',
        revisionSha256: revision.contentSha256,
        code: error instanceof ModelfileDeployCompileError ? error.code : 'DEPLOY_SOURCE_INVALID',
        message: error instanceof Error ? error.message : 'Modelfile local validation failed.',
      };
    }

    const targetRequested = targetIdInput !== undefined || modelInput !== undefined;
    if (!targetRequested) {
      return {
        modelfileId: artifact.id,
        revisionId: revision.id,
        revisionSha256: revision.contentSha256,
        local,
        preflight: { state: 'not-requested' },
        targetVerification: { state: 'not-requested' },
      };
    }

    if (typeof targetIdInput !== 'string' || !targetIdInput.trim() || modelInput === undefined) {
      throw new ModelfileValidationError(
        'TARGET_MODEL_PAIR_REQUIRED',
        400,
        'targetId and model must be supplied together for target validation evidence.',
      );
    }
    const targetId = targetIdInput.trim();
    const target = this.targets.findById(targetId);
    if (!target || !target.enabled) {
      throw new ModelfileValidationError('TARGET_NOT_FOUND', 404, 'Ollama target was not found or is disabled.');
    }
    const outputModel = canonicalModel(modelInput);

    const plan = this.plans.latestForRevisionTargetModel(
      artifact.id,
      revision.id,
      revision.contentSha256,
      target.id,
      outputModel,
    );
    let preflight: PreflightValidationNotRun | PreflightValidationPassed = { state: 'not-run' };
    if (plan) {
      const authorityState: DeployPlanAuthorityState = plan.selectedContainerId !== target.selectedContainerId
        ? 'stale-binding'
        : plan.consumedAt !== null
          ? 'consumed'
          : Date.parse(plan.expiresAt) <= this.now().getTime()
            ? 'expired'
            : 'usable';
      preflight = {
        state: 'passed',
        planId: plan.id,
        createdAt: plan.createdAt,
        expiresAt: plan.expiresAt,
        consumedAt: plan.consumedAt,
        selectedContainerId: plan.selectedContainerId,
        baseModel: plan.baseModel,
        authorityState,
      };
    }

    const deployment = latestMatchingDeployment(this.deployments.listForRevision(revision.id), target.id, outputModel);
    const targetVerification: TargetValidationNotRun | TargetValidationVerified = deployment
      ? {
          state: 'verified',
          deploymentId: deployment.id,
          sourceCreateJobId: deployment.sourceCreateJobId,
          modelDigest: deployment.modelDigest,
          sizeBytes: deployment.sizeBytes,
          selectedContainerId: deployment.selectedContainerId,
          verifiedAt: deployment.verifiedAt,
        }
      : { state: 'not-run' };

    return {
      modelfileId: artifact.id,
      revisionId: revision.id,
      revisionSha256: revision.contentSha256,
      local,
      preflight,
      targetVerification,
    };
  }
}
