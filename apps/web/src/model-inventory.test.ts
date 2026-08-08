import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fetchModelInventory,
  runningModelDigests,
  summarizeModelInventory,
  type ModelInventoryView,
} from './model-inventory.js';

const originalFetch = globalThis.fetch;
type FetchCall = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const inventory: ModelInventoryView = {
  targetId: 'target/one',
  transport: { mode: 'published-binding' },
  installed: [
    {
      name: 'a:latest', model: 'a:latest', modifiedAt: '2026-08-08T18:00:00Z',
      sizeBytes: 100, digest: 'a'.repeat(64),
      details: { format: 'gguf', family: 'a', families: ['a'], parameterSize: '1B', quantizationLevel: 'Q4' },
    },
    {
      name: 'b:latest', model: 'b:latest', modifiedAt: null,
      sizeBytes: 200, digest: 'b'.repeat(64),
      details: { format: 'gguf', family: 'b', families: ['b'], parameterSize: '2B', quantizationLevel: 'Q8' },
    },
  ],
  running: [{
    name: 'b:latest', model: 'b:latest', sizeBytes: 200, digest: 'b'.repeat(64),
    details: { format: 'gguf', family: 'b', families: ['b'], parameterSize: '2B', quantizationLevel: 'Q8' },
    expiresAt: '2026-08-08T22:00:00Z', sizeVramBytes: 150, contextLength: 8192,
  }],
};

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('model inventory web client', () => {
  it('uses encoded target path, same-origin credentials and read-only GET without CSRF/body', async () => {
    const fetchMock = vi.fn<FetchCall>(async () => new Response(JSON.stringify(inventory), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    globalThis.fetch = fetchMock as typeof fetch;

    const result = await fetchModelInventory('target/one');
    expect(result.targetId).toBe('target/one');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/v1/targets/target%2Fone/models');
    expect(init).toEqual({ method: 'GET', credentials: 'include', headers: { accept: 'application/json' } });
  });

  it('maps structured API errors without retaining unrelated response fields', async () => {
    globalThis.fetch = vi.fn<FetchCall>(async () => new Response(JSON.stringify({
      error: { code: 'CONTAINER_NOT_RUNNING', message: 'Ollama container is not running.' },
      secret: 'REMOTE-SECRET',
    }), { status: 409, headers: { 'content-type': 'application/json' } })) as typeof fetch;

    await expect(fetchModelInventory('target')).rejects.toMatchObject({
      status: 409,
      code: 'CONTAINER_NOT_RUNNING',
      message: 'Ollama container is not running.',
    });
  });
});

describe('model inventory summaries', () => {
  it('aggregates disk/VRAM counts and bytes deterministically', () => {
    expect(summarizeModelInventory(inventory)).toEqual({
      installedCount: 2,
      installedBytes: 300,
      runningCount: 1,
      runningVramBytes: 150,
    });
  });

  it('marks loaded models by digest rather than display-name spelling', () => {
    expect(runningModelDigests(inventory)).toEqual(new Set(['b'.repeat(64)]));
  });
});
