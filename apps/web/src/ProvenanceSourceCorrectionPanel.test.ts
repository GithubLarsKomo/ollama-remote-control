import { afterEach, describe, expect, it, vi } from 'vitest';
import { activePersistedSource } from './ProvenanceSourceCorrectionPanel.js';
import {
  correctModelSource,
  type PersistedProvenanceSourceView,
} from './model-inventory.js';

function source(
  id: string,
  supersedesSourceId: string | null,
  overrides: Partial<PersistedProvenanceSourceView> = {},
): PersistedProvenanceSourceView {
  return {
    id,
    subjectKind: 'installed-model',
    targetId: 'target-1',
    modelName: 'example/model:Q4',
    modelDigest: 'a'.repeat(64),
    revisionId: null,
    sourceKind: 'url',
    sourceReference: 'https://example.invalid/source',
    origin: 'operator',
    confidence: 'medium',
    actorUserId: 'user-1',
    supersedesSourceId,
    note: null,
    createdAt: '2026-08-11T13:00:00.000Z',
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('activePersistedSource', () => {
  it('selects the unsuperseded head of an append-only correction chain', () => {
    const first = source('source-1', null);
    const second = source('source-2', first.id, { sourceKind: 'huggingface' });
    const third = source('source-3', second.id, {
      sourceKind: 'unknown',
      sourceReference: null,
      confidence: 'unknown',
    });

    expect(activePersistedSource([third, second, first])?.id).toBe(third.id);
    expect(activePersistedSource([first, second, third])?.id).toBe(third.id);
  });

  it('returns null when no persisted source evidence exists', () => {
    expect(activePersistedSource([])).toBeNull();
  });
});

describe('correctModelSource', () => {
  it('posts only correction evidence to the persisted node with CSRF, never browser target/model/digest authority', async () => {
    vi.stubGlobal('document', { cookie: 'orc_csrf=csrf%20token' });
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe('/api/v1/provenance/nodes/node-installed/source-corrections');
      expect(init?.method).toBe('POST');
      expect(init?.credentials).toBe('include');
      expect(init?.headers).toMatchObject({
        accept: 'application/json',
        'content-type': 'application/json',
        'x-csrf-token': 'csrf token',
      });
      const body = JSON.parse(String(init?.body));
      expect(body).toEqual({
        sourceKind: 'huggingface',
        sourceReference: 'https://huggingface.co/example/model',
        confidence: 'high',
        note: 'verified manually',
        supersedesSourceId: 'source-1',
      });
      expect(body).not.toHaveProperty('targetId');
      expect(body).not.toHaveProperty('modelName');
      expect(body).not.toHaveProperty('modelDigest');
      return new Response(JSON.stringify({ source: source('source-2', 'source-1', {
        sourceKind: 'huggingface',
        sourceReference: 'https://huggingface.co/example/model',
        confidence: 'high',
        note: 'verified manually',
      }) }), { status: 201, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await correctModelSource('node-installed', {
      sourceKind: 'huggingface',
      sourceReference: 'https://huggingface.co/example/model',
      confidence: 'high',
      note: 'verified manually',
      supersedesSourceId: 'source-1',
    });

    expect(result.id).toBe('source-2');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
