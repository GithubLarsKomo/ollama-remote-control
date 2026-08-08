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

afterEach(() => {
  globalThis.fetch = originalFetch;
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
});

describe('CSRF cookie parser', () => {
  it('extracts and decodes only the CSRF cookie value', () => {
    expect(csrfTokenFromCookie('other=1; orc_csrf=hello%2Bworld%3D; session=opaque')).toBe('hello+world=');
    expect(csrfTokenFromCookie('session=opaque')).toBeNull();
  });
});
