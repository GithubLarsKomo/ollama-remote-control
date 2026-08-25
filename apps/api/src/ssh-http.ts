import {
  execPrivateKey,
  SshTransportError,
  type SshPrivateKeyConnection,
} from '@orc/ssh';

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
const MAX_OLLAMA_MODEL_NAME = 512;
const MAX_HTTP_RESPONSE_BYTES = 4 * 1024 * 1024;
const CURL_STATUS_MARKER = '\n__ORC_HTTP_STATUS__:';

interface FixedHttpRequest {
  readonly method: 'GET' | 'POST';
  readonly path: string;
  readonly body?: Buffer;
  readonly contentType?: string;
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

function validateDestination(destinationHost: string, destinationPort: number, timeoutMs: number, maxResponseBytes: number): void {
  if (!Number.isInteger(destinationPort) || destinationPort < 1 || destinationPort > 65535) {
    throw new SshHttpError('SSH_FORWARD_FAILED', 'SSH destination port is invalid.');
  }
  if (!destinationHost || destinationHost.length > 255 || /[\u0000-\u0020\u007f]/u.test(destinationHost)) {
    throw new SshHttpError('SSH_FORWARD_FAILED', 'SSH destination host is invalid.');
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000) {
    throw new SshHttpError('HTTP_TIMEOUT', 'HTTP timeout is invalid.');
  }
  if (!Number.isInteger(maxResponseBytes) || maxResponseBytes < 256 || maxResponseBytes > MAX_HTTP_RESPONSE_BYTES) {
    throw new SshHttpError('HTTP_RESPONSE_TOO_LARGE', 'HTTP response size limit is invalid.');
  }
}

function curlUrl(destinationHost: string, destinationPort: number, path: string): string {
  const host = destinationHost.includes(':') ? `[${destinationHost}]` : destinationHost;
  return `http://${host}:${destinationPort}${path}`;
}

async function httpRequestViaPinnedExec(
  connection: SshPrivateKeyConnection,
  destinationHost: string,
  destinationPort: number,
  request: FixedHttpRequest,
  options: SshHttpOptions,
): Promise<SshHttpResponse> {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const maxResponseBytes = options.maxResponseBytes ?? 64 * 1024;
  validateDestination(destinationHost, destinationPort, timeoutMs, maxResponseBytes);

  const argv = [
    'curl',
    '--noproxy', '*',
    '--silent',
    '--show-error',
    '--max-time', String(Math.max(1, Math.ceil(timeoutMs / 1000))),
    '--output', '-',
    '--write-out', `${CURL_STATUS_MARKER}%{http_code}`,
  ];
  if (request.method === 'POST') {
    argv.push(
      '--request', 'POST',
      '--header', `Content-Type: ${request.contentType ?? 'application/json'}`,
      '--data-binary', '@-',
    );
  }
  argv.push(curlUrl(destinationHost, destinationPort, request.path));

  let result;
  try {
    result = await execPrivateKey(connection, argv, {
      timeoutMs: timeoutMs + 1_000,
      maxOutputBytes: maxResponseBytes + 1024,
      stdin: request.body?.toString('utf8'),
      maxInputBytes: maxResponseBytes,
    });
  } catch (error) {
    if (error instanceof SshTransportError && error.code === 'SSH_HOST_KEY_MISMATCH') {
      throw new SshHttpError('SSH_HOST_KEY_MISMATCH', 'SSH host-key verification failed.', { cause: error });
    }
    if (error instanceof SshTransportError && (error.code === 'SSH_CONNECT_FAILED' || error.code === 'AUTH_FAILED')) {
      throw new SshHttpError('SSH_CONNECT_FAILED', 'SSH HTTP exec could not connect.', { cause: error });
    }
    throw new SshHttpError('SSH_FORWARD_FAILED', 'SSH HTTP exec failed.', { cause: error as Error });
  }

  if (result.exitCode !== 0) {
    if (result.exitCode === 28) throw new SshHttpError('HTTP_TIMEOUT', 'Ollama HTTP request timed out.');
    throw new SshHttpError('SSH_FORWARD_FAILED', 'SSH HTTP exec returned a non-zero exit code.');
  }

  const markerIndex = result.stdout.lastIndexOf(CURL_STATUS_MARKER);
  if (markerIndex < 0) throw new SshHttpError('HTTP_RESPONSE_INVALID', 'SSH HTTP exec returned no status marker.');
  const statusText = result.stdout.slice(markerIndex + CURL_STATUS_MARKER.length).trim();
  if (!/^\d{3}$/u.test(statusText)) throw new SshHttpError('HTTP_RESPONSE_INVALID', 'SSH HTTP exec returned an invalid status.');

  const body = Buffer.from(result.stdout.slice(0, markerIndex), 'utf8');
  if (body.length > maxResponseBytes) throw new SshHttpError('HTTP_RESPONSE_TOO_LARGE', 'HTTP response exceeded the configured size limit.');
  return { statusCode: Number(statusText), headers: {}, body };
}

export async function httpGetManyViaPinnedSsh(
  connection: SshPrivateKeyConnection,
  destinationHost: string,
  destinationPort: number,
  requestPaths: readonly OllamaReadPath[],
  options: SshHttpOptions = {},
): Promise<readonly SshHttpResponse[]> {
  if (requestPaths.length === 0 || requestPaths.some((requestPath) => !OLLAMA_READ_PATHS.has(requestPath))) {
    throw new SshHttpError('HTTP_REQUEST_INVALID', 'Ollama HTTP request path is not allowed.');
  }
  const responses: SshHttpResponse[] = [];
  for (const requestPath of requestPaths) {
    responses.push(await httpRequestViaPinnedExec(
      connection,
      destinationHost,
      destinationPort,
      { method: 'GET', path: requestPath },
      options,
    ));
  }
  return responses;
}

export async function httpGetViaPinnedSsh(
  connection: SshPrivateKeyConnection,
  destinationHost: string,
  destinationPort: number,
  requestPath: OllamaReadPath,
  options: SshHttpOptions = {},
): Promise<SshHttpResponse> {
  if (!OLLAMA_READ_PATHS.has(requestPath)) {
    throw new SshHttpError('HTTP_REQUEST_INVALID', 'Ollama HTTP request path is not allowed.');
  }
  return httpRequestViaPinnedExec(
    connection,
    destinationHost,
    destinationPort,
    { method: 'GET', path: requestPath },
    options,
  );
}

export async function httpPostOllamaShowViaPinnedSsh(
  connection: SshPrivateKeyConnection,
  destinationHost: string,
  destinationPort: number,
  modelName: string,
  options: SshHttpOptions = {},
): Promise<SshHttpResponse> {
  if (
    typeof modelName !== 'string'
    || modelName.length < 1
    || modelName.length > MAX_OLLAMA_MODEL_NAME
    || !/^[A-Za-z0-9][A-Za-z0-9._/:@+-]*$/u.test(modelName)
  ) {
    throw new SshHttpError('HTTP_REQUEST_INVALID', 'Ollama model name is invalid.');
  }
  const body = Buffer.from(JSON.stringify({ model: modelName, verbose: false }), 'utf8');
  return httpRequestViaPinnedExec(
    connection,
    destinationHost,
    destinationPort,
    { method: 'POST', path: '/api/show', body, contentType: 'application/json' },
    options,
  );
}
