import { randomUUID } from 'node:crypto';
import type {
  HostOnboardingRepository,
  OllamaTargetRepository,
  SshCredentialRepository,
  StoredOllamaTarget,
} from '@orc/core';
import {
  discoverOllamaContainers,
  DockerDiscoveryError,
  type DockerDiscoveryResult,
} from '@orc/docker';
import { SecretCipher } from '@orc/security';
import { execPrivateKey, SshTransportError } from '@orc/ssh';

export class TargetDiscoveryError extends Error {
  constructor(
    readonly code: string,
    readonly statusCode: number,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export function safeDockerDiscoveryError(error: DockerDiscoveryError): TargetDiscoveryError {
  if (error.code === 'CONTAINER_NOT_FOUND') {
    return new TargetDiscoveryError(
      error.code,
      404,
      'Docker container was not found during discovery.',
      { cause: error },
    );
  }
  if (error.code === 'DOCKER_OUTPUT_INVALID') {
    return new TargetDiscoveryError(
      error.code,
      502,
      'Docker discovery returned invalid data.',
      { cause: error },
    );
  }
  return new TargetDiscoveryError(
    error.code,
    502,
    'Docker is unavailable on the remote host.',
    { cause: error },
  );
}

export class TargetDiscoveryService {
  constructor(
    private readonly hosts: HostOnboardingRepository,
    private readonly credentials: SshCredentialRepository,
    private readonly targets: OllamaTargetRepository,
    private readonly masterKey: Buffer | null,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private connectionForHost(hostId: string) {
    if (!this.masterKey) {
      throw new TargetDiscoveryError(
        'MASTER_KEY_REQUIRED',
        503,
        'External master key is required to use stored SSH credentials.',
      );
    }
    const host = this.hosts.findHostById(hostId);
    if (!host || !host.enabled) {
      throw new TargetDiscoveryError('HOST_NOT_FOUND', 404, 'Host was not found or is disabled.');
    }
    const credential = this.credentials.findByHostId(hostId);
    if (!credential) {
      throw new TargetDiscoveryError('SSH_CREDENTIAL_NOT_FOUND', 409, 'Host has no SSH credential.');
    }
    const privateKey = new SecretCipher(this.masterKey).decrypt(
      { credentialId: credential.id, hostId },
      credential.encryptedPrivateKey,
    );
    return {
      host,
      connection: {
        hostname: host.hostname,
        port: host.port,
        username: host.username,
        privateKey,
        expectedFingerprint: host.hostKeyFingerprint,
      },
    };
  }

  async discover(hostId: string): Promise<DockerDiscoveryResult> {
    const { connection } = this.connectionForHost(hostId);
    try {
      return await discoverOllamaContainers({
        exec: (argv) => execPrivateKey(connection, argv, { timeoutMs: 15_000 }),
      });
    } catch (error) {
      if (error instanceof DockerDiscoveryError) throw safeDockerDiscoveryError(error);
      if (error instanceof SshTransportError) throw error;
      throw new TargetDiscoveryError('DOCKER_UNAVAILABLE', 502, 'Docker discovery failed.', { cause: error as Error });
    }
  }

  async select(hostId: string, containerId: string, displayName?: string): Promise<StoredOllamaTarget> {
    if (!containerId || containerId.length > 128) {
      throw new TargetDiscoveryError('CONTAINER_NOT_FOUND', 404, 'Docker container was not found.');
    }
    const discovery = await this.discover(hostId);
    const candidate = discovery.candidates.find((item) => item.id === containerId);
    if (!candidate) {
      throw new TargetDiscoveryError(
        'CONTAINER_NOT_FOUND',
        404,
        'Selected Docker container is not a current Ollama discovery candidate.',
      );
    }
    const normalizedName = displayName?.trim() || candidate.name || candidate.id.slice(0, 12);
    if (normalizedName.length > 120) {
      throw new TargetDiscoveryError('INVALID_TARGET', 400, 'Target display name is too long.');
    }
    const timestamp = this.now().toISOString();
    const target: StoredOllamaTarget = {
      id: randomUUID(),
      hostId,
      displayName: normalizedName,
      selectedContainerId: candidate.id,
      containerNameOverride: null,
      enabled: true,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.targets.saveSelection(target);

    const persisted = this.targets
      .findByHostId(hostId)
      .find((item) => item.selectedContainerId === candidate.id);
    if (!persisted) {
      throw new TargetDiscoveryError(
        'TARGET_PERSIST_FAILED',
        500,
        'Ollama target selection could not be read back after persistence.',
      );
    }
    return persisted;
  }
}
