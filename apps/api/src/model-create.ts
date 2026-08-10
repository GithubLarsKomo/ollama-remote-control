import { createHash, timingSafeEqual } from 'node:crypto';
import type {
  HostOnboardingRepository,
  OllamaTargetRepository,
  SshCredentialRepository,
  StoredJob,
} from '@orc/core';
import {
  canonicalOllamaModelName,
  compileModelfileForDeploy,
  type CompiledModelfileDeploy,
} from '@orc/core/modelfile-deploy';
import type {
  ModelfileDeployPlanRepository,
  StoredModelfileDeployPlan,
} from '@orc/core/modelfile-deploy-plans';
import type { ModelfileRepository } from '@orc/core/modelfiles';
import { SecretCipher } from '@orc/security';
import {
  execPrivateKey,
  SshTransportError,
  type SshPrivateKeyConnection,
} from '@orc/ssh';
import { AuditService } from './audit.js';
import { JobService, JobServiceError } from './jobs.js';
import { verifyCompiledModelfileDeploy } from './modelfile-deploy-verification.js';
import {
  OllamaCreateStreamError,
  streamOllamaCreateViaPinnedSsh,
} from './ollama-create-stream.js';
import type { OllamaHealthService } from './ollama-health.js';
import { selectOllamaApiRoute, type OllamaHealthTransportMode } from './ollama-health.js';
import type { OllamaModelDetailService } from './ollama-model-details.js';
import type { InstalledOllamaModelView, OllamaModelInventoryService } from './ollama-models.js';

const PROGRESS_MIN_INTERVAL_MS = 1_000;
const TOKEN_MAX_LENGTH = 256;
const PLAN_ID_MAX_LENGTH = 128;

export class ModelCreateError extends Error {
  constructor(
    readonly code: string,
    readonly statusCode: number,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

interface ResolvedCreateTarget {
  readonly targetId: string;
  readonly hostId: string;
  readonly selectedContainerId: string;
  readonly connection: SshPrivateKeyConnection;
  readonly route: {
    readonly mode: OllamaHealthTransportMode;
    readonly host: string;
    readonly port: number;
  };
}

interface RunningMetadata {
  readonly planId: string;
  readonly modelfileId: string;
  readonly revisionId: string;
  readonly revisionSha256: string;
  readonly payloadSha256: string;
  readonly outputModel: string;
  readonly baseModel: string;
  readonly selectedContainerId: string;
}

export interface PublicCreateJob {
  readonly id: string;
  readonly targetId: string;
  readonly kind: 'model-create';
  readonly state: StoredJob['state'];
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly errorClass: string | null;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function payloadSha(compiled: CompiledModelfileDeploy): string {
  return sha256(JSON.stringify(compiled.payload));
}

function safeEqualHex(left: string, right: string): boolean {
  if (!/^[a-f0-9]{64}$/u.test(left) || !/^[a-f0-9]{64}$/u.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

function confirmationToken(value: unknown): string {
  if (typeof value !== 'string' || value.length < 32 || value.length > TOKEN_MAX_LENGTH || /\s/u.test(value)) {
    throw new ModelCreateError('DEPLOY_CONFIRMATION_INVALID', 400, 'Deploy confirmation token is invalid.');
  }
  return value;
}

function planId(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > PLAN_ID_MAX_LENGTH || /[\u0000-\u0020\u007f]/u.test(value)) {
    throw new ModelCreateError('DEPLOY_PLAN_INVALID', 400, 'Deploy plan ID is invalid.');
  }
  return value;
}

function normalizedContainerId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u.test(text) ? text : null;
}

function parseInspect(stdout: string): Record<string, any> {
  try {
    const parsed = JSON.parse(stdout);
    const object = Array.isArray(parsed) ? parsed[0] : null;
    if (!object || typeof object !== 'object') throw new Error('missing inspect object');
    return object as Record<string, any>;
  } catch {
    throw new ModelCreateError('DOCKER_OUTPUT_INVALID', 502, 'Docker inspect returned invalid data.');
  }
}

function matchingInstalledModel(models: readonly InstalledOllamaModelView[], requested: string): InstalledOllamaModelView | null {
  const canonical = canonicalOllamaModelName(requested);
  return models.find((model) => (
    canonicalOllamaModelName(model.name) === canonical || canonicalOllamaModelName(model.model) === canonical
  )) ?? null;
}

function publicJob(job: StoredJob): PublicCreateJob {
  return {
    id: job.id,
    targetId: job.targetId,
    kind: 'model-create',
    state: job.state,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    errorClass: job.errorClass,
  };
}

function runningMetadata(job: StoredJob): RunningMetadata | null {
  if (!job.resultJson) return null;
  try {
    const parsed = JSON.parse(job.resultJson) as Record<string, unknown>;
    const selectedContainerId = normalizedContainerId(parsed.selectedContainerId);
    const outputModel = typeof parsed.outputModel === 'string' ? canonicalOllamaModelName(parsed.outputModel) : null;
    const baseModel = typeof parsed.baseModel === 'string' ? canonicalOllamaModelName(parsed.baseModel) : null;
    if (
      typeof parsed.planId !== 'string'
      || typeof parsed.modelfileId !== 'string'
      || typeof parsed.revisionId !== 'string'
      || typeof parsed.revisionSha256 !== 'string'
      || typeof parsed.payloadSha256 !== 'string'
      || !safeEqualHex(parsed.revisionSha256, parsed.revisionSha256.toLowerCase())
      || !safeEqualHex(parsed.payloadSha256, parsed.payloadSha256.toLowerCase())
      || !selectedContainerId
      || !outputModel
      || !baseModel
    ) return null;
    return {
      planId: parsed.planId,
      modelfileId: parsed.modelfileId,
      revisionId: parsed.revisionId,
      revisionSha256: parsed.revisionSha256.toLowerCase(),
      payloadSha256: parsed.payloadSha256.toLowerCase(),
      outputModel,
      baseModel,
      selectedContainerId,
    };
  } catch {
    return null;
  }
}

export class ModelCreateService {
  private readonly controllers = new Map<string, AbortController>();
  private readonly tasks = new Set<Promise<void>>();
  private shuttingDown = false;

  constructor(
    private readonly hosts: HostOnboardingRepository,
    private readonly credentials: SshCredentialRepository,
    private readonly targets: OllamaTargetRepository,
    private readonly modelfiles: ModelfileRepository,
    private readonly plans: ModelfileDeployPlanRepository,
    private readonly masterKey: Buffer | null,
    private readonly jobs: JobService,
    private readonly audit: AuditService,
    private readonly health: OllamaHealthService,
    private readonly inventory: OllamaModelInventoryService,
    private readonly details: OllamaModelDetailService,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private resolveLocal(targetId: string): { hostId: string; selectedContainerId: string; connection: SshPrivateKeyConnection } {
    if (!this.masterKey) throw new ModelCreateError('MASTER_KEY_REQUIRED', 503, 'External master key is required.');
    const target = this.targets.findById(targetId);
    if (!target || !target.enabled) throw new ModelCreateError('TARGET_NOT_FOUND', 404, 'Ollama target was not found or is disabled.');
    const host = this.hosts.findHostById(target.hostId);
    if (!host || !host.enabled) throw new ModelCreateError('HOST_NOT_FOUND', 404, 'Host was not found or is disabled.');
    const credential = this.credentials.findByHostId(host.id);
    if (!credential) throw new ModelCreateError('SSH_CREDENTIAL_NOT_FOUND', 409, 'Host has no SSH credential.');
    let privateKey: string;
    try {
      privateKey = new SecretCipher(this.masterKey).decrypt(
        { credentialId: credential.id, hostId: host.id },
        credential.encryptedPrivateKey,
      );
    } catch {
      throw new ModelCreateError('SSH_CREDENTIAL_INVALID', 409, 'Stored SSH credential could not be decrypted.');
    }
    return {
      hostId: host.id,
      selectedContainerId: target.selectedContainerId,
      connection: {
        hostname: host.hostname,
        port: host.port,
        username: host.username,
        privateKey,
        expectedFingerprint: host.hostKeyFingerprint,
      },
    };
  }

  private assertExpectedBinding(targetId: string, expectedContainerId: string): ReturnType<ModelCreateService['resolveLocal']> {
    const local = this.resolveLocal(targetId);
    if (local.selectedContainerId !== expectedContainerId) {
      throw new ModelCreateError('TARGET_BINDING_STALE', 409, 'Ollama target binding changed after deploy confirmation.');
    }
    return local;
  }

  private async resolveRoute(targetId: string, expectedContainerId: string): Promise<ResolvedCreateTarget> {
    const local = this.assertExpectedBinding(targetId, expectedContainerId);
    let inspectResult;
    try {
      inspectResult = await execPrivateKey(
        local.connection,
        ['docker', 'inspect', expectedContainerId],
        { timeoutMs: 10_000, maxOutputBytes: 2 * 1024 * 1024 },
      );
    } catch (error) {
      if (error instanceof SshTransportError) {
        const statusCode = error.code === 'SSH_HOST_KEY_MISMATCH' ? 409 : error.code === 'AUTH_FAILED' ? 422 : 502;
        throw new ModelCreateError(error.code, statusCode, 'Remote SSH create preflight failed.', { cause: error });
      }
      throw error;
    }
    if (inspectResult.exitCode !== 0) {
      const detail = `${inspectResult.stdout}\n${inspectResult.stderr}`;
      if (/no such (object|container)/iu.test(detail)) throw new ModelCreateError('CONTAINER_NOT_FOUND', 404, 'Ollama container was not found.');
      throw new ModelCreateError('DOCKER_UNAVAILABLE', 502, 'Docker inspect failed.');
    }
    const inspect = parseInspect(inspectResult.stdout);
    if (!Boolean(inspect.State?.Running)) throw new ModelCreateError('CONTAINER_NOT_RUNNING', 409, 'Ollama container is not running.');
    const route = selectOllamaApiRoute(inspect);
    if (!route) throw new ModelCreateError('OLLAMA_API_UNAVAILABLE', 502, 'No safe Ollama API route could be derived from Docker state.');
    return { targetId, ...local, route };
  }

  private validatePlanLocal(
    targetId: string,
    modelfileId: string,
    revisionId: string,
    actorUserId: string,
    planValue: unknown,
    tokenValue: unknown,
  ): { plan: StoredModelfileDeployPlan; tokenHash: string; compiled: CompiledModelfileDeploy } {
    const id = planId(planValue);
    const token = confirmationToken(tokenValue);
    const plan = this.plans.findById(id);
    if (
      !plan
      || plan.actorUserId !== actorUserId
      || plan.targetId !== targetId
      || plan.modelfileId !== modelfileId
      || plan.revisionId !== revisionId
    ) throw new ModelCreateError('DEPLOY_PLAN_NOT_FOUND', 404, 'Deploy plan was not found.');
    if (plan.consumedAt) throw new ModelCreateError('DEPLOY_PLAN_ALREADY_USED', 409, 'Deploy plan has already been consumed.');
    if (plan.expiresAt <= this.now().toISOString()) throw new ModelCreateError('DEPLOY_PLAN_EXPIRED', 409, 'Deploy plan has expired.');
    const tokenHash = sha256(token);
    if (!safeEqualHex(tokenHash, plan.confirmationTokenHash)) {
      throw new ModelCreateError('DEPLOY_CONFIRMATION_INVALID', 403, 'Deploy confirmation token does not match this plan.');
    }
    const revision = this.modelfiles.findRevisionById(revisionId);
    if (!revision || revision.modelfileId !== modelfileId || revision.contentSha256 !== plan.revisionSha256) {
      throw new ModelCreateError('DEPLOY_REVISION_STALE', 409, 'Immutable revision identity no longer matches the deploy plan.');
    }
    const compiled = compileModelfileForDeploy(revision.rawText);
    if (!safeEqualHex(payloadSha(compiled), plan.payloadSha256) || compiled.summary.baseModel !== plan.baseModel) {
      throw new ModelCreateError('DEPLOY_PLAN_STALE', 409, 'Compiled deploy payload no longer matches the stored plan authority.');
    }
    return { plan, tokenHash, compiled };
  }

  async start(
    targetId: string,
    modelfileId: string,
    revisionId: string,
    actorUserId: string,
    planValue: unknown,
    tokenValue: unknown,
  ): Promise<PublicCreateJob> {
    if (this.shuttingDown) throw new ModelCreateError('SERVER_SHUTTING_DOWN', 503, 'Model create service is shutting down.');
    const validated = this.validatePlanLocal(targetId, modelfileId, revisionId, actorUserId, planValue, tokenValue);
    const plan = validated.plan;
    const local = this.assertExpectedBinding(targetId, plan.selectedContainerId);

    const health = await this.health.read(targetId);
    if (!health.ollama.versionMatch) throw new ModelCreateError('OLLAMA_VERSION_MISMATCH', 409, 'Ollama CLI/API versions differ; deploy is refused.');
    const inventory = await this.inventory.read(targetId);
    if (!matchingInstalledModel(inventory.installed, plan.baseModel)) {
      throw new ModelCreateError('DEPLOY_BASE_MODEL_NOT_INSTALLED', 409, 'FROM base model is no longer installed.');
    }
    if (matchingInstalledModel(inventory.installed, plan.outputModel)) {
      throw new ModelCreateError('DEPLOY_DESTINATION_EXISTS', 409, 'Destination model now exists; overwrite is not supported.');
    }
    this.assertExpectedBinding(targetId, plan.selectedContainerId);

    const job = this.jobs.create({ targetId, actorUserId, kind: 'model-create', mutating: true });
    const consumed = this.plans.consumeIfUsable(
      plan.id,
      actorUserId,
      validated.tokenHash,
      this.now().toISOString(),
      this.now().toISOString(),
    );
    if (!consumed) {
      this.jobs.transition(job.id, 'failed', { errorClass: 'DEPLOY_PLAN_CONSUME_FAILED' });
      throw new ModelCreateError('DEPLOY_PLAN_CONSUME_FAILED', 409, 'Deploy plan could not be consumed atomically.');
    }

    const metadata: RunningMetadata = {
      planId: plan.id,
      modelfileId,
      revisionId,
      revisionSha256: plan.revisionSha256,
      payloadSha256: plan.payloadSha256,
      outputModel: plan.outputModel,
      baseModel: plan.baseModel,
      selectedContainerId: plan.selectedContainerId,
    };
    this.jobs.appendEvent(job.id, 'create-request', {
      planId: plan.id,
      modelfileId,
      revisionId,
      revisionSha256: plan.revisionSha256,
      outputModel: plan.outputModel,
      baseModel: plan.baseModel,
      selectedContainerId: plan.selectedContainerId,
    });
    this.audit.record({
      actorUserId,
      hostId: local.hostId,
      targetId,
      action: 'model.create.requested',
      parameters: {
        planId: plan.id,
        modelfileId,
        revisionId,
        revisionSha256: plan.revisionSha256,
        outputModel: plan.outputModel,
        baseModel: plan.baseModel,
      },
      result: 'accepted',
      jobId: job.id,
    });

    let task!: Promise<void>;
    task = this.run(job.id, actorUserId, metadata, validated.compiled)
      .catch(() => {
        if (this.shuttingDown) return;
        try {
          const current = this.jobs.get(job.id);
          if (current.state === 'queued' || current.state === 'running' || current.state === 'cancelling') {
            this.jobs.transition(job.id, 'failed', { errorClass: 'CREATE_INTERNAL_ERROR' });
          }
        } catch {
          // Detached worker must not create an unhandled rejection.
        }
      })
      .finally(() => { this.tasks.delete(task); });
    this.tasks.add(task);
    return publicJob(job);
  }

  private async run(jobId: string, actorUserId: string, metadata: RunningMetadata, compiled: CompiledModelfileDeploy): Promise<void> {
    const initial = this.jobs.get(jobId);
    if (initial.state !== 'queued') return;
    try { this.assertExpectedBinding(initial.targetId, metadata.selectedContainerId); }
    catch (error) {
      this.fail(jobId, actorUserId, initial.targetId, error instanceof ModelCreateError ? error.code : 'TARGET_BINDING_STALE', metadata);
      return;
    }

    const controller = new AbortController();
    this.controllers.set(jobId, controller);
    try {
      const running = this.jobs.transition(jobId, 'running', { result: metadata });
      const target = await this.resolveRoute(running.targetId, metadata.selectedContainerId);
      let sawSuccess = false;
      let lastPersistedAt = 0;
      let lastStatus: string | null = null;
      await streamOllamaCreateViaPinnedSsh(
        target.connection,
        target.route.host,
        target.route.port,
        metadata.outputModel,
        compiled.payload,
        {
          signal: controller.signal,
          onProgress: (progress) => {
            if (progress.status === 'success') sawSuccess = true;
            const timestamp = this.now().getTime();
            if (progress.status === lastStatus && progress.status !== 'success' && timestamp - lastPersistedAt < PROGRESS_MIN_INTERVAL_MS) return;
            this.jobs.appendEvent(jobId, 'progress', { status: progress.status });
            lastStatus = progress.status;
            lastPersistedAt = timestamp;
          },
        },
      );
      if (this.shuttingDown) return;
      if (this.jobs.get(jobId).state === 'cancelling') {
        this.fail(jobId, actorUserId, running.targetId, 'CANCEL_UNVERIFIED', metadata);
        return;
      }
      if (!sawSuccess) {
        this.fail(jobId, actorUserId, running.targetId, 'CREATE_STREAM_INCOMPLETE', metadata);
        return;
      }
      this.assertExpectedBinding(running.targetId, metadata.selectedContainerId);
      const installed = matchingInstalledModel((await this.inventory.read(running.targetId)).installed, metadata.outputModel);
      if (!installed) {
        this.fail(jobId, actorUserId, running.targetId, 'CREATE_VERIFICATION_FAILED', metadata, { mismatches: ['model-presence'] });
        return;
      }
      const detail = await this.details.read(running.targetId, metadata.outputModel);
      const verification = verifyCompiledModelfileDeploy(compiled, detail);
      if (!verification.verified) {
        this.fail(jobId, actorUserId, running.targetId, 'CREATE_VERIFICATION_FAILED', metadata, {
          mismatches: verification.mismatches,
          baseModelObservation: verification.baseModelObservation,
        });
        return;
      }
      this.jobs.transition(jobId, 'succeeded', {
        result: {
          ...metadata,
          digest: installed.digest,
          sizeBytes: installed.sizeBytes,
          verified: true,
          baseModelObservation: verification.baseModelObservation,
        },
      });
      this.auditTerminal(actorUserId, target.hostId, running.targetId, jobId, metadata, 'succeeded', null, []);
    } catch (error) {
      if (this.shuttingDown && controller.signal.aborted) return;
      const current = this.jobs.get(jobId);
      if (current.state === 'cancelling' || (error instanceof OllamaCreateStreamError && error.code === 'CREATE_ABORTED')) {
        this.fail(jobId, actorUserId, current.targetId, 'CANCEL_UNVERIFIED', metadata);
        return;
      }
      const errorClass = error instanceof ModelCreateError
        ? error.code
        : error instanceof OllamaCreateStreamError
          ? error.code
          : error instanceof JobServiceError
            ? error.code
            : 'CREATE_FAILED';
      this.fail(jobId, actorUserId, current.targetId, errorClass, metadata);
    } finally {
      this.controllers.delete(jobId);
    }
  }

  cancel(jobId: string, actorUserId: string): PublicCreateJob {
    const job = this.jobs.get(jobId);
    if (job.actorUserId !== actorUserId) throw new ModelCreateError('JOB_NOT_FOUND', 404, 'Job was not found.');
    if (job.kind !== 'model-create') throw new ModelCreateError('JOB_NOT_CANCELLABLE', 409, 'Job is not a model-create job.');
    if (job.state === 'queued') {
      const cancelled = this.jobs.transition(job.id, 'cancelled');
      this.auditTerminal(actorUserId, this.hostIdForTarget(job.targetId), job.targetId, job.id, runningMetadata(job), 'cancelled', null, []);
      return publicJob(cancelled);
    }
    if (job.state === 'running') {
      const cancelling = this.jobs.transition(job.id, 'cancelling');
      this.controllers.get(job.id)?.abort();
      return publicJob(cancelling);
    }
    if (job.state === 'cancelling') return publicJob(job);
    throw new ModelCreateError('JOB_ALREADY_TERMINAL', 409, 'Model-create job is already terminal.');
  }

  get(jobId: string, actorUserId: string): PublicCreateJob {
    const job = this.jobs.get(jobId);
    if (job.actorUserId !== actorUserId || job.kind !== 'model-create') throw new ModelCreateError('JOB_NOT_FOUND', 404, 'Job was not found.');
    return publicJob(job);
  }

  events(jobId: string, actorUserId: string) {
    this.get(jobId, actorUserId);
    return this.jobs.events(jobId);
  }

  async reconcile(): Promise<void> {
    for (const job of this.jobs.jobsNeedingReconciliation()) {
      if (job.kind !== 'model-create') continue;
      let metadata = runningMetadata(job);
      let errorClass: string | null = null;
      let auditResult = 'failed';
      let mismatches: readonly string[] = [];
      try {
        if (job.state === 'queued') {
          errorClass = 'CREATE_INTERRUPTED_BEFORE_START';
          this.jobs.transition(job.id, 'failed', { errorClass });
          continue;
        }
        if (job.state === 'cancelling') {
          errorClass = 'CANCEL_UNVERIFIED';
          this.jobs.transition(job.id, 'failed', { errorClass });
          continue;
        }
        if (!metadata) {
          errorClass = 'CREATE_OUTCOME_UNKNOWN';
          this.jobs.transition(job.id, 'failed', { errorClass });
          continue;
        }
        const currentBinding = this.targets.findById(job.targetId)?.selectedContainerId ?? null;
        if (currentBinding !== metadata.selectedContainerId) {
          errorClass = 'TARGET_BINDING_STALE';
          this.jobs.transition(job.id, 'failed', { errorClass });
          continue;
        }
        const revision = this.modelfiles.findRevisionById(metadata.revisionId);
        if (
          !revision
          || revision.modelfileId !== metadata.modelfileId
          || revision.contentSha256 !== metadata.revisionSha256
        ) {
          errorClass = 'CREATE_OUTCOME_UNKNOWN';
          this.jobs.transition(job.id, 'failed', { errorClass });
          continue;
        }
        const compiled = compileModelfileForDeploy(revision.rawText);
        if (!safeEqualHex(payloadSha(compiled), metadata.payloadSha256)) {
          errorClass = 'CREATE_OUTCOME_UNKNOWN';
          this.jobs.transition(job.id, 'failed', { errorClass });
          continue;
        }
        const installed = matchingInstalledModel((await this.inventory.read(job.targetId)).installed, metadata.outputModel);
        if (!installed) {
          errorClass = 'CREATE_OUTCOME_UNKNOWN';
          this.jobs.transition(job.id, 'failed', { errorClass });
          continue;
        }
        const detail = await this.details.read(job.targetId, metadata.outputModel);
        const verification = verifyCompiledModelfileDeploy(compiled, detail);
        if (!verification.verified) {
          mismatches = verification.mismatches;
          errorClass = 'CREATE_VERIFICATION_FAILED';
          this.jobs.transition(job.id, 'failed', {
            errorClass,
            result: { ...metadata, mismatches, baseModelObservation: verification.baseModelObservation, reconciled: true },
          });
          continue;
        }
        this.jobs.transition(job.id, 'succeeded', {
          result: {
            ...metadata,
            digest: installed.digest,
            sizeBytes: installed.sizeBytes,
            verified: true,
            baseModelObservation: verification.baseModelObservation,
            reconciled: true,
          },
        });
        auditResult = 'succeeded';
      } catch {
        const latest = this.jobs.get(job.id);
        if (latest.state === 'running') {
          errorClass = 'CREATE_RECONCILIATION_FAILED';
          this.jobs.transition(job.id, 'failed', { errorClass });
        }
      } finally {
        const terminal = this.jobs.get(job.id);
        if (terminal.state === 'succeeded') auditResult = 'succeeded';
        else if (terminal.state === 'cancelled') auditResult = 'cancelled';
        else if (terminal.state === 'failed') errorClass = terminal.errorClass ?? errorClass;
        if (terminal.state === 'succeeded' || terminal.state === 'failed' || terminal.state === 'cancelled') {
          this.auditTerminal(
            terminal.actorUserId,
            this.hostIdForTarget(terminal.targetId),
            terminal.targetId,
            terminal.id,
            metadata,
            auditResult,
            errorClass,
            mismatches,
          );
        }
      }
    }
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    for (const controller of this.controllers.values()) controller.abort();
    await Promise.allSettled([...this.tasks]);
  }

  private hostIdForTarget(targetId: string): string | null {
    return this.targets.findById(targetId)?.hostId ?? null;
  }

  private fail(
    jobId: string,
    actorUserId: string,
    targetId: string,
    errorClass: string,
    metadata: RunningMetadata | null,
    result: Readonly<Record<string, unknown>> = {},
  ): void {
    const current = this.jobs.get(jobId);
    if (current.state === 'failed' || current.state === 'succeeded' || current.state === 'cancelled') return;
    const failed = this.jobs.transition(jobId, 'failed', {
      errorClass,
      result: metadata ? { ...metadata, ...result } : result,
    });
    this.auditTerminal(
      actorUserId,
      this.hostIdForTarget(targetId),
      targetId,
      jobId,
      metadata,
      failed.state,
      errorClass,
      Array.isArray(result.mismatches) ? result.mismatches.filter((value): value is string => typeof value === 'string') : [],
    );
  }

  private auditTerminal(
    actorUserId: string,
    hostId: string | null,
    targetId: string,
    jobId: string,
    metadata: RunningMetadata | null,
    result: string,
    errorClass: string | null,
    mismatches: readonly string[],
  ): void {
    this.audit.record({
      actorUserId,
      hostId,
      targetId,
      action: 'model.create.terminal',
      parameters: metadata ? {
        planId: metadata.planId,
        modelfileId: metadata.modelfileId,
        revisionId: metadata.revisionId,
        revisionSha256: metadata.revisionSha256,
        outputModel: metadata.outputModel,
        baseModel: metadata.baseModel,
        mismatches,
      } : { mismatches },
      result,
      errorClass,
      jobId,
    });
  }
}
