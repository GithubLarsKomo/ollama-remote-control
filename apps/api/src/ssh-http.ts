import { createHash } from 'node:crypto';
import type { ClientChannel } from 'ssh2';
import { Client } from 'ssh2';
import type { SshPrivateKeyConnection } from '@orc/ssh';

export type SshHttpErrorCode =
  | 'SSH_HOST_KEY_MISMATCH'
  | 'SSH_CONNECT_FAILED'
  | 'SSH_FORWARD_FAILED'
  | 'HTTP_REQUEST_INVALID'
  | 'HTTP_TIMEOUT'
  | 'HTTP_RESPONSE_TOO_LARGE'
  | 'HTTP_RESPONSE_INVALID';

export class SshHttpError extends Error {
  constructor(readonly code: SshHttpErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

export interface SshHttpResponse {
  readonly statusCode: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Buffer;
}

export interface SshHttpOptions {
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
}

export type OllamaReadPath = '/api/version' | '/api/tags' | '/api/ps';
const OLLAMA_READ_PATHS = new Set<string>(['/api/version', '/api/tags', '/api/ps']);

function fingerprintSha256(key: Buffer): string {
  return `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/u, '')}`;
}

function decodeChunked(body: Buffer, maxBytes: number): Buffer {
  let offset = 0;
  const chunks: Buffer[] = [];
  let total = 0;
  while (offset < body.length) {
    const lineEnd = body.indexOf('\r\n', offset, 'utf8');
    if (lineEnd < 0) throw new SshHttpError('HTTP_RESPONSE_INVALID', 'HTTP chunked response is malformed.');
    const sizeText = body.subarray(offset, lineEnd).toString('ascii').split(';', 1)[0].trim();
    if (!/^[0-9a-f]+$/iu.test(sizeText)) throw new SshHttpError('HTTP_RESPONSE_INVALID', 'HTTP chunk size is invalid.');
    const size = Number.parseInt(sizeText, 16);
    offset = lineEnd + 2;
    if (size === 0) return Buffer.concat(chunks, total);
    if (!Number.isSafeInteger(size) || size < 0 || offset + size + 2 > body.length) {
      throw new SshHttpError('HTTP_RESPONSE_INVALID', 'HTTP chunked response is incomplete.');
    }
    total += size;
    if (total > maxBytes) throw new SshHttpError('HTTP_RESPONSE_TOO_LARGE', 'HTTP response exceeded the configured size limit.');
    chunks.push(body.subarray(offset, offset + size));
    offset += size;
    if (body.subarray(offset, offset + 2).toString('ascii') !== '\r\n') {
      throw new SshHttpError('HTTP_RESPONSE_INVALID', 'HTTP chunk terminator is invalid.');
    }
    offset += 2;
  }
  throw new SshHttpError('HTTP_RESPONSE_INVALID', 'HTTP chunked response has no terminal chunk.');
}

export function parseHttpResponse(raw: Buffer, maxBodyBytes: number): SshHttpResponse {
  const headerEnd = raw.indexOf('\r\n\r\n', 0, 'utf8');
  if (headerEnd < 0) throw new SshHttpError('HTTP_RESPONSE_INVALID', 'HTTP response headers are incomplete.');
  const headerText = raw.subarray(0, headerEnd).toString('latin1');
  const lines = headerText.split('\r\n');
  const statusMatch = /^HTTP\/1\.[01]\s+(\d{3})(?:\s|$)/u.exec(lines.shift() ?? '');
  if (!statusMatch) throw new SshHttpError('HTTP_RESPONSE_INVALID', 'HTTP status line is invalid.');
  const headers: Record<string, string> = {};
  for (const line of lines) {
    const separator = line.indexOf(':');
    if (separator < 1) throw new SshHttpError('HTTP_RESPONSE_INVALID', 'HTTP response header is malformed.');
    const name = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (headers[name]) headers[name] = `${headers[name]}, ${value}`;
    else headers[name] = value;
  }
  const wireBody = raw.subarray(headerEnd + 4);
  let body: Buffer;
  if (/\bchunked\b/iu.test(headers['transfer-encoding'] ?? '')) {
    body = decodeChunked(wireBody, maxBodyBytes);
  } else if (headers['content-length'] !== undefined) {
    if (!/^\d+$/u.test(headers['content-length'])) throw new SshHttpError('HTTP_RESPONSE_INVALID', 'HTTP content-length is invalid.');
    const length = Number(headers['content-length']);
    if (!Number.isSafeInteger(length) || length > maxBodyBytes) throw new SshHttpError('HTTP_RESPONSE_TOO_LARGE', 'HTTP response exceeded the configured size limit.');
    if (wireBody.length < length) throw new SshHttpError('HTTP_RESPONSE_INVALID', 'HTTP response body is incomplete.');
    body = wireBody.subarray(0, length);
  } else {
    if (wireBody.length > maxBodyBytes) throw new SshHttpError('HTTP_RESPONSE_TOO_LARGE', 'HTTP response exceeded the configured size limit.');
    body = wireBody;
  }
  return { statusCode: Number(statusMatch[1]), headers, body };
}

export async function httpGetViaPinnedSsh(
  connection: SshPrivateKeyConnection,
  destinationHost: string,
  destinationPort: number,
  requestPath: OllamaReadPath,
  options: SshHttpOptions = {},
): Promise<SshHttpResponse> {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const maxResponseBytes = options.maxResponseBytes ?? 64 * 1024;
  if (!OLLAMA_READ_PATHS.has(requestPath)) {
    throw new SshHttpError('HTTP_REQUEST_INVALID', 'Ollama HTTP request path is not allowed.');
  }
  if (!Number.isInteger(destinationPort) || destinationPort < 1 || destinationPort > 65535) {
    throw new SshHttpError('SSH_FORWARD_FAILED', 'SSH forward destination port is invalid.');
  }
  if (!destinationHost || destinationHost.length > 255 || /[\u0000-\u0020\u007f]/u.test(destinationHost)) {
    throw new SshHttpError('SSH_FORWARD_FAILED', 'SSH forward destination host is invalid.');
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000) {
    throw new SshHttpError('HTTP_TIMEOUT', 'HTTP timeout is invalid.');
  }
  if (!Number.isInteger(maxResponseBytes) || maxResponseBytes < 256 || maxResponseBytes > 1024 * 1024) {
    throw new SshHttpError('HTTP_RESPONSE_TOO_LARGE', 'HTTP response size limit is invalid.');
  }

  return new Promise<SshHttpResponse>((resolve, reject) => {
    const client = new Client();
    let channel: ClientChannel | null = null;
    let settled = false;
    let hostKeyObserved = false;
    let hostKeyMismatch = false;
    const received: Buffer[] = [];
    let receivedBytes = 0;

    const finish = (error?: Error, response?: SshHttpResponse) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { channel?.destroy(); } catch { /* best effort */ }
      try { client.end(); } catch { /* best effort */ }
      if (error) reject(error);
      else resolve(response!);
    };

    const timer = setTimeout(() => finish(new SshHttpError('HTTP_TIMEOUT', 'SSH-tunneled HTTP request timed out.')), timeoutMs);

    client.on('ready', () => {
      client.forwardOut('127.0.0.1', 0, destinationHost, destinationPort, (error, stream) => {
        if (error) {
          finish(new SshHttpError('SSH_FORWARD_FAILED', 'SSH TCP forwarding failed.'));
          return;
        }
        channel = stream;
        stream.on('data', (chunk: Buffer) => {
          if (settled) return;
          receivedBytes += chunk.length;
          if (receivedBytes > maxResponseBytes + 16 * 1024) {
            finish(new SshHttpError('HTTP_RESPONSE_TOO_LARGE', 'HTTP response exceeded the configured size limit.'));
            return;
          }
          received.push(Buffer.from(chunk));
        });
        stream.once('error', () => finish(new SshHttpError('SSH_FORWARD_FAILED', 'SSH forwarded TCP stream failed.')));
        stream.once('close', () => {
          if (settled) return;
          try {
            finish(undefined, parseHttpResponse(Buffer.concat(received, receivedBytes), maxResponseBytes));
          } catch (parseError) {
            finish(parseError instanceof Error ? parseError : new SshHttpError('HTTP_RESPONSE_INVALID', 'HTTP response parsing failed.'));
          }
        });
        const hostHeader = destinationHost.includes(':') ? `[${destinationHost}]:${destinationPort}` : `${destinationHost}:${destinationPort}`;
        stream.end([
          `GET ${requestPath} HTTP/1.1`,
          `Host: ${hostHeader}`,
          'Accept: application/json',
          'Connection: close',
          '',
          '',
        ].join('\r\n'));
      });
    });
    client.once('error', () => {
      if (hostKeyObserved && hostKeyMismatch) {
        finish(new SshHttpError('SSH_HOST_KEY_MISMATCH', 'SSH host-key verification failed.'));
        return;
      }
      finish(new SshHttpError('SSH_CONNECT_FAILED', 'SSH connection failed.'));
    });
    client.once('end', () => {
      if (!settled && !channel) finish(new SshHttpError('SSH_CONNECT_FAILED', 'SSH connection ended before TCP forwarding started.'));
    });
    client.connect({
      host: connection.hostname,
      port: connection.port,
      username: connection.username,
      privateKey: connection.privateKey,
      readyTimeout: Math.min(timeoutMs, 10_000),
      hostVerifier: (key: Buffer) => {
        hostKeyObserved = true;
        hostKeyMismatch = fingerprintSha256(key) !== connection.expectedFingerprint;
        return !hostKeyMismatch;
      },
    });
  });
}
