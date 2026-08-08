import type {
  HostOnboardingRepository,
  OllamaTargetRepository,
  SshCredentialRepository,
} from '@orc/core';
import {
  ComposeIntentError,
  exactDigestImageReference,
  validateComposeDigestOverride,
} from '@orc/docker/compose-intent';
import { SecretCipher } from '@orc/security';
import {
  execPrivateKey,
  SshTransportError,
  type SshPrivateKeyConnection,
} from '@orc/ssh';
import { AuditService } from './audit.js';
import { JobService } from './jobs.js';
import type { UpdatePlan, UpdatePlanService } from './update-plan.js';
import type { UpdateStrategyResult, UpdateStrategyService } from './update-strategy.js';

export interface UpdateExecutionIntent {
  readonly intentVersion: 1;
  readonly intentId: string;
  readonly targetId: string;
  readonly snapshotId: string;
  readonly imageReference: string;
  readonly currentDigest: string;
  readonly candidateDigest: string;
  readonly candidateIndexDigest: string | null;
  readonly exactCandidateReference: string;
  readonly candidateImageVersion: string | null;
  readonly strategy: 'compose';
  readonly composeService: string;
  readonly createdAt: string;
}

export class UpdateExecutionIntentError extends Error {
  constructor(
    readonly code: string,
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

interface UpdatePlanReader {
  create(targetId: string, snapshotId: string, actorUserId: string): Promise<UpdatePlan>;
}

interface UpdateStrategyReader {
  create(targetId: string, snapshotId: string, actorUserId: string): Promise<UpdateStrategyResult>;
}

interface ResolvedConnection {
  readonly hostId: string;
  readonly targetId: string;
  readonly connection: SshPrivateKeyConnection;
}

function classifyDependency(error: unknown): UpdateExecutionIntentError {
  if (error && typeof error === 'object' && 'code' in error && 'statusCode' in error) {
    const candidate = error as { code?: unknown; statusCode?: unknown; message?: unknown };
    if (typeof candidate.code === 'string' && typeof candidate.statusCode === 'number') {
      return new UpdateExecutionIntentError(
        candidate.code,
        candidate.statusCode,
        typeof candidate.message === 'string' ? candidate.message : 'Update intent prerequisite failed.',
      );
    }
  }
  if (error instanceof ComposeIntentError) {
    return new UpdateExecutionIntentError(error.code, 409, error.message);
  }
  if (error instanceof SshTransportError) {
    const status = error.code === 'SSH_HOST_KEY_MISMATCH' ? 409 : error.code === 'AUTH_FAILED' ? 422 : 502;
    return new UpdateExecutionIntentError(error.code, status, 'Remote SSH Compose pin validation failed.');
  }
  return new UpdateExecutionIntentError('UPDATE_EXECUTION_INTENT_FAILED', 500, 'Update execution intent creation failed.');
}

export class UpdateExecutionIntentService {
  constructor(
    private readonly hosts: HostOnboardingRepository,
    private readonly credentials: SshCredentialRepository,
    private readonly targets: OllamaTargetRepository,
    private readonly masterKey: Buffer | null,
    private readonly jobs: JobService,
    private readonly audit: AuditService,
    private readonly updatePlan: UpdatePlanReader | UpdatePlanService,
    private readonly updateStrategy: UpdateStrategyReader | UpdateStrategyService,
  ) {}

  private resolveConnection(targetId: string): ResolvedConnection {
    if (!this.masterKey) throw new UpdateExecutionIntentError('MASTER_KEY_REQUIRED', 503, 'External master key is required.');
    const target = this.targets.findById(targetId);
    if (!target || !target.enabled) throw new UpdateExecutionIntentError('TARGET_NOT_FOUND', 404, 'Ollama target was not found or is disabled.');
    const host = this.hosts.findHostById(target.hostId);
    if (!host || !host.enabled) throw new UpdateExecutionIntentError('HOST_NOT_FOUND', 404, 'Host was not found or is disabled.');
    const credential = this.credentials.findByHostId(host.id);
    if (!credential) throw new UpdateExecutionIntentError('SSH_CREDENTIAL_NOT_FOUND', 409, 'Host has no SSH credential.');
    let privateKey: string;
    try {
      privateKey = new SecretCipher(this.masterKey).decrypt(
        { credentialId: credential.id, hostId: host.id },
        credential.encryptedPrivateKey,
      );
    } catch {
      throw new UpdateExecutionIntentError('SSH_CREDENTIAL_INVALID', 409, 'Stored SSH credential could not be decrypted.');
    }
    return {
      hostId: host.id,
      targetId: target.id,
      connection: {
        hostname: host.hostname,
        port: host.port,
        username: host.username,
        privateKey,
        expectedFingerprint: host.hostKeyFingerprint,
      },
    };
  }

  async create(targetId: string, snapshotId: string, actorUserId: string): Promise<UpdateExecutionIntent> {
    const source = this.resolveConnection(targetId);
    const job = this.jobs.create({
      targetId: source.targetId,
      actorUserId,
      kind: 'container.update_execution_intent',
      mutating: false,
    });
    this.jobs.transition(job.id, 'running');
    this.audit.record({
      actorUserId,
      hostId: source.hostId,
      targetId: source.targetId,
      action: 'container.update_execution_intent.requested',
      parameters: { intentId: job.id, snapshotId, targetId: source.targetId },
      result: 'requested',
      jobId: job.id,
    });

    try {
      const plan = await this.updatePlan.create(source.targetId, snapshotId, actorUserId);
      if (plan.pinned) {
        throw new UpdateExecutionIntentError('SOURCE_IMAGE_PINNED', 409, 'Digest-pinned source image has no tag-based update candidate.');
      }
      if (!plan.updateAvailable) {
        throw new UpdateExecutionIntentError('NO_UPDATE_AVAILABLE', 409, 'Registry candidate matches the current image.');
      }
      const strategyResult = await this.updateStrategy.create(source.targetId, snapshotId, actorUserId);
      if (strategyResult.strategy.type !== 'compose' || !strategyResult.strategy.executable) {
        throw new UpdateExecutionIntentError('UPDATE_STRATEGY_UNSUPPORTED', 422, 'First update execution slice supports validated Compose-managed targets only.');
      }

      const exactCandidateReference = exactDigestImageReference(plan.imageReference, plan.candidateDigest);
      await validateComposeDigestOverride(
        {
          exec: (argv, stdin) => execPrivateKey(
            source.connection,
            argv,
            { timeoutMs: 30_000, maxOutputBytes: 512 * 1024, stdin, maxInputBytes: 64 * 1024 },
          ),
        },
        strategyResult.strategy,
        exactCandidateReference,
      );

      const intent: UpdateExecutionIntent = {
        intentVersion: 1,
        intentId: job.id,
        targetId: source.targetId,
        snapshotId,
        imageReference: plan.imageReference,
        currentDigest: plan.currentDigest,
        candidateDigest: plan.candidateDigest,
        candidateIndexDigest: plan.candidateIndexDigest,
        exactCandidateReference,
        candidateImageVersion: plan.candidateImageVersion,
        strategy: 'compose',
        composeService: strategyResult.strategy.service,
        createdAt: job.createdAt,
      };
      this.jobs.transition(job.id, 'succeeded', { result: intent as unknown as Readonly<Record<string, unknown>> });
      try {
        this.audit.record({
          actorUserId,
          hostId: source.hostId,
          targetId: source.targetId,
          action: 'container.update_execution_intent.created',
          parameters: {
            intentId: job.id,
            snapshotId,
            currentDigest: intent.currentDigest,
            candidateDigest: intent.candidateDigest,
            exactCandidateReference: intent.exactCandidateReference,
            strategy: intent.strategy,
            composeService: intent.composeService,
          },
          result: 'succeeded',
          jobId: job.id,
        });
      } catch {
        // A terminal intent remains usable if the secondary audit write fails.
      }
      return intent;
    } catch (error) {
      const failure = classifyDependency(error);
      try { this.jobs.transition(job.id, 'failed', { errorClass: failure.code }); } catch { /* preserve primary failure */ }
      try {
        this.audit.record({
          actorUserId,
          hostId: source.hostId,
          targetId: source.targetId,
          action: 'container.update_execution_intent.failed',
          parameters: { intentId: job.id, snapshotId, targetId: source.targetId },
          result: 'failed',
          errorClass: failure.code,
          jobId: job.id,
        });
      } catch {
        // Preserve the primary planning failure.
      }
      throw failure;
    }
  }
}
