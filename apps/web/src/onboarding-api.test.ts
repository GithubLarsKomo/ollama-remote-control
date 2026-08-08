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
  vi.stubGlobal('document', { cookie: 'orc_csrf=onboarding%2Bcsrf%3D' });
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('first-run onboarding API client', () => {
  it('probes host identity without sending SSH credentials', async () => {
    withCsrf();
    const fetchMock = vi.fn<FetchCall>(async () => jsonResponse(200, {
      algorithm: 'ssh-ed25519',
      fingerprint: `SHA256:${'A'.repeat(43)}`,
    }));
    globalThis.fetch = fetchMock as typeof fetch;

    await api.probeHost('server.internal', 2222);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/v1/hosts/probe');
    expect(init?.method).toBe('POST');
    expect(init?.credentials).toBe('include');
    expect(init?.headers).toMatchObject({
      'content-type': 'application/json',
      'x-csrf-token': 'onboarding+csrf=',
    });
    expect(JSON.parse(String(init?.body))).toEqual({ hostname: 'server.internal', port: 2222 });
    expect(String(init?.body)).not.toContain('privateKey');
  });

  it('creates a host with only declared onboarding fields and no browser-created IDs', async () => {
    withCsrf();
    const fetchMock = vi.fn<FetchCall>(async () => jsonResponse(201, { host: { id: 'server-host-id' } }));
    globalThis.fetch = fetchMock as typeof fetch;

    await api.createHost({
      displayName: 'Ollama server',
      hostname: 'server.internal',
      port: 22,
      username: 'ops',
      confirmedFingerprint: `SHA256:${'B'.repeat(43)}`,
      privateKey: 'PRIVATE-KEY-ONLY-IN-THIS-REQUEST',
    });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/v1/hosts');
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual([
      'confirmedFingerprint', 'displayName', 'hostname', 'port', 'privateKey', 'username',
    ]);
    expect(body.privateKey).toBe('PRIVATE-KEY-ONLY-IN-THIS-REQUEST');
    for (const forbidden of ['hostId', 'credentialId', 'encryptedPrivateKey', 'hostKeyAlgorithm']) {
      expect(body).not.toHaveProperty(forbidden);
    }
  });

  it('resumes stored hosts and encodes host IDs for discovery and target selection', async () => {
    withCsrf();
    const fetchMock = vi.fn<FetchCall>(async (input) => {
      const url = String(input);
      if (url === '/api/v1/hosts') return jsonResponse(200, { hosts: [{ id: 'host/one' }] });
      if (url.endsWith('/discover-ollama')) return jsonResponse(200, { dockerVersion: '27', candidates: [] });
      return jsonResponse(201, { target: { id: 'target-1' } });
    });
    globalThis.fetch = fetchMock as typeof fetch;

    await api.listHosts();
    await api.discoverOllama('host/one');
    await api.selectTarget('host/one', 'container-current', 'Primary Ollama');

    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/v1/hosts');
    expect(fetchMock.mock.calls[0]?.[1]?.credentials).toBe('include');

    expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/v1/hosts/host%2Fone/discover-ollama');
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ method: 'POST', credentials: 'include' });
    expect(fetchMock.mock.calls[1]?.[1]?.headers).toMatchObject({ 'x-csrf-token': 'onboarding+csrf=' });

    expect(fetchMock.mock.calls[2]?.[0]).toBe('/api/v1/hosts/host%2Fone/targets');
    expect(JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body))).toEqual({
      containerId: 'container-current',
      displayName: 'Primary Ollama',
    });
  });
});
