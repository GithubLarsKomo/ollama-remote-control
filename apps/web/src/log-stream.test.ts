import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from './api.js';
import {
  appendBoundedLogEntries,
  isLogTail,
  MAX_LOG_BUFFER_CHARS,
  MAX_LOG_CHUNK_CHARS,
  MAX_LOG_ENTRIES,
  openLogStream,
  SseParser,
  type LogEntry,
} from './log-stream.js';

const originalFetch = globalThis.fetch;
type FetchCall = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function streamResponse(body = 'event: ready\ndata: {"tail":100}\n\n'): Response {
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream; charset=utf-8' },
  });
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('live log stream request', () => {
  it('encodes the target, uses same-origin credentials and wires the AbortSignal without CSRF', async () => {
    const fetchMock = vi.fn<FetchCall>(async () => streamResponse());
    globalThis.fetch = fetchMock as typeof fetch;
    const controller = new AbortController();

    await openLogStream('target/one', 100, controller.signal);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/v1/targets/target%2Fone/logs/stream?tail=100');
    expect(init).toMatchObject({ method: 'GET', credentials: 'include', signal: controller.signal });
    expect(init?.headers).toEqual({ accept: 'text/event-stream' });
    expect(init?.body).toBeUndefined();
  });

  it('accepts only the fixed bounded tail allowlist', async () => {
    expect([0, 50, 100, 200, 500, 1000].every(isLogTail)).toBe(true);
    expect(isLogTail(7)).toBe(false);
    await expect(openLogStream('target', 7 as 100, new AbortController().signal))
      .rejects.toMatchObject({ code: 'INVALID_LOG_TAIL' });
  });

  it('maps structured pre-stream API failures and rejects non-SSE success responses', async () => {
    globalThis.fetch = vi.fn<FetchCall>(async () => new Response(JSON.stringify({
      error: { code: 'TARGET_NOT_FOUND', message: 'Ollama target was not found or is disabled.' },
    }), { status: 404, headers: { 'content-type': 'application/json' } })) as typeof fetch;
    await expect(openLogStream('missing', 100, new AbortController().signal))
      .rejects.toMatchObject({ status: 404, code: 'TARGET_NOT_FOUND' });

    globalThis.fetch = vi.fn<FetchCall>(async () => new Response('not sse', {
      status: 200,
      headers: { 'content-type': 'text/plain' },
    })) as typeof fetch;
    await expect(openLogStream('target', 100, new AbortController().signal))
      .rejects.toBeInstanceOf(ApiError);
  });
});

describe('incremental SSE parser', () => {
  it('parses frames split across arbitrary network and CRLF boundaries and preserves multiline data', () => {
    const parser = new SseParser();
    expect(parser.push('event: rea')).toEqual([]);
    expect(parser.push('dy\r')).toEqual([]);
    expect(parser.push('\ndata: {"tail":100}\r')).toEqual([]);
    expect(parser.push('\n\r')).toEqual([]);
    expect(parser.push('\nevent: log\ndata: first\ndata: second\n\n')).toEqual([
      { event: 'ready', data: '{"tail":100}' },
      { event: 'log', data: 'first\nsecond' },
    ]);
  });

  it('ignores comments/empty frames and defaults the event name', () => {
    const parser = new SseParser();
    expect(parser.push(': keepalive\n\ndata: hello\n\n')).toEqual([{ event: 'message', data: 'hello' }]);
  });
});

describe('bounded log buffer', () => {
  it('drops oldest entries when the count limit is exceeded', () => {
    const entries: LogEntry[] = Array.from({ length: MAX_LOG_ENTRIES + 2 }, (_, id) => ({
      id,
      stream: 'stdout',
      chunk: `entry-${id}`,
    }));
    const bounded = appendBoundedLogEntries([], entries);
    expect(bounded).toHaveLength(MAX_LOG_ENTRIES);
    expect(bounded[0]?.id).toBe(2);
  });

  it('drops oldest content to stay within the total character budget', () => {
    const chunk = 'x'.repeat(60_000);
    const entries: LogEntry[] = Array.from({ length: 17 }, (_, index) => ({
      id: index + 1,
      stream: index % 2 === 0 ? 'stdout' : 'stderr',
      chunk,
    }));
    const bounded = appendBoundedLogEntries([], entries);
    expect(bounded.map((entry) => entry.id)).toEqual(Array.from({ length: 16 }, (_, index) => index + 2));
    expect(bounded.reduce((sum, entry) => sum + entry.chunk.length, 0)).toBeLessThanOrEqual(MAX_LOG_BUFFER_CHARS);
  });

  it('truncates one pathological network chunk before buffering it', () => {
    const bounded = appendBoundedLogEntries([], [{
      id: 1,
      stream: 'stdout',
      chunk: 'x'.repeat(MAX_LOG_CHUNK_CHARS + 500),
    }]);
    expect(bounded[0]?.chunk).toContain('[chunk truncated by browser]');
    expect(bounded[0]?.chunk.length).toBeLessThan(MAX_LOG_CHUNK_CHARS + 100);
  });
});
