import type { RemoteExecResult } from '@orc/core';

export const DOCKER_ADAPTER_SCOPE = Object.freeze([
  'discover', 'inspect', 'logs', 'start', 'stop', 'restart', 'update', 'rollback',
] as const);

export type DockerDiscoveryErrorCode = 'DOCKER_UNAVAILABLE' | 'DOCKER_OUTPUT_INVALID';

export class DockerDiscoveryError extends Error {
  constructor(readonly code: DockerDiscoveryErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

export interface CommandExecutor {
  exec(argv: readonly string[]): Promise<RemoteExecResult>;
}

export interface DockerContainerCandidate {
  readonly id: string;
  readonly name: string;
  readonly image: string;
  readonly state: string;
  readonly status: string;
  readonly ports: string;
  readonly labels: string;
  readonly score: number;
  readonly reasons: readonly string[];
  readonly inspect: {
    readonly image: string;
    readonly running: boolean;
    readonly env: readonly string[];
    readonly mounts: readonly { source: string; destination: string; type: string }[];
    readonly portBindings: Readonly<Record<string, unknown>>;
    readonly labels: Readonly<Record<string, string>>;
  };
}

export interface DockerDiscoveryResult {
  readonly dockerVersion: string;
  readonly candidates: readonly DockerContainerCandidate[];
  readonly recommendedContainerId: string | null;
  readonly ambiguous: boolean;
}

interface PsRow {
  ID?: unknown;
  Names?: unknown;
  Image?: unknown;
  State?: unknown;
  Status?: unknown;
  Ports?: unknown;
  Labels?: unknown;
}

function requireSuccess(result: RemoteExecResult, action: string): string {
  if (result.exitCode !== 0) {
    throw new DockerDiscoveryError('DOCKER_UNAVAILABLE', `${action} failed: ${result.stderr.trim() || 'unknown Docker error'}`);
  }
  return result.stdout;
}

function scoreCandidate(row: Required<PsRow>): { score: number; reasons: string[] } {
  let score = 0;
  const reasons: string[] = [];
  const image = String(row.Image).toLowerCase();
  const name = String(row.Names).toLowerCase();
  const ports = String(row.Ports).toLowerCase();
  const labels = String(row.Labels).toLowerCase();
  if (/(^|\/)ollama\/ollama(?::|@|$)/u.test(image) || /^ollama(?::|@)/u.test(image)) { score += 6; reasons.push('image'); }
  if (name.includes('ollama')) { score += 2; reasons.push('name'); }
  if (ports.includes('11434')) { score += 3; reasons.push('port-11434'); }
  if (labels.includes('ollama')) { score += 1; reasons.push('label'); }
  return { score, reasons };
}

function parsePs(stdout: string): Required<PsRow>[] {
  if (!stdout.trim()) return [];
  try {
    return stdout.trim().split(/\r?\n/u).map((line) => {
      const row = JSON.parse(line) as PsRow;
      return {
        ID: String(row.ID ?? ''), Names: String(row.Names ?? ''), Image: String(row.Image ?? ''),
        State: String(row.State ?? ''), Status: String(row.Status ?? ''), Ports: String(row.Ports ?? ''),
        Labels: String(row.Labels ?? ''),
      };
    }).filter((row) => Boolean(row.ID));
  } catch (error) {
    throw new DockerDiscoveryError('DOCKER_OUTPUT_INVALID', 'Docker container listing was not valid JSON-lines.', { cause: error as Error });
  }
}

function inspectCandidate(value: unknown): DockerContainerCandidate['inspect'] {
  const item = Array.isArray(value) ? value[0] : null;
  if (!item || typeof item !== 'object') throw new DockerDiscoveryError('DOCKER_OUTPUT_INVALID', 'Docker inspect returned no object.');
  const object = item as Record<string, any>;
  const mounts = Array.isArray(object.Mounts) ? object.Mounts.map((mount: any) => ({
    source: String(mount?.Source ?? ''), destination: String(mount?.Destination ?? ''), type: String(mount?.Type ?? ''),
  })) : [];
  const labelsValue = object.Config?.Labels && typeof object.Config.Labels === 'object' ? object.Config.Labels : {};
  const labels: Record<string, string> = {};
  for (const [key, val] of Object.entries(labelsValue)) labels[key] = String(val);
  return {
    image: String(object.Config?.Image ?? ''), running: Boolean(object.State?.Running),
    env: Array.isArray(object.Config?.Env) ? object.Config.Env.map(String) : [], mounts,
    portBindings: object.HostConfig?.PortBindings && typeof object.HostConfig.PortBindings === 'object' ? object.HostConfig.PortBindings : {},
    labels,
  };
}

export async function discoverOllamaContainers(executor: CommandExecutor): Promise<DockerDiscoveryResult> {
  const version = requireSuccess(await executor.exec(['docker', 'version', '--format', '{{.Server.Version}}']), 'docker version').trim();
  const rows = parsePs(requireSuccess(await executor.exec([
    'docker', 'ps', '-a', '--no-trunc', '--format', '{{json .}}',
  ]), 'docker ps'));
  const scored = rows.map((row) => ({ row, ...scoreCandidate(row) })).filter((entry) => entry.score > 0);
  const candidates: DockerContainerCandidate[] = [];
  for (const entry of scored) {
    const inspected = requireSuccess(await executor.exec(['docker', 'inspect', String(entry.row.ID)]), 'docker inspect');
    let parsed: unknown;
    try { parsed = JSON.parse(inspected); } catch (error) {
      throw new DockerDiscoveryError('DOCKER_OUTPUT_INVALID', 'Docker inspect output was invalid JSON.', { cause: error as Error });
    }
    candidates.push({
      id: String(entry.row.ID), name: String(entry.row.Names), image: String(entry.row.Image),
      state: String(entry.row.State), status: String(entry.row.Status), ports: String(entry.row.Ports),
      labels: String(entry.row.Labels), score: entry.score, reasons: entry.reasons, inspect: inspectCandidate(parsed),
    });
  }
  candidates.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  const recommended = candidates.length > 0 && (candidates.length === 1 || candidates[0].score > candidates[1].score)
    ? candidates[0].id : null;
  return { dockerVersion: version, candidates, recommendedContainerId: recommended, ambiguous: candidates.length > 1 && recommended === null };
}
