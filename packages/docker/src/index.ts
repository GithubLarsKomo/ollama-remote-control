import type { RemoteExecResult } from '@orc/core';

export const DOCKER_ADAPTER_SCOPE = Object.freeze([
  'discover', 'inspect', 'logs', 'start', 'stop', 'restart', 'update', 'rollback',
] as const);

export type DockerDiscoveryErrorCode = 'DOCKER_UNAVAILABLE' | 'DOCKER_OUTPUT_INVALID' | 'CONTAINER_NOT_FOUND';
export type DockerLifecycleAction = 'start' | 'stop' | 'restart';
export type DockerLifecycleErrorCode = 'DOCKER_UNAVAILABLE' | 'CONTAINER_NOT_FOUND' | 'CONTAINER_STATE_UNVERIFIED';
export type DockerPreflightErrorCode = 'DOCKER_UNAVAILABLE' | 'DOCKER_OUTPUT_INVALID' | 'CONTAINER_NOT_FOUND' | 'OLLAMA_CLI_ERROR';

export class DockerDiscoveryError extends Error {
  constructor(readonly code: DockerDiscoveryErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

export class DockerLifecycleError extends Error {
  constructor(
    readonly code: DockerLifecycleErrorCode,
    readonly exitCode: number | null,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export class DockerPreflightError extends Error {
  constructor(readonly code: DockerPreflightErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

export interface CommandExecutor {
  exec(argv: readonly string[]): Promise<RemoteExecResult>;
}

export interface DockerMount {
  readonly source: string;
  readonly destination: string;
  readonly type: string;
}

export interface DockerContainerStatus {
  readonly id: string;
  readonly name: string;
  readonly image: string;
  readonly running: boolean;
  readonly state: string;
  readonly status: string;
  readonly startedAt: string | null;
  readonly restartCount: number;
  readonly oomKilled: boolean;
  readonly env: readonly string[];
  readonly mounts: readonly DockerMount[];
  readonly portBindings: Readonly<Record<string, unknown>>;
  readonly labels: Readonly<Record<string, string>>;
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
    readonly mounts: readonly DockerMount[];
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

export interface DockerUpdatePreflightMetadata {
  readonly containerId: string;
  readonly containerName: string;
  readonly running: boolean;
  readonly imageReference: string;
  readonly imageId: string;
  readonly repoDigests: readonly string[];
  readonly restartPolicy: string;
  readonly mountCount: number;
  readonly portBindingCount: number;
  readonly networkNames: readonly string[];
  readonly gpuDeviceRequestCount: number;
  readonly ollamaVersion: string | null;
  readonly compose: {
    readonly managed: boolean;
    readonly project: string | null;
    readonly service: string | null;
    readonly configFiles: string | null;
    readonly workingDir: string | null;
  };
}

export interface DockerRollbackCapture {
  readonly metadata: DockerUpdatePreflightMetadata;
  readonly rawPayloadJson: string;
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

function parseInspectObject(stdout: string, action: string): Record<string, any> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    throw new DockerDiscoveryError('DOCKER_OUTPUT_INVALID', `${action} output was invalid JSON.`, { cause: error as Error });
  }
  const item = Array.isArray(parsed) ? parsed[0] : null;
  if (!item || typeof item !== 'object') {
    throw new DockerDiscoveryError('DOCKER_OUTPUT_INVALID', `${action} returned no object.`);
  }
  return item as Record<string, any>;
}

function parsePreflightObject(stdout: string, action: string): Record<string, any> {
  try {
    const parsed = JSON.parse(stdout);
    const item = Array.isArray(parsed) ? parsed[0] : null;
    if (!item || typeof item !== 'object') throw new Error('missing object');
    return item as Record<string, any>;
  } catch (error) {
    throw new DockerPreflightError('DOCKER_OUTPUT_INVALID', `${action} returned invalid JSON.`, { cause: error as Error });
  }
}

function mountsFrom(object: Record<string, any>): DockerMount[] {
  return Array.isArray(object.Mounts) ? object.Mounts.map((mount: any) => ({
    source: String(mount?.Source ?? ''),
    destination: String(mount?.Destination ?? ''),
    type: String(mount?.Type ?? ''),
  })) : [];
}

function labelsFrom(object: Record<string, any>): Record<string, string> {
  const labelsValue = object.Config?.Labels && typeof object.Config.Labels === 'object' ? object.Config.Labels : {};
  const labels: Record<string, string> = {};
  for (const [key, value] of Object.entries(labelsValue)) labels[key] = String(value);
  return labels;
}

function inspectCandidate(value: unknown): DockerContainerCandidate['inspect'] {
  const item = Array.isArray(value) ? value[0] : null;
  if (!item || typeof item !== 'object') throw new DockerDiscoveryError('DOCKER_OUTPUT_INVALID', 'Docker inspect returned no object.');
  const object = item as Record<string, any>;
  return {
    image: String(object.Config?.Image ?? ''),
    running: Boolean(object.State?.Running),
    env: Array.isArray(object.Config?.Env) ? object.Config.Env.map(String) : [],
    mounts: mountsFrom(object),
    portBindings: object.HostConfig?.PortBindings && typeof object.HostConfig.PortBindings === 'object' ? object.HostConfig.PortBindings : {},
    labels: labelsFrom(object),
  };
}

export async function inspectDockerContainer(
  executor: CommandExecutor,
  containerId: string,
): Promise<DockerContainerStatus> {
  const result = await executor.exec(['docker', 'inspect', containerId]);
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim();
    if (/no such (object|container)/iu.test(detail)) {
      throw new DockerDiscoveryError('CONTAINER_NOT_FOUND', `Docker container ${containerId} was not found.`);
    }
    throw new DockerDiscoveryError('DOCKER_UNAVAILABLE', `docker inspect failed: ${detail || 'unknown Docker error'}`);
  }
  const object = parseInspectObject(result.stdout, 'docker inspect');
  const state = object.State && typeof object.State === 'object' ? object.State : {};
  const health = state.Health && typeof state.Health === 'object' ? state.Health : null;
  return {
    id: String(object.Id ?? containerId),
    name: String(object.Name ?? '').replace(/^\//u, ''),
    image: String(object.Config?.Image ?? ''),
    running: Boolean(state.Running),
    state: String(state.Status ?? ''),
    status: health?.Status ? String(health.Status) : String(state.Status ?? ''),
    startedAt: state.StartedAt ? String(state.StartedAt) : null,
    restartCount: Number(object.RestartCount ?? 0),
    oomKilled: Boolean(state.OOMKilled),
    env: Array.isArray(object.Config?.Env) ? object.Config.Env.map(String) : [],
    mounts: mountsFrom(object),
    portBindings: object.HostConfig?.PortBindings && typeof object.HostConfig.PortBindings === 'object' ? object.HostConfig.PortBindings : {},
    labels: labelsFrom(object),
  };
}

export async function captureDockerRollbackState(
  executor: CommandExecutor,
  containerId: string,
): Promise<DockerRollbackCapture> {
  const containerResult = await executor.exec(['docker', 'inspect', containerId]);
  if (containerResult.exitCode !== 0) {
    const detail = `${containerResult.stderr}\n${containerResult.stdout}`;
    if (/no such (object|container)/iu.test(detail)) {
      throw new DockerPreflightError('CONTAINER_NOT_FOUND', 'Selected Docker container was not found.');
    }
    throw new DockerPreflightError('DOCKER_UNAVAILABLE', 'Docker container inspect failed.');
  }
  const container = parsePreflightObject(containerResult.stdout, 'docker inspect');
  const imageReference = String(container.Config?.Image ?? '');
  if (!imageReference) throw new DockerPreflightError('DOCKER_OUTPUT_INVALID', 'Container has no configured image reference.');

  const imageResult = await executor.exec(['docker', 'image', 'inspect', imageReference]);
  if (imageResult.exitCode !== 0) {
    throw new DockerPreflightError('DOCKER_UNAVAILABLE', 'Docker image inspect failed.');
  }
  const image = parsePreflightObject(imageResult.stdout, 'docker image inspect');
  const running = Boolean(container.State?.Running);
  let ollamaVersion: string | null = null;
  if (running) {
    const versionResult = await executor.exec(['docker', 'exec', containerId, 'ollama', '--version']);
    if (versionResult.exitCode !== 0) {
      throw new DockerPreflightError('OLLAMA_CLI_ERROR', 'Ollama version lookup failed.');
    }
    ollamaVersion = versionResult.stdout.trim() || null;
    if (!ollamaVersion) throw new DockerPreflightError('OLLAMA_CLI_ERROR', 'Ollama version lookup returned no version.');
  }

  const labels = labelsFrom(container);
  const composeProject = labels['com.docker.compose.project'] ?? null;
  const composeService = labels['com.docker.compose.service'] ?? null;
  const composeManaged = Boolean(composeProject && composeService);
  const portBindings = container.HostConfig?.PortBindings && typeof container.HostConfig.PortBindings === 'object'
    ? container.HostConfig.PortBindings as Record<string, unknown>
    : {};
  const networks = container.NetworkSettings?.Networks && typeof container.NetworkSettings.Networks === 'object'
    ? container.NetworkSettings.Networks as Record<string, unknown>
    : {};
  const deviceRequests = Array.isArray(container.HostConfig?.DeviceRequests) ? container.HostConfig.DeviceRequests : [];
  const repoDigests = Array.isArray(image.RepoDigests) ? image.RepoDigests.map(String) : [];

  const metadata: DockerUpdatePreflightMetadata = {
    containerId: String(container.Id ?? containerId),
    containerName: String(container.Name ?? '').replace(/^\//u, ''),
    running,
    imageReference,
    imageId: String(container.Image ?? image.Id ?? ''),
    repoDigests,
    restartPolicy: String(container.HostConfig?.RestartPolicy?.Name ?? ''),
    mountCount: Array.isArray(container.Mounts) ? container.Mounts.length : 0,
    portBindingCount: Object.keys(portBindings).length,
    networkNames: Object.keys(networks).sort(),
    gpuDeviceRequestCount: deviceRequests.length,
    ollamaVersion,
    compose: {
      managed: composeManaged,
      project: composeProject,
      service: composeService,
      configFiles: labels['com.docker.compose.project.config_files'] ?? null,
      workingDir: labels['com.docker.compose.project.working_dir'] ?? null,
    },
  };
  return {
    metadata,
    rawPayloadJson: JSON.stringify({ schemaVersion: 1, containerInspect: container, imageInspect: image, ollamaVersion }),
  };
}

export async function changeDockerContainerState(
  executor: CommandExecutor,
  containerId: string,
  action: DockerLifecycleAction,
): Promise<DockerContainerStatus> {
  const result = await executor.exec(['docker', action, containerId]);
  if (result.exitCode !== 0) {
    const detail = `${result.stderr}\n${result.stdout}`;
    if (/no such (object|container)/iu.test(detail)) {
      throw new DockerLifecycleError('CONTAINER_NOT_FOUND', result.exitCode, 'Selected Docker container was not found.');
    }
    throw new DockerLifecycleError('DOCKER_UNAVAILABLE', result.exitCode, `Docker ${action} command failed.`);
  }

  let verified: DockerContainerStatus;
  try {
    verified = await inspectDockerContainer(executor, containerId);
  } catch (error) {
    if (error instanceof DockerDiscoveryError && error.code === 'CONTAINER_NOT_FOUND') {
      throw new DockerLifecycleError('CONTAINER_NOT_FOUND', null, 'Selected Docker container was not found.', { cause: error });
    }
    throw new DockerLifecycleError('DOCKER_UNAVAILABLE', null, 'Docker state verification failed.', { cause: error as Error });
  }

  const expectedRunning = action !== 'stop';
  if (verified.running !== expectedRunning) {
    throw new DockerLifecycleError(
      'CONTAINER_STATE_UNVERIFIED',
      result.exitCode,
      `Docker ${action} completed but the expected container state could not be verified.`,
    );
  }
  return verified;
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
