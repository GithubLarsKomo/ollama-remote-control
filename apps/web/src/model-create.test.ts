import { afterEach, describe, expect, it, vi } from 'vitest';
import { createModelfileDeployPlan } from './model-create.js';

const originalFetch = globalThis.fetch;
type FetchCall = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('model-create deploy-plan client', () => {
  it('sends only output model and explicit replace intent, never browser-supplied destination evidence', async () => {
    vi.stubGlobal('document', { cookie: 'orc_csrf=csrf-1' });
    const fetchMock = vi.fn<FetchCall>(async () => new Response(JSON.stringify({
      plan: {
        planId: 'plan-1',
        confirmationToken: 'token',
        targetId: 'target-1',
        selectedContainerId: 'container-1',
        modelfileId: 'mf-1',
        revisionId: 'rev-1',
        revisionSha256: 'a'.repeat(64),
        outputModel: 'custom:latest',
        baseModel: 'base:latest',
        replacement: { existingDigest: 'b'.repeat(64), existingSizeBytes: 42 },
        apiVersion: '0.12.0',
        directiveCounts: {},
        expectedFields: [],
        createdAt: '2026-08-11T00:00:00.000Z',
        expiresAt: '2026-08-11T00:05:00.000Z',
      },
    }), { status: 201, headers: { 'content-type': 'application/json' } }));
    globalThis.fetch = fetchMock as typeof fetch;

    await createModelfileDeployPlan('target-1', 'mf-1', 'rev-1', 'custom', true);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(String(init?.body))).toEqual({ outputModel: 'custom', replaceExisting: true });
    expect(String(init?.body)).not.toContain('digest');
    expect(String(init?.body)).not.toContain('size');
    expect(init?.headers).toMatchObject({ 'x-csrf-token': 'csrf-1' });
  });
});