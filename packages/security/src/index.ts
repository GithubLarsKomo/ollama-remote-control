import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { EncryptedSecret } from '@orc/core';

const ALGORITHM = 'aes-256-gcm' as const;
const KEY_LENGTH = 32;
const NONCE_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

export class MasterKeyError extends Error {}

function decodeCanonicalBase64(value: string): Buffer {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9+/]{43}=$/u.test(normalized)) {
    throw new MasterKeyError('Master key must be canonical Base64 for exactly 32 bytes.');
  }
  const key = Buffer.from(normalized, 'base64');
  if (key.length !== KEY_LENGTH || key.toString('base64') !== normalized) {
    throw new MasterKeyError('Master key must decode to exactly 32 bytes.');
  }
  return key;
}

export interface MasterKeyEnvironment {
  readonly ORC_MASTER_KEY_FILE?: string;
  readonly ORC_MASTER_KEY?: string;
}

export interface SecretContext {
  readonly credentialId: string;
  readonly hostId: string;
}

export interface UpdateSnapshotContext {
  readonly snapshotId: string;
  readonly targetId: string;
}

export function loadConfiguredMasterKey(
  environment: MasterKeyEnvironment = process.env,
): Buffer | null {
  if (environment.ORC_MASTER_KEY_FILE) {
    return decodeCanonicalBase64(readFileSync(environment.ORC_MASTER_KEY_FILE, 'utf8'));
  }
  if (environment.ORC_MASTER_KEY) {
    return decodeCanonicalBase64(environment.ORC_MASTER_KEY);
  }
  return null;
}

function secretAad(context: SecretContext, keyVersion: number): Buffer {
  return Buffer.from(
    `ollama-remote-control:ssh-credential:${keyVersion}:${context.hostId}:${context.credentialId}`,
    'utf8',
  );
}

function snapshotAad(context: UpdateSnapshotContext, keyVersion: number): Buffer {
  return Buffer.from(
    `ollama-remote-control:update-snapshot:${keyVersion}:${context.targetId}:${context.snapshotId}`,
    'utf8',
  );
}

function validateSecretContext(context: SecretContext): void {
  if (!context.credentialId) throw new Error('Credential ID is required.');
  if (!context.hostId) throw new Error('Host ID is required.');
}

function validateSnapshotContext(context: UpdateSnapshotContext): void {
  if (!context.snapshotId) throw new Error('Snapshot ID is required.');
  if (!context.targetId) throw new Error('Target ID is required.');
}

function validateMasterKey(masterKey: Buffer, keyVersion: number): Buffer {
  if (masterKey.length !== KEY_LENGTH) {
    throw new MasterKeyError('Master key must contain exactly 32 bytes.');
  }
  if (!Number.isInteger(keyVersion) || keyVersion < 1) {
    throw new MasterKeyError('Key version must be a positive integer.');
  }
  return Buffer.from(masterKey);
}

function encryptAuthenticated(
  key: Buffer,
  keyVersion: number,
  aad: Buffer,
  plaintext: string,
): EncryptedSecret {
  if (!plaintext) throw new Error('Encrypted plaintext must not be empty.');
  const nonce = randomBytes(NONCE_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, nonce, { authTagLength: AUTH_TAG_LENGTH });
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    algorithm: ALGORITHM,
    keyVersion,
    nonce: nonce.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
  };
}

function decryptAuthenticated(
  key: Buffer,
  keyVersion: number,
  aad: Buffer,
  encrypted: EncryptedSecret,
): string {
  if (encrypted.algorithm !== ALGORITHM) {
    throw new Error(`Unsupported secret algorithm: ${encrypted.algorithm}`);
  }
  if (encrypted.keyVersion !== keyVersion) {
    throw new Error(`Unsupported secret key version: ${encrypted.keyVersion}`);
  }
  const nonce = Buffer.from(encrypted.nonce, 'base64');
  const ciphertext = Buffer.from(encrypted.ciphertext, 'base64');
  const authTag = Buffer.from(encrypted.authTag, 'base64');
  if (nonce.length !== NONCE_LENGTH || authTag.length !== AUTH_TAG_LENGTH) {
    throw new Error('Encrypted secret metadata is malformed.');
  }
  const decipher = createDecipheriv(ALGORITHM, key, nonce, { authTagLength: AUTH_TAG_LENGTH });
  decipher.setAAD(aad);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString('utf8');
}

export class SecretCipher {
  private readonly key: Buffer;

  constructor(masterKey: Buffer, private readonly keyVersion = 1) {
    this.key = validateMasterKey(masterKey, keyVersion);
  }

  encrypt(context: SecretContext, plaintext: string): EncryptedSecret {
    validateSecretContext(context);
    return encryptAuthenticated(this.key, this.keyVersion, secretAad(context, this.keyVersion), plaintext);
  }

  decrypt(context: SecretContext, encrypted: EncryptedSecret): string {
    validateSecretContext(context);
    return decryptAuthenticated(this.key, this.keyVersion, secretAad(context, encrypted.keyVersion), encrypted);
  }
}

export class UpdateSnapshotCipher {
  private readonly key: Buffer;

  constructor(masterKey: Buffer, private readonly keyVersion = 1) {
    this.key = validateMasterKey(masterKey, keyVersion);
  }

  encrypt(context: UpdateSnapshotContext, plaintext: string): EncryptedSecret {
    validateSnapshotContext(context);
    return encryptAuthenticated(this.key, this.keyVersion, snapshotAad(context, this.keyVersion), plaintext);
  }

  decrypt(context: UpdateSnapshotContext, encrypted: EncryptedSecret): string {
    validateSnapshotContext(context);
    return decryptAuthenticated(this.key, this.keyVersion, snapshotAad(context, encrypted.keyVersion), encrypted);
  }
}
