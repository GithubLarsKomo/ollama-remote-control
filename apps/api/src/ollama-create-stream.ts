import { createHash } from 'node:crypto';
import http from 'node:http';
import type { ClientChannel } from 'ssh2';
import { Client } from 'ssh2';
import type { CompiledOllamaCreatePayload } from '@orc/core/modelfile-deploy';
import type { SshPrivateKeyConnection } from '@orc/ssh';
import { parsePullProgressLine, type OllamaPullProgress } from './ollama-pull-stream.js';

const MAX_PROGRESS_LINE_BYTES = 64 * 1024;
const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60_000;

export type OllamaCreateStreamErrorCode =
  | 'SSH_HOST_KEY_MISMATCH'
  | 'SSH_CONNECT_FAILED'
  | 'SSH_FORWARD_FAILED'
  | 'OLLAMA_CREATE_HTTP_ERROR'
  | 'OLLAMA_CREATE_RESPONSE_INVALID'
  | 'OLLAMA_CREATE_IDLE_TIMEOUT'
  | 'CREATE_ABORTED';

export class OllamaCreateStreamError extends Error {
  constructor(
    readonly code: OllamaCreateStreamErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export interface OllamaCreateStreamOptions {
  readonly idleTimeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly onProgress: (progress: OllamaPullProgress) => void;
}

function fingerprintSha256(key: Buffer): string {
  return `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/u, '')}`;
}

function validateDestination(destinationHost: string, destinationPort: number, idleTimeoutMs: number): void {
  if (!destinationHost || destinationHost.length > 255 || /[\u0000-\u0020\u007f]/u.test(destinationHost)) {
    throw new OllamaCreateStreamError('SSH_FORWARD_FAILED', 'SSH forward destination host is invalid.');
  }
  if (!Number.isInteger(destinationPort) || destinationPort < 1 || destinationPort > 65535) {
    throw new OllamaCreateStreamError('SSH_FORWARD_FAILED', 'SSH forward destination port is invalid.');
  }
  if (!Number.isInteger(idleTimeoutMs) || idleTimeoutMs < 1_000 || idleTimeoutMs > 60 * 60_000) {
    throw new OllamaCreateStreamError('OLLAMA_CREATE_IDLE_TIMEOUT', 'Ollama create idle timeout is invalid.');
  }
}

function contentTypeAccepted(value: string | string[] | undefined): boolean {
  const text = Array.isArray(value) ? value.join(',') : value ?? '';
  const normalized = text.toLowerCase();
  return normalized.includes('application/x-ndjson') || normalized.includes('application/json');
}

export async function streamOllamaCreateViaPinnedSsh(
  connection: SshPrivateKeyConnection,
  destinationHost: string,
  destinationPort: number,
  model: string,
  payload: CompiledOllamaCreatePayload,
  options: OllamaCreateStreamOptions,
): Promise<void> {
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  validateDestination(destinationHost, destinationPort, idleTimeoutMs);
  if (options.signal?.aborted) throw new OllamaCreateStreamError('CREATE_ABORTED', 'Ollama create request was aborted.');

  const requestBody = JSON.stringify({ model, stream: true, ...payload });
  return await new Promise<void>((resolve, reject) => {
    const client = new Client();
    let channel: ClientChannel | null = null;
    let request: http.ClientRequest | null = null;
    let idleTimer: NodeJS.Timeout | null = null;
    let settled = false;
    let hostKeyObserved = false;
    let hostKeyMismatch = false;
    let lineBuffer = Buffer.alloc(0);

    const removeAbortListener = () => options.signal?.removeEventListener('abort', abort);
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (idleTimer) clearTimeout(idleTimer);
      removeAbortListener();
      try { request?.destroy(); } catch { /* best effort */ }
      try { channel?.destroy(); } catch { /* best effort */ }
      try { client.end(); } catch { /* best effort */ }
      if (error) reject(error);
      else resolve();
    };
    const resetIdleTimer = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(
        () => finish(new OllamaCreateStreamError('OLLAMA_CREATE_IDLE_TIMEOUT', 'Ollama create stream was idle for too long.')),
        idleTimeoutMs,
      );
    };
    const abort = () => finish(new OllamaCreateStreamError('CREATE_ABORTED', 'Ollama create request was aborted.'));
    options.signal?.addEventListener('abort', abort, { once: true });

    const consume = (chunk: Buffer, final = false) => {
      lineBuffer = Buffer.concat([lineBuffer, chunk]);
      if (lineBuffer.length > MAX_PROGRESS_LINE_BYTES && lineBuffer.indexOf(0x0a) < 0) {
        throw new OllamaCreateStreamError('OLLAMA_CREATE_RESPONSE_INVALID', 'Ollama create progress line exceeded the size limit.');
      }
      let newline = lineBuffer.indexOf(0x0a);
      while (newline >= 0) {
        const line = lineBuffer.subarray(0, newline);
        lineBuffer = lineBuffer.subarray(newline + 1);
        if (line.length > 0) {
          try { options.onProgress(parsePullProgressLine(line)); }
          catch (error) {
            throw new OllamaCreateStreamError('OLLAMA_CREATE_RESPONSE_INVALID', 'Ollama create progress was invalid.', { cause: error });
          }
        }
        newline = lineBuffer.indexOf(0x0a);
      }
      if (lineBuffer.length > MAX_PROGRESS_LINE_BYTES) {
        throw new OllamaCreateStreamError('OLLAMA_CREATE_RESPONSE_INVALID', 'Ollama create progress line exceeded the size limit.');
      }
      if (final && lineBuffer.length > 0) {
        const finalLine = lineBuffer;
        lineBuffer = Buffer.alloc(0);
        try { options.onProgress(parsePullProgressLine(finalLine)); }
        catch (error) {
          throw new OllamaCreateStreamError('OLLAMA_CREATE_RESPONSE_INVALID', 'Ollama create progress was invalid.', { cause: error });
        }
      }
    };

    client.once('ready', () => {
      client.forwardOut('127.0.0.1', 0, destinationHost, destinationPort, (forwardError, stream) => {
        if (forwardError) {
          finish(new OllamaCreateStreamError('SSH_FORWARD_FAILED', 'SSH TCP forwarding failed.'));
          return;
        }
        channel = stream;
        const hostHeader = destinationHost.includes(':') ? `[${destinationHost}]:${destinationPort}` : `${destinationHost}:${destinationPort}`;
        request = http.request({
          method: 'POST',
          path: '/api/create',
          host: destinationHost,
          port: destinationPort,
          agent: false,
          createConnection: () => stream,
          headers: {
            host: hostHeader,
            accept: 'application/x-ndjson, application/json',
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(requestBody),
            connection: 'close',
          },
        }, (response) => {
          resetIdleTimer();
          const statusCode = response.statusCode ?? 0;
          if (statusCode < 200 || statusCode >= 300) {
            finish(new OllamaCreateStreamError('OLLAMA_CREATE_HTTP_ERROR', `Ollama create returned HTTP ${statusCode}.`));
            return;
          }
          if (!contentTypeAccepted(response.headers['content-type'])) {
            finish(new OllamaCreateStreamError('OLLAMA_CREATE_RESPONSE_INVALID', 'Ollama create returned an unexpected content type.'));
            return;
          }
          response.on('data', (chunk: Buffer) => {
            if (settled) return;
            resetIdleTimer();
            try { consume(Buffer.from(chunk)); }
            catch (error) { finish(error instanceof Error ? error : new OllamaCreateStreamError('OLLAMA_CREATE_RESPONSE_INVALID', 'Ollama create response was invalid.')); }
          });
          response.once('end', () => {
            if (settled) return;
            try {
              consume(Buffer.alloc(0), true);
              finish();
            } catch (error) {
              finish(error instanceof Error ? error : new OllamaCreateStreamError('OLLAMA_CREATE_RESPONSE_INVALID', 'Ollama create response ended invalidly.'));
            }
          });
          response.once('error', () => finish(new OllamaCreateStreamError('OLLAMA_CREATE_RESPONSE_INVALID', 'Ollama create response stream failed.')));
        });
        request.once('error', () => {
          if (!settled) finish(new OllamaCreateStreamError('SSH_FORWARD_FAILED', 'SSH-forwarded Ollama create request failed.'));
        });
        resetIdleTimer();
        request.end(requestBody);
      });
    });

    client.once('error', () => {
      if (hostKeyObserved && hostKeyMismatch) {
        finish(new OllamaCreateStreamError('SSH_HOST_KEY_MISMATCH', 'SSH host-key verification failed.'));
        return;
      }
      finish(new OllamaCreateStreamError('SSH_CONNECT_FAILED', 'SSH connection failed.'));
    });
    client.once('end', () => {
      if (!settled && !channel) finish(new OllamaCreateStreamError('SSH_CONNECT_FAILED', 'SSH connection ended before TCP forwarding started.'));
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
