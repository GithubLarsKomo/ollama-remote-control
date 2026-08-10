import { createHash } from 'node:crypto';
import http from 'node:http';
import type { ClientChannel } from 'ssh2';
import { Client } from 'ssh2';
import type { SshPrivateKeyConnection } from '@orc/ssh';

const MAX_MODEL_NAME = 512;
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_GENERATED_TEXT = 4 * 1024;
const MAX_DONE_REASON = 80;
const DEFAULT_TIMEOUT_MS = 45_000;

export const MODEL_SMOKE_PROMPT = 'Reply with the single word OK.';
export const MODEL_SMOKE_OPTIONS = Object.freeze({ temperature: 0, num_predict: 8 });

export type OllamaSmokeHttpErrorCode =
  | 'SSH_HOST_KEY_MISMATCH'
  | 'SSH_CONNECT_FAILED'
  | 'SSH_FORWARD_FAILED'
  | 'MODEL_SMOKE_HTTP_ERROR'
  | 'MODEL_SMOKE_RESPONSE_INVALID'
  | 'MODEL_SMOKE_TIMEOUT';

export class OllamaSmokeHttpError extends Error {
  constructor(
    readonly code: OllamaSmokeHttpErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export interface OllamaSmokeHttpResult {
  readonly statusCode: number;
  readonly elapsedMs: number;
  readonly responseChars: number;
  readonly doneReason: string | null;
}

export function modelSmokeRequestBody(model: string): Readonly<Record<string, unknown>> {
  return {
    model,
    prompt: MODEL_SMOKE_PROMPT,
    stream: false,
    keep_alive: 0,
    options: MODEL_SMOKE_OPTIONS,
  };
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
    throw new OllamaSmokeHttpError('SSH_FORWARD_FAILED', 'SSH forward destination host is invalid.');
  }
  if (!Number.isInteger(destinationPort) || destinationPort < 1 || destinationPort > 65535) {
    throw new OllamaSmokeHttpError('SSH_FORWARD_FAILED', 'SSH forward destination port is invalid.');
  }
  if (
    !model
    || model.length > MAX_MODEL_NAME
    || /[\u0000-\u0020\u007f]/u.test(model)
    || !/^[A-Za-z0-9][A-Za-z0-9._/:@+-]*$/u.test(model)
  ) {
    throw new OllamaSmokeHttpError('MODEL_SMOKE_RESPONSE_INVALID', 'Ollama model name is invalid.');
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 120_000) {
    throw new OllamaSmokeHttpError('MODEL_SMOKE_TIMEOUT', 'Ollama smoke-test timeout is invalid.');
  }
}

function parseResponse(chunks: readonly Buffer[], totalBytes: number, elapsedMs: number): OllamaSmokeHttpResult {
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.concat(chunks, totalBytes).toString('utf8')); }
  catch {
    throw new OllamaSmokeHttpError('MODEL_SMOKE_RESPONSE_INVALID', 'Ollama smoke test returned invalid JSON.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new OllamaSmokeHttpError('MODEL_SMOKE_RESPONSE_INVALID', 'Ollama smoke test returned an invalid response shape.');
  }
  const object = parsed as Record<string, unknown>;
  if (object.done !== true) {
    throw new OllamaSmokeHttpError('MODEL_SMOKE_RESPONSE_INVALID', 'Ollama smoke test did not report completion.');
  }
  if (typeof object.response !== 'string' || !object.response.trim() || object.response.length > MAX_GENERATED_TEXT) {
    throw new OllamaSmokeHttpError('MODEL_SMOKE_RESPONSE_INVALID', 'Ollama smoke test returned no bounded generated text.');
  }
  let doneReason: string | null = null;
  if (object.done_reason !== undefined && object.done_reason !== null) {
    if (
      typeof object.done_reason !== 'string'
      || object.done_reason.length > MAX_DONE_REASON
      || /[\u0000-\u001f\u007f]/u.test(object.done_reason)
    ) {
      throw new OllamaSmokeHttpError('MODEL_SMOKE_RESPONSE_INVALID', 'Ollama smoke test returned an invalid done reason.');
    }
    doneReason = object.done_reason;
  }
  return {
    statusCode: 200,
    elapsedMs,
    responseChars: object.response.length,
    doneReason,
  };
}

export async function smokeTestOllamaModelViaPinnedSsh(
  connection: SshPrivateKeyConnection,
  destinationHost: string,
  destinationPort: number,
  model: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<OllamaSmokeHttpResult> {
  validate(destinationHost, destinationPort, model, timeoutMs);
  const requestBody = JSON.stringify(modelSmokeRequestBody(model));
  const startedAt = Date.now();

  return await new Promise<OllamaSmokeHttpResult>((resolve, reject) => {
    const client = new Client();
    let channel: ClientChannel | null = null;
    let request: http.ClientRequest | null = null;
    let settled = false;
    let hostKeyObserved = false;
    let hostKeyMismatch = false;

    const finish = (error?: Error, result?: OllamaSmokeHttpResult) => {
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
      () => finish(new OllamaSmokeHttpError('MODEL_SMOKE_TIMEOUT', 'Ollama smoke test timed out.')),
      timeoutMs,
    );

    client.once('ready', () => {
      client.forwardOut('127.0.0.1', 0, destinationHost, destinationPort, (forwardError, stream) => {
        if (forwardError) {
          finish(new OllamaSmokeHttpError('SSH_FORWARD_FAILED', 'SSH TCP forwarding failed.'));
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
            finish(new OllamaSmokeHttpError('MODEL_SMOKE_HTTP_ERROR', `Ollama smoke test returned HTTP ${statusCode}.`));
            return;
          }
          const chunks: Buffer[] = [];
          let totalBytes = 0;
          response.on('data', (chunk: Buffer) => {
            if (settled) return;
            totalBytes += chunk.length;
            if (totalBytes > MAX_RESPONSE_BYTES) {
              finish(new OllamaSmokeHttpError('MODEL_SMOKE_RESPONSE_INVALID', 'Ollama smoke-test response exceeded the size limit.'));
              return;
            }
            chunks.push(Buffer.from(chunk));
          });
          response.once('end', () => {
            if (settled) return;
            try {
              const parsed = parseResponse(chunks, totalBytes, Math.max(0, Date.now() - startedAt));
              finish(undefined, { ...parsed, statusCode });
            } catch (error) {
              finish(error instanceof Error ? error : new OllamaSmokeHttpError('MODEL_SMOKE_RESPONSE_INVALID', 'Ollama smoke-test response was invalid.'));
            }
          });
          response.once('error', () => finish(new OllamaSmokeHttpError('MODEL_SMOKE_RESPONSE_INVALID', 'Ollama smoke-test response stream failed.')));
        });
        request.once('error', () => {
          if (!settled) finish(new OllamaSmokeHttpError('SSH_FORWARD_FAILED', 'SSH-forwarded Ollama smoke-test request failed.'));
        });
        request.end(requestBody);
      });
    });

    client.once('error', () => {
      if (hostKeyObserved && hostKeyMismatch) {
        finish(new OllamaSmokeHttpError('SSH_HOST_KEY_MISMATCH', 'SSH host-key verification failed.'));
        return;
      }
      finish(new OllamaSmokeHttpError('SSH_CONNECT_FAILED', 'SSH connection failed.'));
    });
    client.once('end', () => {
      if (!settled && !channel) finish(new OllamaSmokeHttpError('SSH_CONNECT_FAILED', 'SSH connection ended before TCP forwarding started.'));
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
