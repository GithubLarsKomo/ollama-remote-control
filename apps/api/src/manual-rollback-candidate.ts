import type {
  JobRepository,
  OllamaTargetRepository,
  StoredJob,
  UpdateSnapshotRepository,
} from '@orc/core';
import {
  exactDigestImageReference,
  sameExactImageReference,
} from '@orc/docker/compose-intent';
import {
  composeContextFromInspect,
  DockerReconstructError,
} from '@orc/docker/reconstruct';
import { UpdateSnapshotCipher } from '@orc/security';

export interface SuccessfulUpdateHistory {
  latestSuccessfulUpdate(targetId: string): StoredJob | null;
}

export class ManualRollbackCandidateError extends Error {
  constructor(
    readonly code: string,
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

export type RollbackUnavailableReason = 'NO_SUCCESSFUL_UPDATE' | 'TARGET_BINDING_CHANGED';

export interface ManualRollbackCandidate {
  readonly sourceUpdateJobId: string;
  readonly sourceIntentId: string;
  readonly snapshotId: string;
  readonly updatedAt: string;
  readonly currentContainerId: string;
  readonly previousContainerId: string;
  readonly currentImageReference: string;
  readonly rollbackImageReference: string;
  readonly currentDigest: string;
  readonly rollbackDigest: string;
  readonly composeService: string;
  readonly modelVolumeBackup: {
    readonly included: false;
    readonly warning: string;
  };
}

export interface ManualRollbackCandidateResult {
  readonly candidate: ManualRollbackCandidate | null;
  readonly reason: RollbackUnavailableReason | null;
}

interface SuccessfulUpdateResult {
  readonly jobId: string;
  readonly outcome: 'updated';
  readonly intentId: string;
  readonly snapshotId: string;
  readonly previousContainerId: string;
  readonly containerId: string;
  readonly candidateDigest: string;
}

interface StoredIntent {
  readonly intentVersion: 1;
  readonly intentId: string;
  readonly targetId: string;
  readonly snapshotId: string;
  readonly imageReference: string;
  readonly currentDigest: string;
  readonly candidateDigest: string;
  readonly exactCandidateReference: string;
  readonly strategy: 'compose';
  readonly composeService: string;
}

interface SnapshotPayload {
  readonly schemaVersion: 1;
  readonly containerInspect: Record<string, any>;
  readonly imageInspect: Record<string, any>;
}

function invalidAuthority(message: string): never {
  throw new ManualRollbackCandidateError('ROLLBACK_AUTHORITY_INVALID', 409, message);
}

function parseObject(serialized: string | null, description: string): Record<string, any> {
  try {
    if (!serialized) throw new Error('missing');
    const value = JSON.parse(serialized) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('shape');
    return value as Record<string, any>;
  } catch {
    return invalidAuthority(`Stored ${description} is invalid.`);
  }
}

function parseSuccessfulUpdate(job: StoredJob): SuccessfulUpdateResult {
  const value = parseObject(job.resultJson, 'successful update result');
  if (
    value.outcome !== 'updated'
    || typeof value.jobId !== 'string'
    || value.jobId !== job.id
    || typeof value.intentId !== 'string'
    || typeof value.snapshotId !== 'string'
    || typeof value.previousContainerId !== 'string'
    || typeof value.containerId !== 'string'
    || typeof value.candidateDigest !== 'string'
  ) return invalidAuthority('Stored successful update result is inconsistent.');
  return value as SuccessfulUpdateResult;
}

function parseIntent(job: StoredJob, expectedTargetId: string, expectedIntentId: string): StoredIntent {
  if (
    job.kind !== 'container.update_execution_intent'
    || job.state !== 'succeeded'
    || job.targetId !== expectedTargetId
    || job.id !== expectedIntentId
  ) return invalidAuthority('Stored update intent job is not valid rollback authority.');
  const value = parseObject(job.resultJson, 'update intent');
  if (
    value.intentVersion !== 1
    || value.intentId !== job.id
    || value.targetId !== expectedTargetId
    || typeof value.snapshotId !== 'string'
    || typeof value.imageReference !== 'string'
    || typeof value.currentDigest !== 'string'
    || typeof value.candidateDigest !== 'string'
    || typeof value.exactCandidateReference !== 'string'
    || value.strategy !== 'compose'
    || typeof value.composeService !== 'string'
  ) return invalidAuthority('Stored update intent is inconsistent.');
  let expectedCandidate: string;
  try { expectedCandidate = exactDigestImageReference(value.imageReference, value.candidateDigest); }
  catch { return invalidAuthority('Stored update intent candidate digest is invalid.'); }
  if (!sameExactImageReference(expectedCandidate, value.exactCandidateReference)) {
    return invalidAuthority('Stored update intent exact candidate reference is inconsistent.');
  }
  return value as StoredIntent;
}

function parseSnapshot(serialized: string): SnapshotPayload {
  const value = parseObject(serialized, 'rollback snapshot payload');
  if (
    value.schemaVersion !== 1
    || !value.containerInspect
    || typeof value.containerInspect !== 'object'
    || !value.imageInspect
    || typeof value.imageInspect !== 'object'
  ) return invalidAuthority('Stored rollback snapshot payload is inconsistent.');
  return value as SnapshotPayload;
}

export class ManualRollbackCandidateService {
  constructor(
    private readonly targets: OllamaTargetRepository,
    private readonly jobs: JobRepository,
    private readonly snapshots: UpdateSnapshotRepository,
    private readonly history: SuccessfulUpdateHistory,
    private readonly masterKey: Buffer | null,
  ) {}

  read(targetId: string): ManualRollbackCandidateResult {
    const target = this.targets.findById(targetId);
    if (!target || !target.enabled) {
      throw new ManualRollbackCandidateError('TARGET_NOT_FOUND', 404, 'Ollama target was not found or is disabled.');
    }

    const updateJob = this.history.latestSuccessfulUpdate(target.id);
    if (!updateJob) return { candidate: null, reason: 'NO_SUCCESSFUL_UPDATE' };
    const update = parseSuccessfulUpdate(updateJob);
    if (updateJob.targetId !== target.id || updateJob.kind !== 'container.update' || updateJob.state !== 'succeeded') {
      return invalidAuthority('Latest successful update job is not valid rollback authority.');
    }

    if (target.selectedContainerId !== update.containerId) {
      return { candidate: null, reason: 'TARGET_BINDING_CHANGED' };
    }

    const intentJob = this.jobs.findById(update.intentId);
    if (!intentJob) return invalidAuthority('Successful update references a missing update intent.');
    const intent = parseIntent(intentJob, target.id, update.intentId);
    if (
      intent.snapshotId !== update.snapshotId
      || intent.candidateDigest !== update.candidateDigest
      || !sameExactImageReference(intent.exactCandidateReference, exactDigestImageReference(intent.imageReference, update.candidateDigest))
    ) return invalidAuthority('Successful update and update intent do not agree.');

    const storedSnapshot = this.snapshots.findById(update.snapshotId);
    if (!storedSnapshot || storedSnapshot.targetId !== target.id) {
      return invalidAuthority('Successful update references a missing or foreign rollback snapshot.');
    }
    if (!this.masterKey) {
      throw new ManualRollbackCandidateError('MASTER_KEY_REQUIRED', 503, 'External master key is required to authenticate rollback authority.');
    }

    let plaintext: string;
    try {
      plaintext = new UpdateSnapshotCipher(this.masterKey).decrypt(
        { snapshotId: storedSnapshot.id, targetId: target.id },
        storedSnapshot.encryptedPayload,
      );
    } catch {
      return invalidAuthority('Encrypted rollback snapshot could not be authenticated or decrypted.');
    }
    const snapshot = parseSnapshot(plaintext);
    const previousContainerId = String(snapshot.containerInspect.Id ?? '').trim();
    if (!previousContainerId || previousContainerId !== update.previousContainerId) {
      return invalidAuthority('Rollback snapshot container does not match the successful update result.');
    }

    const snapshotImageReference = String(snapshot.containerInspect.Config?.Image ?? '').trim();
    let rollbackImageReference: string;
    try { rollbackImageReference = exactDigestImageReference(snapshotImageReference, intent.currentDigest); }
    catch { return invalidAuthority('Rollback snapshot image reference or digest is invalid.'); }
    const repoDigests = Array.isArray(snapshot.imageInspect.RepoDigests)
      ? snapshot.imageInspect.RepoDigests.map(String)
      : [];
    if (!repoDigests.some((reference) => sameExactImageReference(reference, rollbackImageReference))) {
      return invalidAuthority('Rollback snapshot does not prove the previous image digest.');
    }

    let compose;
    try { compose = composeContextFromInspect(snapshot.containerInspect); }
    catch (error) {
      if (error instanceof DockerReconstructError) {
        throw new ManualRollbackCandidateError(error.code, 409, error.message);
      }
      throw error;
    }
    if (!compose || compose.service !== intent.composeService) {
      return invalidAuthority('Rollback snapshot Compose service does not match the successful update intent.');
    }

    return {
      candidate: {
        sourceUpdateJobId: updateJob.id,
        sourceIntentId: intent.intentId,
        snapshotId: storedSnapshot.id,
        updatedAt: updateJob.finishedAt ?? updateJob.createdAt,
        currentContainerId: update.containerId,
        previousContainerId,
        currentImageReference: intent.exactCandidateReference,
        rollbackImageReference,
        currentDigest: intent.candidateDigest,
        rollbackDigest: intent.currentDigest,
        composeService: compose.service,
        modelVolumeBackup: {
          included: false,
          warning: 'Rollback restores the previous container/runtime configuration; model data volumes are not backed up or restored.',
        },
      },
      reason: null,
    };
  }
}
