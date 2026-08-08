import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api, csrfTokenFromCookie } from './api.js';

const originalFetch = globalThis.fetch;
type FetchCall = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function mutationDocument(): void {
  vi.stubGlobal('document', { cookie: 'other=1; orc_csrf=csrf%2Btoken%3D' });
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('web API client', () => {
  it('always uses same-origin credentials and encodes target identifiers', async () => {
    const fetchMock = vi.fn<FetchCall>(async () => jsonResponse(200, {
      targetId: 'target/one',
      container: {},
      ollama: {},
      gpu: { available: false, errorClass: 'GPU_UNAVAILABLE' },
      modelStorage: { available: false, errorClass: 'MODEL_STORAGE_UNAVAILABLE' },
    }));
    globalThis.fetch = fetchMock as typeof fetch;

    await api.targetStatus('target/one');

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/v1/targets/target%2Fone/status');
    expect(init?.credentials).toBe('include');
    expect(init?.headers).toMatchObject({ accept: 'application/json' });
  });

  it('sends credentials only in the request body and does not touch browser storage', async () => {
    const fetchMock = vi.fn<FetchCall>(async () => jsonResponse(200, {
      user: { id: 'user-1', username: 'admin', role: 'admin' },
      expiresAt: '2026-08-08T16:00:00.000Z',
    }));
    globalThis.fetch = fetchMock as typeof fetch;

    await api.login('admin', 'super-secret-password');

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/v1/session');
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe(JSON.stringify({ username: 'admin', password: 'super-secret-password' }));
    expect(init?.credentials).toBe('include');
  });

  it('maps structured API errors without exposing an unrelated response body', async () => {
    globalThis.fetch = vi.fn<FetchCall>(async () => jsonResponse(409, {
      error: { code: 'JOB_CONFLICT', message: 'Another mutation is active.' },
      ignored: 'REMOTE-SECRET',
    })) as typeof fetch;

    try {
      await api.listTargets();
      expect.fail('request should reject');
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      const apiError = error as ApiError;
      expect(apiError.status).toBe(409);
      expect(apiError.code).toBe('JOB_CONFLICT');
      expect(apiError.message).toBe('Another mutation is active.');
      expect(apiError.message).not.toContain('REMOTE-SECRET');
    }
  });

  it('orchestrates update planning endpoints with encoded server-issued snapshot IDs', async () => {
    mutationDocument();
    const fetchMock = vi.fn<FetchCall>(async (input) => {
      const url = String(input);
      if (url.endsWith('/update-preflight')) return jsonResponse(201, { snapshot: { id: 'snapshot/one' } });
      if (url.includes('/update-plan?')) return jsonResponse(200, { plan: { snapshotId: 'snapshot/one' } });
      if (url.includes('/update-strategy?')) return jsonResponse(200, { snapshotId: 'snapshot/one', strategy: { type: 'compose', executable: true } });
      return jsonResponse(201, { intent: { intentId: 'intent-one' } });
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const preflight = await api.updatePreflight('target/one');
    await api.updatePlan('target/one', preflight.snapshot.id);
    await api.updateStrategy('target/one', preflight.snapshot.id);
    await api.createUpdateExecutionIntent('target/one', preflight.snapshot.id);

    expect(fetchMock).toHaveBeenCalledTimes(4);
    const calls = fetchMock.mock.calls;
    expect(calls[0]?.[0]).toBe('/api/v1/targets/target%2Fone/container/update-preflight');
    expect(calls[0]?.[1]).toMatchObject({ method: 'POST', credentials: 'include' });
    expect(calls[0]?.[1]?.headers).toMatchObject({ 'x-csrf-token': 'csrf+token=' });

    expect(calls[1]?.[0]).toBe('/api/v1/targets/target%2Fone/container/update-plan?snapshotId=snapshot%2Fone');
    expect(calls[2]?.[0]).toBe('/api/v1/targets/target%2Fone/container/update-strategy?snapshotId=snapshot%2Fone');

    expect(calls[3]?.[0]).toBe('/api/v1/targets/target%2Fone/container/update-execution-intent');
    expect(calls[3]?.[1]?.headers).toMatchObject({
      'content-type': 'application/json',
      'x-csrf-token': 'csrf+token=',
    });
    expect(calls[3]?.[1]?.body).toBe(JSON.stringify({ snapshotId: 'snapshot/one' }));
  });

  it('executes updates with only intent and structural confirmation authority', async () => {
    mutationDocument();
    const fetchMock = vi.fn<FetchCall>(async () => jsonResponse(200, {
      update: {
        jobId: 'job-1',
        outcome: 'updated',
        intentId: 'intent/one',
        snapshotId: 'snapshot-1',
        previousContainerId: 'old-container',
        containerId: 'new-container',
        candidateDigest: 'sha256:server-result-only',
      },
    }));
    globalThis.fetch = fetchMock as typeof fetch;

    await api.executeUpdate('target/one', 'intent/one');

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/v1/targets/target%2Fone/container/update');
    expect(init?.method).toBe('POST');
    expect(init?.credentials).toBe('include');
    expect(init?.headers).toMatchObject({
      'content-type': 'application/json',
      'x-csrf-token': 'csrf+token=',
    });

    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(body).toEqual({
      intentId: 'intent/one',
      confirmation: {
        action: 'update',
        targetId: 'target/one',
        intentId: 'intent/one',
      },
    });
    const serialized = JSON.stringify(body);
    for (const forbidden of ['candidateDigest', 'currentDigest', 'imageReference', 'exactCandidateReference', 'containerId', 'composeService', 'workingDirectory']) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});

describe('CSRF cookie parser', () => {
  it('extracts and decodes only the CSRF cookie value', () => {
    expect(csrfTokenFromCookie('other=1; orc_csrf=hello%2Bworld%3D; session=opaque')).toBe('hello+world=');
    expect(csrfTokenFromCookie('session=opaque')).toBeNull();
  });
});
