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
import type {
  InstalledOllamaModelView,
  ModelInventoryView,
  RunningOllamaModelView,
  OllamaModelInventoryService,
} from './ollama-models.js';
import {
  OllamaSmokeHttpError,
  smokeTestOllamaModelViaPinnedSsh,
} from './ollama-smoke-http.js';

const MAX_MODEL_NAME = 512;

export interface ModelSmokeConfirmation {
  readonly action?: unknown;
  readonly targetId?: unknown;
  readonly model?: unknown;
  readonly digest?: unknown;
}

export interface PublicModelSmokeJob {
  readonly id: string;
  readonly targetId: string;
  readonly kind: 'model-smoke-test';
  readonly state: StoredJob['state'];
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly errorClass: string | null;
}

export interface ModelSmokeResult {
  readonly job: PublicModelSmokeJob;
  readonly model: string;
  readonly digest: string;
  readonly verified: true;
  readonly elapsedMs: number;
  readonly responseChars: number;
  readonly doneReason: string | null;
}

export class ModelSmokeError extends Error {
  constructor(
    readonly code: string,
    readonly statusCode: number,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

interface ResolvedSmokeTarget {
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
  if (typeof value !== 'string') throw new ModelSmokeError('INVALID_MODEL_NAME', 400, 'Model name is required.');
  const model = value.trim();
  if (
    !model
    || model.length > MAX_MODEL_NAME
    || /[\u0000-\u0020\u007f]/u.test(model)
    || !/^[A-Za-z0-9][A-Za-z0-9._/:@+-]*$/u.test(model)
    || model.includes('://')
    || /[/:]$/u.test(model)
  ) {
    throw new ModelSmokeError('INVALID_MODEL_NAME', 400, 'Model name is invalid.');
  }
  return canonicalOllamaModelName(model);
}

function normalizedDigest(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/iu.test(value.trim())) {
    throw new ModelSmokeError('INVALID_MODEL_DIGEST', 400, 'Installed model digest is invalid.');
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
    throw new ModelSmokeError('DOCKER_OUTPUT_INVALID', 502, 'Docker inspect returned invalid data.');
  }
}

function publicJob(job: StoredJob): PublicModelSmokeJob {
  return {
    id: job.id,
    targetId: job.targetId,
    kind: 'model-smoke-test',
    state: job.state,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    errorClass: job.errorClass,
  };
}

function installedNameMatches(
  inventory: ModelInventoryView,
  canonicalModel: string,
): readonly InstalledOllamaModelView[] {
  return inventory.installed.filter((entry) => (
    canonicalOllamaModelName(entry.name) === canonicalModel
    || canonicalOllamaModelName(entry.model) === canonicalModel
  ));
}

function runningNameMatches(
  inventory: ModelInventoryView,
  canonicalModel: string,
): readonly RunningOllamaModelView[] {
  return inventory.running.filter((entry) => (
    canonicalOllamaModelName(entry.name) === canonicalModel
    || canonicalOllamaModelName(entry.model) === canonicalModel
  ));
}

function mapError(error: unknown): ModelSmokeError {
  if (error instanceof OllamaSmokeHttpError) {
    const statusCode = error.code === 'SSH_HOST_KEY_MISMATCH' ? 409 : 502;
    return new ModelSmokeError(error.code, statusCode, error.message, { cause: error });
  }
  if (error instanceof SshTransportError) {
    const statusCode = error.code === 'SSH_HOST_KEY_MISMATCH' ? 409 : error.code === 'AUTH_FAILED' ? 422 : 502;
    return new ModelSmokeError(error.code, statusCode, 'Remote SSH smoke-test preflight failed.', { cause: error });
  }
  if (error instanceof JobServiceError) return new ModelSmokeError(error.code, error.statusCode, error.message, { cause: error });
  if (error instanceof ModelSmokeError) return error;
  return new ModelSmokeError('MODEL_SMOKE_FAILED', 500, 'Model smoke test failed.');
}

export class ModelSmokeService {
  constructor(
    private readonly hosts: HostOnboardingRepository,
    private readonly credentials: SshCredentialRepository,
    private readonly targets: OllamaTargetRepository,
    private readonly masterKey: Buffer | null,
    private readonly jobs: JobService,
    private readonly audit: AuditService,
    private readonly inventory: OllamaModelInventoryService,
  ) {}

  private resolveLocal(targetId: string): { hostId: string; selectedContainerId: string; connection: SshPrivateKeyConnection } {
    if (!this.masterKey) throw new ModelSmokeError('MASTER_KEY_REQUIRED', 503, 'External master key is required.');
    const target = this.targets.findById(targetId);
    if (!target || !target.enabled) throw new ModelSmokeError('TARGET_NOT_FOUND', 404, 'Ollama target was not found or is disabled.');
    const host = this.hosts.findHostById(target.hostId);
    if (!host || !host.enabled) throw new ModelSmokeError('HOST_NOT_FOUND', 404, 'Host was not found or is disabled.');
    const credential = this.credentials.findByHostId(host.id);
    if (!credential) throw new ModelSmokeError('SSH_CREDENTIAL_NOT_FOUND', 409, 'Host has no SSH credential.');
    let privateKey: string;
    try {
      privateKey = new SecretCipher(this.masterKey).decrypt(
        { credentialId: credential.id, hostId: host.id },
        credential.encryptedPrivateKey,
      );
    } catch {
      throw new ModelSmokeError('SSH_CREDENTIAL_INVALID', 409, 'Stored SSH credential could not be decrypted.');
    }
    const selectedContainerId = normalizedContainerId(target.selectedContainerId);
    if (!selectedContainerId) throw new ModelSmokeError('TARGET_BINDING_INVALID', 409, 'Ollama target has an invalid selected container binding.');
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
      throw new ModelSmokeError('TARGET_BINDING_STALE', 409, 'Ollama target binding changed during model smoke test.');
    }
    return local;
  }

  private async resolveRoute(targetId: string, expectedContainerId: string): Promise<ResolvedSmokeTarget> {
    const local = this.assertExpectedBinding(targetId, expectedContainerId);
    let inspectResult;
    try {
      inspectResult = await execPrivateKey(
        local.connection,
        ['docker', 'inspect', local.selectedContainerId],
        { timeoutMs: 10_000, maxOutputBytes: 2 * 1024 * 1024 },
      );
    } catch (error) {
      throw mapError(error);
    }
    if (inspectResult.exitCode !== 0) {
      const detail = `${inspectResult.stderr}\n${inspectResult.stdout}`;
      if (/no such (object|container)/iu.test(detail)) throw new ModelSmokeError('CONTAINER_NOT_FOUND', 404, 'Ollama container was not found.');
      throw new ModelSmokeError('DOCKER_UNAVAILABLE', 502, 'Docker inspect failed.');
    }
    const inspect = parseInspect(inspectResult.stdout);
    if (!Boolean(inspect.State?.Running)) throw new ModelSmokeError('CONTAINER_NOT_RUNNING', 409, 'Ollama container is not running.');
    const route = selectOllamaApiRoute(inspect);
    if (!route) throw new ModelSmokeError('OLLAMA_API_UNAVAILABLE', 502, 'No safe Ollama API route could be derived from Docker state.');
    return {
      targetId,
      hostId: local.hostId,
      selectedContainerId: local.selectedContainerId,
      connection: local.connection,
      route,
    };
  }

  private assertConfirmation(
    targetId: string,
    canonicalModel: string,
    digest: string,
    confirmation: ModelSmokeConfirmation | undefined,
  ): void {
    if (
      confirmation?.action !== 'smoke-test'
      || confirmation.targetId !== targetId
      || normalizedModel(confirmation.model) !== canonicalModel
      || normalizedDigest(confirmation.digest) !== digest
    ) {
      throw new ModelSmokeError('CONFIRMATION_REQUIRED', 400, 'Model smoke test requires confirmation of the exact target, model and installed digest.');
    }
  }

  async execute(
    targetId: string,
    actorUserId: string,
    modelValue: unknown,
    digestValue: unknown,
    confirmation?: ModelSmokeConfirmation,
  ): Promise<ModelSmokeResult> {
    const canonicalModel = normalizedModel(modelValue);
    const requestedDigest = normalizedDigest(digestValue);
    this.assertConfirmation(targetId, canonicalModel, requestedDigest, confirmation);

    const local = this.resolveLocal(targetId);
    const expectedContainerId = local.selectedContainerId;
    const safe = { model: canonicalModel, digest: requestedDigest, selectedContainerId: expectedContainerId };

    let job: StoredJob;
    try {
      job = this.jobs.create({ targetId, actorUserId, kind: 'model-smoke-test', mutating: true });
    } catch (error) {
      throw mapError(error);
    }

    try {
      this.audit.record({
        actorUserId,
        hostId: local.hostId,
        targetId,
        action: 'model.smoke.requested',
        parameters: safe,
        result: 'queued',
        jobId: job.id,
      });
      this.jobs.transition(job.id, 'running', { result: safe });

      this.assertExpectedBinding(targetId, expectedContainerId);
      const before = await this.inventory.read(targetId);
      this.assertExpectedBinding(targetId, expectedContainerId);
      const sameName = installedNameMatches(before, canonicalModel);
      const exactInstalled = sameName.filter((entry) => entry.digest === requestedDigest);
      if (exactInstalled.length === 0) {
        if (sameName.length > 0) {
          throw new ModelSmokeError('MODEL_SMOKE_STALE', 409, 'The confirmed installed model name now has a different digest. Refresh models before retrying.');
        }
        throw new ModelSmokeError('MODEL_NOT_INSTALLED', 409, 'The confirmed model is no longer installed.');
      }
      if (exactInstalled.length !== 1) throw new ModelSmokeError('MODEL_MATCH_AMBIGUOUS', 409, 'Installed model identity is ambiguous.');
      if (runningNameMatches(before, canonicalModel).length > 0) {
        throw new ModelSmokeError('MODEL_SMOKE_ALREADY_LOADED', 409, 'The model is already loaded. This smoke-test slice refuses to alter an existing loaded-model lease.');
      }

      const executionTarget = await this.resolveRoute(targetId, expectedContainerId);
      const smoke = await smokeTestOllamaModelViaPinnedSsh(
        executionTarget.connection,
        executionTarget.route.host,
        executionTarget.route.port,
        canonicalModel,
      );

      this.assertExpectedBinding(targetId, expectedContainerId);
      const after = await this.inventory.read(targetId);
      this.assertExpectedBinding(targetId, expectedContainerId);
      const afterSameName = installedNameMatches(after, canonicalModel);
      const afterExact = afterSameName.filter((entry) => entry.digest === requestedDigest);
      if (afterExact.length !== 1) {
        throw new ModelSmokeError('MODEL_SMOKE_INSTALL_CHANGED', 409, 'Installed model identity changed during the smoke test.');
      }
      if (runningNameMatches(after, canonicalModel).length > 0) {
        throw new ModelSmokeError('MODEL_SMOKE_CLEANUP_FAILED', 502, 'The smoke-tested model remained loaded after keep_alive=0.');
      }

      const verified = {
        ...safe,
        elapsedMs: smoke.elapsedMs,
        responseChars: smoke.responseChars,
        doneReason: smoke.doneReason,
      };
      this.audit.record({
        actorUserId,
        hostId: executionTarget.hostId,
        targetId,
        action: 'model.smoke.verified',
        parameters: verified,
        result: 'succeeded',
        jobId: job.id,
      });
      const terminal = this.jobs.transition(job.id, 'succeeded', {
        result: { ...verified, verified: true },
        exitCode: 0,
      });
      return {
        job: publicJob(terminal),
        model: canonicalModel,
        digest: requestedDigest,
        verified: true,
        elapsedMs: smoke.elapsedMs,
        responseChars: smoke.responseChars,
        doneReason: smoke.doneReason,
      };
    } catch (error) {
      const failure = mapError(error);
      try {
        this.audit.record({
          actorUserId,
          hostId: local.hostId,
          targetId,
          action: 'model.smoke.failed',
          parameters: safe,
          result: 'failed',
          errorClass: failure.code,
          jobId: job.id,
        });
      } catch { /* preserve operation error */ }
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
