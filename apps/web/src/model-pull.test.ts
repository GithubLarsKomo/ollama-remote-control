import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  activeModelPull,
  applyPullSseEvent,
  cancelModelPull,
  isTerminalPullState,
  startModelPull,
  type PullJobView,
  type PullUiState,
} from './model-pull.js';

const originalFetch = globalThis.fetch;
type FetchCall = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function job(state: PullJobView['state'] = 'running'): PullJobView {
  return {
    id: 'job/one',
    targetId: 'target/one',
    kind: 'model-pull',
    state,
    createdAt: '2026-08-09T06:00:00.000Z',
    startedAt: state === 'queued' ? null : '2026-08-09T06:00:01.000Z',
    finishedAt: isTerminalPullState(state) ? '2026-08-09T06:01:00.000Z' : null,
    errorClass: state === 'failed' ? 'CANCEL_UNVERIFIED' : null,
  };
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('model pull browser client', () => {
  it('starts pull with only model authority, CSRF and encoded target ID', async () => {
    vi.stubGlobal('document', { cookie: 'orc_csrf=csrf%2Btoken%3D' });
    const fetchMock = vi.fn<FetchCall>(async () => jsonResponse(202, { job: job('queued') }));
    globalThis.fetch = fetchMock as typeof fetch;

    await startModelPull('target/one', 'qwen3.5:9b');

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/v1/targets/target%2Fone/models/pull');
    expect(init?.method).toBe('POST');
    expect(init?.credentials).toBe('include');
    expect(init?.headers).toMatchObject({
      'content-type': 'application/json',
      'x-csrf-token': 'csrf+token=',
    });
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(body).toEqual({ model: 'qwen3.5:9b' });
    const serialized = JSON.stringify(body);
    for (const forbidden of ['host', 'hostname', 'container', 'port', 'insecure', 'stream', 'endpoint', 'privateKey']) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it('finds an active pull and cancels only by encoded job ID', async () => {
    vi.stubGlobal('document', { cookie: 'orc_csrf=csrf-token' });
    const fetchMock = vi.fn<FetchCall>(async (input) => {
      const url = String(input);
      return jsonResponse(200, url.includes('/active') ? { job: job() } : { job: job('cancelling') });
    });
    globalThis.fetch = fetchMock as typeof fetch;

    await activeModelPull('target/one');
    await cancelModelPull('job/one');

    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/v1/targets/target%2Fone/models/pull/active');
    expect(fetchMock.mock.calls[0]?.[1]?.credentials).toBe('include');
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/v1/jobs/job%2Fone/cancel');
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ method: 'POST', credentials: 'include' });
    expect(fetchMock.mock.calls[1]?.[1]?.headers).toMatchObject({ 'x-csrf-token': 'csrf-token' });
    expect(fetchMock.mock.calls[1]?.[1]?.body).toBeUndefined();
  });
});

describe('model pull event reducer', () => {
  it('reconstructs model and progress from persisted replay and accepts terminal job state', () => {
    let state: PullUiState = { job: job('running'), model: null, progress: null };
    state = applyPullSseEvent(state, { type: 'pull-request', data: { model: 'qwen3.5:9b' } });
    state = applyPullSseEvent(state, {
      type: 'progress',
      data: {
        status: 'pulling layer',
        digest: 'sha256:abc',
        totalBytes: 1000,
        completedBytes: 500,
        percentage: 50,
        createdAt: '2026-08-09T06:00:05.000Z',
      },
    });
    state = applyPullSseEvent(state, { type: 'end', data: { job: job('succeeded') } });

    expect(state.model).toBe('qwen3.5:9b');
    expect(state.progress?.percentage).toBe(50);
    expect(state.job?.state).toBe('succeeded');
    expect(isTerminalPullState(state.job!.state)).toBe(true);
  });

  it('preserves prior job metadata while applying a cancelling state event', () => {
    const initial: PullUiState = { job: job('running'), model: 'model-a', progress: null };
    const next = applyPullSseEvent(initial, {
      type: 'state',
      data: { state: 'cancelling', errorClass: null },
    });
    expect(next.job).toMatchObject({ id: 'job/one', state: 'cancelling', targetId: 'target/one' });
    expect(next.model).toBe('model-a');
  });
});
