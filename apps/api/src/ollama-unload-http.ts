import { createHash } from 'node:crypto';
import http from 'node:http';
import type { ClientChannel } from 'ssh2';
import { Client } from 'ssh2';
import type { SshPrivateKeyConnection } from '@orc/ssh';

const MAX_MODEL_NAME = 512;
const MAX_RESPONSE_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;

export type OllamaUnloadHttpErrorCode =
  | 'SSH_HOST_KEY_MISMATCH'
  | 'SSH_CONNECT_FAILED'
  | 'SSH_FORWARD_FAILED'
  | 'OLLAMA_UNLOAD_HTTP_ERROR'
  | 'OLLAMA_UNLOAD_RESPONSE_INVALID'
  | 'OLLAMA_UNLOAD_TIMEOUT';

export class OllamaUnloadHttpError extends Error {
  constructor(
    readonly code: OllamaUnloadHttpErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export interface OllamaUnloadHttpResult {
  readonly statusCode: number;
}

function fingerprintSha256(key: Buffer): string {
  return `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/u, '')}`;
}

function validate(
  destinationHost: string,
  destinationPort: number,
  model: string,
  timeoutMs: number,
): void {
  if (!destinationHost || destinationHost.length > 255 || /[\u0000-\u0020\u007f]/u.test(destinationHost)) {
    throw new OllamaUnloadHttpError('SSH_FORWARD_FAILED', 'SSH forward destination host is invalid.');
  }
  if (!Number.isInteger(destinationPort) || destinationPort < 1 || destinationPort > 65535) {
    throw new OllamaUnloadHttpError('SSH_FORWARD_FAILED', 'SSH forward destination port is invalid.');
  }
  if (
    !model
    || model.length > MAX_MODEL_NAME
    || /[\u0000-\u0020\u007f]/u.test(model)
    || !/^[A-Za-z0-9][A-Za-z0-9._/:@+-]*$/u.test(model)
  ) {
    throw new OllamaUnloadHttpError('OLLAMA_UNLOAD_RESPONSE_INVALID', 'Ollama model name is invalid.');
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 60_000) {
    throw new OllamaUnloadHttpError('OLLAMA_UNLOAD_TIMEOUT', 'Ollama unload timeout is invalid.');
  }
}

function validateResponseBody(chunks: readonly Buffer[], totalBytes: number): void {
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.concat(chunks, totalBytes).toString('utf8')); }
  catch {
    throw new OllamaUnloadHttpError('OLLAMA_UNLOAD_RESPONSE_INVALID', 'Ollama unload returned invalid JSON.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new OllamaUnloadHttpError('OLLAMA_UNLOAD_RESPONSE_INVALID', 'Ollama unload returned an invalid response shape.');
  }
}

export async function unloadOllamaModelViaPinnedSsh(
  connection: SshPrivateKeyConnection,
  destinationHost: string,
  destinationPort: number,
  model: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<OllamaUnloadHttpResult> {
  validate(destinationHost, destinationPort, model, timeoutMs);
  const requestBody = JSON.stringify({ model, keep_alive: 0, stream: false });

  return await new Promise<OllamaUnloadHttpResult>((resolve, reject) => {
    const client = new Client();
    let channel: ClientChannel | null = null;
    let request: http.ClientRequest | null = null;
    let settled = false;
    let hostKeyObserved = false;
    let hostKeyMismatch = false;

    const finish = (error?: Error, result?: OllamaUnloadHttpResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { request?.destroy(); } catch { /* best effort */ }
      try { channel?.destroy(); } catch { /* best effort */ }
      try { client.end(); } catch { /* best effort */ }
      if (error) reject(error);
      else resolve(result!);
    };

    const timer = setTimeout(
      () => finish(new OllamaUnloadHttpError('OLLAMA_UNLOAD_TIMEOUT', 'Ollama unload request timed out.')),
      timeoutMs,
    );

    client.once('ready', () => {
      client.forwardOut('127.0.0.1', 0, destinationHost, destinationPort, (forwardError, stream) => {
        if (forwardError) {
          finish(new OllamaUnloadHttpError('SSH_FORWARD_FAILED', 'SSH TCP forwarding failed.'));
          return;
        }
        channel = stream;
        const hostHeader = destinationHost.includes(':') ? `[${destinationHost}]:${destinationPort}` : `${destinationHost}:${destinationPort}`;
        request = http.request({
          method: 'POST',
          path: '/api/generate',
          host: destinationHost,
          port: destinationPort,
          agent: false,
          createConnection: () => stream,
          headers: {
            host: hostHeader,
            accept: 'application/json',
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(requestBody),
            connection: 'close',
          },
        }, (response) => {
          const statusCode = response.statusCode ?? 0;
          if (statusCode < 200 || statusCode >= 300) {
            finish(new OllamaUnloadHttpError('OLLAMA_UNLOAD_HTTP_ERROR', `Ollama unload returned HTTP ${statusCode}.`));
            return;
          }
          const chunks: Buffer[] = [];
          let totalBytes = 0;
          response.on('data', (chunk: Buffer) => {
            if (settled) return;
            totalBytes += chunk.length;
            if (totalBytes > MAX_RESPONSE_BYTES) {
              finish(new OllamaUnloadHttpError('OLLAMA_UNLOAD_RESPONSE_INVALID', 'Ollama unload response exceeded the size limit.'));
              return;
            }
            chunks.push(Buffer.from(chunk));
          });
          response.once('end', () => {
            if (settled) return;
            try {
              validateResponseBody(chunks, totalBytes);
              finish(undefined, { statusCode });
            } catch (error) {
              finish(error instanceof Error ? error : new OllamaUnloadHttpError('OLLAMA_UNLOAD_RESPONSE_INVALID', 'Ollama unload response was invalid.'));
            }
          });
          response.once('error', () => finish(new OllamaUnloadHttpError('OLLAMA_UNLOAD_RESPONSE_INVALID', 'Ollama unload response stream failed.')));
        });
        request.once('error', () => {
          if (!settled) finish(new OllamaUnloadHttpError('SSH_FORWARD_FAILED', 'SSH-forwarded Ollama unload request failed.'));
        });
        request.end(requestBody);
      });
    });

    client.once('error', () => {
      if (hostKeyObserved && hostKeyMismatch) {
        finish(new OllamaUnloadHttpError('SSH_HOST_KEY_MISMATCH', 'SSH host-key verification failed.'));
        return;
      }
      finish(new OllamaUnloadHttpError('SSH_CONNECT_FAILED', 'SSH connection failed.'));
    });
    client.once('end', () => {
      if (!settled && !channel) finish(new OllamaUnloadHttpError('SSH_CONNECT_FAILED', 'SSH connection ended before TCP forwarding started.'));
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
