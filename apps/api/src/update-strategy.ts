import type {
  HostOnboardingRepository,
  OllamaTargetRepository,
  SshCredentialRepository,
  UpdateSnapshotRepository,
} from '@orc/core';
import {
  analyzeStandaloneReconstruction,
  composeContextFromInspect,
  DockerReconstructError,
  validateComposeStrategy,
  type StandaloneStrategy,
  type ValidatedComposeStrategy,
} from '@orc/docker/reconstruct';
import { SecretCipher, UpdateSnapshotCipher } from '@orc/security';
import {
  execPrivateKey,
  SshTransportError,
  type SshPrivateKeyConnection,
} from '@orc/ssh';
import { AuditService } from './audit.js';

export type UpdateExecutionStrategy = ValidatedComposeStrategy | StandaloneStrategy;

export interface UpdateStrategyResult {
  readonly snapshotId: string;
  readonly targetId: string;
  readonly strategy: UpdateExecutionStrategy;
}

export class UpdateStrategyError extends Error {
  constructor(
    readonly code: string,
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

interface SnapshotPayload {
  readonly schemaVersion: number;
  readonly containerInspect: Record<string, any>;
  readonly imageInspect: Record<string, any>;
  readonly ollamaVersion: string | null;
}

interface ResolvedSnapshot {
  readonly targetId: string;
  readonly hostId: string;
  readonly snapshotId: string;
  readonly containerId: string;
  readonly payload: SnapshotPayload;
  readonly host: {
    readonly hostname: string;
    readonly port: number;
    readonly username: string;
    readonly hostKeyFingerprint: string;
  };
}

function parsePayload(serialized: string): SnapshotPayload {
  try {
    const parsed = JSON.parse(serialized) as Record<string, any>;
    if (
      Number(parsed.schemaVersion) !== 1
      || !parsed.containerInspect
      || typeof parsed.containerInspect !== 'object'
      || !parsed.imageInspect
      || typeof parsed.imageInspect !== 'object'
    ) throw new Error('invalid snapshot');
    return {
      schemaVersion: 1,
      containerInspect: parsed.containerInspect,
      imageInspect: parsed.imageInspect,
      ollamaVersion: typeof parsed.ollamaVersion === 'string' ? parsed.ollamaVersion : null,
    };
  } catch {
    throw new UpdateStrategyError('UPDATE_SNAPSHOT_INVALID', 409, 'Encrypted update snapshot payload is invalid.');
  }
}

function classifyReconstruct(error: DockerReconstructError): UpdateStrategyError {
  return new UpdateStrategyError(
    error.code,
    error.code === 'COMPOSE_UNAVAILABLE' ? 422 : 409,
    error.message,
  );
}

export class UpdateStrategyService {
  constructor(
    private readonly hosts: HostOnboardingRepository,
    private readonly credentials: SshCredentialRepository,
    private readonly targets: OllamaTargetRepository,
    private readonly snapshots: UpdateSnapshotRepository,
    private readonly masterKey: Buffer | null,
    private readonly audit: AuditService,
  ) {}

  private resolve(targetId: string, snapshotId: string): ResolvedSnapshot {
    if (!this.masterKey) {
      throw new UpdateStrategyError('MASTER_KEY_REQUIRED', 503, 'External master key is required to read encrypted update snapshots.');
    }
    const target = this.targets.findById(targetId);
    if (!target || !target.enabled) throw new UpdateStrategyError('TARGET_NOT_FOUND', 404, 'Ollama target was not found or is disabled.');
    const snapshot = this.snapshots.findById(snapshotId);
    if (!snapshot) throw new UpdateStrategyError('UPDATE_SNAPSHOT_NOT_FOUND', 404, 'Update snapshot was not found.');
    if (snapshot.targetId !== target.id) {
      throw new UpdateStrategyError('UPDATE_SNAPSHOT_TARGET_MISMATCH', 409, 'Update snapshot does not belong to the requested target.');
    }
    let plaintext: string;
    try {
      plaintext = new UpdateSnapshotCipher(this.masterKey).decrypt(
        { snapshotId: snapshot.id, targetId: target.id },
        snapshot.encryptedPayload,
      );
    } catch {
      throw new UpdateStrategyError('UPDATE_SNAPSHOT_INVALID', 409, 'Encrypted update snapshot could not be authenticated or decrypted.');
    }
    const payload = parsePayload(plaintext);
    const snapshotContainerId = String(payload.containerInspect.Id ?? '').trim();
    if (!snapshotContainerId || snapshotContainerId !== target.selectedContainerId) {
      throw new UpdateStrategyError('UPDATE_SNAPSHOT_STALE', 409, 'Target container binding has changed since this snapshot was captured.');
    }
    const host = this.hosts.findHostById(target.hostId);
    if (!host || !host.enabled) throw new UpdateStrategyError('HOST_NOT_FOUND', 404, 'Host was not found or is disabled.');
    return {
      targetId: target.id,
      hostId: host.id,
      snapshotId: snapshot.id,
      containerId: target.selectedContainerId,
      payload,
      host: {
        hostname: host.hostname,
        port: host.port,
        username: host.username,
        hostKeyFingerprint: host.hostKeyFingerprint,
      },
    };
  }

  async create(targetId: string, snapshotId: string, actorUserId: string): Promise<UpdateStrategyResult> {
    const source = this.resolve(targetId, snapshotId);
    this.audit.record({
      actorUserId,
      hostId: source.hostId,
      targetId: source.targetId,
      action: 'container.update_strategy.requested',
      parameters: { snapshotId: source.snapshotId, targetId: source.targetId },
      result: 'requested',
    });

    try {
      const compose = composeContextFromInspect(source.payload.containerInspect);
      let strategy: UpdateExecutionStrategy;
      if (!compose) {
        strategy = analyzeStandaloneReconstruction(source.payload.containerInspect);
      } else {
        const credential = this.credentials.findByHostId(source.hostId);
        if (!credential) throw new UpdateStrategyError('SSH_CREDENTIAL_NOT_FOUND', 409, 'Host has no SSH credential.');
        let privateKey: string;
        try {
          privateKey = new SecretCipher(this.masterKey!).decrypt(
            { credentialId: credential.id, hostId: source.hostId },
            credential.encryptedPrivateKey,
          );
        } catch {
          throw new UpdateStrategyError('SSH_CREDENTIAL_INVALID', 409, 'Stored SSH credential could not be decrypted.');
        }
        const connection: SshPrivateKeyConnection = {
          hostname: source.host.hostname,
          port: source.host.port,
          username: source.host.username,
          privateKey,
          expectedFingerprint: source.host.hostKeyFingerprint,
        };
        strategy = await validateComposeStrategy(
          {
            exec: (argv: readonly string[]) => execPrivateKey(
              connection,
              argv,
              { timeoutMs: 30_000, maxOutputBytes: 512 * 1024 },
            ),
          },
          compose,
          source.containerId,
        );
      }

      try {
        this.audit.record({
          actorUserId,
          hostId: source.hostId,
          targetId: source.targetId,
          action: 'container.update_strategy.created',
          parameters: {
            snapshotId: source.snapshotId,
            type: strategy.type,
            executable: strategy.executable,
            unsupportedFields: strategy.type === 'standalone' ? strategy.unsupportedFields : [],
            composeService: strategy.type === 'compose' ? strategy.service : null,
          },
          result: 'succeeded',
        });
      } catch {
        // The read-only strategy remains valid if the secondary audit write fails.
      }
      return { snapshotId: source.snapshotId, targetId: source.targetId, strategy };
    } catch (error) {
      const failure = error instanceof DockerReconstructError
        ? classifyReconstruct(error)
        : error instanceof SshTransportError
          ? new UpdateStrategyError(error.code, error.code === 'SSH_HOST_KEY_MISMATCH' ? 409 : error.code === 'AUTH_FAILED' ? 422 : 502, 'Remote SSH Compose validation failed.')
          : error instanceof UpdateStrategyError
            ? error
            : new UpdateStrategyError('UPDATE_STRATEGY_FAILED', 500, 'Update execution strategy validation failed.');
      try {
        this.audit.record({
          actorUserId,
          hostId: source.hostId,
          targetId: source.targetId,
          action: 'container.update_strategy.failed',
          parameters: { snapshotId: source.snapshotId, targetId: source.targetId },
          result: 'failed',
          errorClass: failure.code,
        });
      } catch {
        // Preserve the primary validation failure.
      }
      throw failure;
    }
  }
}
