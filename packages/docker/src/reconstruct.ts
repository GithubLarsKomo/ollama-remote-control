import { posix as path } from 'node:path';
import type { RemoteExecResult } from '@orc/core';

export type DockerReconstructErrorCode =
  | 'COMPOSE_CONTEXT_INVALID'
  | 'COMPOSE_UNAVAILABLE'
  | 'COMPOSE_CONFIG_INVALID'
  | 'COMPOSE_SERVICE_NOT_FOUND'
  | 'COMPOSE_CONTEXT_MISMATCH';

export class DockerReconstructError extends Error {
  constructor(readonly code: DockerReconstructErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

export interface ReconstructCommandExecutor {
  exec(argv: readonly string[]): Promise<RemoteExecResult>;
}

export interface ComposeSnapshotContext {
  readonly projectName: string;
  readonly service: string;
  readonly workingDirectory: string;
  readonly configFiles: readonly string[];
  readonly environmentFiles: readonly string[];
}

export interface ValidatedComposeStrategy extends ComposeSnapshotContext {
  readonly type: 'compose';
  readonly executable: true;
  readonly composeVersion: string;
  readonly containerId: string;
}

export interface StandaloneReconstructionSummary {
  readonly environmentCount: number;
  readonly labelCount: number;
  readonly mountCount: number;
  readonly portBindingCount: number;
  readonly networkNames: readonly string[];
  readonly restartPolicy: string;
  readonly hasCommandOverride: boolean;
  readonly hasEntrypointOverride: boolean;
}

export interface StandaloneStrategy {
  readonly type: 'standalone';
  readonly executable: boolean;
  readonly unsupportedFields: readonly string[];
  readonly summary: StandaloneReconstructionSummary;
}

const COMPOSE_LABELS = {
  project: 'com.docker.compose.project',
  service: 'com.docker.compose.service',
  configFiles: 'com.docker.compose.project.config_files',
  workingDirectory: 'com.docker.compose.project.working_dir',
  environmentFile: 'com.docker.compose.project.environment_file',
  oneoff: 'com.docker.compose.oneoff',
} as const;

const DEFAULT_SHM_SIZE = 64 * 1024 * 1024;

function labelsFrom(containerInspect: Record<string, any>): Record<string, string> {
  const raw = containerInspect.Config?.Labels;
  if (!raw || typeof raw !== 'object') return {};
  const labels: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) labels[key] = String(value ?? '');
  return labels;
}

function splitLabelList(value: string | undefined, workingDirectory: string): string[] {
  if (!value?.trim()) return [];
  return value.split(',').map((entry) => entry.trim()).filter(Boolean).map((entry) => (
    path.isAbsolute(entry) ? path.normalize(entry) : path.resolve(workingDirectory, entry)
  ));
}

export function composeContextFromInspect(containerInspect: Record<string, any>): ComposeSnapshotContext | null {
  const labels = labelsFrom(containerInspect);
  const values = {
    project: labels[COMPOSE_LABELS.project]?.trim() ?? '',
    service: labels[COMPOSE_LABELS.service]?.trim() ?? '',
    configFiles: labels[COMPOSE_LABELS.configFiles]?.trim() ?? '',
    workingDirectory: labels[COMPOSE_LABELS.workingDirectory]?.trim() ?? '',
  };
  const composeHints = Object.values(values).filter(Boolean).length;
  if (composeHints === 0) return null;
  if (composeHints !== 4) {
    throw new DockerReconstructError('COMPOSE_CONTEXT_INVALID', 'Compose labels are partial and cannot reconstruct the original project context.');
  }
  if (labels[COMPOSE_LABELS.oneoff]?.toLowerCase() === 'true') {
    throw new DockerReconstructError('COMPOSE_CONTEXT_INVALID', 'One-off Compose containers are not eligible for managed update reconstruction.');
  }
  if (!path.isAbsolute(values.workingDirectory)) {
    throw new DockerReconstructError('COMPOSE_CONTEXT_INVALID', 'Compose working directory must resolve to an absolute remote path.');
  }
  const configFiles = splitLabelList(values.configFiles, values.workingDirectory);
  if (configFiles.length === 0) {
    throw new DockerReconstructError('COMPOSE_CONTEXT_INVALID', 'Compose snapshot has no usable configuration file path.');
  }
  const environmentFiles = splitLabelList(labels[COMPOSE_LABELS.environmentFile], values.workingDirectory);
  return {
    projectName: values.project,
    service: values.service,
    workingDirectory: path.normalize(values.workingDirectory),
    configFiles,
    environmentFiles,
  };
}

function composeBaseArgv(context: ComposeSnapshotContext): string[] {
  const argv = [
    'docker', 'compose',
    '-p', context.projectName,
    '--project-directory', context.workingDirectory,
  ];
  for (const environmentFile of context.environmentFiles) argv.push('--env-file', environmentFile);
  for (const file of context.configFiles) argv.push('-f', file);
  return argv;
}

export async function validateComposeStrategy(
  executor: ReconstructCommandExecutor,
  context: ComposeSnapshotContext,
  expectedContainerId: string,
): Promise<ValidatedComposeStrategy> {
  const version = await executor.exec(['docker', 'compose', 'version', '--short']);
  if (version.exitCode !== 0 || !version.stdout.trim()) {
    throw new DockerReconstructError('COMPOSE_UNAVAILABLE', 'Docker Compose is unavailable on the target host.');
  }

  const base = composeBaseArgv(context);
  const services = await executor.exec([...base, 'config', '--services']);
  if (services.exitCode !== 0) {
    throw new DockerReconstructError('COMPOSE_CONFIG_INVALID', 'Captured Compose configuration can no longer be validated.');
  }
  const serviceNames = services.stdout.split(/\r?\n/u).map((value) => value.trim()).filter(Boolean);
  if (!serviceNames.includes(context.service)) {
    throw new DockerReconstructError('COMPOSE_SERVICE_NOT_FOUND', 'Captured Compose service is not present in the current configuration.');
  }

  const ps = await executor.exec([...base, 'ps', '--all', '-q', context.service]);
  if (ps.exitCode !== 0) {
    throw new DockerReconstructError('COMPOSE_CONFIG_INVALID', 'Compose service container lookup failed.');
  }
  const ids = [...new Set(ps.stdout.split(/\r?\n/u).map((value) => value.trim()).filter(Boolean))];
  if (ids.length !== 1 || ids[0] !== expectedContainerId) {
    throw new DockerReconstructError('COMPOSE_CONTEXT_MISMATCH', 'Compose context does not resolve to exactly the persisted target container.');
  }

  return {
    type: 'compose',
    executable: true,
    ...context,
    composeVersion: version.stdout.trim(),
    containerId: expectedContainerId,
  };
}

function nonEmpty(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') return value !== '' && value !== 'default' && value !== 'private' && value !== 'runc';
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.values(value as Record<string, unknown>).some(nonEmpty);
  return true;
}

function pushIfMeaningful(unsupported: string[], prefix: string, object: Record<string, any>, keys: readonly string[]): void {
  for (const key of keys) if (nonEmpty(object[key])) unsupported.push(`${prefix}.${key}`);
}

function pushIf(unsupported: string[], field: string, condition: boolean): void {
  if (condition) unsupported.push(field);
}

function nonDefaultLogConfig(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const log = value as Record<string, any>;
  const type = String(log.Type ?? '').trim();
  const config = log.Config && typeof log.Config === 'object' ? log.Config : {};
  return Boolean((type && type !== 'json-file') || Object.keys(config).length > 0);
}

function nonDefaultConsoleSize(value: unknown): boolean {
  return Array.isArray(value) && value.some((entry) => Number(entry) !== 0);
}

export function analyzeStandaloneReconstruction(containerInspect: Record<string, any>): StandaloneStrategy {
  const config = containerInspect.Config && typeof containerInspect.Config === 'object' ? containerInspect.Config : {};
  const host = containerInspect.HostConfig && typeof containerInspect.HostConfig === 'object' ? containerInspect.HostConfig : {};
  const networks = containerInspect.NetworkSettings?.Networks && typeof containerInspect.NetworkSettings.Networks === 'object'
    ? containerInspect.NetworkSettings.Networks as Record<string, unknown>
    : {};
  const mounts = Array.isArray(containerInspect.Mounts) ? containerInspect.Mounts : [];
  const unsupported: string[] = [];

  // The first standalone execution adapter will deliberately support common Ollama runtime primitives:
  // image, env, labels, command/entrypoint, working directory/user, mounts, port bindings,
  // restart policy and one network. Everything else with recreate impact must be explicit here.
  pushIfMeaningful(unsupported, 'HostConfig', host, [
    'Privileged', 'CapAdd', 'CapDrop', 'SecurityOpt', 'Sysctls', 'Ulimits', 'Tmpfs',
    'ReadonlyRootfs', 'AutoRemove', 'Links', 'VolumesFrom', 'ExtraHosts', 'Dns', 'DnsOptions',
    'DnsSearch', 'GroupAdd', 'DeviceRequests', 'Devices', 'DeviceCgroupRules', 'Memory', 'MemorySwap',
    'MemoryReservation', 'NanoCpus', 'CpuShares', 'CpusetCpus', 'CpusetMems', 'OomKillDisable',
    'PidsLimit', 'BlkioWeight', 'PidMode', 'IpcMode', 'UTSMode', 'UsernsMode', 'CgroupnsMode',
    'CgroupParent',
  ]);
  pushIf(unsupported, 'HostConfig.ShmSize', Number(host.ShmSize ?? DEFAULT_SHM_SIZE) !== DEFAULT_SHM_SIZE);
  pushIf(unsupported, 'HostConfig.Runtime', Boolean(String(host.Runtime ?? '').trim()) && String(host.Runtime).trim() !== 'runc');
  pushIf(unsupported, 'HostConfig.Init', host.Init === true);
  pushIf(unsupported, 'HostConfig.OomScoreAdj', Number(host.OomScoreAdj ?? 0) !== 0);
  pushIf(unsupported, 'HostConfig.PublishAllPorts', host.PublishAllPorts === true);
  pushIf(unsupported, 'HostConfig.Isolation', Boolean(String(host.Isolation ?? '').trim()) && String(host.Isolation).trim() !== 'default');
  pushIf(unsupported, 'HostConfig.ConsoleSize', nonDefaultConsoleSize(host.ConsoleSize));
  pushIf(unsupported, 'HostConfig.LogConfig', nonDefaultLogConfig(host.LogConfig));

  pushIfMeaningful(unsupported, 'Config', config, [
    'Healthcheck', 'StopSignal', 'StopTimeout', 'Shell', 'OnBuild', 'MacAddress',
  ]);
  pushIf(unsupported, 'Config.Tty', config.Tty === true);
  pushIf(unsupported, 'Config.OpenStdin', config.OpenStdin === true);
  pushIf(unsupported, 'Config.StdinOnce', config.StdinOnce === true);
  pushIf(unsupported, 'Config.Domainname', Boolean(String(config.Domainname ?? '').trim()));

  const containerId = String(containerInspect.Id ?? '');
  const hostname = String(config.Hostname ?? '').trim();
  const defaultHostname = containerId ? containerId.slice(0, 12) : '';
  pushIf(unsupported, 'Config.Hostname', Boolean(hostname) && (!defaultHostname || hostname !== defaultHostname));

  if (Object.keys(networks).length > 1) unsupported.push('NetworkSettings.Networks.multiple');
  for (const mount of mounts) {
    const type = String(mount?.Type ?? '');
    if (type && type !== 'bind' && type !== 'volume') unsupported.push(`Mounts.type:${type}`);
  }

  return {
    type: 'standalone',
    executable: unsupported.length === 0,
    unsupportedFields: [...new Set(unsupported)].sort(),
    summary: {
      environmentCount: Array.isArray(config.Env) ? config.Env.length : 0,
      labelCount: config.Labels && typeof config.Labels === 'object' ? Object.keys(config.Labels).length : 0,
      mountCount: mounts.length,
      portBindingCount: host.PortBindings && typeof host.PortBindings === 'object' ? Object.keys(host.PortBindings).length : 0,
      networkNames: Object.keys(networks).sort(),
      restartPolicy: String(host.RestartPolicy?.Name ?? ''),
      hasCommandOverride: Array.isArray(config.Cmd) ? config.Cmd.length > 0 : Boolean(config.Cmd),
      hasEntrypointOverride: Array.isArray(config.Entrypoint) ? config.Entrypoint.length > 0 : Boolean(config.Entrypoint),
    },
  };
}
