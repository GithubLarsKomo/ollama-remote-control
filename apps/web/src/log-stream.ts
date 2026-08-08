import { ApiError } from './api.js';

export const LOG_TAIL_OPTIONS = [0, 50, 100, 200, 500, 1000] as const;
export type LogTail = (typeof LOG_TAIL_OPTIONS)[number];
export type LogStreamKind = 'stdout' | 'stderr';

export const MAX_LOG_ENTRIES = 1000;
export const MAX_LOG_BUFFER_CHARS = 1_000_000;
export const MAX_LOG_CHUNK_CHARS = 64_000;

export interface SseFrame {
  readonly event: string;
  readonly data: string;
}

export interface LogEntry {
  readonly id: number;
  readonly stream: LogStreamKind;
  readonly chunk: string;
}

export function isLogTail(value: number): value is LogTail {
  return (LOG_TAIL_OPTIONS as readonly number[]).includes(value);
}

function apiErrorPayload(value: unknown): { readonly error: { readonly code: string; readonly message: string } } | null {
  if (!value || typeof value !== 'object') return null;
  const error = (value as { error?: unknown }).error;
  if (!error || typeof error !== 'object') return null;
  const code = (error as { code?: unknown }).code;
  const message = (error as { message?: unknown }).message;
  return typeof code === 'string' && typeof message === 'string' ? { error: { code, message } } : null;
}

export async function openLogStream(targetId: string, tail: LogTail, signal: AbortSignal): Promise<Response> {
  if (!isLogTail(tail)) throw new ApiError(400, 'INVALID_LOG_TAIL', 'Log tail selection is invalid.');
  const response = await fetch(
    `/api/v1/targets/${encodeURIComponent(targetId)}/logs/stream?tail=${tail}`,
    {
      method: 'GET',
      credentials: 'include',
      headers: { accept: 'text/event-stream' },
      signal,
    },
  );
  if (!response.ok) {
    let payload: unknown = null;
    try { payload = await response.json(); } catch { /* generic error below */ }
    const structured = apiErrorPayload(payload);
    if (structured) throw new ApiError(response.status, structured.error.code, structured.error.message);
    throw new ApiError(response.status, 'HTTP_ERROR', `Log stream failed with HTTP ${response.status}.`);
  }
  if (!/^text\/event-stream(?:;|$)/iu.test(response.headers.get('content-type') ?? '')) {
    throw new ApiError(502, 'LOG_STREAM_PROTOCOL_INVALID', 'Log stream did not return Server-Sent Events.');
  }
  if (!response.body) throw new ApiError(502, 'LOG_STREAM_PROTOCOL_INVALID', 'Log stream response body is unavailable.');
  return response;
}

function nextFrameBoundary(buffer: string): { readonly index: number; readonly length: number } | null {
  const lf = buffer.indexOf('\n\n');
  const crlf = buffer.indexOf('\r\n\r\n');
  if (lf < 0 && crlf < 0) return null;
  if (lf >= 0 && (crlf < 0 || lf < crlf)) return { index: lf, length: 2 };
  return { index: crlf, length: 4 };
}

export class SseParser {
  private buffer = '';

  push(chunk: string): readonly SseFrame[] {
    this.buffer += chunk;
    const frames: SseFrame[] = [];
    while (true) {
      const boundary = nextFrameBoundary(this.buffer);
      if (!boundary) break;
      const raw = this.buffer.slice(0, boundary.index);
      this.buffer = this.buffer.slice(boundary.index + boundary.length);
      const frame = parseFrame(raw);
      if (frame) frames.push(frame);
    }
    return frames;
  }

  reset(): void {
    this.buffer = '';
  }
}

function parseFrame(raw: string): SseFrame | null {
  let event = 'message';
  const data: string[] = [];
  for (const line of raw.split(/\r\n|\n|\r/u)) {
    if (!line || line.startsWith(':')) continue;
    const separator = line.indexOf(':');
    const field = separator < 0 ? line : line.slice(0, separator);
    let value = separator < 0 ? '' : line.slice(separator + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    if (field === 'data') data.push(value);
  }
  if (data.length === 0) return null;
  return { event, data: data.join('\n') };
}

export function appendBoundedLogEntries(
  current: readonly LogEntry[],
  additions: readonly LogEntry[],
): readonly LogEntry[] {
  const normalized = additions.map((entry) => ({
    ...entry,
    chunk: entry.chunk.length > MAX_LOG_CHUNK_CHARS
      ? `${entry.chunk.slice(0, MAX_LOG_CHUNK_CHARS)}\n[chunk truncated by browser]`
      : entry.chunk,
  }));
  const entries = [...current, ...normalized];
  let totalChars = entries.reduce((sum, entry) => sum + entry.chunk.length, 0);
  while (entries.length > MAX_LOG_ENTRIES || totalChars > MAX_LOG_BUFFER_CHARS) {
    const removed = entries.shift();
    if (!removed) break;
    totalChars -= removed.chunk.length;
  }
  return entries;
}
