import type {
  HostOnboardingRepository,
  OllamaTargetRepository,
  SshCredentialRepository,
} from '@orc/core';
import { SecretCipher } from '@orc/security';
import {
  streamPrivateKey,
  type SshCommandStream,
  type SshPrivateKeyConnection,
} from '@orc/ssh';

export const DEFAULT_LOG_TAIL = 100;
export const MAX_LOG_TAIL = 1000;

export class TargetLogError extends Error {
  constructor(
    readonly code: string,
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

export function parseLogTail(value: unknown): number {
  if (value === undefined || value === null || value === '') return DEFAULT_LOG_TAIL;
  if (typeof value !== 'string' || !/^\d{1,4}$/u.test(value)) {
    throw new TargetLogError('INVALID_LOG_TAIL', 400, `Log tail must be an integer from 0 to ${MAX_LOG_TAIL}.`);
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > MAX_LOG_TAIL) {
    throw new TargetLogError('INVALID_LOG_TAIL', 400, `Log tail must be an integer from 0 to ${MAX_LOG_TAIL}.`);
  }
  return parsed;
}

export class TargetLogService {
  constructor(
    private readonly hosts: HostOnboardingRepository,
    private readonly credentials: SshCredentialRepository,
    private readonly targets: OllamaTargetRepository,
    private readonly masterKey: Buffer | null,
  ) {}

  private connectionForTarget(targetId: string): { connection: SshPrivateKeyConnection; containerId: string } {
    if (!this.masterKey) {
      throw new TargetLogError(
        'MASTER_KEY_REQUIRED',
        503,
        'External master key is required to use stored SSH credentials.',
      );
    }
    const target = this.targets.findById(targetId);
    if (!target || !target.enabled) {
      throw new TargetLogError('TARGET_NOT_FOUND', 404, 'Ollama target was not found or is disabled.');
    }
    const host = this.hosts.findHostById(target.hostId);
    if (!host || !host.enabled) {
      throw new TargetLogError('HOST_NOT_FOUND', 404, 'Host was not found or is disabled.');
    }
    const credential = this.credentials.findByHostId(host.id);
    if (!credential) {
      throw new TargetLogError('SSH_CREDENTIAL_NOT_FOUND', 409, 'Host has no SSH credential.');
    }
    const privateKey = new SecretCipher(this.masterKey).decrypt(
      { credentialId: credential.id, hostId: host.id },
      credential.encryptedPrivateKey,
    );
    return {
      containerId: target.selectedContainerId,
      connection: {
        hostname: host.hostname,
        port: host.port,
        username: host.username,
        privateKey,
        expectedFingerprint: host.hostKeyFingerprint,
      },
    };
  }

  async open(targetId: string, tail: number): Promise<SshCommandStream> {
    if (!Number.isInteger(tail) || tail < 0 || tail > MAX_LOG_TAIL) {
      throw new TargetLogError('INVALID_LOG_TAIL', 400, `Log tail must be an integer from 0 to ${MAX_LOG_TAIL}.`);
    }
    const { connection, containerId } = this.connectionForTarget(targetId);
    return await streamPrivateKey(
      connection,
      ['docker', 'logs', '--follow', '--timestamps', '--tail', String(tail), containerId],
      { startupTimeoutMs: 10_000 },
    );
  }
}
