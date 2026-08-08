import { randomUUID } from 'node:crypto';
import type {
  HostOnboardingRepository,
  OllamaTargetRepository,
  SshCredentialRepository,
  UpdateSnapshotRepository,
} from '@orc/core';
import {
  captureDockerRollbackState,
  DockerPreflightError,
  type DockerUpdatePreflightMetadata,
} from '@orc/docker';
import { SecretCipher, UpdateSnapshotCipher } from '@orc/security';
import {
  execPrivateKey,
  SshTransportError,
  type SshPrivateKeyConnection,
} from '@orc/ssh';
import { AuditService } from './audit.js';

export interface PublicUpdateSnapshot {
  readonly id: string;
  readonly targetId: string;
  readonly createdAt: string;
  readonly metadata: DockerUpdatePreflightMetadata;
}

export class UpdatePreflightError extends Error {
  constructor(
    readonly code: string,
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

interface ResolvedTarget {
  readonly targetId: string;
  readonly hostId: string;
  readonly containerId: string;
  readonly connection: SshPrivateKeyConnection;
}

function classifyPreflightError(error: unknown): UpdatePreflightError {
  if (error instanceof UpdatePreflightError) return error;
  if (error instanceof DockerPreflightError) {
    const statusCode = error.code === 'CONTAINER_NOT_FOUND' ? 404 : 502;
    return new UpdatePreflightError(error.code, statusCode, error.message);
  }
  if (error instanceof SshTransportError) {
    const statusCode = error.code === 'SSH_HOST_KEY_MISMATCH' ? 409 : error.code === 'AUTH_FAILED' ? 422 : 502;
    return new UpdatePreflightError(error.code, statusCode, 'Remote SSH preflight failed.');
  }
  return new UpdatePreflightError('UPDATE_PREFLIGHT_FAILED', 500, 'Update preflight failed.');
}

export class UpdatePreflightService {
  constructor(
    private readonly hosts: HostOnboardingRepository,
    private readonly credentials: SshCredentialRepository,
    private readonly targets: OllamaTargetRepository,
    private readonly snapshots: UpdateSnapshotRepository,
    private readonly masterKey: Buffer | null,
    private readonly audit: AuditService,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private resolveTarget(targetId: string): ResolvedTarget {
    if (!this.masterKey) {
      throw new UpdatePreflightError(
        'MASTER_KEY_REQUIRED',
        503,
        'External master key is required to create encrypted rollback snapshots.',
      );
    }
    const target = this.targets.findById(targetId);
    if (!target || !target.enabled) {
      throw new UpdatePreflightError('TARGET_NOT_FOUND', 404, 'Ollama target was not found or is disabled.');
    }
    const host = this.hosts.findHostById(target.hostId);
    if (!host || !host.enabled) {
      throw new UpdatePreflightError('HOST_NOT_FOUND', 404, 'Host was not found or is disabled.');
    }
    const credential = this.credentials.findByHostId(host.id);
    if (!credential) {
      throw new UpdatePreflightError('SSH_CREDENTIAL_NOT_FOUND', 409, 'Host has no SSH credential.');
    }
    const privateKey = new SecretCipher(this.masterKey).decrypt(
      { credentialId: credential.id, hostId: host.id },
      credential.encryptedPrivateKey,
    );
    return {
      targetId: target.id,
      hostId: host.id,
      containerId: target.selectedContainerId,
      connection: {
        hostname: host.hostname,
        port: host.port,
        username: host.username,
        privateKey,
        expectedFingerprint: host.hostKeyFingerprint,
      },
    };
  }

  async capture(targetId: string, actorUserId: string): Promise<PublicUpdateSnapshot> {
    const resolved = this.resolveTarget(targetId);
    this.audit.record({
      actorUserId,
      hostId: resolved.hostId,
      targetId: resolved.targetId,
      action: 'container.update_preflight.requested',
      parameters: { targetId: resolved.targetId, containerId: resolved.containerId },
      result: 'requested',
    });

    try {
      const executor = {
        exec: (argv: readonly string[]) => execPrivateKey(
          resolved.connection,
          argv,
          { timeoutMs: 30_000, maxOutputBytes: 2 * 1024 * 1024 },
        ),
      };
      const capture = await captureDockerRollbackState(executor, resolved.containerId);
      const snapshotId = randomUUID();
      const createdAt = this.now().toISOString();
      const encryptedPayload = new UpdateSnapshotCipher(this.masterKey!).encrypt(
        { snapshotId, targetId: resolved.targetId },
        capture.rawPayloadJson,
      );
      this.snapshots.save({
        id: snapshotId,
        targetId: resolved.targetId,
        actorUserId,
        createdAt,
        publicMetadataJson: JSON.stringify(capture.metadata),
        encryptedPayload,
      });

      try {
        this.audit.record({
          actorUserId,
          hostId: resolved.hostId,
          targetId: resolved.targetId,
          action: 'container.update_preflight.snapshot_created',
          parameters: {
            snapshotId,
            targetId: resolved.targetId,
            containerId: resolved.containerId,
            imageReference: capture.metadata.imageReference,
            imageId: capture.metadata.imageId,
            composeManaged: capture.metadata.compose.managed,
          },
          result: 'succeeded',
        });
      } catch {
        // The immutable snapshot remains valid even if the secondary audit write fails.
      }
      return { id: snapshotId, targetId: resolved.targetId, createdAt, metadata: capture.metadata };
    } catch (error) {
      const failure = classifyPreflightError(error);
      try {
        this.audit.record({
          actorUserId,
          hostId: resolved.hostId,
          targetId: resolved.targetId,
          action: 'container.update_preflight.failed',
          parameters: { targetId: resolved.targetId, containerId: resolved.containerId },
          result: 'failed',
          errorClass: failure.code,
        });
      } catch {
        // Preserve the primary preflight failure.
      }
      throw failure;
    }
  }
}
