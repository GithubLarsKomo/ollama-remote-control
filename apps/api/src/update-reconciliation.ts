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
import type { UpdateExecutionIntent } from './update-execution-intent.js';
import type {
  UpdateRemoteFactory,
  UpdateRemoteOperations,
} from './update-orchestrator.js';

const CONTAINER_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;
const INTENT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const CONTAINER_KEYS = new Set([
  'containerId',
  'fromContainerId',
  'previousContainerId',
  'failedContainerId',
  'rollbackContainerId',
  'lastKnownContainerId',
]);

interface SnapshotPayload {
  readonly schemaVersion: 1;
  readonly containerInspect: Record<string, any>;
  readonly imageInspect: Record<string, any>;
  readonly ollamaVersion: string | null;
}

interface RecoveryAuthority {
  readonly job: StoredJob;
  readonly intent: UpdateExecutionIntent;
  readonly targetId: string;
  readonly hostId: string;
  readonly oldContainerId: string;
  readonly rollbackImageReference: string;
  readonly compose: ComposeSnapshotContext;
  readonly connection: SshPrivateKeyConnection;
}

interface StageRecord {
  readonly stage: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface UpdateReconciliationSummary {
  readonly examined: number;
  readonly reconciled: number;
}

export class UpdateReconciliationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function safeJsonObject(serialized: string): Readonly<Record<string, unknown>> {
  try {
    const value = JSON.parse(serialized) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not object');
    return value as Readonly<Record<string, unknown>>;
  } catch {
    throw new UpdateReconciliationError(
      'UPDATE_RECOVERY_JOURNAL_INVALID',
      'Interrupted update recovery journal is invalid.',
    );
  }
}

function stageRecords(events: readonly StoredJobEvent[]): readonly StageRecord[] {
  const result: StageRecord[] = [];
  for (const event of events) {
    if (event.eventType !== 'stage') continue;
    const payload = safeJsonObject(event.payloadJson);
    if (typeof payload.stage !== 'string' || !payload.stage.trim()) {
      throw new UpdateReconciliationError(
        'UPDATE_RECOVERY_JOURNAL_INVALID',
        'Interrupted update recovery journal contains an invalid stage.',
      );
    }
    for (const [key, value] of Object.entries(payload)) {
      if (CONTAINER_KEYS.has(key) && value !== undefined && value !== null) {
        if (typeof value !== 'string' || !CONTAINER_ID.test(value)) {
          throw new UpdateReconciliationError(
            'UPDATE_RECOVERY_JOURNAL_INVALID',
            'Interrupted update recovery journal contains an invalid container identifier.',
          );
        }
      }
    }
    result.push({ stage: payload.stage.trim(), payload });
  }
  return result;
}

function stageExists(stages: readonly StageRecord[], name: string): boolean {
  return stages.some((stage) => stage.stage === name);
}

function recoveryIntentId(stages: readonly StageRecord[]): string {
  const values = stages
    .filter((stage) => stage.stage === 'lock_acquired')
    .map((stage) => stage.payload.intentId)
    .filter((value): value is string => typeof value === 'string' && Boolean(value.trim()))
    .map((value) => value.trim());
  const unique = [...new Set(values)];
  if (unique.length !== 1 || !INTENT_ID.test(unique[0]!)) {
    throw new UpdateReconciliationError(
      'UPDATE_RECOVERY_AUTHORITY_INVALID',
      'Interrupted update recovery authority is missing or ambiguous.',
    );
  }
  return unique[0]!;
}

function knownContainerIds(stages: readonly StageRecord[], oldContainerId: string): readonly string[] {
  const ids = new Set<string>([oldContainerId]);
  for (const stage of stages) {
    for (const [key, value] of Object.entries(stage.payload)) {
      if (CONTAINER_KEYS.has(key) && typeof value === 'string') ids.add(value);
    }
  }
  return [...ids];
}

function provenRecoveryRollbackIds(stages: readonly StageRecord[]): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const stage of stages) {
    if (stage.stage !== 'recovery_rollback_replacement_created') continue;
    const value = stage.payload.containerId;
    if (typeof value === 'string' && CONTAINER_ID.test(value)) ids.add(value);
  }
  return ids;
}

function parseIntent(serialized: string | null, expectedIntentId: string): UpdateExecutionIntent {
  try {
    if (!serialized) throw new Error('missing intent');
    const value = JSON.parse(serialized) as Record<string, any>;
    if (
      value.intentVersion !== 1
      || value.intentId !== expectedIntentId
      || typeof value.targetId !== 'string'
      || typeof value.snapshotId !== 'string'
      || typeof value.imageReference !== 'string'
      || typeof value.currentDigest !== 'string'
      || typeof value.candidateDigest !== 'string'
      || typeof value.exactCandidateReference !== 'string'
      || value.strategy !== 'compose'
      || typeof value.composeService !== 'string'
      || typeof value.createdAt !== 'string'
    ) throw new Error('invalid intent');
    return value as unknown as UpdateExecutionIntent;
  } catch {
    throw new UpdateReconciliationError(
      'UPDATE_RECOVERY_AUTHORITY_INVALID',
      'Stored update execution intent is invalid for recovery.',
    );
  }
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
    return {
      schemaVersion: 1,
      containerInspect: value.containerInspect,
      imageInspect: value.imageInspect,
      ollamaVersion: typeof value.ollamaVersion === 'string' ? value.ollamaVersion : null,
    };
  } catch {
    throw new UpdateReconciliationError(
      'UPDATE_RECOVERY_SNAPSHOT_INVALID',
      'Encrypted update snapshot is invalid for recovery.',
    );
  }
}

export class UpdateReconciliationService {
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

  private prepare(job: StoredJob, intentId: string): RecoveryAuthority {
    if (!this.masterKey) {
      throw new UpdateReconciliationError(
        'UPDATE_RECOVERY_MASTER_KEY_REQUIRED',
        'Interrupted update recovery requires the configured master key.',
      );
    }
    const target = this.targets.findById(job.targetId);
    if (!target) {
      throw new UpdateReconciliationError(
        'UPDATE_RECOVERY_TARGET_MISSING',
        'Interrupted update target no longer exists.',
      );
    }

    const intentJob = this.jobs.get(intentId);
    if (
      intentJob.kind !== 'container.update_execution_intent'
      || intentJob.mutating
      || intentJob.state !== 'succeeded'
      || intentJob.targetId !== target.id
    ) {
      throw new UpdateReconciliationError(
        'UPDATE_RECOVERY_AUTHORITY_INVALID',
        'Interrupted update execution intent is not valid recovery authority.',
      );
    }
    const intent = parseIntent(intentJob.resultJson, intentId);
    if (intent.targetId !== target.id) {
      throw new UpdateReconciliationError(
        'UPDATE_RECOVERY_AUTHORITY_INVALID',
        'Interrupted update intent target does not match.',
      );
    }
    try {
      const expectedCandidate = exactDigestImageReference(intent.imageReference, intent.candidateDigest);
      if (!sameExactImageReference(expectedCandidate, intent.exactCandidateReference)) throw new Error('candidate mismatch');
    } catch {
      throw new UpdateReconciliationError(
        'UPDATE_RECOVERY_AUTHORITY_INVALID',
        'Interrupted update candidate digest authority is invalid.',
      );
    }

    const storedSnapshot = this.snapshots.findById(intent.snapshotId);
    if (!storedSnapshot || storedSnapshot.targetId !== target.id) {
      throw new UpdateReconciliationError(
        'UPDATE_RECOVERY_SNAPSHOT_INVALID',
        'Interrupted update snapshot is missing or belongs to another target.',
      );
    }
    let plaintext: string;
    try {
      plaintext = new UpdateSnapshotCipher(this.masterKey).decrypt(
        { snapshotId: storedSnapshot.id, targetId: target.id },
        storedSnapshot.encryptedPayload,
      );
    } catch {
      throw new UpdateReconciliationError(
        'UPDATE_RECOVERY_SNAPSHOT_INVALID',
        'Interrupted update snapshot could not be authenticated.',
      );
    }
    const snapshot = parseSnapshot(plaintext);
    const oldContainerId = String(snapshot.containerInspect.Id ?? '').trim();
    if (!CONTAINER_ID.test(oldContainerId)) {
      throw new UpdateReconciliationError(
        'UPDATE_RECOVERY_SNAPSHOT_INVALID',
        'Interrupted update snapshot container identifier is invalid.',
      );
    }

    const snapshotImageReference = String(snapshot.containerInspect.Config?.Image ?? '').trim();
    let rollbackImageReference: string;
    try {
      rollbackImageReference = exactDigestImageReference(snapshotImageReference, intent.currentDigest);
    } catch {
      throw new UpdateReconciliationError(
        'UPDATE_RECOVERY_ROLLBACK_IMAGE_INVALID',
        'Interrupted update rollback image digest is invalid.',
      );
    }
    const repoDigests = Array.isArray(snapshot.imageInspect.RepoDigests)
      ? snapshot.imageInspect.RepoDigests.map(String)
      : [];
    if (!repoDigests.some((reference) => sameExactImageReference(reference, rollbackImageReference))) {
      throw new UpdateReconciliationError(
        'UPDATE_RECOVERY_ROLLBACK_IMAGE_INVALID',
        'Interrupted update snapshot does not prove the rollback digest.',
      );
    }

    let compose: ComposeSnapshotContext | null;
    try {
      compose = composeContextFromInspect(snapshot.containerInspect);
    } catch {
      throw new UpdateReconciliationError(
        'UPDATE_RECOVERY_COMPOSE_INVALID',
        'Interrupted update Compose context is invalid.',
      );
    }
    if (!compose || compose.service !== intent.composeService) {
      throw new UpdateReconciliationError(
        'UPDATE_RECOVERY_COMPOSE_INVALID',
        'Interrupted update Compose service does not match the execution intent.',
      );
    }

    const host = this.hosts.findHostById(target.hostId);
    if (!host) {
      throw new UpdateReconciliationError(
        'UPDATE_RECOVERY_HOST_MISSING',
        'Interrupted update host no longer exists.',
      );
    }
    const credential = this.credentials.findByHostId(host.id);
    if (!credential) {
      throw new UpdateReconciliationError(
        'UPDATE_RECOVERY_CREDENTIAL_MISSING',
        'Interrupted update host has no SSH credential.',
      );
    }
    let privateKey: string;
    try {
      privateKey = new SecretCipher(this.masterKey).decrypt(
        { credentialId: credential.id, hostId: host.id },
        credential.encryptedPrivateKey,
      );
    } catch {
      throw new UpdateReconciliationError(
        'UPDATE_RECOVERY_CREDENTIAL_INVALID',
        'Interrupted update SSH credential could not be authenticated.',
      );
    }

    return {
      job,
      intent,
      targetId: target.id,
      hostId: host.id,
      oldContainerId,
      rollbackImageReference,
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

  private rebindKnown(
    authority: RecoveryAuthority,
    allowedExpected: readonly string[],
    newContainerId: string,
  ): void {
    const current = this.targets.findById(authority.targetId);
    if (!current) {
      throw new UpdateReconciliationError(
        'UPDATE_RECOVERY_BINDING_INVALID',
        'Interrupted update target disappeared during recovery.',
      );
    }
    if (current.selectedContainerId === newContainerId) return;
    if (!allowedExpected.includes(current.selectedContainerId)) {
      throw new UpdateReconciliationError(
        'UPDATE_RECOVERY_BINDING_INVALID',
        'Interrupted update target binding is outside the recovery journal.',
      );
    }
    const rebound = this.bindings.rebindContainer(
      authority.targetId,
      current.selectedContainerId,
      newContainerId,
      this.now().toISOString(),
    );
    if (!rebound) {
      throw new UpdateReconciliationError(
        'UPDATE_RECOVERY_BINDING_FAILED',
        'Interrupted update target binding could not be reconciled.',
      );
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
        action: 'container.update.recovered',
        parameters: {
          intentId: authority.intent.intentId,
          snapshotId: authority.intent.snapshotId,
          outcome: result.outcome,
        },
        result: 'failed',
        errorClass,
        jobId: authority.job.id,
      });
    } catch {
      // A completed recovery must not be reopened solely because audit persistence failed.
    }
  }

  private finalizeBeforeForward(job: StoredJob): void {
    const errorClass = 'UPDATE_RECOVERY_INTERRUPTED_BEFORE_MUTATION';
    this.jobs.transition(job.id, 'failed', {
      result: {
        outcome: 'recovered_interrupted_before_mutation',
        targetId: job.targetId,
      },
      errorClass,
    });
    try {
      this.audit.record({
        actorUserId: job.actorUserId,
        targetId: job.targetId,
        action: 'container.update.recovered',
        parameters: { outcome: 'recovered_interrupted_before_mutation' },
        result: 'failed',
        errorClass,
        jobId: job.id,
      });
    } catch {
      // Recovery is terminal even if the best-effort audit append fails.
    }
  }

  private async requireHealthy(
    remote: UpdateRemoteOperations,
    authority: RecoveryAuthority,
    containerId: string,
  ): Promise<void> {
    const health = await remote.health(authority.targetId, containerId);
    if (health.status !== 'healthy') {
      throw new UpdateReconciliationError(
        'UPDATE_RECOVERY_HEALTH_DEGRADED',
        'Recovered Ollama container health is degraded.',
      );
    }
  }

  private async reconcileForwardStarted(
    job: StoredJob,
    stages: readonly StageRecord[],
  ): Promise<void> {
    const authority = this.prepare(job, recoveryIntentId(stages));
    const remote = this.remoteFactory(authority.connection);
    const known = knownContainerIds(stages, authority.oldContainerId);
    const rollbackProven = provenRecoveryRollbackIds(stages);

    this.stage(job.id, 'recovery_started', { intentId: authority.intent.intentId });
    const remoteContainerId = await remote.resolveComposeContainer(authority.compose);
    if (!CONTAINER_ID.test(remoteContainerId)) {
      throw new UpdateReconciliationError(
        'UPDATE_RECOVERY_REMOTE_STATE_INVALID',
        'Interrupted update Compose service resolved to an invalid container identifier.',
      );
    }
    this.stage(job.id, 'recovery_service_resolved', { containerId: remoteContainerId });

    const currentBinding = this.targets.findById(authority.targetId)?.selectedContainerId;
    if (!currentBinding || (!known.includes(currentBinding) && currentBinding !== remoteContainerId)) {
      throw new UpdateReconciliationError(
        'UPDATE_RECOVERY_BINDING_INVALID',
        'Interrupted update target binding cannot be reconciled safely.',
      );
    }

    if (remoteContainerId === authority.oldContainerId) {
      this.rebindKnown(authority, [...known, remoteContainerId], authority.oldContainerId);
      await this.requireHealthy(remote, authority, authority.oldContainerId);
      this.stage(job.id, 'recovery_health_verified', { containerId: authority.oldContainerId });
      this.finalize(
        authority,
        'UPDATE_RECOVERY_INTERRUPTED_NO_REPLACEMENT',
        {
          outcome: 'recovered_original_container',
          intentId: authority.intent.intentId,
          snapshotId: authority.intent.snapshotId,
          containerId: authority.oldContainerId,
        },
      );
      return;
    }

    if (rollbackProven.has(remoteContainerId)) {
      this.rebindKnown(authority, [...known, remoteContainerId], remoteContainerId);
      await this.requireHealthy(remote, authority, remoteContainerId);
      this.stage(job.id, 'recovery_health_verified', { containerId: remoteContainerId });
      this.finalize(
        authority,
        'UPDATE_RECOVERY_ROLLBACK_SUCCEEDED',
        {
          outcome: 'recovered_rolled_back',
          intentId: authority.intent.intentId,
          snapshotId: authority.intent.snapshotId,
          rollbackContainerId: remoteContainerId,
        },
      );
      return;
    }

    this.stage(job.id, 'recovery_rollback_started', { fromContainerId: remoteContainerId });
    const rollback = await remote.replace(
      authority.compose,
      authority.rollbackImageReference,
      remoteContainerId,
      'local-only',
    );
    this.stage(job.id, 'recovery_rollback_replacement_created', {
      containerId: rollback.containerId,
      imageId: rollback.imageId,
    });

    this.rebindKnown(
      authority,
      [...known, remoteContainerId],
      rollback.containerId,
    );
    this.stage(job.id, 'recovery_binding_rebound', { containerId: rollback.containerId });
    await this.requireHealthy(remote, authority, rollback.containerId);
    this.stage(job.id, 'recovery_health_verified', { containerId: rollback.containerId });
    this.finalize(
      authority,
      'UPDATE_RECOVERY_ROLLBACK_SUCCEEDED',
      {
        outcome: 'recovered_rolled_back',
        intentId: authority.intent.intentId,
        snapshotId: authority.intent.snapshotId,
        failedContainerId: remoteContainerId,
        rollbackContainerId: rollback.containerId,
      },
    );
  }

  async reconcile(): Promise<UpdateReconciliationSummary> {
    const pending = this.jobs.jobsNeedingReconciliation()
      .filter((job) => job.kind === 'container.update' && job.mutating);
    let reconciled = 0;
    for (const job of pending) {
      const stages = stageRecords(this.jobs.events(job.id));
      if (!stageExists(stages, 'forward_started')) {
        this.finalizeBeforeForward(job);
        reconciled += 1;
        continue;
      }
      try {
        await this.reconcileForwardStarted(job, stages);
        reconciled += 1;
      } catch (error) {
        if (error instanceof UpdateReconciliationError) throw error;
        throw new UpdateReconciliationError(
          'UPDATE_RECOVERY_UNRESOLVED',
          'Interrupted update could not be reconciled safely; startup is blocked.',
        );
      }
    }
    return { examined: pending.length, reconciled };
  }
}
