import { randomUUID } from 'node:crypto';
import type {
  HostKeyObservation,
  HostOnboardingRepository,
  StoredHost,
} from '@orc/core';
import { SecretCipher } from '@orc/security';
import {
  probeHostKey,
  verifyPrivateKeyAccess,
} from '@orc/ssh';

const MAX_PRIVATE_KEY_LENGTH = 256 * 1024;

export class HostOnboardingError extends Error {
  constructor(
    readonly code: string,
    readonly statusCode: number,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export interface HostProbeInput {
  readonly hostname: string;
  readonly port?: number;
}

export interface HostCreateInput extends HostProbeInput {
  readonly displayName: string;
  readonly username: string;
  readonly confirmedFingerprint: string;
  readonly privateKey: string;
}

function hostname(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 253 || /\s/u.test(normalized)) {
    throw new HostOnboardingError('INVALID_HOST', 400, 'SSH hostname is invalid.');
  }
  return normalized;
}

function port(value: number | undefined): number {
  const normalized = value ?? 22;
  if (!Number.isInteger(normalized) || normalized < 1 || normalized > 65535) {
    throw new HostOnboardingError('INVALID_HOST', 400, 'SSH port is invalid.');
  }
  return normalized;
}

function displayName(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 120) {
    throw new HostOnboardingError('INVALID_HOST', 400, 'Host display name is invalid.');
  }
  return normalized;
}

function username(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 128 || /[\u0000\r\n]/u.test(normalized)) {
    throw new HostOnboardingError('INVALID_HOST', 400, 'SSH username is invalid.');
  }
  return normalized;
}

function privateKey(value: string): string {
  if (!value || value.length > MAX_PRIVATE_KEY_LENGTH || /\u0000/u.test(value)) {
    throw new HostOnboardingError('INVALID_SSH_KEY', 400, 'SSH private key is invalid.');
  }
  return value;
}

function confirmedFingerprint(value: string): string {
  const normalized = value.trim();
  if (!/^SHA256:[A-Za-z0-9+/]{43}$/u.test(normalized)) {
    throw new HostOnboardingError(
      'INVALID_HOST_KEY_FINGERPRINT',
      400,
      'Confirmed SSH host-key fingerprint is invalid.',
    );
  }
  return normalized;
}

export class HostOnboardingService {
  constructor(
    private readonly repository: HostOnboardingRepository,
    private readonly masterKey: Buffer | null,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async probe(input: HostProbeInput): Promise<HostKeyObservation> {
    return probeHostKey({
      hostname: hostname(input.hostname),
      port: port(input.port),
    });
  }

  async create(input: HostCreateInput): Promise<StoredHost & { hostKeyAlgorithm: string }> {
    if (!this.masterKey) {
      throw new HostOnboardingError(
        'MASTER_KEY_REQUIRED',
        503,
        'An external master key is required before SSH credentials can be stored.',
      );
    }

    const targetHostname = hostname(input.hostname);
    const targetPort = port(input.port);
    const targetUsername = username(input.username);
    const targetDisplayName = displayName(input.displayName);
    const expectedFingerprint = confirmedFingerprint(input.confirmedFingerprint);
    const key = privateKey(input.privateKey);

    const observed = await probeHostKey({
      hostname: targetHostname,
      port: targetPort,
    });
    if (observed.fingerprint !== expectedFingerprint) {
      throw new HostOnboardingError(
        'SSH_HOST_KEY_MISMATCH',
        409,
        'SSH host key changed after confirmation; host was not stored.',
      );
    }

    await verifyPrivateKeyAccess({
      hostname: targetHostname,
      port: targetPort,
      username: targetUsername,
      privateKey: key,
      expectedFingerprint,
    });

    const hostId = randomUUID();
    const credentialId = randomUUID();
    const timestamp = this.now().toISOString();
    const host: StoredHost = {
      id: hostId,
      displayName: targetDisplayName,
      hostname: targetHostname,
      port: targetPort,
      username: targetUsername,
      hostKeyFingerprint: expectedFingerprint,
      enabled: true,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const encryptedPrivateKey = new SecretCipher(this.masterKey).encrypt(
      { credentialId, hostId },
      key,
    );

    if (!this.repository.createHostWithCredential(host, {
      id: credentialId,
      hostId,
      encryptedPrivateKey,
      createdAt: timestamp,
      updatedAt: timestamp,
    })) {
      throw new HostOnboardingError(
        'HOST_ALREADY_EXISTS',
        409,
        'A host with the same hostname, port and username already exists.',
      );
    }

    return { ...host, hostKeyAlgorithm: observed.algorithm };
  }
}
