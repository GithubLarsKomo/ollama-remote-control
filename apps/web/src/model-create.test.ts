import { afterEach, describe, expect, it, vi } from 'vitest';
import { createModelfileDeployPlan } from './model-create.js';

const originalFetch = globalThis.fetch;
type FetchCall = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('model-create client', () => {
  it('sends explicit replacement intent but never browser-supplied digest or size authority', async () => {
    vi.stubGlobal('document', { cookie: 'orc_csrf=csrf-token' });
    const fetchMock = vi.fn<FetchCall>(async () => jsonResponse({ plan: {
      planId: 'plan-1', confirmationToken: 'server-token', targetId: 'target/one', selectedContainerId: 'container-1',
      modelfileId: 'mf/one', revisionId: 'rev/one', revisionSha256: 'a'.repeat(64), outputModel: 'custom:latest',
      baseModel: 'base:latest', operation: 'replace', existingDestination: { digest: 'b'.repeat(64), sizeBytes: 42 },
      apiVersion: '0.32.5', directiveCounts: {}, expectedFields: [], createdAt: '2026-08-12T00:00:00.000Z', expiresAt: '2026-08-12T00:05:00.000Z',
    } }));
    globalThis.fetch = fetchMock as typeof fetch;

    await createModelfileDeployPlan('target/one', 'mf/one', 'rev/one', 'custom:latest', 'replace');

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/v1/targets/target%2Fone/modelfiles/mf%2Fone/revisions/rev%2Fone/deploy-plan');
    expect(init?.method).toBe('POST');
    expect(init?.headers).toMatchObject({ 'x-csrf-token': 'csrf-token' });
    expect(init?.body).toBe(JSON.stringify({ outputModel: 'custom:latest', replaceExisting: true }));
    expect(String(init?.body)).not.toContain('digest');
    expect(String(init?.body)).not.toContain('sizeBytes');
  });

  it('defaults to non-replacement planning', async () => {
    vi.stubGlobal('document', { cookie: 'orc_csrf=csrf-token' });
    const fetchMock = vi.fn<FetchCall>(async () => jsonResponse({ plan: {} }));
    globalThis.fetch = fetchMock as typeof fetch;

    await createModelfileDeployPlan('target-1', 'mf-1', 'rev-1', 'new-model');
    expect(fetchMock.mock.calls[0]?.[1]?.body).toBe(JSON.stringify({ outputModel: 'new-model', replaceExisting: false }));
  });
});
