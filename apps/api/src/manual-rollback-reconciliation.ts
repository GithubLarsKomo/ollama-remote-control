import type {
  HostOnboardingRepository,
  OllamaTargetRepository,
  SshCredentialRepository,
  StoredJob,
  StoredJobEvent,
  TargetContainerBindingRepository,
  UpdateSnapshotRepository,
} from '@orc/core';
import {
  exactDigestImageReference,
  sameExactImageReference,
} from '@orc/docker/compose-intent';
import {
  composeContextFromInspect,
  type ComposeSnapshotContext,
} from '@orc/docker/reconstruct';
import { SecretCipher, UpdateSnapshotCipher } from '@orc/security';
import type { SshPrivateKeyConnection } from '@orc/ssh';
import { AuditService } from './audit.js';
import { JobService } from './jobs.js';
import type {
  UpdateRemoteFactory,
  UpdateRemoteOperations,
} from './update-orchestrator.js';

const CONTAINER_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;
const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const CONTAINER_KEYS = new Set([
  'containerId',
  'fromContainerId',
  'currentContainerId',
  'failedRollbackContainerId',
  'restoredContainerId',
  'lastKnownContainerId',
]);

interface StageRecord {
  readonly stage: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

interface UpdateResult {
  readonly jobId: string;
  readonly outcome: 'updated';
  readonly intentId: string;
  readonly snapshotId: string;
  readonly previousContainerId: string;
  readonly containerId: string;
  readonly candidateDigest: string;
}

interface UpdateIntent {
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

interface RecoveryAuthority {
  readonly job: StoredJob;
  readonly targetId: string;
  readonly hostId: string;
  readonly sourceUpdateJobId: string;
  readonly snapshotId: string;
  readonly currentContainerId: string;
  readonly currentImageReference: string;
  readonly rollbackImageReference: string;
  readonly currentDigest: string;
  readonly rollbackDigest: string;
  readonly compose: ComposeSnapshotContext;
  readonly connection: SshPrivateKeyConnection;
}

export interface ManualRollbackReconciliationSummary {
  readonly examined: number;
  readonly reconciled: number;
}

export class ManualRollbackReconciliationError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

function safeObject(serialized: string | null, errorCode: string, description: string): Record<string, any> {
  try {
    if (!serialized) throw new Error('missing');
    const value = JSON.parse(serialized) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('shape');
    return value as Record<string, any>;
  } catch {
    throw new ManualRollbackReconciliationError(errorCode, description);
  }
}

function stageRecords(events: readonly StoredJobEvent[]): readonly StageRecord[] {
  const stages: StageRecord[] = [];
  for (const event of events) {
    if (event.eventType !== 'stage') continue;
    const payload = safeObject(
      event.payloadJson,
      'MANUAL_ROLLBACK_RECOVERY_JOURNAL_INVALID',
      'Interrupted rollback recovery journal is invalid.',
    );
    if (typeof payload.stage !== 'string' || !payload.stage.trim()) {
      throw new ManualRollbackReconciliationError(
        'MANUAL_ROLLBACK_RECOVERY_JOURNAL_INVALID',
        'Interrupted rollback recovery journal contains an invalid stage.',
      );
    }
    for (const [key, value] of Object.entries(payload)) {
      if (!CONTAINER_KEYS.has(key) || value === null || value === undefined) continue;
      if (typeof value !== 'string' || !CONTAINER_ID.test(value)) {
        throw new ManualRollbackReconciliationError(
          'MANUAL_ROLLBACK_RECOVERY_JOURNAL_INVALID',
          'Interrupted rollback recovery journal contains an invalid container identifier.',
        );
      }
    }
    stages.push({ stage: payload.stage.trim(), payload });
  }
  return stages;
}

function hasStage(stages: readonly StageRecord[], stage: string): boolean {
  return stages.some((entry) => entry.stage === stage);
}

function oneString(stages: readonly StageRecord[], stage: string, key: string, pattern?: RegExp): string {
  const values = stages
    .filter((entry) => entry.stage === stage)
    .map((entry) => entry.payload[key])
    .filter((value): value is string => typeof value === 'string' && Boolean(value.trim()))
    .map((value) => value.trim());
  const unique = [...new Set(values)];
  if (unique.length !== 1 || (pattern && !pattern.test(unique[0]!))) {
    throw new ManualRollbackReconciliationError(
      'MANUAL_ROLLBACK_RECOVERY_AUTHORITY_INVALID',
      `Interrupted rollback recovery authority is missing or ambiguous: ${key}.`,
    );
  }
  return unique[0]!;
}

function provenContainerIds(stages: readonly StageRecord[], stage: string): ReadonlySet<string> {
  const result = new Set<string>();
  for (const entry of stages) {
    if (entry.stage !== stage) continue;
    const containerId = entry.payload.containerId;
    if (typeof containerId === 'string' && CONTAINER_ID.test(containerId)) result.add(containerId);
  }
  return result;
}

function knownContainerIds(stages: readonly StageRecord[], currentContainerId: string): readonly string[] {
  const result = new Set<string>([currentContainerId]);
  for (const entry of stages) {
    for (const [key, value] of Object.entries(entry.payload)) {
      if (CONTAINER_KEYS.has(key) && typeof value === 'string' && CONTAINER_ID.test(value)) result.add(value);
    }
  }
  return [...result];
}

function parseUpdate(job: StoredJob): UpdateResult {
  if (job.kind !== 'container.update' || job.state !== 'succeeded') {
    throw new ManualRollbackReconciliationError(
      'MANUAL_ROLLBACK_RECOVERY_AUTHORITY_INVALID',
      'Interrupted rollback source update is not a successful update job.',
    );
  }
  const value = safeObject(
    job.resultJson,
    'MANUAL_ROLLBACK_RECOVERY_AUTHORITY_INVALID',
    'Interrupted rollback source update result is invalid.',
  );
  if (
    value.jobId !== job.id
    || value.outcome !== 'updated'
    || typeof value.intentId !== 'string'
    || typeof value.snapshotId !== 'string'
    || typeof value.previousContainerId !== 'string'
    || typeof value.containerId !== 'string'
    || typeof value.candidateDigest !== 'string'
  ) {
    throw new ManualRollbackReconciliationError(
      'MANUAL_ROLLBACK_RECOVERY_AUTHORITY_INVALID',
      'Interrupted rollback source update result is inconsistent.',
    );
  }
  return value as UpdateResult;
}

function parseIntent(job: StoredJob, expectedTargetId: string): UpdateIntent {
  if (
    job.kind !== 'container.update_execution_intent'
    || job.state !== 'succeeded'
    || job.targetId !== expectedTargetId
  ) {
    throw new ManualRollbackReconciliationError(
      'MANUAL_ROLLBACK_RECOVERY_AUTHORITY_INVALID',
      'Interrupted rollback source update intent is invalid.',
    );
  }
  const value = safeObject(
    job.resultJson,
    'MANUAL_ROLLBACK_RECOVERY_AUTHORITY_INVALID',
    'Interrupted rollback source update intent is invalid.',
  );
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
  ) {
    throw new ManualRollbackReconciliationError(
      'MANUAL_ROLLBACK_RECOVERY_AUTHORITY_INVALID',
      'Interrupted rollback source update intent is inconsistent.',
    );
  }
  let exactCandidate: string;
  try {
    exactCandidate = exactDigestImageReference(value.imageReference, value.candidateDigest);
  } catch {
    throw new ManualRollbackReconciliationError(
      'MANUAL_ROLLBACK_RECOVERY_AUTHORITY_INVALID',
      'Interrupted rollback candidate image authority is invalid.',
    );
  }
  if (!sameExactImageReference(exactCandidate, value.exactCandidateReference)) {
    throw new ManualRollbackReconciliationError(
      'MANUAL_ROLLBACK_RECOVERY_AUTHORITY_INVALID',
      'Interrupted rollback candidate image authority is inconsistent.',
    );
  }
  return value as UpdateIntent;
}

function parseSnapshot(serialized: string): SnapshotPayload {
  const value = safeObject(
    serialized,
    'MANUAL_ROLLBACK_RECOVERY_SNAPSHOT_INVALID',
    'Interrupted rollback snapshot is invalid.',
  );
  if (
    value.schemaVersion !== 1
    || !value.containerInspect
    || typeof value.containerInspect !== 'object'
    || !value.imageInspect
    || typeof value.imageInspect !== 'object'
  ) {
    throw new ManualRollbackReconciliationError(
      'MANUAL_ROLLBACK_RECOVERY_SNAPSHOT_INVALID',
      'Interrupted rollback snapshot is inconsistent.',
    );
  }
  return value as SnapshotPayload;
}

export class ManualRollbackReconciliationService {
  constructor(
    private readonly hosts: HostOnboardingRepository,
    private readonly credentials: SshCredentialRepository,
    private readonly targets: OllamaTargetRepository,
    private readonly bindings: TargetContainerBindingRepository,
    private readonly snapshots: UpdateSnapshotRepository,
    private readonly masterKey: Buffer | null,
    private readonly jobs: JobService,
    private readonly audit: AuditService,
    private readonly remoteFactory: UpdateRemoteFactory,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private prepare(job: StoredJob, stages: readonly StageRecord[]): RecoveryAuthority {
    if (!this.masterKey) {
      throw new ManualRollbackReconciliationError(
        'MANUAL_ROLLBACK_RECOVERY_MASTER_KEY_REQUIRED',
        'Interrupted manual rollback recovery requires the configured master key.',
      );
    }
    const target = this.targets.findById(job.targetId);
    if (!target || !target.enabled) {
      throw new ManualRollbackReconciliationError(
        'MANUAL_ROLLBACK_RECOVERY_TARGET_MISSING',
        'Interrupted manual rollback target no longer exists or is disabled.',
      );
    }

    const sourceUpdateJobId = oneString(stages, 'lock_acquired', 'sourceUpdateJobId', JOB_ID);
    const snapshotId = oneString(stages, 'lock_acquired', 'snapshotId', JOB_ID);
    const currentContainerId = oneString(stages, 'lock_acquired', 'currentContainerId', CONTAINER_ID);
    const rollbackDigest = oneString(stages, 'lock_acquired', 'rollbackDigest');
    const currentDigest = oneString(stages, 'lock_acquired', 'currentDigest');

    const sourceUpdate = this.jobs.get(sourceUpdateJobId);
    if (sourceUpdate.targetId !== target.id) {
      throw new ManualRollbackReconciliationError(
        'MANUAL_ROLLBACK_RECOVERY_AUTHORITY_INVALID',
        'Interrupted rollback source update belongs to another target.',
      );
    }
    const update = parseUpdate(sourceUpdate);
    if (
      update.snapshotId !== snapshotId
      || update.containerId !== currentContainerId
      || update.candidateDigest !== currentDigest
    ) {
      throw new ManualRollbackReconciliationError(
        'MANUAL_ROLLBACK_RECOVERY_AUTHORITY_INVALID',
        'Interrupted rollback journal does not match the successful update result.',
      );
    }
    const intentJob = this.jobs.get(update.intentId);
    const intent = parseIntent(intentJob, target.id);
    if (
      intent.snapshotId !== snapshotId
      || intent.currentDigest !== rollbackDigest
      || intent.candidateDigest !== currentDigest
    ) {
      throw new ManualRollbackReconciliationError(
        'MANUAL_ROLLBACK_RECOVERY_AUTHORITY_INVALID',
        'Interrupted rollback journal does not match the successful update intent.',
      );
    }

    const storedSnapshot = this.snapshots.findById(snapshotId);
    if (!storedSnapshot || storedSnapshot.targetId !== target.id) {
      throw new ManualRollbackReconciliationError(
        'MANUAL_ROLLBACK_RECOVERY_SNAPSHOT_INVALID',
        'Interrupted rollback snapshot is missing or foreign.',
      );
    }
    let plaintext: string;
    try {
      plaintext = new UpdateSnapshotCipher(this.masterKey).decrypt(
        { snapshotId, targetId: target.id },
        storedSnapshot.encryptedPayload,
      );
    } catch {
      throw new ManualRollbackReconciliationError(
        'MANUAL_ROLLBACK_RECOVERY_SNAPSHOT_INVALID',
        'Interrupted rollback snapshot could not be authenticated.',
      );
    }
    const snapshot = parseSnapshot(plaintext);
    const snapshotContainerId = String(snapshot.containerInspect.Id ?? '').trim();
    if (snapshotContainerId !== update.previousContainerId) {
      throw new ManualRollbackReconciliationError(
        'MANUAL_ROLLBACK_RECOVERY_SNAPSHOT_INVALID',
        'Interrupted rollback snapshot container does not match the source update.',
      );
    }
    const imageReference = String(snapshot.containerInspect.Config?.Image ?? '').trim();
    let rollbackImageReference: string;
    try {
      rollbackImageReference = exactDigestImageReference(imageReference, rollbackDigest);
    } catch {
      throw new ManualRollbackReconciliationError(
        'MANUAL_ROLLBACK_RECOVERY_SNAPSHOT_INVALID',
        'Interrupted rollback snapshot image authority is invalid.',
      );
    }
    const repoDigests = Array.isArray(snapshot.imageInspect.RepoDigests)
      ? snapshot.imageInspect.RepoDigests.map(String)
      : [];
    if (!repoDigests.some((reference) => sameExactImageReference(reference, rollbackImageReference))) {
      throw new ManualRollbackReconciliationError(
        'MANUAL_ROLLBACK_RECOVERY_SNAPSHOT_INVALID',
        'Interrupted rollback snapshot does not prove the rollback image digest.',
      );
    }

    let compose: ComposeSnapshotContext | null;
    try {
      compose = composeContextFromInspect(snapshot.containerInspect);
    } catch {
      throw new ManualRollbackReconciliationError(
        'MANUAL_ROLLBACK_RECOVERY_COMPOSE_INVALID',
        'Interrupted rollback Compose authority is invalid.',
      );
    }
    if (!compose || compose.service !== intent.composeService) {
      throw new ManualRollbackReconciliationError(
        'MANUAL_ROLLBACK_RECOVERY_COMPOSE_INVALID',
        'Interrupted rollback Compose service does not match the source update.',
      );
    }

    const host = this.hosts.findHostById(target.hostId);
    if (!host || !host.enabled) {
      throw new ManualRollbackReconciliationError(
        'MANUAL_ROLLBACK_RECOVERY_HOST_MISSING',
        'Interrupted rollback host no longer exists or is disabled.',
      );
    }
    const credential = this.credentials.findByHostId(host.id);
    if (!credential) {
      throw new ManualRollbackReconciliationError(
        'MANUAL_ROLLBACK_RECOVERY_CREDENTIAL_MISSING',
        'Interrupted rollback host has no SSH credential.',
      );
    }
    let privateKey: string;
    try {
      privateKey = new SecretCipher(this.masterKey).decrypt(
        { credentialId: credential.id, hostId: host.id },
        credential.encryptedPrivateKey,
      );
    } catch {
      throw new ManualRollbackReconciliationError(
        'MANUAL_ROLLBACK_RECOVERY_CREDENTIAL_INVALID',
        'Interrupted rollback SSH credential could not be authenticated.',
      );
    }

    return {
      job,
      targetId: target.id,
      hostId: host.id,
      sourceUpdateJobId,
      snapshotId,
      currentContainerId,
      currentImageReference: intent.exactCandidateReference,
      rollbackImageReference,
      currentDigest,
      rollbackDigest,
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

  private stage(jobId: string, stage: string, payload: Readonly<Record<string, unknown>> = {}): void {
    this.jobs.appendEvent(jobId, 'stage', { stage, ...payload });
  }

  private rebindKnown(authority: RecoveryAuthority, allowed: readonly string[], containerId: string): void {
    const target = this.targets.findById(authority.targetId);
    if (!target || !target.enabled) {
      throw new ManualRollbackReconciliationError(
        'MANUAL_ROLLBACK_RECOVERY_BINDING_INVALID',
        'Interrupted rollback target disappeared during recovery.',
      );
    }
    if (target.selectedContainerId === containerId) return;
    if (!allowed.includes(target.selectedContainerId)) {
      throw new ManualRollbackReconciliationError(
        'MANUAL_ROLLBACK_RECOVERY_BINDING_INVALID',
        'Interrupted rollback target binding is outside the recovery journal.',
      );
    }
    if (!this.bindings.rebindContainer(
      authority.targetId,
      target.selectedContainerId,
      containerId,
      this.now().toISOString(),
    )) {
      throw new ManualRollbackReconciliationError(
        'MANUAL_ROLLBACK_RECOVERY_BINDING_FAILED',
        'Interrupted rollback target binding could not be reconciled.',
      );
    }
  }

  private async healthy(remote: UpdateRemoteOperations, authority: RecoveryAuthority, containerId: string): Promise<boolean> {
    try {
      return (await remote.health(authority.targetId, containerId)).status === 'healthy';
    } catch {
      return false;
    }
  }

  private finalize(
    authority: RecoveryAuthority,
    errorClass: string,
    result: Readonly<Record<string, unknown>>,
  ): void {
    this.jobs.transition(authority.job.id, 'failed', { result, errorClass });
    try {
      this.audit.record({
        actorUserId: authority.job.actorUserId,
        hostId: authority.hostId,
        targetId: authority.targetId,
        action: 'container.rollback.recovered',
        parameters: {
          sourceUpdateJobId: authority.sourceUpdateJobId,
          snapshotId: authority.snapshotId,
          outcome: result.outcome,
        },
        result: 'failed',
        errorClass,
        jobId: authority.job.id,
      });
    } catch {
      // A terminal recovery result is not reopened solely because audit persistence failed.
    }
  }

  private finalizeBeforeMutation(job: StoredJob): void {
    const errorClass = 'MANUAL_ROLLBACK_RECOVERY_INTERRUPTED_BEFORE_MUTATION';
    this.jobs.transition(job.id, 'failed', {
      result: { outcome: 'recovered_interrupted_before_mutation', targetId: job.targetId },
      errorClass,
    });
    try {
      this.audit.record({
        actorUserId: job.actorUserId,
        targetId: job.targetId,
        action: 'container.rollback.recovered',
        parameters: { outcome: 'recovered_interrupted_before_mutation' },
        result: 'failed',
        errorClass,
        jobId: job.id,
      });
    } catch {
      // Recovery is terminal even if audit persistence fails.
    }
  }

  private async restoreCurrent(
    authority: RecoveryAuthority,
    remote: UpdateRemoteOperations,
    fromContainerId: string,
    known: readonly string[],
  ): Promise<void> {
    this.stage(authority.job.id, 'recovery_restore_started', {
      fromContainerId,
      currentDigest: authority.currentDigest,
    });
    const restored = await remote.replace(
      authority.compose,
      authority.currentImageReference,
      fromContainerId,
      'local-only',
    );
    this.stage(authority.job.id, 'recovery_restore_replacement_created', {
      containerId: restored.containerId,
      imageId: restored.imageId,
    });
    this.rebindKnown(authority, [...known, fromContainerId], restored.containerId);
    this.stage(authority.job.id, 'recovery_restore_binding_rebound', { containerId: restored.containerId });
    if (!await this.healthy(remote, authority, restored.containerId)) {
      throw new ManualRollbackReconciliationError(
        'MANUAL_ROLLBACK_RECOVERY_HEALTH_DEGRADED',
        'Recovered current-image container health is degraded.',
      );
    }
    this.stage(authority.job.id, 'recovery_restore_health_verified', { containerId: restored.containerId });
    this.finalize(
      authority,
      'MANUAL_ROLLBACK_RECOVERY_CURRENT_RESTORED',
      {
        outcome: 'recovered_current_restored',
        sourceUpdateJobId: authority.sourceUpdateJobId,
        snapshotId: authority.snapshotId,
        restoredContainerId: restored.containerId,
      },
    );
  }

  private async reconcileStarted(job: StoredJob, stages: readonly StageRecord[]): Promise<void> {
    const authority = this.prepare(job, stages);
    const remote = this.remoteFactory(authority.connection);
    const known = knownContainerIds(stages, authority.currentContainerId);
    const provenRollback = provenContainerIds(stages, 'rollback_replacement_created');
    const provenRestore = provenContainerIds(stages, 'restore_replacement_created');
    const recoveryRestores = provenContainerIds(stages, 'recovery_restore_replacement_created');

    this.stage(job.id, 'recovery_started', { sourceUpdateJobId: authority.sourceUpdateJobId });
    const remoteContainerId = await remote.resolveComposeContainer(authority.compose);
    if (!CONTAINER_ID.test(remoteContainerId)) {
      throw new ManualRollbackReconciliationError(
        'MANUAL_ROLLBACK_RECOVERY_REMOTE_STATE_INVALID',
        'Interrupted rollback Compose service resolved to an invalid container identifier.',
      );
    }
    this.stage(job.id, 'recovery_service_resolved', { containerId: remoteContainerId });

    const binding = this.targets.findById(authority.targetId)?.selectedContainerId;
    if (!binding || (!known.includes(binding) && binding !== remoteContainerId)) {
      throw new ManualRollbackReconciliationError(
        'MANUAL_ROLLBACK_RECOVERY_BINDING_INVALID',
        'Interrupted rollback target binding cannot be reconciled safely.',
      );
    }

    if (remoteContainerId === authority.currentContainerId) {
      this.rebindKnown(authority, [...known, remoteContainerId], remoteContainerId);
      if (!await this.healthy(remote, authority, remoteContainerId)) {
        throw new ManualRollbackReconciliationError(
          'MANUAL_ROLLBACK_RECOVERY_HEALTH_DEGRADED',
          'Pre-rollback current container is not healthy during recovery.',
        );
      }
      this.finalize(
        authority,
        'MANUAL_ROLLBACK_RECOVERY_NO_REMOTE_CHANGE',
        {
          outcome: 'recovered_no_remote_change',
          sourceUpdateJobId: authority.sourceUpdateJobId,
          containerId: remoteContainerId,
        },
      );
      return;
    }

    if (provenRestore.has(remoteContainerId) || recoveryRestores.has(remoteContainerId)) {
      this.rebindKnown(authority, [...known, remoteContainerId], remoteContainerId);
      if (await this.healthy(remote, authority, remoteContainerId)) {
        this.finalize(
          authority,
          'MANUAL_ROLLBACK_RECOVERY_CURRENT_RESTORED',
          {
            outcome: 'recovered_current_restored',
            sourceUpdateJobId: authority.sourceUpdateJobId,
            restoredContainerId: remoteContainerId,
          },
        );
        return;
      }
      await this.restoreCurrent(authority, remote, remoteContainerId, [...known, remoteContainerId]);
      return;
    }

    if (provenRollback.has(remoteContainerId)) {
      this.rebindKnown(authority, [...known, remoteContainerId], remoteContainerId);
      if (await this.healthy(remote, authority, remoteContainerId)) {
        this.finalize(
          authority,
          'MANUAL_ROLLBACK_RECOVERY_ROLLBACK_VERIFIED',
          {
            outcome: 'recovered_rollback_verified',
            sourceUpdateJobId: authority.sourceUpdateJobId,
            rollbackContainerId: remoteContainerId,
            rollbackDigest: authority.rollbackDigest,
          },
        );
        return;
      }
      await this.restoreCurrent(authority, remote, remoteContainerId, [...known, remoteContainerId]);
      return;
    }

    // The remote service changed but the replacement event was not durably journaled.
    // Treat it as ambiguous and restore only the exact previously healthy update digest.
    await this.restoreCurrent(authority, remote, remoteContainerId, [...known, remoteContainerId]);
  }

  async reconcile(): Promise<ManualRollbackReconciliationSummary> {
    const pending = this.jobs.jobsNeedingReconciliation()
      .filter((job) => job.kind === 'container.rollback' && job.mutating);
    let reconciled = 0;
    for (const job of pending) {
      const stages = stageRecords(this.jobs.events(job.id));
      if (!hasStage(stages, 'rollback_started')) {
        this.finalizeBeforeMutation(job);
        reconciled += 1;
        continue;
      }
      try {
        await this.reconcileStarted(job, stages);
        reconciled += 1;
      } catch (error) {
        if (error instanceof ManualRollbackReconciliationError) throw error;
        throw new ManualRollbackReconciliationError(
          'MANUAL_ROLLBACK_RECOVERY_UNRESOLVED',
          'Interrupted manual rollback could not be reconciled safely; startup is blocked.',
        );
      }
    }
    return { examined: pending.length, reconciled };
  }
}
