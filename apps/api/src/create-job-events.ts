import type { ServerResponse } from 'node:http';
import type { StoredJobEvent } from '@orc/core';
import type { ModelCreateService, PublicCreateJob } from './model-create.js';

const TERMINAL_STATES = new Set(['succeeded', 'failed', 'cancelled']);
const MAX_PUBLIC_EVENT_BYTES = 16 * 1024;
const POLL_INTERVAL_MS = 250;
const KEEPALIVE_INTERVAL_MS = 15_000;

export class CreateJobEventError extends Error {
  constructor(
    readonly code: string,
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

export interface PublicCreateEvent {
  readonly sequence: number;
  readonly event: 'state' | 'create-request' | 'progress';
  readonly data: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
}

function objectPayload(event: StoredJobEvent): Record<string, unknown> {
  if (Buffer.byteLength(event.payloadJson, 'utf8') > MAX_PUBLIC_EVENT_BYTES) {
    throw new CreateJobEventError('JOB_EVENT_INVALID', 500, 'Persisted model-create job event is too large.');
  }
  try {
    const parsed = JSON.parse(event.payloadJson);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not object');
    return parsed as Record<string, unknown>;
  } catch {
    throw new CreateJobEventError('JOB_EVENT_INVALID', 500, 'Persisted model-create job event is invalid.');
  }
}

function stringOrNull(value: unknown, maxLength: number): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || value.length > maxLength || /[\u0000-\u001f\u007f]/u.test(value)) return null;
  return value;
}

export function parseCreateEventCursor(value: unknown): number {
  if (value === undefined || value === null || value === '') return 0;
  const text = Array.isArray(value) ? value[0] : value;
  if (typeof text !== 'string' || !/^\d{1,10}$/u.test(text)) {
    throw new CreateJobEventError('INVALID_JOB_CURSOR', 400, 'Job event cursor is invalid.');
  }
  const cursor = Number(text);
  if (!Number.isSafeInteger(cursor) || cursor < 0) {
    throw new CreateJobEventError('INVALID_JOB_CURSOR', 400, 'Job event cursor is invalid.');
  }
  return cursor;
}

export function publicCreateEvent(event: StoredJobEvent): PublicCreateEvent | null {
  const payload = objectPayload(event);
  if (event.eventType === 'state') {
    const state = stringOrNull(payload.state, 32);
    if (!state || !['queued', 'running', 'cancelling', 'succeeded', 'failed', 'cancelled'].includes(state)) {
      throw new CreateJobEventError('JOB_EVENT_INVALID', 500, 'Persisted model-create state event is invalid.');
    }
    return {
      sequence: event.sequence,
      event: 'state',
      data: {
        state,
        errorClass: stringOrNull(payload.errorClass, 120),
      },
      createdAt: event.createdAt,
    };
  }
  if (event.eventType === 'create-request') {
    const outputModel = stringOrNull(payload.outputModel, 512);
    const baseModel = stringOrNull(payload.baseModel, 512);
    const revisionId = stringOrNull(payload.revisionId, 128);
    if (!outputModel || !baseModel || !revisionId) {
      throw new CreateJobEventError('JOB_EVENT_INVALID', 500, 'Persisted model-create request event is invalid.');
    }
    return {
      sequence: event.sequence,
      event: 'create-request',
      data: { outputModel, baseModel, revisionId },
      createdAt: event.createdAt,
    };
  }
  if (event.eventType === 'progress') {
    const status = stringOrNull(payload.status, 240);
    if (!status) throw new CreateJobEventError('JOB_EVENT_INVALID', 500, 'Persisted model-create progress event is invalid.');
    return {
      sequence: event.sequence,
      event: 'progress',
      data: { status },
      createdAt: event.createdAt,
    };
  }
  return null;
}

function writeSse(response: ServerResponse, event: string, data: unknown, id?: number): void {
  if (response.destroyed || response.writableEnded) return;
  if (id !== undefined) response.write(`id: ${id}\n`);
  response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function terminal(job: PublicCreateJob): boolean {
  return TERMINAL_STATES.has(job.state);
}

export async function streamCreateJobEvents(
  response: ServerResponse,
  creates: ModelCreateService,
  jobId: string,
  actorUserId: string,
  initialCursor: number,
): Promise<void> {
  let cursor = initialCursor;
  let closed = false;
  let lastWrite = Date.now();
  const close = () => { closed = true; };
  response.once('close', close);
  try {
    writeSse(response, 'ready', { job: creates.get(jobId, actorUserId), after: cursor });
    while (!closed && !response.destroyed && !response.writableEnded) {
      const job = creates.get(jobId, actorUserId);
      const events = creates.events(jobId, actorUserId);
      for (const stored of events) {
        if (stored.sequence <= cursor) continue;
        const event = publicCreateEvent(stored);
        cursor = stored.sequence;
        if (!event) continue;
        writeSse(response, event.event, { ...event.data, createdAt: event.createdAt }, event.sequence);
        lastWrite = Date.now();
      }
      if (terminal(job)) {
        writeSse(response, 'end', { job });
        break;
      }
      if (Date.now() - lastWrite >= KEEPALIVE_INTERVAL_MS) {
        if (!response.destroyed && !response.writableEnded) response.write(': keepalive\n\n');
        lastWrite = Date.now();
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
  } finally {
    response.off('close', close);
    if (!response.destroyed && !response.writableEnded) response.end();
  }
}
