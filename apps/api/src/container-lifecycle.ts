import type {
  HostOnboardingRepository,
  OllamaTargetRepository,
  SshCredentialRepository,
  StoredJob,
} from '@orc/core';
import {
  changeDockerContainerState,
  DockerLifecycleError,
  inspectDockerContainer,
  type DockerContainerStatus,
  type DockerLifecycleAction,
} from '@orc/docker';
import { SecretCipher } from '@orc/security';
import {
  execPrivateKey,
  SshTransportError,
  type SshPrivateKeyConnection,
} from '@orc/ssh';
import { AuditService } from './audit.js';
import { JobService, JobServiceError } from './jobs.js';

export interface ContainerLifecycleConfirmation {
  readonly action?: unknown;
  readonly targetId?: unknown;
  readonly containerId?: unknown;
}

export interface PublicContainerLifecycleStatus extends Omit<DockerContainerStatus, 'env'> {}

export interface ContainerLifecycleResult {
  readonly job: StoredJob;
  readonly container: PublicContainerLifecycleStatus;
}

export class ContainerLifecycleError extends Error {
  constructor(
    readonly code: string,
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

interface ResolvedTarget {
  readonly target: {
    readonly id: string;
    readonly hostId: string;
    readonly selectedContainerId: string;
  };
  readonly hostId: string;
  readonly connection: SshPrivateKeyConnection;
}

function publicContainer(container: DockerContainerStatus): PublicContainerLifecycleStatus {
  const { env: _env, ...safe } = container;
  return safe;
}

function confirmationRequired(action: DockerLifecycleAction): boolean {
  return action === 'stop' || action === 'restart';
}

function classifyFailure(error: unknown): {
  code: string;
  statusCode: number;
  message: string;
  exitCode: number | null;
} {
  if (error instanceof DockerLifecycleError) {
    const statusCode = error.code === 'CONTAINER_NOT_FOUND' ? 404 : 502;
    return { code: error.code, statusCode, message: error.message, exitCode: error.exitCode };
  }
  if (error instanceof SshTransportError) {
    const statusCode = error.code === 'SSH_HOST_KEY_MISMATCH' ? 409 : error.code === 'AUTH_FAILED' ? 422 : 502;
    return { code: error.code, statusCode, message: 'Remote SSH operation failed.', exitCode: null };
  }
  if (error instanceof JobServiceError) {
    return { code: error.code, statusCode: error.statusCode, message: error.message, exitCode: null };
  }
  return { code: 'INTERNAL_ERROR', statusCode: 500, message: 'Container lifecycle operation failed.', exitCode: null };
}

export class ContainerLifecycleService {
  constructor(
    private readonly hosts: HostOnboardingRepository,
    private readonly credentials: SshCredentialRepository,
    private readonly targets: OllamaTargetRepository,
    private readonly masterKey: Buffer | null,
    private readonly jobs: JobService,
    private readonly audit: AuditService,
  ) {}

  private resolveTarget(targetId: string): ResolvedTarget {
    if (!this.masterKey) {
      throw new ContainerLifecycleError(
        'MASTER_KEY_REQUIRED',
        503,
        'External master key is required to use stored SSH credentials.',
      );
    }
    const target = this.targets.findById(targetId);
    if (!target || !target.enabled) {
      throw new ContainerLifecycleError('TARGET_NOT_FOUND', 404, 'Ollama target was not found or is disabled.');
    }
    const host = this.hosts.findHostById(target.hostId);
    if (!host || !host.enabled) {
      throw new ContainerLifecycleError('HOST_NOT_FOUND', 404, 'Host was not found or is disabled.');
    }
    const credential = this.credentials.findByHostId(host.id);
    if (!credential) {
      throw new ContainerLifecycleError('SSH_CREDENTIAL_NOT_FOUND', 409, 'Host has no SSH credential.');
    }
    const privateKey = new SecretCipher(this.masterKey).decrypt(
      { credentialId: credential.id, hostId: host.id },
      credential.encryptedPrivateKey,
    );
    return {
      target: {
        id: target.id,
        hostId: target.hostId,
        selectedContainerId: target.selectedContainerId,
      },
      hostId: host.id,
      connection: {
        hostname: host.hostname,
        port: host.port,
        username: host.username,
        privateKey,
        expectedFingerprint: host.hostKeyFingerprint,
      },
    };
  }

  private assertConfirmation(
    action: DockerLifecycleAction,
    resolved: ResolvedTarget,
    confirmation: ContainerLifecycleConfirmation | undefined,
  ): void {
    if (!confirmationRequired(action)) return;
    if (
      confirmation?.action !== action
      || confirmation.targetId !== resolved.target.id
      || confirmation.containerId !== resolved.target.selectedContainerId
    ) {
      throw new ContainerLifecycleError(
        'CONFIRMATION_REQUIRED',
        400,
        `Container ${action} requires confirmation of the exact action, target and selected container.`,
      );
    }
  }

  async execute(
    targetId: string,
    action: DockerLifecycleAction,
    actorUserId: string,
    confirmation?: ContainerLifecycleConfirmation,
  ): Promise<ContainerLifecycleResult> {
    const resolved = this.resolveTarget(targetId);
    this.assertConfirmation(action, resolved, confirmation);

    const job = this.jobs.create({
      targetId: resolved.target.id,
      actorUserId,
      kind: `container.${action}`,
      mutating: true,
    });
    const auditParameters = {
      action,
      targetId: resolved.target.id,
      containerId: resolved.target.selectedContainerId,
      confirmationRequired: confirmationRequired(action),
      confirmed: confirmationRequired(action) ? true : null,
    };

    try {
      this.audit.record({
        actorUserId,
        hostId: resolved.hostId,
        targetId: resolved.target.id,
        action: `container.${action}.requested`,
        parameters: auditParameters,
        result: 'queued',
        jobId: job.id,
      });

      const executor = {
        exec: (argv: readonly string[]) => execPrivateKey(
          resolved.connection,
          argv,
          { timeoutMs: 30_000, maxOutputBytes: 512 * 1024 },
        ),
      };
      const initial = await inspectDockerContainer(executor, resolved.target.selectedContainerId);
      this.jobs.transition(job.id, 'running', {
        result: {
          action,
          containerId: resolved.target.selectedContainerId,
          initialRunning: initial.running,
          initialStartedAt: initial.startedAt,
        },
      });

      const verified = await changeDockerContainerState(
        executor,
        resolved.target.selectedContainerId,
        action,
      );
      const safeContainer = publicContainer(verified);
      const result = {
        action,
        targetId: resolved.target.id,
        containerId: resolved.target.selectedContainerId,
        verified: true,
        running: verified.running,
        state: verified.state,
        status: verified.status,
      };

      this.audit.record({
        actorUserId,
        hostId: resolved.hostId,
        targetId: resolved.target.id,
        action: `container.${action}.verified`,
        parameters: auditParameters,
        result: 'succeeded',
        exitCode: 0,
        jobId: job.id,
      });
      const terminal = this.jobs.transition(job.id, 'succeeded', { result, exitCode: 0 });
      return { job: terminal, container: safeContainer };
    } catch (error) {
      const failure = classifyFailure(error);
      try {
        this.audit.record({
          actorUserId,
          hostId: resolved.hostId,
          targetId: resolved.target.id,
          action: `container.${action}.failed`,
          parameters: auditParameters,
          result: 'failed',
          exitCode: failure.exitCode,
          errorClass: failure.code,
          jobId: job.id,
        });
      } catch {
        // If audit persistence itself is unavailable, preserve the original operation failure.
      }
      try {
        const current = this.jobs.get(job.id);
        if (current.state === 'queued' || current.state === 'running' || current.state === 'cancelling') {
          this.jobs.transition(job.id, 'failed', {
            result: { action, targetId: resolved.target.id, containerId: resolved.target.selectedContainerId, verified: false },
            errorClass: failure.code,
            exitCode: failure.exitCode,
          });
        }
      } catch {
        // A concurrent/recovery path may have changed the job; do not overwrite that state.
      }
      throw new ContainerLifecycleError(failure.code, failure.statusCode, failure.message);
    }
  }
}