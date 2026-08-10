import type {
  HostOnboardingRepository,
  OllamaTargetRepository,
  SshCredentialRepository,
  TargetContainerBindingRepository,
  UpdateSnapshotRepository,
} from '@orc/core';
import { ComposeReplacementError } from '@orc/docker/compose-replacement';
import {
  composeContextFromInspect,
  DockerReconstructError,
  type ComposeSnapshotContext,
} from '@orc/docker/reconstruct';
import { SecretCipher, UpdateSnapshotCipher } from '@orc/security';
import {
  SshTransportError,
  type SshPrivateKeyConnection,
} from '@orc/ssh';
import { AuditService } from './audit.js';
import { JobService, JobServiceError } from './jobs.js';
import {
  ManualRollbackCandidateError,
  ManualRollbackCandidateService,
  type ManualRollbackCandidate,
} from './manual-rollback-candidate.js';
import {
  OllamaHealthError,
  type OllamaHealthResult,
} from './ollama-health.js';
import type {
  UpdateRemoteFactory,
  UpdateRemoteOperations,
} from './update-orchestrator.js';

export interface ManualRollbackConfirmation {
  readonly targetId: string;
  readonly sourceUpdateJobId: string;
  readonly currentContainerId: string;
  readonly rollbackDigest: string;
  readonly acknowledgeModelVolumeBoundary: true;
}

export interface ManualRollbackSuccess {
  readonly jobId: string;
  readonly outcome: 'rolled_back';
  readonly sourceUpdateJobId: string;
  readonly snapshotId: string;
  readonly previousContainerId: string;
  readonly replacedContainerId: string;
  readonly containerId: string;
  readonly rollbackDigest: string;
}

export class ManualRollbackExecutionError extends Error {
  constructor(
    readonly code: string,
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

interface SnapshotPayload {
  readonly schemaVersion: 1;
  readonly containerInspect: Record<string, any>;
  readonly imageInspect: Record<string, any>;
}

interface PreparedRollback {
  readonly targetId: string;
  readonly hostId: string;
  readonly candidate: ManualRollbackCandidate;
  readonly compose: ComposeSnapshotContext;
  readonly connection: SshPrivateKeyConnection;
}

interface FailureDescriptor {
  readonly code: string;
  readonly statusCode: number;
  readonly message: string;
}

function classifyFailure(error: unknown): FailureDescriptor {
  if (error instanceof ManualRollbackExecutionError) return error;
  if (error instanceof ManualRollbackCandidateError) return error;
  if (error instanceof JobServiceError) return error;
  if (error instanceof OllamaHealthError) return error;
  if (error instanceof DockerReconstructError) {
    return { code: error.code, statusCode: 409, message: error.message };
  }
  if (error instanceof ComposeReplacementError) {
    const conflicts = new Set(['INVALID_CONTAINER_ID', 'INVALID_IMAGE_REFERENCE', 'COMPOSE_CONTEXT_CHANGED']);
    return {
      code: error.code,
      statusCode: conflicts.has(error.code) ? 409 : 502,
      message: error.message,
    };
  }
  if (error instanceof SshTransportError) {
    return {
      code: error.code,
      statusCode: error.code === 'SSH_HOST_KEY_MISMATCH' ? 409 : error.code === 'AUTH_FAILED' ? 422 : 502,
      message: 'Remote SSH rollback operation failed.',
    };
  }
  return { code: 'MANUAL_ROLLBACK_FAILED', statusCode: 500, message: 'Manual rollback failed.' };
}

function parseSnapshot(serialized: string): SnapshotPayload {
  try {
    const value = JSON.parse(serialized) as Record<string, any>;
    if (
      value.schemaVersion !== 1
      || !value.containerInspect
      || typeof value.containerInspect !== 'object'
      || !value.imageInspect
      || typeof value.imageInspect !== 'object'
    ) throw new Error('invalid snapshot');
    return value as SnapshotPayload;
  } catch {
    throw new ManualRollbackExecutionError(
      'ROLLBACK_AUTHORITY_INVALID',
      409,
      'Authenticated rollback snapshot payload is invalid.',
    );
  }
}

function confirmationMatches(candidate: ManualRollbackCandidate, confirmation: ManualRollbackConfirmation): boolean {
  return confirmation.targetId.trim() === candidate.targetId
    && confirmation.sourceUpdateJobId.trim() === candidate.sourceUpdateJobId
    && confirmation.currentContainerId.trim() === candidate.currentContainerId
    && confirmation.rollbackDigest.trim() === candidate.rollbackDigest
    && confirmation.acknowledgeModelVolumeBoundary === true;
}

// Candidate targetId is server-internal authority; it is attached before execution.
type ExecutionCandidate = ManualRollbackCandidate & { readonly targetId: string };

export class ManualRollbackExecutionService {
  constructor(
    private readonly hosts: HostOnboardingRepository,
    private readonly credentials: SshCredentialRepository,
    private readonly targets: OllamaTargetRepository,
    private readonly bindings: TargetContainerBindingRepository,
    private readonly snapshots: UpdateSnapshotRepository,
    private readonly masterKey: Buffer | null,
    private readonly candidateService: ManualRollbackCandidateService,
    private readonly jobs: JobService,
    private readonly audit: AuditService,
    private readonly remoteFactory: UpdateRemoteFactory,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private prepare(targetId: string, confirmation: ManualRollbackConfirmation): PreparedRollback {
    const target = this.targets.findById(targetId);
    if (!target || !target.enabled) {
      throw new ManualRollbackExecutionError('TARGET_NOT_FOUND', 404, 'Ollama target was not found or is disabled.');
    }
    if (!this.masterKey) {
      throw new ManualRollbackExecutionError('MASTER_KEY_REQUIRED', 503, 'External master key is required for manual rollback.');
    }

    const candidateResult = this.candidateService.read(target.id);
    if (!candidateResult.candidate) {
      throw new ManualRollbackExecutionError(
        'ROLLBACK_NOT_AVAILABLE',
        409,
        candidateResult.reason === 'TARGET_BINDING_CHANGED'
          ? 'Target binding changed after the last successful update; manual rollback authority is stale.'
          : 'No successful update is available for manual rollback.',
      );
    }
    const candidate: ExecutionCandidate = { ...candidateResult.candidate, targetId: target.id };
    if (!confirmationMatches(candidate, confirmation)) {
      throw new ManualRollbackExecutionError(
        'ROLLBACK_CONFIRMATION_MISMATCH',
        409,
        'Rollback confirmation does not match the current server-derived candidate.',
      );
    }

    const storedSnapshot = this.snapshots.findById(candidate.snapshotId);
    if (!storedSnapshot || storedSnapshot.targetId !== target.id) {
      throw new ManualRollbackExecutionError('ROLLBACK_AUTHORITY_INVALID', 409, 'Rollback snapshot is missing or foreign.');
    }
    let plaintext: string;
    try {
      plaintext = new UpdateSnapshotCipher(this.masterKey).decrypt(
        { snapshotId: storedSnapshot.id, targetId: target.id },
        storedSnapshot.encryptedPayload,
      );
    } catch {
      throw new ManualRollbackExecutionError('ROLLBACK_AUTHORITY_INVALID', 409, 'Rollback snapshot could not be authenticated.');
    }
    const snapshot = parseSnapshot(plaintext);
    const previousContainerId = String(snapshot.containerInspect.Id ?? '').trim();
    if (previousContainerId !== candidate.previousContainerId) {
      throw new ManualRollbackExecutionError('ROLLBACK_AUTHORITY_INVALID', 409, 'Rollback snapshot container changed from the derived authority.');
    }
    let compose: ComposeSnapshotContext | null;
    try { compose = composeContextFromInspect(snapshot.containerInspect); }
    catch (error) {
      if (error instanceof DockerReconstructError) {
        throw new ManualRollbackExecutionError(error.code, 409, error.message);
      }
      throw error;
    }
    if (!compose || compose.service !== candidate.composeService) {
      throw new ManualRollbackExecutionError('ROLLBACK_AUTHORITY_INVALID', 409, 'Rollback Compose service changed from the derived authority.');
    }

    const host = this.hosts.findHostById(target.hostId);
    if (!host || !host.enabled) throw new ManualRollbackExecutionError('HOST_NOT_FOUND', 404, 'Host was not found or is disabled.');
    const credential = this.credentials.findByHostId(host.id);
    if (!credential) throw new ManualRollbackExecutionError('SSH_CREDENTIAL_NOT_FOUND', 409, 'Host has no SSH credential.');
    let privateKey: string;
    try {
      privateKey = new SecretCipher(this.masterKey).decrypt(
        { credentialId: credential.id, hostId: host.id },
        credential.encryptedPrivateKey,
      );
    } catch {
      throw new ManualRollbackExecutionError('SSH_CREDENTIAL_INVALID', 409, 'Stored SSH credential could not be authenticated.');
    }

    return {
      targetId: target.id,
      hostId: host.id,
      candidate,
      compose,
      connection: {
        hostname: host.hostname,
        port: host.port,
        username: host.username,
        privateKey,
        expectedFingerprint: host.hostKeyFingerprint,
      },
    };
  }

  private event(jobId: string, stage: string, payload: Readonly<Record<string, unknown>> = {}): void {
    this.jobs.appendEvent(jobId, 'stage', { stage, ...payload });
  }

  private rebindKnown(targetId: string, allowedExpected: readonly string[], newContainerId: string): boolean {
    const target = this.targets.findById(targetId);
    if (!target || !target.enabled) return false;
    if (target.selectedContainerId === newContainerId) return true;
    if (!allowedExpected.includes(target.selectedContainerId)) return false;
    return this.bindings.rebindContainer(
      targetId,
      target.selectedContainerId,
      newContainerId,
      this.now().toISOString(),
    );
  }

  private failBeforeMutation(
    jobId: string,
    prepared: PreparedRollback,
    actorUserId: string,
    failure: FailureDescriptor,
  ): never {
    const result = {
      outcome: 'failed_before_replacement',
      sourceUpdateJobId: prepared.candidate.sourceUpdateJobId,
      snapshotId: prepared.candidate.snapshotId,
      causeClass: failure.code,
      containerId: prepared.candidate.currentContainerId,
    } as const;
    try { this.jobs.transition(jobId, 'failed', { result, errorClass: failure.code }); } catch { /* preserve primary */ }
    try {
      this.audit.record({
        actorUserId,
        hostId: prepared.hostId,
        targetId: prepared.targetId,
        action: 'container.rollback.failed',
        parameters: {
          sourceUpdateJobId: prepared.candidate.sourceUpdateJobId,
          snapshotId: prepared.candidate.snapshotId,
        },
        result: 'failed',
        errorClass: failure.code,
        jobId,
      });
    } catch { /* preserve primary */ }
    throw new ManualRollbackExecutionError(failure.code, failure.statusCode, failure.message);
  }

  async execute(
    targetId: string,
    confirmation: ManualRollbackConfirmation,
    actorUserId: string,
  ): Promise<ManualRollbackSuccess> {
    let prepared = this.prepare(targetId, confirmation);
    const job = this.jobs.create({ targetId: prepared.targetId, actorUserId, kind: 'container.rollback', mutating: true });
    this.jobs.transition(job.id, 'running');

    // The persistent target lock is now held. Re-derive all local rollback authority before remote mutation.
    try {
      const locked = this.prepare(targetId, confirmation);
      if (
        locked.candidate.sourceUpdateJobId !== prepared.candidate.sourceUpdateJobId
        || locked.candidate.snapshotId !== prepared.candidate.snapshotId
        || locked.candidate.currentContainerId !== prepared.candidate.currentContainerId
        || locked.candidate.rollbackImageReference !== prepared.candidate.rollbackImageReference
      ) {
        throw new ManualRollbackExecutionError('ROLLBACK_AUTHORITY_CHANGED', 409, 'Rollback authority changed while acquiring the target lock.');
      }
      prepared = locked;
    } catch (error) {
      return this.failBeforeMutation(job.id, prepared, actorUserId, classifyFailure(error));
    }

    const remote: UpdateRemoteOperations = this.remoteFactory(prepared.connection);
    let replacementAttempted = false;
    let rollbackContainerId: string | null = null;
    try {
      this.audit.record({
        actorUserId,
        hostId: prepared.hostId,
        targetId: prepared.targetId,
        action: 'container.rollback.requested',
        parameters: {
          sourceUpdateJobId: prepared.candidate.sourceUpdateJobId,
          snapshotId: prepared.candidate.snapshotId,
          currentContainerId: prepared.candidate.currentContainerId,
          rollbackDigest: prepared.candidate.rollbackDigest,
        },
        result: 'requested',
        jobId: job.id,
      });
      this.event(job.id, 'lock_acquired', {
        sourceUpdateJobId: prepared.candidate.sourceUpdateJobId,
        snapshotId: prepared.candidate.snapshotId,
        currentContainerId: prepared.candidate.currentContainerId,
        rollbackDigest: prepared.candidate.rollbackDigest,
        currentDigest: prepared.candidate.currentDigest,
      });

      await remote.validateCompose(prepared.compose, prepared.candidate.currentContainerId);
      this.event(job.id, 'compose_revalidated', { containerId: prepared.candidate.currentContainerId });

      replacementAttempted = true;
      this.event(job.id, 'rollback_started', {
        fromContainerId: prepared.candidate.currentContainerId,
        rollbackDigest: prepared.candidate.rollbackDigest,
      });
      const replacement = await remote.replace(
        prepared.compose,
        prepared.candidate.rollbackImageReference,
        prepared.candidate.currentContainerId,
        'local-only',
      );
      rollbackContainerId = replacement.containerId;
      this.event(job.id, 'rollback_replacement_created', {
        containerId: rollbackContainerId,
        imageId: replacement.imageId,
      });

      if (!this.rebindKnown(prepared.targetId, [prepared.candidate.currentContainerId], rollbackContainerId)) {
        throw new ManualRollbackExecutionError('ROLLBACK_REBIND_FAILED', 409, 'Target binding could not be moved to the rollback container.');
      }
      this.event(job.id, 'rollback_binding_rebound', { containerId: rollbackContainerId });

      const health: OllamaHealthResult = await remote.health(prepared.targetId, rollbackContainerId);
      if (health.status !== 'healthy') {
        throw new ManualRollbackExecutionError('ROLLBACK_HEALTH_DEGRADED', 502, 'Rollback Ollama health verification was degraded.');
      }
      this.event(job.id, 'rollback_health_verified', {
        containerId: rollbackContainerId,
        version: health.ollama.apiVersion,
      });

      const result: ManualRollbackSuccess = {
        jobId: job.id,
        outcome: 'rolled_back',
        sourceUpdateJobId: prepared.candidate.sourceUpdateJobId,
        snapshotId: prepared.candidate.snapshotId,
        previousContainerId: prepared.candidate.previousContainerId,
        replacedContainerId: prepared.candidate.currentContainerId,
        containerId: rollbackContainerId,
        rollbackDigest: prepared.candidate.rollbackDigest,
      };
      this.jobs.transition(job.id, 'succeeded', { result: result as unknown as Readonly<Record<string, unknown>> });
      try {
        this.audit.record({
          actorUserId,
          hostId: prepared.hostId,
          targetId: prepared.targetId,
          action: 'container.rollback.succeeded',
          parameters: {
            sourceUpdateJobId: prepared.candidate.sourceUpdateJobId,
            snapshotId: prepared.candidate.snapshotId,
            replacedContainerId: prepared.candidate.currentContainerId,
            containerId: rollbackContainerId,
            rollbackDigest: prepared.candidate.rollbackDigest,
          },
          result: 'succeeded',
          jobId: job.id,
        });
      } catch { /* terminal rollback remains successful */ }
      return result;
    } catch (error) {
      const primary = classifyFailure(error);
      if (!replacementAttempted) return this.failBeforeMutation(job.id, prepared, actorUserId, primary);

      let remoteContainerId = rollbackContainerId;
      if (!remoteContainerId) {
        try { remoteContainerId = await remote.resolveComposeContainer(prepared.compose); }
        catch {
          const result = {
            outcome: 'rollback_failed_restore_failed',
            sourceUpdateJobId: prepared.candidate.sourceUpdateJobId,
            causeClass: primary.code,
            restoreCauseClass: 'REMOTE_STATE_UNRESOLVED',
            lastKnownContainerId: prepared.candidate.currentContainerId,
          } as const;
          try { this.jobs.transition(job.id, 'failed', { result, errorClass: 'MANUAL_ROLLBACK_FAILED_RESTORE_FAILED' }); } catch { /* preserve */ }
          throw new ManualRollbackExecutionError(
            'MANUAL_ROLLBACK_FAILED_RESTORE_FAILED',
            502,
            'Manual rollback failed and current Compose state could not be resolved for restoration.',
          );
        }
      }

      if (remoteContainerId === prepared.candidate.currentContainerId) {
        return this.failBeforeMutation(job.id, prepared, actorUserId, primary);
      }

      this.event(job.id, 'restore_started', {
        causeClass: primary.code,
        fromContainerId: remoteContainerId,
        currentDigest: prepared.candidate.currentDigest,
      });
      try {
        const restored = await remote.replace(
          prepared.compose,
          prepared.candidate.currentImageReference,
          remoteContainerId,
          'local-only',
        );
        this.event(job.id, 'restore_replacement_created', {
          containerId: restored.containerId,
          imageId: restored.imageId,
        });
        if (!this.rebindKnown(
          prepared.targetId,
          [prepared.candidate.currentContainerId, remoteContainerId, ...(rollbackContainerId ? [rollbackContainerId] : [])],
          restored.containerId,
        )) {
          throw new ManualRollbackExecutionError('RESTORE_REBIND_FAILED', 409, 'Target binding could not be restored to the pre-rollback image.');
        }
        this.event(job.id, 'restore_binding_rebound', { containerId: restored.containerId });
        const health = await remote.health(prepared.targetId, restored.containerId);
        if (health.status !== 'healthy') {
          throw new ManualRollbackExecutionError('RESTORE_HEALTH_DEGRADED', 502, 'Restored pre-rollback container health verification was degraded.');
        }
        this.event(job.id, 'restore_health_verified', {
          containerId: restored.containerId,
          version: health.ollama.apiVersion,
        });
        const result = {
          outcome: 'rollback_failed_current_restored',
          sourceUpdateJobId: prepared.candidate.sourceUpdateJobId,
          snapshotId: prepared.candidate.snapshotId,
          causeClass: primary.code,
          failedRollbackContainerId: remoteContainerId,
          restoredContainerId: restored.containerId,
        } as const;
        this.jobs.transition(job.id, 'failed', { result, errorClass: 'MANUAL_ROLLBACK_FAILED_CURRENT_RESTORED' });
        try {
          this.audit.record({
            actorUserId,
            hostId: prepared.hostId,
            targetId: prepared.targetId,
            action: 'container.rollback.current_restored',
            parameters: {
              sourceUpdateJobId: prepared.candidate.sourceUpdateJobId,
              causeClass: primary.code,
              restoredContainerId: restored.containerId,
            },
            result: 'failed',
            errorClass: 'MANUAL_ROLLBACK_FAILED_CURRENT_RESTORED',
            jobId: job.id,
          });
        } catch { /* preserve terminal result */ }
        throw new ManualRollbackExecutionError(
          'MANUAL_ROLLBACK_FAILED_CURRENT_RESTORED',
          502,
          'Manual rollback failed; the previously healthy update image was restored and verified.',
        );
      } catch (restoreError) {
        if (
          restoreError instanceof ManualRollbackExecutionError
          && restoreError.code === 'MANUAL_ROLLBACK_FAILED_CURRENT_RESTORED'
        ) throw restoreError;
        const restoreFailure = classifyFailure(restoreError);
        let lastKnownContainerId = remoteContainerId;
        try {
          const resolved = await remote.resolveComposeContainer(prepared.compose);
          lastKnownContainerId = resolved;
          this.rebindKnown(
            prepared.targetId,
            [prepared.candidate.currentContainerId, remoteContainerId, ...(rollbackContainerId ? [rollbackContainerId] : [])],
            resolved,
          );
        } catch { /* best-effort consistency only */ }
        const result = {
          outcome: 'rollback_failed_restore_failed',
          sourceUpdateJobId: prepared.candidate.sourceUpdateJobId,
          snapshotId: prepared.candidate.snapshotId,
          causeClass: primary.code,
          restoreCauseClass: restoreFailure.code,
          lastKnownContainerId,
        } as const;
        try { this.jobs.transition(job.id, 'failed', { result, errorClass: 'MANUAL_ROLLBACK_FAILED_RESTORE_FAILED' }); } catch { /* preserve */ }
        try {
          this.audit.record({
            actorUserId,
            hostId: prepared.hostId,
            targetId: prepared.targetId,
            action: 'container.rollback.restore_failed',
            parameters: {
              sourceUpdateJobId: prepared.candidate.sourceUpdateJobId,
              causeClass: primary.code,
              restoreCauseClass: restoreFailure.code,
              lastKnownContainerId,
            },
            result: 'failed',
            errorClass: 'MANUAL_ROLLBACK_FAILED_RESTORE_FAILED',
            jobId: job.id,
          });
        } catch { /* preserve terminal failure */ }
        throw new ManualRollbackExecutionError(
          'MANUAL_ROLLBACK_FAILED_RESTORE_FAILED',
          502,
          'Manual rollback failed and the previously healthy image could not be verified as restored.',
        );
      }
    }
  }
}
