import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from './api.js';
import {
  appendLocalModelfileRevision,
  createLocalModelfile,
  importInstalledModelfile,
  listLocalModelfileRevisions,
  listLocalModelfiles,
  readLocalModelfile,
  readLocalModelfileRevision,
} from './modelfile-library.js';

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

describe('local Modelfile web client', () => {
  it('encodes artifact/revision identifiers and uses credentialed read-only GET requests', async () => {
    const fetchMock = vi.fn<FetchCall>(async () => jsonResponse(200, { modelfile: {}, revisions: [], revision: {} }));
    globalThis.fetch = fetchMock as typeof fetch;

    await listLocalModelfiles();
    await readLocalModelfile('artifact/one');
    await listLocalModelfileRevisions('artifact/one');
    await readLocalModelfileRevision('artifact/one', 'revision/one');

    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      '/api/v1/modelfiles',
      '/api/v1/modelfiles/artifact%2Fone',
      '/api/v1/modelfiles/artifact%2Fone/revisions',
      '/api/v1/modelfiles/artifact%2Fone/revisions/revision%2Fone',
    ]);
    for (const [, init] of fetchMock.mock.calls) {
      expect(init?.credentials).toBe('include');
      expect(init?.method).toBeUndefined();
      expect(init?.body).toBeUndefined();
    }
  });

  it('sends CSRF on local creation and preserves raw source exactly in JSON transport', async () => {
    mutationDocument();
    const fetchMock = vi.fn<FetchCall>(async () => jsonResponse(201, { modelfile: {} }));
    globalThis.fetch = fetchMock as typeof fetch;
    const rawText = '# keep CRLF\r\nFROM llama3.2:latest\r\n';

    await createLocalModelfile({ displayName: 'Local llama', description: 'Draft', rawText });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/v1/modelfiles');
    expect(init).toMatchObject({ method: 'POST', credentials: 'include' });
    expect(init?.headers).toMatchObject({
      'content-type': 'application/json',
      'x-csrf-token': 'csrf+token=',
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      displayName: 'Local llama',
      description: 'Draft',
      rawText,
    });
  });

  it('sends only expected base revision and raw text for append', async () => {
    mutationDocument();
    const fetchMock = vi.fn<FetchCall>(async () => jsonResponse(201, { modelfile: {} }));
    globalThis.fetch = fetchMock as typeof fetch;

    await appendLocalModelfileRevision('artifact/one', {
      expectedCurrentRevisionId: 'revision/base',
      rawText: 'FROM next:latest\n',
    });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/v1/modelfiles/artifact%2Fone/revisions');
    expect(init?.headers).toMatchObject({ 'x-csrf-token': 'csrf+token=' });
    expect(JSON.parse(String(init?.body))).toEqual({
      expectedCurrentRevisionId: 'revision/base',
      rawText: 'FROM next:latest\n',
    });
  });

  it('installed import sends only target/model plus local metadata and no provenance authority', async () => {
    mutationDocument();
    const fetchMock = vi.fn<FetchCall>(async () => jsonResponse(201, { modelfile: {} }));
    globalThis.fetch = fetchMock as typeof fetch;

    await importInstalledModelfile({
      targetId: 'target/one',
      model: 'hf.co/example/model:Q4_K_M',
      displayName: 'Imported model',
      description: 'Baseline',
    });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/v1/modelfiles/import-installed');
    const body = JSON.parse(String(init?.body));
    expect(body).toEqual({
      targetId: 'target/one',
      model: 'hf.co/example/model:Q4_K_M',
      displayName: 'Imported model',
      description: 'Baseline',
    });
    for (const forbidden of ['digest', 'rawText', 'importedTargetId', 'contentSha256', 'sourceKind']) {
      expect(Object.hasOwn(body, forbidden)).toBe(false);
    }
  });

  it('maps structured failures without retaining unrelated response fields', async () => {
    globalThis.fetch = vi.fn<FetchCall>(async () => jsonResponse(409, {
      error: { code: 'MODEFILE_REVISION_CONFLICT', message: 'Local Modelfile changed.' },
      secret: 'REMOTE-SECRET',
    })) as typeof fetch;

    await expect(readLocalModelfile('artifact')).rejects.toMatchObject({
      status: 409,
      code: 'MODEFILE_REVISION_CONFLICT',
      message: 'Local Modelfile changed.',
    } satisfies Partial<ApiError>);
  });
});
