import type {
  HostOnboardingRepository,
  OllamaTargetRepository,
  SshCredentialRepository,
} from '@orc/core';
import {
  inspectDockerContainer,
  type DockerContainerStatus,
  type DockerMount,
} from '@orc/docker';
import { SecretCipher } from '@orc/security';
import { execPrivateKey, type SshPrivateKeyConnection } from '@orc/ssh';

export class TargetStatusError extends Error {
  constructor(
    readonly code: string,
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

export interface OllamaEnvironmentValue {
  readonly name: string;
  readonly value: string | null;
  readonly redacted: boolean;
}

export interface OllamaVersionCapability {
  readonly available: boolean;
  readonly version: string | null;
  readonly errorClass: string | null;
}

export interface GpuDeviceStatus {
  readonly name: string;
  readonly driverVersion: string;
  readonly utilizationPercent: number | null;
  readonly memoryTotalMiB: number | null;
  readonly memoryUsedMiB: number | null;
  readonly memoryFreeMiB: number | null;
  readonly temperatureC: number | null;
}

export interface GpuCapability {
  readonly available: boolean;
  readonly devices: readonly GpuDeviceStatus[];
  readonly errorClass: string | null;
}

export interface DiskUsage {
  readonly totalKiB: number;
  readonly usedKiB: number;
  readonly availableKiB: number;
  readonly capacityPercent: number;
  readonly mountedOn: string;
}

export interface ModelStorageCapability {
  readonly available: boolean;
  readonly mount: DockerMount | null;
  readonly disk: DiskUsage | null;
  readonly errorClass: string | null;
}

export interface TargetStatusSnapshot {
  readonly target: {
    readonly id: string;
    readonly displayName: string;
    readonly hostId: string;
    readonly selectedContainerId: string;
  };
  readonly container: DockerContainerStatus;
  readonly ollama: OllamaVersionCapability;
  readonly environment: readonly OllamaEnvironmentValue[];
  readonly gpu: GpuCapability;
  readonly modelStorage: ModelStorageCapability;
}

const SENSITIVE_ENV = /(token|secret|password|credential|api.?key|auth)/iu;

function maskOllamaEnvironment(values: readonly string[]): OllamaEnvironmentValue[] {
  return values
    .map((entry) => {
      const separator = entry.indexOf('=');
      const name = separator >= 0 ? entry.slice(0, separator) : entry;
      const value = separator >= 0 ? entry.slice(separator + 1) : '';
      return { name, value };
    })
    .filter((entry) => entry.name.startsWith('OLLAMA_'))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((entry) => {
      const redacted = SENSITIVE_ENV.test(entry.name);
      return {
        name: entry.name,
        value: redacted ? null : entry.value,
        redacted,
      };
    });
}

function parseNumber(value: string): number | null {
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function selectModelStorageMount(mounts: readonly DockerMount[]): DockerMount | null {
  return mounts.find((mount) => mount.destination === '/root/.ollama')
    ?? mounts.find((mount) => mount.destination.toLowerCase().includes('.ollama'))
    ?? mounts.find((mount) => mount.source.toLowerCase().includes('ollama'))
    ?? null;
}

async function readOllamaVersion(
  connection: SshPrivateKeyConnection,
  containerId: string,
  running: boolean,
): Promise<OllamaVersionCapability> {
  if (!running) {
    return { available: false, version: null, errorClass: 'CONTAINER_NOT_RUNNING' };
  }
  try {
    const result = await execPrivateKey(
      connection,
      ['docker', 'exec', containerId, 'ollama', '--version'],
      { timeoutMs: 10_000, maxOutputBytes: 256 * 1024 },
    );
    if (result.exitCode !== 0) {
      return { available: false, version: null, errorClass: 'OLLAMA_CLI_ERROR' };
    }
    const output = `${result.stdout}\n${result.stderr}`.trim();
    const match = output.match(/\b\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\b/u);
    return {
      available: true,
      version: match?.[0] ?? output || null,
      errorClass: null,
    };
  } catch {
    return { available: false, version: null, errorClass: 'OLLAMA_CLI_ERROR' };
  }
}

async function readGpu(connection: SshPrivateKeyConnection): Promise<GpuCapability> {
  try {
    const result = await execPrivateKey(connection, [
      'nvidia-smi',
      '--query-gpu=name,driver_version,utilization.gpu,memory.total,memory.used,memory.free,temperature.gpu',
      '--format=csv,noheader,nounits',
    ], { timeoutMs: 10_000, maxOutputBytes: 1024 * 1024 });
    if (result.exitCode !== 0 || !result.stdout.trim()) {
      return { available: false, devices: [], errorClass: 'GPU_UNAVAILABLE' };
    }
    const devices = result.stdout.trim().split(/\r?\n/u).map((line) => {
      const fields = line.split(',').map((value) => value.trim());
      return {
        name: fields[0] ?? '',
        driverVersion: fields[1] ?? '',
        utilizationPercent: parseNumber(fields[2] ?? ''),
        memoryTotalMiB: parseNumber(fields[3] ?? ''),
        memoryUsedMiB: parseNumber(fields[4] ?? ''),
        memoryFreeMiB: parseNumber(fields[5] ?? ''),
        temperatureC: parseNumber(fields[6] ?? ''),
      };
    });
    return { available: true, devices, errorClass: null };
  } catch {
    return { available: false, devices: [], errorClass: 'GPU_UNAVAILABLE' };
  }
}

function parseDf(stdout: string): DiskUsage | null {
  const lines = stdout.trim().split(/\r?\n/u).filter(Boolean);
  const line = lines.at(-1);
  if (!line) return null;
  const match = line.match(/^\S+\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)%\s+(.+)$/u);
  if (!match) return null;
  return {
    totalKiB: Number(match[1]),
    usedKiB: Number(match[2]),
    availableKiB: Number(match[3]),
    capacityPercent: Number(match[4]),
    mountedOn: match[5],
  };
}

async function readModelStorage(
  connection: SshPrivateKeyConnection,
  mounts: readonly DockerMount[],
): Promise<ModelStorageCapability> {
  const mount = selectModelStorageMount(mounts);
  if (!mount) {
    return { available: false, mount: null, disk: null, errorClass: 'MODEL_STORAGE_NOT_FOUND' };
  }
  if (!mount.source.startsWith('/')) {
    return { available: false, mount, disk: null, errorClass: 'MODEL_STORAGE_DISK_UNAVAILABLE' };
  }
  try {
    const result = await execPrivateKey(
      connection,
      ['df', '-Pk', mount.source],
      { timeoutMs: 10_000, maxOutputBytes: 256 * 1024 },
    );
    const disk = result.exitCode === 0 ? parseDf(result.stdout) : null;
    if (!disk) {
      return { available: false, mount, disk: null, errorClass: 'MODEL_STORAGE_DISK_UNAVAILABLE' };
    }
    return { available: true, mount, disk, errorClass: null };
  } catch {
    return { available: false, mount, disk: null, errorClass: 'MODEL_STORAGE_DISK_UNAVAILABLE' };
  }
}

export class TargetStatusService {
  constructor(
    private readonly hosts: HostOnboardingRepository,
    private readonly credentials: SshCredentialRepository,
    private readonly targets: OllamaTargetRepository,
    private readonly masterKey: Buffer | null,
  ) {}

  private connectionForTarget(targetId: string) {
    if (!this.masterKey) {
      throw new TargetStatusError(
        'MASTER_KEY_REQUIRED',
        503,
        'External master key is required to use stored SSH credentials.',
      );
    }
    const target = this.targets.findById(targetId);
    if (!target || !target.enabled) {
      throw new TargetStatusError('TARGET_NOT_FOUND', 404, 'Ollama target was not found or is disabled.');
    }
    const host = this.hosts.findHostById(target.hostId);
    if (!host || !host.enabled) {
      throw new TargetStatusError('HOST_NOT_FOUND', 404, 'Host was not found or is disabled.');
    }
    const credential = this.credentials.findByHostId(host.id);
    if (!credential) {
      throw new TargetStatusError('SSH_CREDENTIAL_NOT_FOUND', 409, 'Host has no SSH credential.');
    }
    const privateKey = new SecretCipher(this.masterKey).decrypt(
      { credentialId: credential.id, hostId: host.id },
      credential.encryptedPrivateKey,
    );
    return {
      target,
      connection: {
        hostname: host.hostname,
        port: host.port,
        username: host.username,
        privateKey,
        expectedFingerprint: host.hostKeyFingerprint,
      } satisfies SshPrivateKeyConnection,
    };
  }

  async read(targetId: string): Promise<TargetStatusSnapshot> {
    const { target, connection } = this.connectionForTarget(targetId);
    const executor = {
      exec: (argv: readonly string[]) => execPrivateKey(connection, argv, { timeoutMs: 15_000 }),
    };
    const container = await inspectDockerContainer(executor, target.selectedContainerId);
    const [ollama, gpu, modelStorage] = await Promise.all([
      readOllamaVersion(connection, target.selectedContainerId, container.running),
      readGpu(connection),
      readModelStorage(connection, container.mounts),
    ]);
    return {
      target: {
        id: target.id,
        displayName: target.displayName,
        hostId: target.hostId,
        selectedContainerId: target.selectedContainerId,
      },
      container,
      ollama,
      environment: maskOllamaEnvironment(container.env),
      gpu,
      modelStorage,
    };
  }
}
