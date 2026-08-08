import { randomUUID } from 'node:crypto';
import type {
  JobRepository,
  JobState,
  StoredJob,
  StoredJobEvent,
} from '@orc/core';

const TERMINAL_STATES = new Set<JobState>(['succeeded', 'failed', 'cancelled']);
const TRANSITIONS: Readonly<Record<JobState, readonly JobState[]>> = {
  queued: ['running', 'cancelled'],
  running: ['succeeded', 'failed', 'cancelling'],
  cancelling: ['cancelled', 'failed'],
  succeeded: [],
  failed: [],
  cancelled: [],
};

export class JobServiceError extends Error {
  constructor(
    readonly code: string,
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

export interface CreateJobInput {
  readonly targetId: string;
  readonly actorUserId: string;
  readonly kind: string;
  readonly mutating: boolean;
}

export interface TransitionJobInput {
  readonly result?: Readonly<Record<string, unknown>> | null;
  readonly errorClass?: string | null;
  readonly exitCode?: number | null;
}

function eventPayload(state: JobState, input: TransitionJobInput = {}): string {
  return JSON.stringify({
    state,
    ...(input.result === undefined ? {} : { result: input.result }),
    ...(input.errorClass === undefined ? {} : { errorClass: input.errorClass }),
    ...(input.exitCode === undefined ? {} : { exitCode: input.exitCode }),
  });
}

function newStateEvent(jobId: string, state: JobState, timestamp: string, input: TransitionJobInput = {}): Omit<StoredJobEvent, 'sequence'> {
  return {
    id: randomUUID(),
    jobId,
    eventType: 'state',
    payloadJson: eventPayload(state, input),
    createdAt: timestamp,
  };
}

export class JobService {
  constructor(
    private readonly repository: JobRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  create(input: CreateJobInput): StoredJob {
    const kind = input.kind.trim();
    if (!kind || kind.length > 120) {
      throw new JobServiceError('INVALID_JOB', 400, 'Job kind is required and must be at most 120 characters.');
    }
    const timestamp = this.now().toISOString();
    const job: StoredJob = {
      id: randomUUID(),
      targetId: input.targetId,
      actorUserId: input.actorUserId,
      kind,
      mutating: input.mutating,
      state: 'queued',
      createdAt: timestamp,
      startedAt: null,
      finishedAt: null,
      resultJson: null,
      errorClass: null,
      exitCode: null,
    };
    const created = this.repository.createWithInitialEvent(
      job,
      newStateEvent(job.id, 'queued', timestamp),
    );
    if (!created) {
      throw new JobServiceError(
        input.mutating ? 'JOB_CONFLICT' : 'JOB_CREATE_FAILED',
        input.mutating ? 409 : 500,
        input.mutating
          ? 'Another mutating operation is already active for this Ollama target.'
          : 'Job could not be created.',
      );
    }
    return job;
  }

  get(jobId: string): StoredJob {
    const job = this.repository.findById(jobId);
    if (!job) throw new JobServiceError('JOB_NOT_FOUND', 404, 'Job was not found.');
    return job;
  }

  transition(jobId: string, nextState: JobState, input: TransitionJobInput = {}): StoredJob {
    const current = this.get(jobId);
    if (!TRANSITIONS[current.state].includes(nextState)) {
      throw new JobServiceError(
        'JOB_STATE_CONFLICT',
        409,
        `Job cannot transition from ${current.state} to ${nextState}.`,
      );
    }
    if (nextState === 'succeeded' && input.errorClass) {
      throw new JobServiceError('INVALID_JOB_RESULT', 400, 'Succeeded jobs cannot carry an error class.');
    }
    const timestamp = this.now().toISOString();
    const terminal = TERMINAL_STATES.has(nextState);
    const update = {
      state: nextState,
      startedAt: nextState === 'running' ? (current.startedAt ?? timestamp) : current.startedAt,
      finishedAt: terminal ? timestamp : null,
      resultJson: input.result === undefined ? current.resultJson : input.result === null ? null : JSON.stringify(input.result),
      errorClass: input.errorClass === undefined ? current.errorClass : input.errorClass,
      exitCode: input.exitCode === undefined ? current.exitCode : input.exitCode,
    } as const;
    const changed = this.repository.transitionWithEvent(
      jobId,
      current.state,
      update,
      newStateEvent(jobId, nextState, timestamp, input),
    );
    if (!changed) {
      throw new JobServiceError('JOB_STATE_CONFLICT', 409, 'Job state changed concurrently.');
    }
    return this.get(jobId);
  }

  appendEvent(jobId: string, eventType: string, payload: Readonly<Record<string, unknown>>): StoredJobEvent {
    this.get(jobId);
    const normalizedType = eventType.trim();
    if (!normalizedType || normalizedType.length > 80) {
      throw new JobServiceError('INVALID_JOB_EVENT', 400, 'Job event type is invalid.');
    }
    return this.repository.appendEvent({
      id: randomUUID(),
      jobId,
      eventType: normalizedType,
      payloadJson: JSON.stringify(payload),
      createdAt: this.now().toISOString(),
    });
  }

  events(jobId: string): readonly StoredJobEvent[] {
    this.get(jobId);
    return this.repository.listEvents(jobId);
  }

  jobsNeedingReconciliation(): readonly StoredJob[] {
    return this.repository.findNonTerminal();
  }
}
