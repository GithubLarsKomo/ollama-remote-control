import type {
  HostOnboardingRepository,
  OllamaTargetRepository,
  SshCredentialRepository,
  StoredJob,
} from '@orc/core';
import { canonicalOllamaModelName } from '@orc/core/modelfile-deploy';
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
  parseRunningModels,
  type RunningOllamaModelView,
} from './ollama-models.js';
import {
  OllamaUnloadHttpError,
  unloadOllamaModelViaPinnedSsh,
} from './ollama-unload-http.js';
import { httpGetViaPinnedSsh, SshHttpError } from './ssh-http.js';

const MAX_MODEL_NAME = 512;
const MAX_PS_RESPONSE_BYTES = 1024 * 1024;

export interface ModelUnloadConfirmation {
  readonly action?: unknown;
  readonly targetId?: unknown;
  readonly model?: unknown;
  readonly digest?: unknown;
}

export interface PublicModelUnloadJob {
  readonly id: string;
  readonly targetId: string;
  readonly kind: 'model-unload';
  readonly state: StoredJob['state'];
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly errorClass: string | null;
}

export interface ModelUnloadResult {
  readonly job: PublicModelUnloadJob;
  readonly model: string;
  readonly digest: string;
  readonly verified: true;
}

export class ModelUnloadError extends Error {
  constructor(
    readonly code: string,
    readonly statusCode: number,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

interface ResolvedUnloadTarget {
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

function normalizedModel(value: unknown): string {
  if (typeof value !== 'string') throw new ModelUnloadError('INVALID_MODEL_NAME', 400, 'Model name is required.');
  const model = value.trim();
  if (
    !model
    || model.length > MAX_MODEL_NAME
    || /[\u0000-\u0020\u007f]/u.test(model)
    || !/^[A-Za-z0-9][A-Za-z0-9._/:@+-]*$/u.test(model)
    || model.includes('://')
    || /[/:]$/u.test(model)
  ) {
    throw new ModelUnloadError('INVALID_MODEL_NAME', 400, 'Model name is invalid.');
  }
  return canonicalOllamaModelName(model);
}

function normalizedDigest(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/iu.test(value.trim())) {
    throw new ModelUnloadError('INVALID_MODEL_DIGEST', 400, 'Loaded model digest is invalid.');
  }
  return value.trim().toLowerCase();
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
    throw new ModelUnloadError('DOCKER_OUTPUT_INVALID', 502, 'Docker inspect returned invalid data.');
  }
}

function publicJob(job: StoredJob): PublicModelUnloadJob {
  return {
    id: job.id,
    targetId: job.targetId,
    kind: 'model-unload',
    state: job.state,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    errorClass: job.errorClass,
  };
}

function exactLoadedMatch(
  running: readonly RunningOllamaModelView[],
  canonicalModel: string,
  digest: string,
): readonly RunningOllamaModelView[] {
  return running.filter((entry) => (
    entry.digest === digest
    && (
      canonicalOllamaModelName(entry.name) === canonicalModel
      || canonicalOllamaModelName(entry.model) === canonicalModel
    )
  ));
}

function mapTransportError(error: unknown): ModelUnloadError {
  if (error instanceof OllamaUnloadHttpError) {
    const statusCode = error.code === 'SSH_HOST_KEY_MISMATCH' ? 409 : 502;
    return new ModelUnloadError(error.code, statusCode, error.message, { cause: error });
  }
  if (error instanceof SshHttpError) {
    const statusCode = error.code === 'SSH_HOST_KEY_MISMATCH' ? 409 : 502;
    return new ModelUnloadError(error.code, statusCode, 'Ollama loaded-model verification failed.', { cause: error });
  }
  if (error instanceof SshTransportError) {
    const statusCode = error.code === 'SSH_HOST_KEY_MISMATCH' ? 409 : error.code === 'AUTH_FAILED' ? 422 : 502;
    return new ModelUnloadError(error.code, statusCode, 'Remote SSH unload preflight failed.', { cause: error });
  }
  if (error instanceof JobServiceError) return new ModelUnloadError(error.code, error.statusCode, error.message, { cause: error });
  if (error instanceof ModelUnloadError) return error;
  return new ModelUnloadError('MODEL_UNLOAD_FAILED', 500, 'Model unload failed.');
}

export class ModelUnloadService {
  constructor(
    private readonly hosts: HostOnboardingRepository,
    private readonly credentials: SshCredentialRepository,
    private readonly targets: OllamaTargetRepository,
    private readonly masterKey: Buffer | null,
    private readonly jobs: JobService,
    private readonly audit: AuditService,
  ) {}

  private resolveLocal(targetId: string): { hostId: string; selectedContainerId: string; connection: SshPrivateKeyConnection } {
    if (!this.masterKey) throw new ModelUnloadError('MASTER_KEY_REQUIRED', 503, 'External master key is required.');
    const target = this.targets.findById(targetId);
    if (!target || !target.enabled) throw new ModelUnloadError('TARGET_NOT_FOUND', 404, 'Ollama target was not found or is disabled.');
    const host = this.hosts.findHostById(target.hostId);
    if (!host || !host.enabled) throw new ModelUnloadError('HOST_NOT_FOUND', 404, 'Host was not found or is disabled.');
    const credential = this.credentials.findByHostId(host.id);
    if (!credential) throw new ModelUnloadError('SSH_CREDENTIAL_NOT_FOUND', 409, 'Host has no SSH credential.');
    let privateKey: string;
    try {
      privateKey = new SecretCipher(this.masterKey).decrypt(
        { credentialId: credential.id, hostId: host.id },
        credential.encryptedPrivateKey,
      );
    } catch {
      throw new ModelUnloadError('SSH_CREDENTIAL_INVALID', 409, 'Stored SSH credential could not be decrypted.');
    }
    const selectedContainerId = normalizedContainerId(target.selectedContainerId);
    if (!selectedContainerId) throw new ModelUnloadError('TARGET_BINDING_INVALID', 409, 'Ollama target has an invalid selected container binding.');
    return {
      hostId: host.id,
      selectedContainerId,
      connection: {
        hostname: host.hostname,
        port: host.port,
        username: host.username,
        privateKey,
        expectedFingerprint: host.hostKeyFingerprint,
      },
    };
  }

  private assertExpectedBinding(targetId: string, expectedContainerId: string) {
    const local = this.resolveLocal(targetId);
    if (local.selectedContainerId !== expectedContainerId) {
      throw new ModelUnloadError('TARGET_BINDING_STALE', 409, 'Ollama target binding changed during model unload.');
    }
    return local;
  }

  private async resolveRoute(targetId: string, expectedContainerId?: string): Promise<ResolvedUnloadTarget> {
    const local = expectedContainerId
      ? this.assertExpectedBinding(targetId, expectedContainerId)
      : this.resolveLocal(targetId);
    let inspectResult;
    try {
      inspectResult = await execPrivateKey(
        local.connection,
        ['docker', 'inspect', local.selectedContainerId],
        { timeoutMs: 10_000, maxOutputBytes: 2 * 1024 * 1024 },
      );
    } catch (error) {
      throw mapTransportError(error);
    }
    if (inspectResult.exitCode !== 0) {
      const detail = `${inspectResult.stderr}\n${inspectResult.stdout}`;
      if (/no such (object|container)/iu.test(detail)) throw new ModelUnloadError('CONTAINER_NOT_FOUND', 404, 'Ollama container was not found.');
      throw new ModelUnloadError('DOCKER_UNAVAILABLE', 502, 'Docker inspect failed.');
    }
    const inspect = parseInspect(inspectResult.stdout);
    if (!Boolean(inspect.State?.Running)) throw new ModelUnloadError('CONTAINER_NOT_RUNNING', 409, 'Ollama container is not running.');
    const route = selectOllamaApiRoute(inspect);
    if (!route) throw new ModelUnloadError('OLLAMA_API_UNAVAILABLE', 502, 'No safe Ollama API route could be derived from Docker state.');
    return {
      targetId,
      hostId: local.hostId,
      selectedContainerId: local.selectedContainerId,
      connection: local.connection,
      route,
    };
  }

  private async runningModels(target: ResolvedUnloadTarget): Promise<readonly RunningOllamaModelView[]> {
    let response;
    try {
      response = await httpGetViaPinnedSsh(
        target.connection,
        target.route.host,
        target.route.port,
        '/api/ps',
        { timeoutMs: 7_500, maxResponseBytes: MAX_PS_RESPONSE_BYTES },
      );
    } catch (error) {
      throw mapTransportError(error);
    }
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new ModelUnloadError('OLLAMA_API_ERROR', 502, `Ollama API returned HTTP ${response.statusCode}.`);
    }
    try { return parseRunningModels(response.body); }
    catch (error) {
      throw new ModelUnloadError('OLLAMA_MODEL_DATA_INVALID', 502, 'Ollama loaded-model inventory was invalid.', { cause: error });
    }
  }

  private assertConfirmation(
    targetId: string,
    canonicalModel: string,
    digest: string,
    confirmation: ModelUnloadConfirmation | undefined,
  ): void {
    if (
      confirmation?.action !== 'unload'
      || confirmation.targetId !== targetId
      || normalizedModel(confirmation.model) !== canonicalModel
      || normalizedDigest(confirmation.digest) !== digest
    ) {
      throw new ModelUnloadError('CONFIRMATION_REQUIRED', 400, 'Model unload requires confirmation of the exact target, model and loaded digest.');
    }
  }

  async execute(
    targetId: string,
    actorUserId: string,
    modelValue: unknown,
    digestValue: unknown,
    confirmation?: ModelUnloadConfirmation,
  ): Promise<ModelUnloadResult> {
    const canonicalModel = normalizedModel(modelValue);
    const requestedDigest = normalizedDigest(digestValue);
    this.assertConfirmation(targetId, canonicalModel, requestedDigest, confirmation);

    const preflightTarget = await this.resolveRoute(targetId);
    const preflightRunning = await this.runningModels(preflightTarget);
    const matches = exactLoadedMatch(preflightRunning, canonicalModel, requestedDigest);
    if (matches.length === 0) throw new ModelUnloadError('MODEL_NOT_LOADED', 409, 'The confirmed model/digest is no longer loaded.');
    if (matches.length !== 1) throw new ModelUnloadError('MODEL_MATCH_AMBIGUOUS', 409, 'Loaded model identity is ambiguous.');
    const loaded = matches[0];
    const serverModel = canonicalOllamaModelName(loaded.model);
    const expectedContainerId = preflightTarget.selectedContainerId;
    this.assertExpectedBinding(targetId, expectedContainerId);

    let job: StoredJob;
    try {
      job = this.jobs.create({ targetId, actorUserId, kind: 'model-unload', mutating: true });
    } catch (error) {
      throw mapTransportError(error);
    }

    const safe = {
      model: serverModel,
      digest: loaded.digest,
      selectedContainerId: expectedContainerId,
    };
    try {
      this.audit.record({
        actorUserId,
        hostId: preflightTarget.hostId,
        targetId,
        action: 'model.unload.requested',
        parameters: safe,
        result: 'queued',
        jobId: job.id,
      });
      this.jobs.transition(job.id, 'running', { result: safe });

      const executionTarget = await this.resolveRoute(targetId, expectedContainerId);
      await unloadOllamaModelViaPinnedSsh(
        executionTarget.connection,
        executionTarget.route.host,
        executionTarget.route.port,
        serverModel,
      );

      const verificationTarget = await this.resolveRoute(targetId, expectedContainerId);
      const after = await this.runningModels(verificationTarget);
      if (exactLoadedMatch(after, canonicalModel, loaded.digest).length !== 0) {
        throw new ModelUnloadError('MODEL_UNLOAD_VERIFICATION_FAILED', 502, 'Ollama still reports the confirmed model/digest as loaded.');
      }

      this.audit.record({
        actorUserId,
        hostId: verificationTarget.hostId,
        targetId,
        action: 'model.unload.verified',
        parameters: safe,
        result: 'succeeded',
        jobId: job.id,
      });
      const terminal = this.jobs.transition(job.id, 'succeeded', {
        result: { ...safe, verified: true },
        exitCode: 0,
      });
      return { job: publicJob(terminal), model: serverModel, digest: loaded.digest, verified: true };
    } catch (error) {
      const failure = mapTransportError(error);
      try {
        this.audit.record({
          actorUserId,
          hostId: preflightTarget.hostId,
          targetId,
          action: 'model.unload.failed',
          parameters: safe,
          result: 'failed',
          errorClass: failure.code,
          jobId: job.id,
        });
      } catch { /* preserve original operation error */ }
      try {
        const current = this.jobs.get(job.id);
        if (current.state === 'queued' || current.state === 'running' || current.state === 'cancelling') {
          this.jobs.transition(job.id, 'failed', {
            result: { ...safe, verified: false },
            errorClass: failure.code,
          });
        }
      } catch { /* do not overwrite concurrent terminal state */ }
      throw failure;
    }
  }
}
