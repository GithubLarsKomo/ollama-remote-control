import type {
  HostOnboardingRepository,
  OllamaTargetRepository,
  SshCredentialRepository,
  TargetContainerBindingRepository,
  UpdateSnapshotRepository,
} from '@orc/core';
import {
  exactDigestImageReference,
  sameExactImageReference,
} from '@orc/docker/compose-intent';
import {
  ComposeReplacementError,
  replaceComposeServiceImage,
  type ComposeImageSource,
  type ComposeReplacementResult,
} from '@orc/docker/compose-replacement';
import { resolveComposeServiceContainer } from '@orc/docker/compose-resolve';
import {
  composeContextFromInspect,
  DockerReconstructError,
  validateComposeStrategy,
  type ComposeSnapshotContext,
} from '@orc/docker/reconstruct';
import { SecretCipher, UpdateSnapshotCipher } from '@orc/security';
import {
  execPrivateKey,
  SshTransportError,
  type SshPrivateKeyConnection,
} from '@orc/ssh';
import { AuditService } from './audit.js';
import { JobService, JobServiceError } from './jobs.js';
import {
  OllamaHealthError,
  type OllamaHealthResult,
  type OllamaHealthService,
} from './ollama-health.js';
import type { UpdateExecutionIntent } from './update-execution-intent.js';

export interface UpdateRemoteOperations {
  validateCompose(context: ComposeSnapshotContext, expectedContainerId: string): Promise<void>;
  replace(
    context: ComposeSnapshotContext,
    exactImageReference: string,
    expectedPreviousContainerId: string,
    source: ComposeImageSource,
  ): Promise<ComposeReplacementResult>;
  resolveComposeContainer(context: ComposeSnapshotContext): Promise<string>;
  health(targetId: string, containerId: string): Promise<OllamaHealthResult>;
}

export type UpdateRemoteFactory = (connection: SshPrivateKeyConnection) => UpdateRemoteOperations;

export interface UpdateOrchestratorSuccess {
  readonly jobId: string;
  readonly outcome: 'updated';
  readonly intentId: string;
  readonly snapshotId: string;
  readonly previousContainerId: string;
  readonly containerId: string;
  readonly candidateDigest: string;
}

export class UpdateOrchestratorError extends Error {
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
  readonly ollamaVersion: string | null;
}

interface PreparedUpdate {
  readonly targetId: string;
  readonly hostId: string;
  readonly intent: UpdateExecutionIntent;
  readonly snapshot: SnapshotPayload;
  readonly oldContainerId: string;
  readonly rollbackImageReference: string;
  readonly compose: ComposeSnapshotContext;
  readonly connection: SshPrivateKeyConnection;
}

interface FailureDescriptor {
  readonly code: string;
  readonly statusCode: number;
  readonly message: string;
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
    throw new UpdateOrchestratorError('UPDATE_INTENT_INVALID', 409, 'Stored update execution intent is invalid.');
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
    throw new UpdateOrchestratorError('UPDATE_SNAPSHOT_INVALID', 409, 'Encrypted update snapshot payload is invalid.');
  }
}

function classifyFailure(error: unknown): FailureDescriptor {
  if (error instanceof UpdateOrchestratorError) return error;
  if (error instanceof JobServiceError) return error;
  if (error instanceof OllamaHealthError) return error;
  if (error instanceof DockerReconstructError) {
    return { code: error.code, statusCode: error.code === 'COMPOSE_UNAVAILABLE' ? 422 : 409, message: error.message };
  }
  if (error instanceof ComposeReplacementError) {
    const conflictCodes = new Set(['INVALID_CONTAINER_ID', 'INVALID_IMAGE_REFERENCE', 'COMPOSE_CONTEXT_CHANGED']);
    return { code: error.code, statusCode: conflictCodes.has(error.code) ? 409 : 502, message: error.message };
  }
  if (error instanceof SshTransportError) {
    return {
      code: error.code,
      statusCode: error.code === 'SSH_HOST_KEY_MISMATCH' ? 409 : error.code === 'AUTH_FAILED' ? 422 : 502,
      message: 'Remote SSH update operation failed.',
    };
  }
  return { code: 'UPDATE_FAILED', statusCode: 500, message: 'Container update failed.' };
}

function safeResult(value: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  return value;
}

export function createSshUpdateRemoteFactory(healthService: OllamaHealthService): UpdateRemoteFactory {
  return (connection) => {
    const executor = {
      exec: (argv: readonly string[], stdin?: string) => execPrivateKey(
        connection,
        argv,
        {
          timeoutMs: 120_000,
          maxOutputBytes: 2 * 1024 * 1024,
          stdin,
          maxInputBytes: 64 * 1024,
        },
      ),
    };
    return {
      async validateCompose(context, expectedContainerId) {
        await validateComposeStrategy(executor, context, expectedContainerId);
      },
      replace: (context, exactImageReference, expectedPreviousContainerId, source) => replaceComposeServiceImage(
        executor,
        context,
        exactImageReference,
        expectedPreviousContainerId,
        source,
      ),
      resolveComposeContainer: (context) => resolveComposeServiceContainer(executor, context),
      health: (targetId, containerId) => healthService.readContainer(targetId, containerId),
    };
  };
}

export class UpdateOrchestratorService {
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

  private prepare(targetId: string, intentId: string): PreparedUpdate {
    if (!this.masterKey) throw new UpdateOrchestratorError('MASTER_KEY_REQUIRED', 503, 'External master key is required.');
    const target = this.targets.findById(targetId);
    if (!target || !target.enabled) throw new UpdateOrchestratorError('TARGET_NOT_FOUND', 404, 'Ollama target was not found or is disabled.');

    const intentJob = this.jobs.get(intentId);
    if (
      intentJob.kind !== 'container.update_execution_intent'
      || intentJob.mutating
      || intentJob.state !== 'succeeded'
      || intentJob.targetId !== target.id
    ) {
      throw new UpdateOrchestratorError('UPDATE_INTENT_INVALID', 409, 'Update execution intent is not executable for this target.');
    }
    const intent = parseIntent(intentJob.resultJson, intentId);
    if (intent.targetId !== target.id) throw new UpdateOrchestratorError('UPDATE_INTENT_TARGET_MISMATCH', 409, 'Update intent target does not match.');

    let expectedCandidate: string;
    try { expectedCandidate = exactDigestImageReference(intent.imageReference, intent.candidateDigest); }
    catch { throw new UpdateOrchestratorError('UPDATE_INTENT_INVALID', 409, 'Update intent candidate digest is invalid.'); }
    if (!sameExactImageReference(expectedCandidate, intent.exactCandidateReference)) {
      throw new UpdateOrchestratorError('UPDATE_INTENT_INVALID', 409, 'Update intent exact candidate reference is inconsistent.');
    }

    const storedSnapshot = this.snapshots.findById(intent.snapshotId);
    if (!storedSnapshot) throw new UpdateOrchestratorError('UPDATE_SNAPSHOT_NOT_FOUND', 404, 'Update snapshot was not found.');
    if (storedSnapshot.targetId !== target.id) throw new UpdateOrchestratorError('UPDATE_SNAPSHOT_TARGET_MISMATCH', 409, 'Update snapshot does not belong to the target.');
    let plaintext: string;
    try {
      plaintext = new UpdateSnapshotCipher(this.masterKey).decrypt(
        { snapshotId: storedSnapshot.id, targetId: target.id },
        storedSnapshot.encryptedPayload,
      );
    } catch {
      throw new UpdateOrchestratorError('UPDATE_SNAPSHOT_INVALID', 409, 'Encrypted update snapshot could not be authenticated or decrypted.');
    }
    const snapshot = parseSnapshot(plaintext);
    const oldContainerId = String(snapshot.containerInspect.Id ?? '').trim();
    if (!oldContainerId || target.selectedContainerId !== oldContainerId) {
      throw new UpdateOrchestratorError('UPDATE_BINDING_STALE', 409, 'Target container binding changed after update planning.');
    }

    const snapshotImageReference = String(snapshot.containerInspect.Config?.Image ?? '').trim();
    let rollbackImageReference: string;
    try { rollbackImageReference = exactDigestImageReference(snapshotImageReference, intent.currentDigest); }
    catch { throw new UpdateOrchestratorError('ROLLBACK_IMAGE_INVALID', 409, 'Snapshot rollback image digest is invalid.'); }
    const repoDigests = Array.isArray(snapshot.imageInspect.RepoDigests) ? snapshot.imageInspect.RepoDigests.map(String) : [];
    if (!repoDigests.some((reference) => sameExactImageReference(reference, rollbackImageReference))) {
      throw new UpdateOrchestratorError('ROLLBACK_IMAGE_INVALID', 409, 'Snapshot does not prove the rollback image digest.');
    }

    let compose: ComposeSnapshotContext | null;
    try { compose = composeContextFromInspect(snapshot.containerInspect); }
    catch (error) {
      if (error instanceof DockerReconstructError) throw new UpdateOrchestratorError(error.code, 409, error.message);
      throw error;
    }
    if (!compose || compose.service !== intent.composeService) {
      throw new UpdateOrchestratorError('UPDATE_STRATEGY_INVALID', 409, 'Snapshot Compose strategy does not match the update intent.');
    }

    const host = this.hosts.findHostById(target.hostId);
    if (!host || !host.enabled) throw new UpdateOrchestratorError('HOST_NOT_FOUND', 404, 'Host was not found or is disabled.');
    const credential = this.credentials.findByHostId(host.id);
    if (!credential) throw new UpdateOrchestratorError('SSH_CREDENTIAL_NOT_FOUND', 409, 'Host has no SSH credential.');
    let privateKey: string;
    try {
      privateKey = new SecretCipher(this.masterKey).decrypt(
        { credentialId: credential.id, hostId: host.id },
        credential.encryptedPrivateKey,
      );
    } catch {
      throw new UpdateOrchestratorError('SSH_CREDENTIAL_INVALID', 409, 'Stored SSH credential could not be decrypted.');
    }

    return {
      targetId: target.id,
      hostId: host.id,
      intent,
      snapshot,
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

  private event(jobId: string, stage: string, payload: Readonly<Record<string, unknown>> = {}): void {
    this.jobs.appendEvent(jobId, 'stage', { stage, ...payload });
  }

  private rebindKnown(targetId: string, allowedExpected: readonly string[], newContainerId: string): boolean {
    const current = this.targets.findById(targetId);
    if (!current || !current.enabled) return false;
    if (current.selectedContainerId === newContainerId) return true;
    if (!allowedExpected.includes(current.selectedContainerId)) return false;
    return this.bindings.rebindContainer(
      targetId,
      current.selectedContainerId,
      newContainerId,
      this.now().toISOString(),
    );
  }

  private failWithoutRollback(
    jobId: string,
    prepared: PreparedUpdate,
    actorUserId: string,
    failure: FailureDescriptor,
  ): never {
    const result = safeResult({
      outcome: 'failed_before_replacement',
      intentId: prepared.intent.intentId,
      snapshotId: prepared.intent.snapshotId,
      causeClass: failure.code,
      containerId: prepared.oldContainerId,
    });
    try { this.jobs.transition(jobId, 'failed', { result, errorClass: failure.code }); } catch { /* preserve primary */ }
    try {
      this.audit.record({
        actorUserId,
        hostId: prepared.hostId,
        targetId: prepared.targetId,
        action: 'container.update.failed',
        parameters: { intentId: prepared.intent.intentId, snapshotId: prepared.intent.snapshotId },
        result: 'failed',
        errorClass: failure.code,
        jobId,
      });
    } catch { /* preserve primary */ }
    throw new UpdateOrchestratorError(failure.code, failure.statusCode, failure.message);
  }

  async execute(targetId: string, intentId: string, actorUserId: string): Promise<UpdateOrchestratorSuccess> {
    const prepared = this.prepare(targetId, intentId);
    const remote = this.remoteFactory(prepared.connection);
    const job = this.jobs.create({ targetId: prepared.targetId, actorUserId, kind: 'container.update', mutating: true });
    this.jobs.transition(job.id, 'running');

    let forwardAttempted = false;
    let candidateContainerId: string | null = null;
    try {
      this.audit.record({
        actorUserId,
        hostId: prepared.hostId,
        targetId: prepared.targetId,
        action: 'container.update.requested',
        parameters: {
          intentId: prepared.intent.intentId,
          snapshotId: prepared.intent.snapshotId,
          currentDigest: prepared.intent.currentDigest,
          candidateDigest: prepared.intent.candidateDigest,
        },
        result: 'requested',
        jobId: job.id,
      });
      this.event(job.id, 'lock_acquired', { intentId: prepared.intent.intentId });

      await remote.validateCompose(prepared.compose, prepared.oldContainerId);
      this.event(job.id, 'compose_revalidated', { containerId: prepared.oldContainerId });

      forwardAttempted = true;
      this.event(job.id, 'forward_started', { candidateDigest: prepared.intent.candidateDigest });
      const replacement = await remote.replace(
        prepared.compose,
        prepared.intent.exactCandidateReference,
        prepared.oldContainerId,
        'pull-exact',
      );
      candidateContainerId = replacement.containerId;
      this.event(job.id, 'replacement_created', { containerId: candidateContainerId, imageId: replacement.imageId });

      if (!this.rebindKnown(prepared.targetId, [prepared.oldContainerId], candidateContainerId)) {
        throw new UpdateOrchestratorError('TARGET_REBIND_FAILED', 409, 'Target binding could not be moved to the replacement container.');
      }
      this.event(job.id, 'binding_rebound', { fromContainerId: prepared.oldContainerId, containerId: candidateContainerId });

      const health = await remote.health(prepared.targetId, candidateContainerId);
      if (health.status !== 'healthy') {
        throw new UpdateOrchestratorError('CANDIDATE_HEALTH_DEGRADED', 502, 'Replacement Ollama health verification was degraded.');
      }
      this.event(job.id, 'health_verified', { containerId: candidateContainerId, version: health.ollama.apiVersion });

      const result: UpdateOrchestratorSuccess = {
        jobId: job.id,
        outcome: 'updated',
        intentId: prepared.intent.intentId,
        snapshotId: prepared.intent.snapshotId,
        previousContainerId: prepared.oldContainerId,
        containerId: candidateContainerId,
        candidateDigest: prepared.intent.candidateDigest,
      };
      this.jobs.transition(job.id, 'succeeded', { result: result as unknown as Readonly<Record<string, unknown>> });
      try {
        this.audit.record({
          actorUserId,
          hostId: prepared.hostId,
          targetId: prepared.targetId,
          action: 'container.update.succeeded',
          parameters: {
            intentId: prepared.intent.intentId,
            snapshotId: prepared.intent.snapshotId,
            previousContainerId: prepared.oldContainerId,
            containerId: candidateContainerId,
            candidateDigest: prepared.intent.candidateDigest,
          },
          result: 'succeeded',
          jobId: job.id,
        });
      } catch { /* terminal update remains successful */ }
      return result;
    } catch (error) {
      const primary = classifyFailure(error);
      if (!forwardAttempted) return this.failWithoutRollback(job.id, prepared, actorUserId, primary);

      let remoteContainerId: string;
      try {
        remoteContainerId = candidateContainerId ?? await remote.resolveComposeContainer(prepared.compose);
      } catch {
        const rollbackFailure = { code: 'UPDATE_FAILED_ROLLBACK_FAILED', statusCode: 502, message: 'Update failed and current Compose state could not be resolved for rollback.' };
        const result = safeResult({ outcome: 'rollback_failed', causeClass: primary.code, lastKnownContainerId: candidateContainerId ?? prepared.oldContainerId });
        try { this.jobs.transition(job.id, 'failed', { result, errorClass: rollbackFailure.code }); } catch { /* preserve */ }
        throw new UpdateOrchestratorError(rollbackFailure.code, rollbackFailure.statusCode, rollbackFailure.message);
      }

      if (remoteContainerId === prepared.oldContainerId) {
        return this.failWithoutRollback(job.id, prepared, actorUserId, primary);
      }

      this.event(job.id, 'rollback_started', { causeClass: primary.code, fromContainerId: remoteContainerId });
      try {
        const rollback = await remote.replace(
          prepared.compose,
          prepared.rollbackImageReference,
          remoteContainerId,
          'local-only',
        );
        this.event(job.id, 'rollback_replacement_created', { containerId: rollback.containerId, imageId: rollback.imageId });

        if (!this.rebindKnown(
          prepared.targetId,
          [prepared.oldContainerId, remoteContainerId, ...(candidateContainerId ? [candidateContainerId] : [])],
          rollback.containerId,
        )) {
          throw new UpdateOrchestratorError('ROLLBACK_REBIND_FAILED', 409, 'Target binding could not be moved to the rollback container.');
        }
        this.event(job.id, 'rollback_binding_rebound', { containerId: rollback.containerId });

        const rollbackHealth = await remote.health(prepared.targetId, rollback.containerId);
        if (rollbackHealth.status !== 'healthy') {
          throw new UpdateOrchestratorError('ROLLBACK_HEALTH_DEGRADED', 502, 'Rollback Ollama health verification was degraded.');
        }
        this.event(job.id, 'rollback_health_verified', { containerId: rollback.containerId, version: rollbackHealth.ollama.apiVersion });

        const result = safeResult({
          outcome: 'rolled_back',
          intentId: prepared.intent.intentId,
          snapshotId: prepared.intent.snapshotId,
          causeClass: primary.code,
          failedContainerId: remoteContainerId,
          rollbackContainerId: rollback.containerId,
        });
        this.jobs.transition(job.id, 'failed', { result, errorClass: 'UPDATE_FAILED_ROLLBACK_SUCCEEDED' });
        try {
          this.audit.record({
            actorUserId,
            hostId: prepared.hostId,
            targetId: prepared.targetId,
            action: 'container.update.rolled_back',
            parameters: {
              intentId: prepared.intent.intentId,
              causeClass: primary.code,
              failedContainerId: remoteContainerId,
              rollbackContainerId: rollback.containerId,
            },
            result: 'failed',
            errorClass: 'UPDATE_FAILED_ROLLBACK_SUCCEEDED',
            jobId: job.id,
          });
        } catch { /* preserve terminal result */ }
        throw new UpdateOrchestratorError('UPDATE_FAILED_ROLLBACK_SUCCEEDED', 502, 'Update failed; automatic rollback completed and was verified healthy.');
      } catch (rollbackError) {
        if (rollbackError instanceof UpdateOrchestratorError && rollbackError.code === 'UPDATE_FAILED_ROLLBACK_SUCCEEDED') throw rollbackError;
        const rollbackCause = classifyFailure(rollbackError);
        let lastKnownContainerId = remoteContainerId;
        try {
          const resolved = await remote.resolveComposeContainer(prepared.compose);
          lastKnownContainerId = resolved;
          this.rebindKnown(
            prepared.targetId,
            [prepared.oldContainerId, remoteContainerId, ...(candidateContainerId ? [candidateContainerId] : [])],
            resolved,
          );
        } catch { /* best-effort consistency only */ }
        const result = safeResult({
          outcome: 'rollback_failed',
          intentId: prepared.intent.intentId,
          snapshotId: prepared.intent.snapshotId,
          causeClass: primary.code,
          rollbackCauseClass: rollbackCause.code,
          lastKnownContainerId,
        });
        try { this.jobs.transition(job.id, 'failed', { result, errorClass: 'UPDATE_FAILED_ROLLBACK_FAILED' }); } catch { /* preserve */ }
        try {
          this.audit.record({
            actorUserId,
            hostId: prepared.hostId,
            targetId: prepared.targetId,
            action: 'container.update.rollback_failed',
            parameters: {
              intentId: prepared.intent.intentId,
              causeClass: primary.code,
              rollbackCauseClass: rollbackCause.code,
              lastKnownContainerId,
            },
            result: 'failed',
            errorClass: 'UPDATE_FAILED_ROLLBACK_FAILED',
            jobId: job.id,
          });
        } catch { /* preserve terminal failure */ }
        throw new UpdateOrchestratorError('UPDATE_FAILED_ROLLBACK_FAILED', 502, 'Update failed and automatic rollback could not be verified.');
      }
    }
  }
}
