import type {
  HostOnboardingRepository,
  OllamaTargetRepository,
  SshCredentialRepository,
  UpdateSnapshotRepository,
} from '@orc/core';
import {
  DockerRegistryError,
  inspectDockerRegistryCandidate,
  type DockerImagePlatform,
} from '@orc/docker/registry';
import { SecretCipher, UpdateSnapshotCipher } from '@orc/security';
import {
  execPrivateKey,
  SshTransportError,
  type SshPrivateKeyConnection,
} from '@orc/ssh';
import { AuditService } from './audit.js';

export interface UpdatePlan {
  readonly snapshotId: string;
  readonly targetId: string;
  readonly imageReference: string;
  readonly pinned: boolean;
  readonly currentDigest: string;
  readonly candidateDigest: string;
  readonly candidateIndexDigest: string | null;
  readonly platform: DockerImagePlatform;
  readonly updateAvailable: boolean;
  readonly currentOllamaVersion: string | null;
  readonly candidateOllamaVersion: string | null;
  readonly composeManaged: boolean;
  readonly modelVolumeBackup: {
    readonly included: false;
    readonly warning: string;
  };
}

export class UpdatePlanError extends Error {
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

interface ResolvedPlanSource {
  readonly targetId: string;
  readonly hostId: string;
  readonly snapshotId: string;
  readonly imageReference: string;
  readonly currentDigest: string;
  readonly pinned: boolean;
  readonly platform: DockerImagePlatform;
  readonly currentOllamaVersion: string | null;
  readonly composeManaged: boolean;
  readonly connection: SshPrivateKeyConnection | null;
}

const MODEL_VOLUME_WARNING = 'Rollback restores container/runtime configuration only; model data volumes are not backed up by this operation.';

function stripTagAndDigest(imageReference: string): string {
  const withoutDigest = imageReference.split('@', 1)[0];
  const slash = withoutDigest.lastIndexOf('/');
  const colon = withoutDigest.lastIndexOf(':');
  return colon > slash ? withoutDigest.slice(0, colon) : withoutDigest;
}

function canonicalRepository(repository: string): string {
  const value = repository.trim().toLowerCase();
  if (!value) return '';
  const parts = value.split('/');
  const first = parts[0];
  const explicitRegistry = first.includes('.') || first.includes(':') || first === 'localhost';
  if (!explicitRegistry) {
    if (parts.length === 1) return `docker.io/library/${parts[0]}`;
    return `docker.io/${parts.join('/')}`;
  }
  const registry = first === 'index.docker.io' ? 'docker.io' : first;
  const remainder = parts.slice(1);
  if (registry === 'docker.io' && remainder.length === 1) remainder.unshift('library');
  return `${registry}/${remainder.join('/')}`;
}

function digestFromReference(reference: string): string | null {
  const separator = reference.indexOf('@');
  if (separator < 0) return null;
  const digest = reference.slice(separator + 1).trim();
  return digest || null;
}

export function resolveCurrentImageDigest(imageReference: string, repoDigests: readonly string[]): {
  readonly pinned: boolean;
  readonly digest: string;
} {
  const pinnedDigest = digestFromReference(imageReference);
  if (pinnedDigest) return { pinned: true, digest: pinnedDigest };

  const expectedRepository = canonicalRepository(stripTagAndDigest(imageReference));
  const matches = repoDigests.flatMap((entry) => {
    const separator = entry.lastIndexOf('@');
    if (separator < 1) return [];
    const repository = canonicalRepository(entry.slice(0, separator));
    const digest = entry.slice(separator + 1).trim();
    return repository === expectedRepository && digest ? [digest] : [];
  });
  const unique = [...new Set(matches)];
  if (unique.length !== 1) {
    throw new UpdatePlanError(
      'CURRENT_IMAGE_DIGEST_UNAVAILABLE',
      409,
      'Snapshot does not contain exactly one current digest for the configured image repository.',
    );
  }
  return { pinned: false, digest: unique[0] };
}

function parseSnapshotPayload(serialized: string): SnapshotPayload {
  try {
    const parsed = JSON.parse(serialized) as Record<string, any>;
    if (
      Number(parsed.schemaVersion) !== 1
      || !parsed.containerInspect
      || typeof parsed.containerInspect !== 'object'
      || !parsed.imageInspect
      || typeof parsed.imageInspect !== 'object'
    ) {
      throw new Error('invalid snapshot shape');
    }
    return {
      schemaVersion: 1,
      containerInspect: parsed.containerInspect,
      imageInspect: parsed.imageInspect,
      ollamaVersion: typeof parsed.ollamaVersion === 'string' && parsed.ollamaVersion.trim()
        ? parsed.ollamaVersion.trim()
        : null,
    };
  } catch (error) {
    throw new UpdatePlanError('UPDATE_SNAPSHOT_INVALID', 409, 'Encrypted update snapshot payload is invalid.');
  }
}

function snapshotPlatform(payload: SnapshotPayload): DockerImagePlatform {
  const os = String(payload.imageInspect.Os ?? '').trim();
  const architecture = String(payload.imageInspect.Architecture ?? '').trim();
  const variantValue = String(payload.imageInspect.Variant ?? '').trim();
  if (!os || !architecture) {
    throw new UpdatePlanError('IMAGE_PLATFORM_UNKNOWN', 409, 'Snapshot does not contain image OS and architecture.');
  }
  return { os, architecture, variant: variantValue || null };
}

function snapshotComposeManaged(payload: SnapshotPayload): boolean {
  const labels = payload.containerInspect.Config?.Labels;
  return Boolean(
    labels
    && typeof labels === 'object'
    && labels['com.docker.compose.project']
    && labels['com.docker.compose.service'],
  );
}

function registryStatus(error: DockerRegistryError): number {
  if (error.code === 'REGISTRY_LOOKUP_UNAVAILABLE') return 422;
  if (error.code === 'IMAGE_PLATFORM_NOT_FOUND') return 409;
  return 502;
}

export class UpdatePlanService {
  constructor(
    private readonly hosts: HostOnboardingRepository,
    private readonly credentials: SshCredentialRepository,
    private readonly targets: OllamaTargetRepository,
    private readonly snapshots: UpdateSnapshotRepository,
    private readonly masterKey: Buffer | null,
    private readonly audit: AuditService,
  ) {}

  private resolve(targetId: string, snapshotId: string): ResolvedPlanSource {
    if (!this.masterKey) {
      throw new UpdatePlanError('MASTER_KEY_REQUIRED', 503, 'External master key is required to read encrypted update snapshots.');
    }
    const target = this.targets.findById(targetId);
    if (!target || !target.enabled) throw new UpdatePlanError('TARGET_NOT_FOUND', 404, 'Ollama target was not found or is disabled.');
    const snapshot = this.snapshots.findById(snapshotId);
    if (!snapshot) throw new UpdatePlanError('UPDATE_SNAPSHOT_NOT_FOUND', 404, 'Update snapshot was not found.');
    if (snapshot.targetId !== target.id) {
      throw new UpdatePlanError('UPDATE_SNAPSHOT_TARGET_MISMATCH', 409, 'Update snapshot does not belong to the requested target.');
    }
    let serializedPayload: string;
    try {
      serializedPayload = new UpdateSnapshotCipher(this.masterKey).decrypt(
        { snapshotId: snapshot.id, targetId: target.id },
        snapshot.encryptedPayload,
      );
    } catch {
      throw new UpdatePlanError('UPDATE_SNAPSHOT_INVALID', 409, 'Encrypted update snapshot could not be authenticated or decrypted.');
    }
    const payload = parseSnapshotPayload(serializedPayload);
    const snapshotContainerId = String(payload.containerInspect.Id ?? '').trim();
    if (!snapshotContainerId || snapshotContainerId !== target.selectedContainerId) {
      throw new UpdatePlanError('UPDATE_SNAPSHOT_STALE', 409, 'Target container binding has changed since this snapshot was captured.');
    }
    const imageReference = String(payload.containerInspect.Config?.Image ?? '').trim();
    if (!imageReference) throw new UpdatePlanError('UPDATE_SNAPSHOT_INVALID', 409, 'Snapshot has no configured image reference.');
    const repoDigests = Array.isArray(payload.imageInspect.RepoDigests) ? payload.imageInspect.RepoDigests.map(String) : [];
    const current = resolveCurrentImageDigest(imageReference, repoDigests);
    const platform = snapshotPlatform(payload);
    const host = this.hosts.findHostById(target.hostId);
    if (!host || !host.enabled) throw new UpdatePlanError('HOST_NOT_FOUND', 404, 'Host was not found or is disabled.');

    if (current.pinned) {
      return {
        targetId: target.id,
        hostId: host.id,
        snapshotId: snapshot.id,
        imageReference,
        currentDigest: current.digest,
        pinned: true,
        platform,
        currentOllamaVersion: payload.ollamaVersion,
        composeManaged: snapshotComposeManaged(payload),
        connection: null,
      };
    }

    const credential = this.credentials.findByHostId(host.id);
    if (!credential) throw new UpdatePlanError('SSH_CREDENTIAL_NOT_FOUND', 409, 'Host has no SSH credential.');
    let privateKey: string;
    try {
      privateKey = new SecretCipher(this.masterKey).decrypt(
        { credentialId: credential.id, hostId: host.id },
        credential.encryptedPrivateKey,
      );
    } catch {
      throw new UpdatePlanError('SSH_CREDENTIAL_INVALID', 409, 'Stored SSH credential could not be decrypted.');
    }
    return {
      targetId: target.id,
      hostId: host.id,
      snapshotId: snapshot.id,
      imageReference,
      currentDigest: current.digest,
      pinned: false,
      platform,
      currentOllamaVersion: payload.ollamaVersion,
      composeManaged: snapshotComposeManaged(payload),
      connection: {
        hostname: host.hostname,
        port: host.port,
        username: host.username,
        privateKey,
        expectedFingerprint: host.hostKeyFingerprint,
      },
    };
  }

  async create(targetId: string, snapshotId: string, actorUserId: string): Promise<UpdatePlan> {
    const source = this.resolve(targetId, snapshotId);
    this.audit.record({
      actorUserId,
      hostId: source.hostId,
      targetId: source.targetId,
      action: 'container.update_plan.requested',
      parameters: { snapshotId: source.snapshotId, targetId: source.targetId },
      result: 'requested',
    });

    try {
      if (source.pinned) {
        const plan: UpdatePlan = {
          snapshotId: source.snapshotId,
          targetId: source.targetId,
          imageReference: source.imageReference,
          pinned: true,
          currentDigest: source.currentDigest,
          candidateDigest: source.currentDigest,
          candidateIndexDigest: null,
          platform: source.platform,
          updateAvailable: false,
          currentOllamaVersion: source.currentOllamaVersion,
          candidateOllamaVersion: source.currentOllamaVersion,
          composeManaged: source.composeManaged,
          modelVolumeBackup: { included: false, warning: MODEL_VOLUME_WARNING },
        };
        this.recordCreated(actorUserId, source, plan);
        return plan;
      }

      const executor = {
        exec: (argv: readonly string[]) => execPrivateKey(
          source.connection!,
          argv,
          { timeoutMs: 30_000, maxOutputBytes: 2 * 1024 * 1024 },
        ),
      };
      const candidate = await inspectDockerRegistryCandidate(executor, source.imageReference, source.platform);
      const plan: UpdatePlan = {
        snapshotId: source.snapshotId,
        targetId: source.targetId,
        imageReference: source.imageReference,
        pinned: false,
        currentDigest: source.currentDigest,
        candidateDigest: candidate.platformDigest,
        candidateIndexDigest: candidate.indexDigest,
        platform: source.platform,
        updateAvailable: source.currentDigest !== candidate.platformDigest && source.currentDigest !== candidate.indexDigest,
        currentOllamaVersion: source.currentOllamaVersion,
        candidateOllamaVersion: candidate.version,
        composeManaged: source.composeManaged,
        modelVolumeBackup: { included: false, warning: MODEL_VOLUME_WARNING },
      };
      this.recordCreated(actorUserId, source, plan);
      return plan;
    } catch (error) {
      const failure = error instanceof DockerRegistryError
        ? new UpdatePlanError(error.code, registryStatus(error), error.message)
        : error instanceof SshTransportError
          ? new UpdatePlanError(error.code, error.code === 'SSH_HOST_KEY_MISMATCH' ? 409 : error.code === 'AUTH_FAILED' ? 422 : 502, 'Remote SSH registry lookup failed.')
          : error instanceof UpdatePlanError
            ? error
            : new UpdatePlanError('UPDATE_PLAN_FAILED', 500, 'Update plan creation failed.');
      try {
        this.audit.record({
          actorUserId,
          hostId: source.hostId,
          targetId: source.targetId,
          action: 'container.update_plan.failed',
          parameters: { snapshotId: source.snapshotId, targetId: source.targetId },
          result: 'failed',
          errorClass: failure.code,
        });
      } catch {
        // Preserve the primary read-only planning failure.
      }
      throw failure;
    }
  }

  private recordCreated(actorUserId: string, source: ResolvedPlanSource, plan: UpdatePlan): void {
    try {
      this.audit.record({
        actorUserId,
        hostId: source.hostId,
        targetId: source.targetId,
        action: 'container.update_plan.created',
        parameters: {
          snapshotId: plan.snapshotId,
          imageReference: plan.imageReference,
          currentDigest: plan.currentDigest,
          candidateDigest: plan.candidateDigest,
          candidateIndexDigest: plan.candidateIndexDigest,
          pinned: plan.pinned,
          updateAvailable: plan.updateAvailable,
          platform: plan.platform,
        },
        result: 'succeeded',
      });
    } catch {
      // A read-only plan is still valid if the secondary audit write fails.
    }
  }
}
