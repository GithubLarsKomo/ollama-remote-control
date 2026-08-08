import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from './api.js';

const originalFetch = globalThis.fetch;
type FetchCall = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function withCsrf(): void {
  vi.stubGlobal('document', { cookie: 'orc_csrf=lifecycle%2Bcsrf%3D' });
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('container lifecycle API client', () => {
  it('starts an encoded target with CSRF but no browser-invented confirmation authority', async () => {
    withCsrf();
    const fetchMock = vi.fn<FetchCall>(async () => jsonResponse(200, { job: { id: 'job-start' }, container: { running: true } }));
    globalThis.fetch = fetchMock as typeof fetch;

    await api.containerLifecycle('target/one', 'start');

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/v1/targets/target%2Fone/container/start');
    expect(init).toMatchObject({ method: 'POST', credentials: 'include' });
    expect(init?.headers).toMatchObject({ 'x-csrf-token': 'lifecycle+csrf=' });
    expect(init?.body).toBeUndefined();
  });

  it.each(['stop', 'restart'] as const)('sends only the exact structural confirmation for %s', async (action) => {
    withCsrf();
    const fetchMock = vi.fn<FetchCall>(async () => jsonResponse(200, { job: { id: `job-${action}` }, container: { running: action === 'restart' } }));
    globalThis.fetch = fetchMock as typeof fetch;

    await api.containerLifecycle('target/one', action, 'container-current');

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`/api/v1/targets/target%2Fone/container/${action}`);
    expect(init?.headers).toMatchObject({
      'content-type': 'application/json',
      'x-csrf-token': 'lifecycle+csrf=',
    });
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(body).toEqual({
      confirmation: {
        action,
        targetId: 'target/one',
        containerId: 'container-current',
      },
    });
    expect(Object.keys(body)).toEqual(['confirmation']);
    for (const forbidden of ['image', 'imageReference', 'hostId', 'hostname', 'privateKey', 'credentialId', 'argv', 'command']) {
      expect(JSON.stringify(body)).not.toContain(forbidden);
    }
  });
});
