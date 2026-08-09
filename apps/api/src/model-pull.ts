import type {
  HostOnboardingRepository,
  OllamaTargetRepository,
  SshCredentialRepository,
  StoredJob,
} from '@orc/core';
import { SecretCipher } from '@orc/security';
import {
  execPrivateKey,
  SshTransportError,
  type SshPrivateKeyConnection,
} from '@orc/ssh';
import { AuditService } from './audit.js';
import { JobService, JobServiceError } from './jobs.js';
import {
  selectOllamaApiRoute,
  type OllamaHealthTransportMode,
} from './ollama-health.js';
import {
  OllamaModelInventoryService,
  type InstalledOllamaModelView,
} from './ollama-models.js';
import {
  OllamaPullStreamError,
  streamOllamaPullViaPinnedSsh,
  type OllamaPullProgress,
} from './ollama-pull-stream.js';

const MAX_MODEL_NAME = 512;
const PROGRESS_MIN_INTERVAL_MS = 1_000;

export class ModelPullError extends Error {
  constructor(
    readonly code: string,
    readonly statusCode: number,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

interface ResolvedPullTarget {
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
  readonly model: string;
  readonly previousDigest: string | null;
  readonly selectedContainerId: string;
}

export interface PublicPullJob {
  readonly id: string;
  readonly targetId: string;
  readonly kind: 'model-pull';
  readonly state: StoredJob['state'];
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly errorClass: string | null;
}

export function normalizePullModelName(value: unknown): string {
  if (typeof value !== 'string') throw new ModelPullError('INVALID_MODEL_NAME', 400, 'Model name is required.');
  const model = value.trim();
  if (
    !model
    || model.length > MAX_MODEL_NAME
    || /[\u0000-\u0020\u007f]/u.test(model)
    || !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u.test(model)
    || model.includes('://')
    || /[/:]$/u.test(model)
  ) {
    throw new ModelPullError('INVALID_MODEL_NAME', 400, 'Model name is invalid.');
  }
  return model;
}

function normalizedContainerId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u.test(text) ? text : null;
}

function canonicalModelName(value: string): string {
  const slash = value.lastIndexOf('/');
  const colon = value.lastIndexOf(':');
  return colon > slash ? value : `${value}:latest`;
}

function matchingInstalledModel(models: readonly InstalledOllamaModelView[], requested: string): InstalledOllamaModelView | null {
  const canonical = canonicalModelName(requested);
  return models.find((model) => (
    canonicalModelName(model.name) === canonical || canonicalModelName(model.model) === canonical
  )) ?? null;
}

function parseInspect(stdout: string): Record<string, any> {
  try {
    const parsed = JSON.parse(stdout);
    const object = Array.isArray(parsed) ? parsed[0] : null;
    if (!object || typeof object !== 'object') throw new Error('missing inspect object');
    return object as Record<string, any>;
  } catch {
    throw new ModelPullError('DOCKER_OUTPUT_INVALID', 502, 'Docker inspect returned invalid data.');
  }
}

function publicJob(job: StoredJob): PublicPullJob {
  return {
    id: job.id,
    targetId: job.targetId,
    kind: 'model-pull',
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
    if (typeof parsed.model !== 'string') return null;
    const model = normalizePullModelName(parsed.model);
    const previousDigest = parsed.previousDigest === null
      ? null
      : typeof parsed.previousDigest === 'string' && /^[a-f0-9]{64}$/iu.test(parsed.previousDigest)
        ? parsed.previousDigest.toLowerCase()
        : undefined;
    const selectedContainerId = normalizedContainerId(parsed.selectedContainerId);
    return previousDigest === undefined || !selectedContainerId
      ? null
      : { model, previousDigest, selectedContainerId };
  } catch {
    return null;
  }
}

function progressPayload(progress: OllamaPullProgress): Readonly<Record<string, unknown>> {
  const percentage = progress.total !== null && progress.total > 0 && progress.completed !== null
    ? Math.max(0, Math.min(100, Math.floor((progress.completed / progress.total) * 100)))
    : null;
  return {
    status: progress.status,
    digest: progress.digest,
    totalBytes: progress.total,
    completedBytes: progress.completed,
    percentage,
  };
}

export class ModelPullService {
  private readonly controllers = new Map<string, AbortController>();
  private readonly tasks = new Set<Promise<void>>();
  private shuttingDown = false;

  constructor(
    private readonly hosts: HostOnboardingRepository,
    private readonly credentials: SshCredentialRepository,
    private readonly targets: OllamaTargetRepository,
    private readonly masterKey: Buffer | null,
    private readonly jobs: JobService,
    private readonly audit: AuditService,
    private readonly inventory: OllamaModelInventoryService,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private resolveLocal(targetId: string): { hostId: string; selectedContainerId: string; connection: SshPrivateKeyConnection } {
    if (!this.masterKey) throw new ModelPullError('MASTER_KEY_REQUIRED', 503, 'External master key is required.');
    const target = this.targets.findById(targetId);
    if (!target || !target.enabled) throw new ModelPullError('TARGET_NOT_FOUND', 404, 'Ollama target was not found or is disabled.');
    const host = this.hosts.findHostById(target.hostId);
    if (!host || !host.enabled) throw new ModelPullError('HOST_NOT_FOUND', 404, 'Host was not found or is disabled.');
    const credential = this.credentials.findByHostId(host.id);
    if (!credential) throw new ModelPullError('SSH_CREDENTIAL_NOT_FOUND', 409, 'Host has no SSH credential.');
    let privateKey: string;
    try {
      privateKey = new SecretCipher(this.masterKey).decrypt(
        { credentialId: credential.id, hostId: host.id },
        credential.encryptedPrivateKey,
      );
    } catch {
      throw new ModelPullError('SSH_CREDENTIAL_INVALID', 409, 'Stored SSH credential could not be decrypted.');
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

  private assertExpectedBinding(targetId: string, expectedContainerId: string): ReturnType<ModelPullService['resolveLocal']> {
    const local = this.resolveLocal(targetId);
    if (local.selectedContainerId !== expectedContainerId) {
      throw new ModelPullError(
        'TARGET_BINDING_STALE',
        409,
        'Ollama target binding changed after the pull job was accepted.',
      );
    }
    return local;
  }

  private async resolveRoute(targetId: string, expectedContainerId: string): Promise<ResolvedPullTarget> {
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
        throw new ModelPullError(error.code, statusCode, 'Remote SSH pull preflight failed.', { cause: error });
      }
      throw error;
    }
    if (inspectResult.exitCode !== 0) {
      const detail = `${inspectResult.stdout}\n${inspectResult.stderr}`;
      if (/no such (object|container)/iu.test(detail)) throw new ModelPullError('CONTAINER_NOT_FOUND', 404, 'Ollama container was not found.');
      throw new ModelPullError('DOCKER_UNAVAILABLE', 502, 'Docker inspect failed.');
    }
    const inspect = parseInspect(inspectResult.stdout);
    if (!Boolean(inspect.State?.Running)) throw new ModelPullError('CONTAINER_NOT_RUNNING', 409, 'Ollama container is not running.');
    const route = selectOllamaApiRoute(inspect);
    if (!route) throw new ModelPullError('OLLAMA_API_UNAVAILABLE', 502, 'No safe Ollama API route could be derived from Docker state.');
    return { targetId, ...local, route };
  }

  start(targetId: string, actorUserId: string, modelValue: unknown): PublicPullJob {
    if (this.shuttingDown) throw new ModelPullError('SERVER_SHUTTING_DOWN', 503, 'Model pull service is shutting down.');
    const model = normalizePullModelName(modelValue);
    const target = this.resolveLocal(targetId);
    const expectedContainerId = target.selectedContainerId;
    const job = this.jobs.create({ targetId, actorUserId, kind: 'model-pull', mutating: true });
    this.jobs.appendEvent(job.id, 'pull-request', { model });
    this.audit.record({
      actorUserId,
      hostId: target.hostId,
      targetId,
      action: 'model.pull.requested',
      parameters: { model },
      result: 'accepted',
      jobId: job.id,
    });

    let task!: Promise<void>;
    task = this.run(job.id, actorUserId, model, expectedContainerId)
      .catch(() => {
        if (this.shuttingDown) return;
        try {
          const current = this.jobs.get(job.id);
          if (current.state === 'queued' || current.state === 'running' || current.state === 'cancelling') {
            this.jobs.transition(job.id, 'failed', { errorClass: 'PULL_INTERNAL_ERROR' });
          }
        } catch {
          // A detached worker must never create an unhandled rejection.
        }
      })
      .finally(() => { this.tasks.delete(task); });
    this.tasks.add(task);
    return publicJob(job);
  }

  private async run(jobId: string, actorUserId: string, model: string, expectedContainerId: string): Promise<void> {
    const initial = this.jobs.get(jobId);
    if (initial.state !== 'queued') return;
    try {
      this.assertExpectedBinding(initial.targetId, expectedContainerId);
    } catch (error) {
      this.fail(jobId, actorUserId, initial.targetId, error instanceof ModelPullError ? error.code : 'TARGET_BINDING_STALE');
      return;
    }

    let baseline: InstalledOllamaModelView | null;
    try {
      const inventory = await this.inventory.read(initial.targetId);
      baseline = matchingInstalledModel(inventory.installed, model);
    } catch {
      if (this.shuttingDown) return;
      this.fail(jobId, actorUserId, initial.targetId, 'PULL_PREFLIGHT_FAILED');
      return;
    }
    if (this.shuttingDown) return;

    const controller = new AbortController();
    this.controllers.set(jobId, controller);
    try {
      this.assertExpectedBinding(initial.targetId, expectedContainerId);
      const running = this.jobs.transition(jobId, 'running', {
        result: {
          model,
          previousDigest: baseline?.digest ?? null,
          selectedContainerId: expectedContainerId,
        },
      });
      this.jobs.appendEvent(jobId, 'pull-baseline', { model, previousDigest: baseline?.digest ?? null });
      const target = await this.resolveRoute(running.targetId, expectedContainerId);
      let sawSuccess = false;
      let lastPersistedAt = 0;
      let lastStatus: string | null = null;
      let lastDigest: string | null = null;
      let lastPercentage: number | null = null;

      await streamOllamaPullViaPinnedSsh(
        target.connection,
        target.route.host,
        target.route.port,
        model,
        {
          signal: controller.signal,
          onProgress: (progress) => {
            if (progress.status === 'success') sawSuccess = true;
            const payload = progressPayload(progress);
            const percentage = payload.percentage as number | null;
            const timestamp = this.now().getTime();
            const meaningful = (
              progress.status !== lastStatus
              || progress.digest !== lastDigest
              || percentage !== lastPercentage
              || progress.status === 'success'
              || (progress.total !== null && progress.completed === progress.total)
              || timestamp - lastPersistedAt >= PROGRESS_MIN_INTERVAL_MS
            );
            if (!meaningful) return;
            this.jobs.appendEvent(jobId, 'progress', payload);
            lastPersistedAt = timestamp;
            lastStatus = progress.status;
            lastDigest = progress.digest;
            lastPercentage = percentage;
          },
        },
      );

      if (this.shuttingDown) return;
      if (this.jobs.get(jobId).state === 'cancelling') {
        this.fail(jobId, actorUserId, running.targetId, 'CANCEL_UNVERIFIED');
        return;
      }
      if (!sawSuccess) {
        this.fail(jobId, actorUserId, running.targetId, 'PULL_STREAM_INCOMPLETE');
        return;
      }
      try {
        this.assertExpectedBinding(running.targetId, expectedContainerId);
      } catch (error) {
        this.fail(jobId, actorUserId, running.targetId, error instanceof ModelPullError ? error.code : 'TARGET_BINDING_STALE');
        return;
      }

      let installed: InstalledOllamaModelView | null = null;
      try {
        const verified = await this.inventory.read(running.targetId);
        installed = matchingInstalledModel(verified.installed, model);
      } catch {
        this.fail(jobId, actorUserId, running.targetId, 'PULL_VERIFICATION_FAILED');
        return;
      }
      if (!installed) {
        this.fail(jobId, actorUserId, running.targetId, 'PULL_VERIFICATION_FAILED');
        return;
      }
      this.jobs.transition(jobId, 'succeeded', {
        result: { model, digest: installed.digest, sizeBytes: installed.sizeBytes },
      });
      this.auditTerminal(actorUserId, target.hostId, running.targetId, jobId, model, 'succeeded', null);
    } catch (error) {
      if (this.shuttingDown && controller.signal.aborted) return;
      const current = this.jobs.get(jobId);
      if (current.state === 'cancelling' || (error instanceof OllamaPullStreamError && error.code === 'PULL_ABORTED')) {
        this.fail(jobId, actorUserId, current.targetId, 'CANCEL_UNVERIFIED');
        return;
      }
      const errorClass = error instanceof ModelPullError
        ? error.code
        : error instanceof OllamaPullStreamError
          ? error.code
          : error instanceof JobServiceError
            ? error.code
            : 'PULL_FAILED';
      this.fail(jobId, actorUserId, current.targetId, errorClass);
    } finally {
      this.controllers.delete(jobId);
    }
  }

  cancel(jobId: string, actorUserId: string): PublicPullJob {
    const job = this.jobs.get(jobId);
    if (job.actorUserId !== actorUserId) throw new ModelPullError('JOB_NOT_FOUND', 404, 'Job was not found.');
    if (job.kind !== 'model-pull') throw new ModelPullError('JOB_NOT_CANCELLABLE', 409, 'Job is not a model pull job.');
    if (job.state === 'queued') {
      const cancelled = this.jobs.transition(job.id, 'cancelled', { errorClass: null });
      this.auditTerminal(actorUserId, this.hostIdForTarget(job.targetId), job.targetId, job.id, null, 'cancelled', null);
      return publicJob(cancelled);
    }
    if (job.state === 'running') {
      const cancelling = this.jobs.transition(job.id, 'cancelling');
      this.controllers.get(job.id)?.abort();
      return publicJob(cancelling);
    }
    if (job.state === 'cancelling') return publicJob(job);
    throw new ModelPullError('JOB_ALREADY_TERMINAL', 409, 'Model pull job is already terminal.');
  }

  get(jobId: string, actorUserId: string): PublicPullJob {
    const job = this.jobs.get(jobId);
    if (job.actorUserId !== actorUserId || job.kind !== 'model-pull') throw new ModelPullError('JOB_NOT_FOUND', 404, 'Job was not found.');
    return publicJob(job);
  }

  events(jobId: string, actorUserId: string) {
    this.get(jobId, actorUserId);
    return this.jobs.events(jobId);
  }

  async reconcile(): Promise<void> {
    for (const job of this.jobs.jobsNeedingReconciliation()) {
      if (job.kind !== 'model-pull') continue;
      let model: string | null = null;
      let errorClass: string | null = null;
      let result = 'failed';
      try {
        if (job.state === 'queued') {
          errorClass = 'PULL_INTERRUPTED_BEFORE_START';
          this.jobs.transition(job.id, 'failed', { errorClass });
          continue;
        }
        if (job.state === 'cancelling') {
          errorClass = 'CANCEL_UNVERIFIED';
          this.jobs.transition(job.id, 'failed', { errorClass });
          continue;
        }
        const metadata = runningMetadata(job);
        if (!metadata) {
          errorClass = 'PULL_OUTCOME_UNKNOWN';
          this.jobs.transition(job.id, 'failed', { errorClass });
          continue;
        }
        model = metadata.model;
        const currentBinding = this.targets.findById(job.targetId)?.selectedContainerId ?? null;
        if (currentBinding !== metadata.selectedContainerId) {
          errorClass = 'TARGET_BINDING_STALE';
          this.jobs.transition(job.id, 'failed', { errorClass });
          continue;
        }
        const current = matchingInstalledModel((await this.inventory.read(job.targetId)).installed, metadata.model);
        if (current && (metadata.previousDigest === null || current.digest !== metadata.previousDigest)) {
          this.jobs.transition(job.id, 'succeeded', {
            result: { model: metadata.model, digest: current.digest, sizeBytes: current.sizeBytes, reconciled: true },
          });
          result = 'succeeded';
        } else {
          errorClass = 'PULL_OUTCOME_UNKNOWN';
          this.jobs.transition(job.id, 'failed', { errorClass });
        }
      } catch {
        const latest = this.jobs.get(job.id);
        if (latest.state === 'running') {
          errorClass = 'PULL_RECONCILIATION_FAILED';
          this.jobs.transition(job.id, 'failed', { errorClass });
        }
      } finally {
        const terminal = this.jobs.get(job.id);
        if (terminal.state === 'succeeded') result = 'succeeded';
        else if (terminal.state === 'cancelled') result = 'cancelled';
        else if (terminal.state === 'failed') errorClass = terminal.errorClass ?? errorClass;
        if (terminal.state === 'succeeded' || terminal.state === 'failed' || terminal.state === 'cancelled') {
          this.auditTerminal(
            terminal.actorUserId,
            this.hostIdForTarget(terminal.targetId),
            terminal.targetId,
            terminal.id,
            model,
            result,
            errorClass,
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

  private fail(jobId: string, actorUserId: string, targetId: string, errorClass: string): void {
    const current = this.jobs.get(jobId);
    if (current.state === 'failed' || current.state === 'succeeded' || current.state === 'cancelled') return;
    const failed = this.jobs.transition(jobId, 'failed', { errorClass });
    this.auditTerminal(
      actorUserId,
      this.hostIdForTarget(targetId),
      targetId,
      jobId,
      null,
      failed.state,
      errorClass,
    );
  }

  private auditTerminal(
    actorUserId: string,
    hostId: string | null,
    targetId: string,
    jobId: string,
    model: string | null,
    result: string,
    errorClass: string | null,
  ): void {
    this.audit.record({
      actorUserId,
      hostId,
      targetId,
      action: 'model.pull.terminal',
      parameters: model ? { model } : {},
      result,
      errorClass,
      jobId,
    });
  }
}
