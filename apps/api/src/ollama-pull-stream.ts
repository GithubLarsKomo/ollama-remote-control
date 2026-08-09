import { createHash } from 'node:crypto';
import type { ClientChannel } from 'ssh2';
import { Client } from 'ssh2';
import type { SshPrivateKeyConnection } from '@orc/ssh';

const MAX_HEADER_BYTES = 16 * 1024;
const MAX_PROGRESS_LINE_BYTES = 64 * 1024;
const MAX_WIRE_CHUNK_BYTES = 2 * 1024 * 1024;
const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60_000;

export type OllamaPullStreamErrorCode =
  | 'SSH_HOST_KEY_MISMATCH'
  | 'SSH_CONNECT_FAILED'
  | 'SSH_FORWARD_FAILED'
  | 'OLLAMA_PULL_HTTP_ERROR'
  | 'OLLAMA_PULL_RESPONSE_INVALID'
  | 'OLLAMA_PULL_IDLE_TIMEOUT'
  | 'PULL_ABORTED';

export class OllamaPullStreamError extends Error {
  constructor(
    readonly code: OllamaPullStreamErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export interface OllamaPullProgress {
  readonly status: string;
  readonly digest: string | null;
  readonly total: number | null;
  readonly completed: number | null;
}

export interface OllamaPullStreamOptions {
  readonly idleTimeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly onProgress: (progress: OllamaPullProgress) => void;
}

function fingerprintSha256(key: Buffer): string {
  return `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/u, '')}`;
}

function safeStatus(value: unknown): string {
  if (typeof value !== 'string') {
    throw new OllamaPullStreamError('OLLAMA_PULL_RESPONSE_INVALID', 'Ollama pull progress status is missing.');
  }
  const text = value.trim();
  if (!text || text.length > 240 || /[\u0000-\u001f\u007f]/u.test(text)) {
    throw new OllamaPullStreamError('OLLAMA_PULL_RESPONSE_INVALID', 'Ollama pull progress status is invalid.');
  }
  return text;
}

function optionalDigest(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') {
    throw new OllamaPullStreamError('OLLAMA_PULL_RESPONSE_INVALID', 'Ollama pull digest is invalid.');
  }
  const text = value.trim();
  if (!text || text.length > 128 || /[\u0000-\u001f\u007f]/u.test(text)) {
    throw new OllamaPullStreamError('OLLAMA_PULL_RESPONSE_INVALID', 'Ollama pull digest is invalid.');
  }
  return text;
}

function optionalCount(value: unknown, field: string): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new OllamaPullStreamError('OLLAMA_PULL_RESPONSE_INVALID', `Ollama pull ${field} is invalid.`);
  }
  return value;
}

export function parsePullProgressLine(line: Buffer | string): OllamaPullProgress {
  const source = Buffer.isBuffer(line) ? line : Buffer.from(line, 'utf8');
  if (source.length === 0 || source.length > MAX_PROGRESS_LINE_BYTES) {
    throw new OllamaPullStreamError('OLLAMA_PULL_RESPONSE_INVALID', 'Ollama pull progress line is invalid.');
  }
  let parsed: unknown;
  try { parsed = JSON.parse(source.toString('utf8')); }
  catch {
    throw new OllamaPullStreamError('OLLAMA_PULL_RESPONSE_INVALID', 'Ollama pull progress is not valid JSON.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new OllamaPullStreamError('OLLAMA_PULL_RESPONSE_INVALID', 'Ollama pull progress object is invalid.');
  }
  const object = parsed as Record<string, unknown>;
  if (typeof object.error === 'string' && object.error.trim()) {
    throw new OllamaPullStreamError('OLLAMA_PULL_HTTP_ERROR', 'Ollama reported a pull error while streaming.');
  }
  const total = optionalCount(object.total, 'total bytes');
  const completed = optionalCount(object.completed, 'completed bytes');
  if (total !== null && completed !== null && completed > total) {
    throw new OllamaPullStreamError('OLLAMA_PULL_RESPONSE_INVALID', 'Ollama pull completed bytes exceed total bytes.');
  }
  return {
    status: safeStatus(object.status),
    digest: optionalDigest(object.digest),
    total,
    completed,
  };
}

interface ParsedHeaders {
  readonly statusCode: number;
  readonly chunked: boolean;
}

function parseHeaders(value: Buffer): ParsedHeaders {
  const text = value.toString('latin1');
  const lines = text.split('\r\n');
  const statusMatch = /^HTTP\/1\.[01]\s+(\d{3})(?:\s|$)/u.exec(lines.shift() ?? '');
  if (!statusMatch) throw new OllamaPullStreamError('OLLAMA_PULL_RESPONSE_INVALID', 'Ollama pull HTTP status line is invalid.');
  const headers: Record<string, string> = {};
  for (const line of lines) {
    const separator = line.indexOf(':');
    if (separator < 1) throw new OllamaPullStreamError('OLLAMA_PULL_RESPONSE_INVALID', 'Ollama pull HTTP header is malformed.');
    const name = line.slice(0, separator).trim().toLowerCase();
    const fieldValue = line.slice(separator + 1).trim();
    headers[name] = headers[name] ? `${headers[name]}, ${fieldValue}` : fieldValue;
  }
  const statusCode = Number(statusMatch[1]);
  if (statusCode < 200 || statusCode >= 300) {
    throw new OllamaPullStreamError('OLLAMA_PULL_HTTP_ERROR', `Ollama pull returned HTTP ${statusCode}.`);
  }
  const contentType = (headers['content-type'] ?? '').toLowerCase();
  if (!contentType.includes('application/x-ndjson') && !contentType.includes('application/json')) {
    throw new OllamaPullStreamError('OLLAMA_PULL_RESPONSE_INVALID', 'Ollama pull returned an unexpected content type.');
  }
  return {
    statusCode,
    chunked: /\bchunked\b/iu.test(headers['transfer-encoding'] ?? ''),
  };
}

export async function streamOllamaPullViaPinnedSsh(
  connection: SshPrivateKeyConnection,
  destinationHost: string,
  destinationPort: number,
  model: string,
  options: OllamaPullStreamOptions,
): Promise<void> {
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  if (!destinationHost || destinationHost.length > 255 || /[\u0000-\u0020\u007f]/u.test(destinationHost)) {
    throw new OllamaPullStreamError('SSH_FORWARD_FAILED', 'SSH forward destination host is invalid.');
  }
  if (!Number.isInteger(destinationPort) || destinationPort < 1 || destinationPort > 65535) {
    throw new OllamaPullStreamError('SSH_FORWARD_FAILED', 'SSH forward destination port is invalid.');
  }
  if (!Number.isInteger(idleTimeoutMs) || idleTimeoutMs < 1_000 || idleTimeoutMs > 60 * 60_000) {
    throw new OllamaPullStreamError('OLLAMA_PULL_IDLE_TIMEOUT', 'Ollama pull idle timeout is invalid.');
  }
  if (options.signal?.aborted) throw new OllamaPullStreamError('PULL_ABORTED', 'Ollama pull request was aborted.');

  return await new Promise<void>((resolve, reject) => {
    const client = new Client();
    let channel: ClientChannel | null = null;
    let settled = false;
    let hostKeyObserved = false;
    let hostKeyMismatch = false;
    let headersDone = false;
    let chunked = false;
    let wireBuffer = Buffer.alloc(0);
    let ndjsonBuffer = Buffer.alloc(0);
    let expectedChunkSize: number | null = null;
    let sawTerminalChunk = false;
    let idleTimer: NodeJS.Timeout | null = null;

    const resetIdleTimer = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => finish(new OllamaPullStreamError('OLLAMA_PULL_IDLE_TIMEOUT', 'Ollama pull stream was idle for too long.')), idleTimeoutMs);
    };

    const removeAbortListener = () => options.signal?.removeEventListener('abort', abort);
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (idleTimer) clearTimeout(idleTimer);
      removeAbortListener();
      try { channel?.destroy(); } catch { /* best effort */ }
      try { client.end(); } catch { /* best effort */ }
      if (error) reject(error);
      else resolve();
    };
    const abort = () => finish(new OllamaPullStreamError('PULL_ABORTED', 'Ollama pull request was aborted.'));
    options.signal?.addEventListener('abort', abort, { once: true });

    const emitLine = (line: Buffer) => {
      const normalized = line.length > 0 && line[line.length - 1] === 0x0d ? line.subarray(0, line.length - 1) : line;
      if (normalized.length === 0) return;
      options.onProgress(parsePullProgressLine(normalized));
    };

    const consumeNdjson = (chunk: Buffer, final = false) => {
      ndjsonBuffer = Buffer.concat([ndjsonBuffer, chunk]);
      if (ndjsonBuffer.length > MAX_PROGRESS_LINE_BYTES && ndjsonBuffer.indexOf(0x0a) < 0) {
        throw new OllamaPullStreamError('OLLAMA_PULL_RESPONSE_INVALID', 'Ollama pull progress line exceeded the size limit.');
      }
      let newline = ndjsonBuffer.indexOf(0x0a);
      while (newline >= 0) {
        const line = ndjsonBuffer.subarray(0, newline);
        ndjsonBuffer = ndjsonBuffer.subarray(newline + 1);
        emitLine(line);
        newline = ndjsonBuffer.indexOf(0x0a);
      }
      if (ndjsonBuffer.length > MAX_PROGRESS_LINE_BYTES) {
        throw new OllamaPullStreamError('OLLAMA_PULL_RESPONSE_INVALID', 'Ollama pull progress line exceeded the size limit.');
      }
      if (final && ndjsonBuffer.length > 0) {
        const line = ndjsonBuffer;
        ndjsonBuffer = Buffer.alloc(0);
        emitLine(line);
      }
    };

    const consumeChunked = () => {
      while (!settled) {
        if (expectedChunkSize === null) {
          const lineEnd = wireBuffer.indexOf('\r\n', 0, 'utf8');
          if (lineEnd < 0) {
            if (wireBuffer.length > 128) throw new OllamaPullStreamError('OLLAMA_PULL_RESPONSE_INVALID', 'Ollama pull chunk header is too large.');
            return;
          }
          const sizeText = wireBuffer.subarray(0, lineEnd).toString('ascii').split(';', 1)[0].trim();
          if (!/^[0-9a-f]+$/iu.test(sizeText)) throw new OllamaPullStreamError('OLLAMA_PULL_RESPONSE_INVALID', 'Ollama pull chunk size is invalid.');
          const size = Number.parseInt(sizeText, 16);
          if (!Number.isSafeInteger(size) || size < 0 || size > MAX_WIRE_CHUNK_BYTES) {
            throw new OllamaPullStreamError('OLLAMA_PULL_RESPONSE_INVALID', 'Ollama pull wire chunk is too large.');
          }
          wireBuffer = wireBuffer.subarray(lineEnd + 2);
          if (size === 0) {
            sawTerminalChunk = true;
            consumeNdjson(Buffer.alloc(0), true);
            finish();
            return;
          }
          expectedChunkSize = size;
        }
        if (wireBuffer.length < expectedChunkSize + 2) return;
        const body = wireBuffer.subarray(0, expectedChunkSize);
        const terminator = wireBuffer.subarray(expectedChunkSize, expectedChunkSize + 2).toString('ascii');
        if (terminator !== '\r\n') throw new OllamaPullStreamError('OLLAMA_PULL_RESPONSE_INVALID', 'Ollama pull chunk terminator is invalid.');
        wireBuffer = wireBuffer.subarray(expectedChunkSize + 2);
        expectedChunkSize = null;
        consumeNdjson(body);
      }
    };

    const consumeWire = (chunk: Buffer) => {
      resetIdleTimer();
      wireBuffer = Buffer.concat([wireBuffer, chunk]);
      if (!headersDone) {
        const headerEnd = wireBuffer.indexOf('\r\n\r\n', 0, 'utf8');
        if (headerEnd < 0) {
          if (wireBuffer.length > MAX_HEADER_BYTES) throw new OllamaPullStreamError('OLLAMA_PULL_RESPONSE_INVALID', 'Ollama pull response headers are too large.');
          return;
        }
        if (headerEnd > MAX_HEADER_BYTES) throw new OllamaPullStreamError('OLLAMA_PULL_RESPONSE_INVALID', 'Ollama pull response headers are too large.');
        const parsed = parseHeaders(wireBuffer.subarray(0, headerEnd));
        headersDone = true;
        chunked = parsed.chunked;
        wireBuffer = wireBuffer.subarray(headerEnd + 4);
      }
      if (chunked) consumeChunked();
      else {
        const body = wireBuffer;
        wireBuffer = Buffer.alloc(0);
        consumeNdjson(body);
      }
    };

    client.on('ready', () => {
      client.forwardOut('127.0.0.1', 0, destinationHost, destinationPort, (error, stream) => {
        if (error) {
          finish(new OllamaPullStreamError('SSH_FORWARD_FAILED', 'SSH TCP forwarding failed.'));
          return;
        }
        channel = stream;
        resetIdleTimer();
        stream.on('data', (chunk: Buffer) => {
          if (settled) return;
          try { consumeWire(Buffer.from(chunk)); }
          catch (streamError) {
            finish(streamError instanceof Error ? streamError : new OllamaPullStreamError('OLLAMA_PULL_RESPONSE_INVALID', 'Ollama pull stream parsing failed.'));
          }
        });
        stream.once('error', () => finish(new OllamaPullStreamError('SSH_FORWARD_FAILED', 'SSH forwarded TCP stream failed.')));
        stream.once('close', () => {
          if (settled) return;
          try {
            if (!headersDone) throw new OllamaPullStreamError('OLLAMA_PULL_RESPONSE_INVALID', 'Ollama pull response ended before headers.');
            if (chunked && !sawTerminalChunk) throw new OllamaPullStreamError('OLLAMA_PULL_RESPONSE_INVALID', 'Ollama pull chunked response ended early.');
            if (!chunked) consumeNdjson(Buffer.alloc(0), true);
            finish();
          } catch (streamError) {
            finish(streamError instanceof Error ? streamError : new OllamaPullStreamError('OLLAMA_PULL_RESPONSE_INVALID', 'Ollama pull stream ended invalidly.'));
          }
        });

        const requestBody = JSON.stringify({ model, stream: true });
        const hostHeader = destinationHost.includes(':') ? `[${destinationHost}]:${destinationPort}` : `${destinationHost}:${destinationPort}`;
        stream.write([
          'POST /api/pull HTTP/1.1',
          `Host: ${hostHeader}`,
          'Accept: application/x-ndjson, application/json',
          'Content-Type: application/json',
          `Content-Length: ${Buffer.byteLength(requestBody)}`,
          'Connection: close',
          '',
          requestBody,
        ].join('\r\n'));
      });
    });
    client.once('error', () => {
      if (hostKeyObserved && hostKeyMismatch) {
        finish(new OllamaPullStreamError('SSH_HOST_KEY_MISMATCH', 'SSH host-key verification failed.'));
        return;
      }
      finish(new OllamaPullStreamError('SSH_CONNECT_FAILED', 'SSH connection failed.'));
    });
    client.once('end', () => {
      if (!settled && !channel) finish(new OllamaPullStreamError('SSH_CONNECT_FAILED', 'SSH connection ended before TCP forwarding started.'));
    });
    client.connect({
      host: connection.hostname,
      port: connection.port,
      username: connection.username,
      privateKey: connection.privateKey,
      readyTimeout: Math.min(idleTimeoutMs, 10_000),
      hostVerifier: (key: Buffer) => {
        hostKeyObserved = true;
        hostKeyMismatch = fingerprintSha256(key) !== connection.expectedFingerprint;
        return !hostKeyMismatch;
      },
    });
  });
}
