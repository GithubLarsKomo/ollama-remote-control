import type { OllamaTargetRepository, StoredJob } from '@orc/core';
import { canonicalOllamaModelName } from '@orc/core/modelfile-deploy';
import type { DockerContainerStatus } from '@orc/docker';
import { AuditService } from './audit.js';
import { JobService } from './jobs.js';
import type { OllamaModelInventoryResult } from './ollama-models.js';

const SHORT_KINDS = new Set([
  'model-smoke-test',
  'model-unload',
  'container.start',
  'container.stop',
  'container.restart',
]);

interface ModelMetadata {
  readonly model: string;
  readonly digest: string;
  readonly selectedContainerId: string;
}

interface LifecycleMetadata {
  readonly action: 'start' | 'stop' | 'restart';
  readonly containerId: string;
  readonly initialRunning: boolean;
  readonly initialStartedAt: string | null;
}

export interface ContainerObserver {
  observe(targetId: string, expectedContainerId: string): Promise<DockerContainerStatus>;
}

export interface InventoryObserver {
  read(targetId: string): Promise<OllamaModelInventoryResult>;
}

function parseObject(job: StoredJob): Record<string, unknown> | null {
  if (!job.resultJson) return null;
  try {
    const value = JSON.parse(job.resultJson);
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function modelMetadata(job: StoredJob): ModelMetadata | null {
  const value = parseObject(job);
  if (
    !value
    || typeof value.model !== 'string'
    || typeof value.digest !== 'string'
    || typeof value.selectedContainerId !== 'string'
    || !/^[a-f0-9]{64}$/iu.test(value.digest)
  ) return null;
  return {
    model: canonicalOllamaModelName(value.model),
    digest: value.digest.toLowerCase(),
    selectedContainerId: value.selectedContainerId,
  };
}

function lifecycleMetadata(job: StoredJob): LifecycleMetadata | null {
  const value = parseObject(job);
  if (!value || !['start', 'stop', 'restart'].includes(String(value.action))) return null;
  if (typeof value.containerId !== 'string' || typeof value.initialRunning !== 'boolean') return null;
  if (value.initialStartedAt !== null && typeof value.initialStartedAt !== 'string') return null;
  return {
    action: value.action as LifecycleMetadata['action'],
    containerId: value.containerId,
    initialRunning: value.initialRunning,
    initialStartedAt: value.initialStartedAt as string | null,
  };
}

function canonical(value: string): string {
  return canonicalOllamaModelName(value);
}

function matchingInstalled(inventory: OllamaModelInventoryResult, metadata: ModelMetadata) {
  return inventory.installed.filter((entry) => (
    (canonical(entry.name) === metadata.model || canonical(entry.model) === metadata.model)
    && entry.digest === metadata.digest
  ));
}

function matchingRunning(inventory: OllamaModelInventoryResult, metadata: ModelMetadata) {
  return inventory.running.filter((entry) => (
    (canonical(entry.name) === metadata.model || canonical(entry.model) === metadata.model)
    && entry.digest === metadata.digest
  ));
}

export class ShortMutationReconciliationService {
  constructor(
    private readonly jobs: JobService,
    private readonly audit: AuditService,
    private readonly targets: OllamaTargetRepository,
    private readonly inventory: InventoryObserver,
    private readonly containers: ContainerObserver,
  ) {}

  private transitionFailed(job: StoredJob, errorClass: string, result: Readonly<Record<string, unknown>> = {}): void {
    const current = this.jobs.get(job.id);
    if (!['queued', 'running', 'cancelling'].includes(current.state)) return;
    this.jobs.transition(job.id, 'failed', {
      result: { ...result, reconciledAfterRestart: true, verified: false },
      errorClass,
    });
    try {
      this.audit.record({
        actorUserId: job.actorUserId,
        hostId: null,
        targetId: job.targetId,
        action: 'job.restart_reconciled',
        parameters: { jobId: job.id, kind: job.kind, outcome: 'failed' },
        result: 'failed',
        errorClass,
        jobId: job.id,
      });
    } catch { /* recovery terminal state has priority */ }
  }

  private transitionSucceeded(job: StoredJob, result: Readonly<Record<string, unknown>>): void {
    const current = this.jobs.get(job.id);
    if (current.state !== 'running') {
      this.transitionFailed(job, 'RESTART_STATE_UNVERIFIED', result);
      return;
    }
    this.jobs.transition(job.id, 'succeeded', {
      result: { ...result, reconciledAfterRestart: true, verified: true },
      exitCode: 0,
    });
    try {
      this.audit.record({
        actorUserId: job.actorUserId,
        hostId: null,
        targetId: job.targetId,
        action: 'job.restart_reconciled',
        parameters: { jobId: job.id, kind: job.kind, outcome: 'succeeded' },
        result: 'succeeded',
        jobId: job.id,
      });
    } catch { /* recovery terminal state has priority */ }
  }

  private assertBinding(job: StoredJob, expectedContainerId: string): boolean {
    const target = this.targets.findById(job.targetId);
    return Boolean(target?.enabled && target.selectedContainerId === expectedContainerId);
  }

  private async reconcileModel(job: StoredJob): Promise<void> {
    const metadata = modelMetadata(job);
    if (!metadata) {
      this.transitionFailed(job, 'RESTART_METADATA_MISSING');
      return;
    }
    if (!this.assertBinding(job, metadata.selectedContainerId)) {
      this.transitionFailed(job, 'TARGET_BINDING_STALE', metadata);
      return;
    }
    let observed: OllamaModelInventoryResult;
    try {
      observed = await this.inventory.read(job.targetId);
    } catch {
      this.transitionFailed(job, 'RESTART_OBSERVATION_FAILED', metadata);
      return;
    }
    if (job.kind === 'model-unload') {
      if (matchingRunning(observed, metadata).length === 0) {
        this.transitionSucceeded(job, metadata);
      } else {
        this.transitionFailed(job, 'MODEL_UNLOAD_RESTART_UNVERIFIED', metadata);
      }
      return;
    }
    if (matchingInstalled(observed, metadata).length !== 1) {
      this.transitionFailed(job, 'MODEL_SMOKE_INSTALL_CHANGED', metadata);
      return;
    }
    if (matchingRunning(observed, metadata).length !== 0) {
      this.transitionFailed(job, 'MODEL_SMOKE_RESTART_RESIDUAL_LOAD', metadata);
      return;
    }
    // The desired cleanup postcondition is proven, but the generation response itself was lost.
    this.transitionFailed(job, 'MODEL_SMOKE_RESTART_INTERRUPTED_CLEAN', metadata);
  }

  private async reconcileLifecycle(job: StoredJob): Promise<void> {
    const metadata = lifecycleMetadata(job);
    if (!metadata) {
      this.transitionFailed(job, 'RESTART_METADATA_MISSING');
      return;
    }
    if (!this.assertBinding(job, metadata.containerId)) {
      this.transitionFailed(job, 'TARGET_BINDING_STALE', metadata);
      return;
    }
    let observed: DockerContainerStatus;
    try {
      observed = await this.containers.observe(job.targetId, metadata.containerId);
    } catch {
      this.transitionFailed(job, 'RESTART_OBSERVATION_FAILED', metadata);
      return;
    }
    const startVerified = metadata.action === 'start' && observed.running;
    const stopVerified = metadata.action === 'stop' && !observed.running;
    const restartVerified = metadata.action === 'restart'
      && observed.running
      && metadata.initialStartedAt !== null
      && observed.startedAt !== null
      && observed.startedAt !== metadata.initialStartedAt;
    if (startVerified || stopVerified || restartVerified) {
      this.transitionSucceeded(job, {
        ...metadata,
        running: observed.running,
        startedAt: observed.startedAt,
      });
    } else {
      this.transitionFailed(job, 'CONTAINER_RESTART_STATE_UNVERIFIED', {
        ...metadata,
        running: observed.running,
        startedAt: observed.startedAt,
      });
    }
  }

  async reconcile(): Promise<void> {
    for (const job of this.jobs.jobsNeedingReconciliation()) {
      if (!SHORT_KINDS.has(job.kind)) continue;
      if (job.kind === 'model-smoke-test' || job.kind === 'model-unload') await this.reconcileModel(job);
      else await this.reconcileLifecycle(job);
    }
  }
}
