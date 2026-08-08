import { isIP } from 'node:net';
import type {
  HostOnboardingRepository,
  OllamaTargetRepository,
  SshCredentialRepository,
} from '@orc/core';
import { SecretCipher } from '@orc/security';
import {
  execPrivateKey,
  SshTransportError,
  type SshPrivateKeyConnection,
} from '@orc/ssh';
import {
  httpGetViaPinnedSsh,
  SshHttpError,
} from './ssh-http.js';

export type OllamaHealthTransportMode = 'published-binding' | 'container-network';

export interface OllamaHealthResult {
  readonly targetId: string;
  readonly status: 'healthy' | 'degraded';
  readonly container: {
    readonly running: true;
  };
  readonly ollama: {
    readonly cliVersion: string;
    readonly apiReachable: true;
    readonly apiVersion: string;
    readonly versionMatch: boolean;
  };
  readonly transport: {
    readonly mode: OllamaHealthTransportMode;
  };
}

export class OllamaHealthError extends Error {
  constructor(
    readonly code: string,
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

interface ApiRoute {
  readonly mode: OllamaHealthTransportMode;
  readonly host: string;
  readonly port: number;
}

interface ResolvedTarget {
  readonly targetId: string;
  readonly selectedContainerId: string;
  readonly connection: SshPrivateKeyConnection;
}

function parsePort(value: unknown): number | null {
  const text = String(value ?? '').trim();
  if (!/^\d{1,5}$/u.test(text)) return null;
  const port = Number(text);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}

function normalizePublishedHost(value: unknown): string | null {
  const host = String(value ?? '').trim();
  if (!host || host === '0.0.0.0') return '127.0.0.1';
  if (host === '::' || host === '[::]') return '::1';
  return isIP(host) ? host : null;
}

function ipv4Octets(value: string): readonly number[] | null {
  if (isIP(value) !== 4) return null;
  const octets = value.split('.').map(Number);
  return octets.length === 4 ? octets : null;
}

function safeContainerIpv4(value: unknown): string | null {
  const address = String(value ?? '').trim();
  const octets = ipv4Octets(address);
  if (!octets) return null;
  const [a, b] = octets;
  if (a === 0 || a === 127 || a >= 224) return null;
  if (a === 169 && b === 254) return null;
  return address;
}

function normalizedContainerId(value: string): string {
  const containerId = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u.test(containerId)) {
    throw new OllamaHealthError('INVALID_CONTAINER_ID', 400, 'Container identifier is invalid.');
  }
  return containerId;
}

export function selectOllamaApiRoute(containerInspect: Record<string, any>): ApiRoute | null {
  const bindings = containerInspect.HostConfig?.PortBindings?.['11434/tcp'];
  if (Array.isArray(bindings)) {
    const candidates = bindings.flatMap((binding: any) => {
      const host = normalizePublishedHost(binding?.HostIp);
      const port = parsePort(binding?.HostPort);
      return host && port ? [{ host, port }] : [];
    });
    const rank = (host: string): number => host === '127.0.0.1' ? 0 : host === '::1' ? 1 : isIP(host) === 4 ? 2 : 3;
    candidates.sort((left, right) => rank(left.host) - rank(right.host) || left.host.localeCompare(right.host) || left.port - right.port);
    if (candidates[0]) return { mode: 'published-binding', ...candidates[0] };
  }

  const networks = containerInspect.NetworkSettings?.Networks;
  if (networks && typeof networks === 'object') {
    const candidates = Object.entries(networks as Record<string, any>).flatMap(([name, network]) => {
      const host = safeContainerIpv4(network?.IPAddress);
      return host ? [{ name, host }] : [];
    });
    candidates.sort((left, right) => left.name.localeCompare(right.name) || left.host.localeCompare(right.host));
    if (candidates[0]) return { mode: 'container-network', host: candidates[0].host, port: 11434 };
  }
  return null;
}

function parseInspect(stdout: string): Record<string, any> {
  try {
    const parsed = JSON.parse(stdout);
    const object = Array.isArray(parsed) ? parsed[0] : null;
    if (!object || typeof object !== 'object') throw new Error('missing inspect object');
    return object as Record<string, any>;
  } catch {
    throw new OllamaHealthError('DOCKER_OUTPUT_INVALID', 502, 'Docker inspect returned invalid data.');
  }
}

function parseCliVersion(stdout: string): string {
  const text = stdout.trim();
  const match = /(?:^|\s)(\d+\.\d+\.\d+(?:[-+][A-Za-z0-9._-]+)?)(?:\s|$)/u.exec(text);
  if (!match) throw new OllamaHealthError('OLLAMA_CLI_ERROR', 502, 'Ollama CLI did not return a readable version.');
  return match[1];
}

function parseApiVersion(body: Buffer): string {
  if (body.length === 0) throw new OllamaHealthError('OLLAMA_API_ERROR', 502, 'Ollama API returned an empty version response.');
  let parsed: unknown;
  try { parsed = JSON.parse(body.toString('utf8')); }
  catch { throw new OllamaHealthError('OLLAMA_API_ERROR', 502, 'Ollama API returned invalid JSON.'); }
  const version = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>).version : undefined;
  if (typeof version !== 'string' || !version.trim() || version.length > 100 || /[\u0000-\u001f\u007f]/u.test(version)) {
    throw new OllamaHealthError('OLLAMA_API_ERROR', 502, 'Ollama API returned an invalid version value.');
  }
  return version.trim();
}

function mapHttpError(error: SshHttpError): OllamaHealthError {
  if (error.code === 'SSH_HOST_KEY_MISMATCH') {
    return new OllamaHealthError('SSH_HOST_KEY_MISMATCH', 409, 'SSH host-key verification failed.');
  }
  if (error.code === 'HTTP_RESPONSE_INVALID' || error.code === 'HTTP_RESPONSE_TOO_LARGE') {
    return new OllamaHealthError('OLLAMA_API_ERROR', 502, 'Ollama API response was invalid.');
  }
  return new OllamaHealthError('OLLAMA_API_UNAVAILABLE', 502, 'Ollama API could not be reached through SSH.');
}

export class OllamaHealthService {
  constructor(
    private readonly hosts: HostOnboardingRepository,
    private readonly credentials: SshCredentialRepository,
    private readonly targets: OllamaTargetRepository,
    private readonly masterKey: Buffer | null,
  ) {}

  private resolve(targetId: string): ResolvedTarget {
    if (!this.masterKey) throw new OllamaHealthError('MASTER_KEY_REQUIRED', 503, 'External master key is required.');
    const target = this.targets.findById(targetId);
    if (!target || !target.enabled) throw new OllamaHealthError('TARGET_NOT_FOUND', 404, 'Ollama target was not found or is disabled.');
    const host = this.hosts.findHostById(target.hostId);
    if (!host || !host.enabled) throw new OllamaHealthError('HOST_NOT_FOUND', 404, 'Host was not found or is disabled.');
    const credential = this.credentials.findByHostId(host.id);
    if (!credential) throw new OllamaHealthError('SSH_CREDENTIAL_NOT_FOUND', 409, 'Host has no SSH credential.');
    let privateKey: string;
    try {
      privateKey = new SecretCipher(this.masterKey).decrypt(
        { credentialId: credential.id, hostId: host.id },
        credential.encryptedPrivateKey,
      );
    } catch {
      throw new OllamaHealthError('SSH_CREDENTIAL_INVALID', 409, 'Stored SSH credential could not be decrypted.');
    }
    return {
      targetId: target.id,
      selectedContainerId: target.selectedContainerId,
      connection: {
        hostname: host.hostname,
        port: host.port,
        username: host.username,
        privateKey,
        expectedFingerprint: host.hostKeyFingerprint,
      },
    };
  }

  private async readResolved(target: ResolvedTarget, containerId: string): Promise<OllamaHealthResult> {
    const executor = (argv: readonly string[]) => execPrivateKey(
      target.connection,
      argv,
      { timeoutMs: 10_000, maxOutputBytes: 2 * 1024 * 1024 },
    );

    let inspectResult;
    try { inspectResult = await executor(['docker', 'inspect', containerId]); }
    catch (error) {
      if (error instanceof SshTransportError) {
        const status = error.code === 'SSH_HOST_KEY_MISMATCH' ? 409 : error.code === 'AUTH_FAILED' ? 422 : 502;
        throw new OllamaHealthError(error.code, status, 'Remote SSH health inspection failed.');
      }
      throw error;
    }
    if (inspectResult.exitCode !== 0) {
      const detail = `${inspectResult.stderr}\n${inspectResult.stdout}`;
      if (/no such (object|container)/iu.test(detail)) throw new OllamaHealthError('CONTAINER_NOT_FOUND', 404, 'Ollama container was not found.');
      throw new OllamaHealthError('DOCKER_UNAVAILABLE', 502, 'Docker inspect failed.');
    }
    const inspect = parseInspect(inspectResult.stdout);
    if (!Boolean(inspect.State?.Running)) {
      throw new OllamaHealthError('CONTAINER_NOT_RUNNING', 409, 'Ollama container is not running.');
    }

    const cliResult = await executor(['docker', 'exec', containerId, 'ollama', '--version']);
    if (cliResult.exitCode !== 0) throw new OllamaHealthError('OLLAMA_CLI_ERROR', 502, 'Ollama CLI version lookup failed.');
    const cliVersion = parseCliVersion(cliResult.stdout);

    const route = selectOllamaApiRoute(inspect);
    if (!route) throw new OllamaHealthError('OLLAMA_API_UNAVAILABLE', 502, 'No safe Ollama API route could be derived from Docker state.');

    let response;
    try {
      response = await httpGetViaPinnedSsh(
        target.connection,
        route.host,
        route.port,
        '/api/version',
        { timeoutMs: 5_000, maxResponseBytes: 64 * 1024 },
      );
    } catch (error) {
      if (error instanceof SshHttpError) throw mapHttpError(error);
      throw new OllamaHealthError('OLLAMA_API_UNAVAILABLE', 502, 'Ollama API health request failed.');
    }
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new OllamaHealthError('OLLAMA_API_ERROR', 502, `Ollama API returned HTTP ${response.statusCode}.`);
    }
    const apiVersion = parseApiVersion(response.body);
    const versionMatch = apiVersion === cliVersion;
    return {
      targetId: target.targetId,
      status: versionMatch ? 'healthy' : 'degraded',
      container: { running: true },
      ollama: { cliVersion, apiReachable: true, apiVersion, versionMatch },
      transport: { mode: route.mode },
    };
  }

  async read(targetId: string): Promise<OllamaHealthResult> {
    const target = this.resolve(targetId);
    return this.readResolved(target, target.selectedContainerId);
  }

  async readContainer(targetId: string, containerId: string): Promise<OllamaHealthResult> {
    const normalized = normalizedContainerId(containerId);
    const target = this.resolve(targetId);
    return this.readResolved(target, normalized);
  }
}
