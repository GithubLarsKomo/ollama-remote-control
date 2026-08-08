import { createHash } from 'node:crypto';
import { Client } from 'ssh2';
import type { HostKeyObservation, RemoteExecResult } from '@orc/core';

export const SSH_ADAPTER_CAPABILITIES = Object.freeze({
  privateKeyAuthentication: true,
  hostKeyVerification: true,
  exec: true,
  streamingExec: true,
  forwarding: true,
  pty: true,
});

export type SshTransportErrorCode =
  | 'SSH_CONNECT_FAILED'
  | 'SSH_HOST_KEY_MISMATCH'
  | 'AUTH_FAILED'
  | 'SSH_EXEC_FAILED';

export class SshTransportError extends Error {
  constructor(
    readonly code: SshTransportErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export interface SshEndpoint {
  readonly hostname: string;
  readonly port?: number;
  readonly timeoutMs?: number;
}

export interface SshPrivateKeyConnection extends SshEndpoint {
  readonly username: string;
  readonly privateKey: string | Buffer;
  readonly expectedFingerprint: string;
}

export interface SshExecOptions {
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
}

export interface SshStreamOptions {
  readonly startupTimeoutMs?: number;
}

export interface SshStreamCompletion {
  readonly exitCode: number | null;
  readonly signal?: string;
  readonly cancelled: boolean;
}

export interface SshCommandStream {
  readonly done: Promise<SshStreamCompletion>;
  onStdout(listener: (chunk: string) => void): void;
  onStderr(listener: (chunk: string) => void): void;
  start(): void;
  cancel(): void;
}

interface PinnedClient {
  readonly client: Client;
  readonly observation: HostKeyObservation;
}

function fingerprint(key: Buffer): string {
  return `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/u, '')}`;
}

function keyAlgorithm(key: Buffer): string {
  if (key.length < 4) return 'unknown';
  const length = key.readUInt32BE(0);
  if (length < 1 || 4 + length > key.length) return 'unknown';
  return key.subarray(4, 4 + length).toString('ascii');
}

function observation(key: Buffer): HostKeyObservation {
  return { algorithm: keyAlgorithm(key), fingerprint: fingerprint(key) };
}

function endpointPort(port: number | undefined): number {
  const value = port ?? 22;
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new SshTransportError('SSH_CONNECT_FAILED', 'SSH port is invalid.');
  }
  return value;
}

function mapConnectionError(error: Error, mismatch = false): SshTransportError {
  if (mismatch) return new SshTransportError('SSH_HOST_KEY_MISMATCH', 'SSH host key does not match the pinned fingerprint.', { cause: error });
  const candidate = error as Error & { level?: string };
  if (candidate.level === 'client-authentication' || /authentication|private.?key|parse.*key|no supported authentication/i.test(error.message)) {
    return new SshTransportError('AUTH_FAILED', 'SSH private-key authentication failed.', { cause: error });
  }
  return new SshTransportError('SSH_CONNECT_FAILED', 'SSH connection failed.', { cause: error });
}

function quoteArgument(argument: string): string {
  if (argument.includes('\u0000')) throw new SshTransportError('SSH_EXEC_FAILED', 'Remote command argument contains NUL.');
  return `'${argument.replaceAll("'", `'"'"'`)}'`;
}

function commandFromArgv(argv: readonly string[]): string {
  if (argv.length === 0) throw new SshTransportError('SSH_EXEC_FAILED', 'Remote command argv must not be empty.');
  return argv.map(quoteArgument).join(' ');
}

function connectPinned(connection: SshPrivateKeyConnection): Promise<PinnedClient> {
  return new Promise((resolve, reject) => {
    const client = new Client();
    let mismatch = false;
    let observed: HostKeyObservation | null = null;
    client
      .on('ready', () => {
        if (!observed) {
          client.end();
          reject(new SshTransportError('SSH_CONNECT_FAILED', 'SSH connection became ready without a host-key observation.'));
          return;
        }
        resolve({ client, observation: observed });
      })
      .on('error', (error: Error) => reject(mapConnectionError(error, mismatch)));

    try {
      client.connect({
        host: connection.hostname,
        port: endpointPort(connection.port),
        username: connection.username,
        privateKey: connection.privateKey,
        readyTimeout: connection.timeoutMs ?? 10_000,
        hostVerifier(key: Buffer) {
          observed = observation(key);
          mismatch = observed.fingerprint !== connection.expectedFingerprint;
          return !mismatch;
        },
      });
    } catch (error) {
      reject(mapConnectionError(error as Error, mismatch));
    }
  });
}

export function probeHostKey(endpoint: SshEndpoint): Promise<HostKeyObservation> {
  return new Promise((resolve, reject) => {
    const client = new Client();
    let observed = false;
    client.on('error', (error: Error) => { if (!observed) reject(mapConnectionError(error)); });
    try {
      client.connect({
        host: endpoint.hostname,
        port: endpointPort(endpoint.port),
        username: '__orc_host_key_probe__',
        readyTimeout: endpoint.timeoutMs ?? 10_000,
        hostVerifier(key: Buffer) {
          observed = true;
          resolve(observation(key));
          queueMicrotask(() => client.end());
          return false;
        },
      });
    } catch (error) {
      reject(mapConnectionError(error as Error));
    }
  });
}

export async function verifyPrivateKeyAccess(connection: SshPrivateKeyConnection): Promise<HostKeyObservation> {
  const pinned = await connectPinned(connection);
  pinned.client.end();
  return pinned.observation;
}

export async function execPrivateKey(
  connection: SshPrivateKeyConnection,
  argv: readonly string[],
  options: SshExecOptions = {},
): Promise<RemoteExecResult> {
  const pinned = await connectPinned(connection);
  const client = pinned.client;
  const command = commandFromArgv(argv);
  const maxOutputBytes = options.maxOutputBytes ?? 8 * 1024 * 1024;
  try {
    return await new Promise<RemoteExecResult>((resolve, reject) => {
      client.exec(command, (error, stream) => {
        if (error) {
          reject(new SshTransportError('SSH_EXEC_FAILED', 'Remote command could not start.', { cause: error }));
          return;
        }
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        let totalBytes = 0;
        let exitCode: number | null = null;
        let signal: string | undefined;
        let settled = false;
        const finishError = (value: Error) => {
          if (settled) return;
          settled = true;
          stream.end();
          reject(value);
        };
        const collect = (target: Buffer[], chunk: Buffer) => {
          totalBytes += chunk.length;
          if (totalBytes > maxOutputBytes) {
            finishError(new SshTransportError('SSH_EXEC_FAILED', 'Remote command output exceeded limit.'));
            return;
          }
          target.push(Buffer.from(chunk));
        };
        const timer = options.timeoutMs
          ? setTimeout(() => finishError(new SshTransportError('SSH_EXEC_FAILED', 'Remote command timed out.')), options.timeoutMs)
          : null;
        timer?.unref();
        stream.on('data', (chunk: Buffer) => collect(stdout, chunk));
        stream.stderr.on('data', (chunk: Buffer) => collect(stderr, chunk));
        stream.on('exit', (code: number | null, signalName?: string) => { exitCode = code; signal = signalName; });
        stream.on('error', (streamError: Error) => finishError(new SshTransportError('SSH_EXEC_FAILED', 'Remote command stream failed.', { cause: streamError })));
        stream.on('close', () => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          resolve({ stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'), exitCode, signal });
        });
      });
    });
  } finally {
    client.end();
  }
}

export async function streamPrivateKey(
  connection: SshPrivateKeyConnection,
  argv: readonly string[],
  options: SshStreamOptions = {},
): Promise<SshCommandStream> {
  const pinned = await connectPinned(connection);
  const client = pinned.client;
  const command = commandFromArgv(argv);
  return await new Promise<SshCommandStream>((resolve, reject) => {
    let started = false;
    let startupSettled = false;
    const startupTimer = setTimeout(() => {
      if (startupSettled) return;
      startupSettled = true;
      client.end();
      reject(new SshTransportError('SSH_EXEC_FAILED', 'Remote streaming command did not start in time.'));
    }, options.startupTimeoutMs ?? 10_000);
    startupTimer.unref();

    client.exec(command, (error, stream) => {
      if (startupSettled) {
        stream?.close();
        return;
      }
      startupSettled = true;
      clearTimeout(startupTimer);
      if (error) {
        client.end();
        reject(new SshTransportError('SSH_EXEC_FAILED', 'Remote streaming command could not start.', { cause: error }));
        return;
      }

      stream.pause();
      stream.stderr.pause();
      const stdoutListeners = new Set<(chunk: string) => void>();
      const stderrListeners = new Set<(chunk: string) => void>();
      let exitCode: number | null = null;
      let signal: string | undefined;
      let cancelled = false;
      let completed = false;
      let resolveDone!: (completion: SshStreamCompletion) => void;
      let rejectDone!: (error: Error) => void;
      const done = new Promise<SshStreamCompletion>((resolveCompletion, rejectCompletion) => {
        resolveDone = resolveCompletion;
        rejectDone = rejectCompletion;
      });

      const finish = () => {
        if (completed) return;
        completed = true;
        client.end();
        resolveDone({ exitCode, signal, cancelled });
      };
      const fail = (streamError: Error) => {
        if (completed) return;
        completed = true;
        client.end();
        rejectDone(new SshTransportError('SSH_EXEC_FAILED', 'Remote streaming command failed.', { cause: streamError }));
      };
      stream.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf8');
        for (const listener of stdoutListeners) listener(text);
      });
      stream.stderr.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf8');
        for (const listener of stderrListeners) listener(text);
      });
      stream.on('exit', (code: number | null, signalName?: string) => {
        exitCode = code;
        signal = signalName;
      });
      stream.on('error', fail);
      stream.on('close', finish);

      const handle: SshCommandStream = {
        done,
        onStdout(listener) { stdoutListeners.add(listener); },
        onStderr(listener) { stderrListeners.add(listener); },
        start() {
          if (started || completed) return;
          started = true;
          stream.stderr.resume();
          stream.resume();
        },
        cancel() {
          if (completed || cancelled) return;
          cancelled = true;
          try { stream.signal('TERM'); } catch { /* best effort */ }
          try { stream.close(); } catch { stream.end(); }
          client.end();
        },
      };
      resolve(handle);
    });
  });
}
