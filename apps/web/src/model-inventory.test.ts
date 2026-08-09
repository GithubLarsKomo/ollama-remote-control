import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fetchModelDetail,
  fetchModelInventory,
  runningModelDigests,
  summarizeModelInventory,
  type ModelDetailView,
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

const detail: ModelDetailView = {
  targetId: 'target/one',
  transport: { mode: 'published-binding' },
  identity: {
    name: 'hf.co/example/model:Q4_K_M',
    model: 'hf.co/example/model:Q4_K_M',
    digest: 'c'.repeat(64),
    modifiedAt: '2026-08-09T05:00:00Z',
  },
  details: {
    format: 'gguf', family: 'qwen3', families: ['qwen3'], parameterSize: '9B',
    quantizationLevel: 'Q4_K_M', parentModel: null,
  },
  capabilities: ['completion'],
  modelfile: 'FROM /root/.ollama/models/blobs/sha256:abc',
  parameters: 'num_ctx 32768',
  template: '{{ .Prompt }}',
  system: null,
  license: null,
  requires: null,
  architecture: {
    architecture: 'qwen3', parameterCount: 9000000000, contextLength: 32768,
    embeddingLength: 4096, blockCount: 36, quantizationVersion: 2,
  },
  provenancePreview: {
    from: { reference: '/root/.ollama/models/blobs/sha256:abc', kind: 'local-artifact' },
    adapters: [],
  },
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

describe('model detail web client', () => {
  it('encodes target and namespaced model identity in a read-only same-origin request', async () => {
    const fetchMock = vi.fn<FetchCall>(async () => new Response(JSON.stringify(detail), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    globalThis.fetch = fetchMock as typeof fetch;

    const result = await fetchModelDetail('target/one', 'hf.co/example/model:Q4_K_M');
    expect(result.identity.model).toBe('hf.co/example/model:Q4_K_M');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/v1/targets/target%2Fone/model-details?model=hf.co%2Fexample%2Fmodel%3AQ4_K_M');
    expect(init).toEqual({ method: 'GET', credentials: 'include', headers: { accept: 'application/json' } });
    expect((init as RequestInit).body).toBeUndefined();
  });

  it('maps detail API errors without exposing unrelated payload fields', async () => {
    globalThis.fetch = vi.fn<FetchCall>(async () => new Response(JSON.stringify({
      error: { code: 'MODEL_NOT_FOUND', message: 'Requested model is not installed.' },
      secret: 'REMOTE-SECRET',
    }), { status: 404, headers: { 'content-type': 'application/json' } })) as typeof fetch;

    await expect(fetchModelDetail('target', 'missing:latest')).rejects.toMatchObject({
      status: 404,
      code: 'MODEL_NOT_FOUND',
      message: 'Requested model is not installed.',
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
