import type { ServerResponse } from 'node:http';
import type { StoredJobEvent } from '@orc/core';
import type { ModelPullService, PublicPullJob } from './model-pull.js';

const TERMINAL_STATES = new Set(['succeeded', 'failed', 'cancelled']);
const MAX_PUBLIC_EVENT_BYTES = 16 * 1024;
const POLL_INTERVAL_MS = 250;
const KEEPALIVE_INTERVAL_MS = 15_000;

export class PullJobEventError extends Error {
  constructor(
    readonly code: string,
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

export interface PublicPullEvent {
  readonly sequence: number;
  readonly event: 'state' | 'pull-request' | 'pull-baseline' | 'progress';
  readonly data: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
}

function objectPayload(event: StoredJobEvent): Record<string, unknown> {
  if (Buffer.byteLength(event.payloadJson, 'utf8') > MAX_PUBLIC_EVENT_BYTES) {
    throw new PullJobEventError('JOB_EVENT_INVALID', 500, 'Persisted pull job event is too large.');
  }
  try {
    const parsed = JSON.parse(event.payloadJson);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not object');
    return parsed as Record<string, unknown>;
  } catch {
    throw new PullJobEventError('JOB_EVENT_INVALID', 500, 'Persisted pull job event is invalid.');
  }
}

function stringOrNull(value: unknown, maxLength: number): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || value.length > maxLength || /[\u0000-\u001f\u007f]/u.test(value)) return null;
  return value;
}

function integerOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function publicPullEvent(event: StoredJobEvent): PublicPullEvent | null {
  const payload = objectPayload(event);
  if (event.eventType === 'state') {
    const state = stringOrNull(payload.state, 32);
    if (!state || !['queued', 'running', 'cancelling', 'succeeded', 'failed', 'cancelled'].includes(state)) {
      throw new PullJobEventError('JOB_EVENT_INVALID', 500, 'Persisted pull state event is invalid.');
    }
    return {
      sequence: event.sequence,
      event: 'state',
      data: {
        state,
        errorClass: stringOrNull(payload.errorClass, 120),
        exitCode: payload.exitCode === null || payload.exitCode === undefined
          ? null
          : typeof payload.exitCode === 'number' && Number.isSafeInteger(payload.exitCode)
            ? payload.exitCode
            : null,
      },
      createdAt: event.createdAt,
    };
  }
  if (event.eventType === 'pull-request') {
    const model = stringOrNull(payload.model, 512);
    if (!model) throw new PullJobEventError('JOB_EVENT_INVALID', 500, 'Persisted pull request event is invalid.');
    return { sequence: event.sequence, event: 'pull-request', data: { model }, createdAt: event.createdAt };
  }
  if (event.eventType === 'pull-baseline') {
    const model = stringOrNull(payload.model, 512);
    const previousDigest = stringOrNull(payload.previousDigest, 128);
    if (!model) throw new PullJobEventError('JOB_EVENT_INVALID', 500, 'Persisted pull baseline event is invalid.');
    return { sequence: event.sequence, event: 'pull-baseline', data: { model, previousDigest }, createdAt: event.createdAt };
  }
  if (event.eventType === 'progress') {
    const status = stringOrNull(payload.status, 240);
    if (!status) throw new PullJobEventError('JOB_EVENT_INVALID', 500, 'Persisted pull progress event is invalid.');
    const totalBytes = integerOrNull(payload.totalBytes);
    const completedBytes = integerOrNull(payload.completedBytes);
    const percentage = integerOrNull(payload.percentage);
    if (percentage !== null && percentage > 100) throw new PullJobEventError('JOB_EVENT_INVALID', 500, 'Persisted pull percentage is invalid.');
    return {
      sequence: event.sequence,
      event: 'progress',
      data: {
        status,
        digest: stringOrNull(payload.digest, 128),
        totalBytes,
        completedBytes,
        percentage,
      },
      createdAt: event.createdAt,
    };
  }
  return null;
}

export function parsePullEventCursor(value: unknown): number {
  if (value === undefined || value === null || value === '') return 0;
  const text = Array.isArray(value) ? value[0] : value;
  if (typeof text !== 'string' || !/^\d{1,10}$/u.test(text)) {
    throw new PullJobEventError('INVALID_JOB_CURSOR', 400, 'Job event cursor is invalid.');
  }
  const cursor = Number(text);
  if (!Number.isSafeInteger(cursor) || cursor < 0) throw new PullJobEventError('INVALID_JOB_CURSOR', 400, 'Job event cursor is invalid.');
  return cursor;
}

function writeSse(response: ServerResponse, event: string, data: unknown, id?: number): void {
  if (response.destroyed || response.writableEnded) return;
  if (id !== undefined) response.write(`id: ${id}\n`);
  response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function terminal(job: PublicPullJob): boolean {
  return TERMINAL_STATES.has(job.state);
}

export async function streamPullJobEvents(
  response: ServerResponse,
  pulls: ModelPullService,
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
    writeSse(response, 'ready', { job: pulls.get(jobId, actorUserId), after: cursor });
    while (!closed && !response.destroyed && !response.writableEnded) {
      const job = pulls.get(jobId, actorUserId);
      const events = pulls.events(jobId, actorUserId);
      for (const stored of events) {
        if (stored.sequence <= cursor) continue;
        const event = publicPullEvent(stored);
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
