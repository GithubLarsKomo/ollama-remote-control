import type { RemoteExecResult } from '@orc/core';
import type { ComposeSnapshotContext } from './reconstruct.js';

export type ComposeIntentErrorCode =
  | 'INVALID_IMAGE_REFERENCE'
  | 'INVALID_IMAGE_DIGEST'
  | 'COMPOSE_PIN_VALIDATION_FAILED'
  | 'COMPOSE_PIN_MISMATCH';

export class ComposeIntentError extends Error {
  constructor(readonly code: ComposeIntentErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

export interface ComposeInputExecutor {
  exec(argv: readonly string[], stdin: string): Promise<RemoteExecResult>;
}

function stripTagAndDigest(imageReference: string): string {
  const withoutDigest = imageReference.split('@', 1)[0].trim();
  const slash = withoutDigest.lastIndexOf('/');
  const colon = withoutDigest.lastIndexOf(':');
  return colon > slash ? withoutDigest.slice(0, colon) : withoutDigest;
}

function canonicalRepository(repository: string): string {
  const value = repository.trim().toLowerCase();
  if (!value) return '';
  const parts = value.split('/');
  const first = parts[0];
  const explicitRegistry = first.includes('.') || first.includes(':') || first === 'localhost';
  if (!explicitRegistry) {
    if (parts.length === 1) return `docker.io/library/${parts[0]}`;
    return `docker.io/${parts.join('/')}`;
  }
  const registry = first === 'index.docker.io' ? 'docker.io' : first;
  const remainder = parts.slice(1);
  if (registry === 'docker.io' && remainder.length === 1) remainder.unshift('library');
  return `${registry}/${remainder.join('/')}`;
}

function validDigest(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  const separator = normalized.indexOf(':');
  if (separator < 1) return false;
  const algorithm = normalized.slice(0, separator);
  const encoded = normalized.slice(separator + 1);
  if (!/^[a-z0-9]+(?:[+._-][a-z0-9]+)*$/u.test(algorithm)) return false;
  if (algorithm === 'sha256') return /^[0-9a-f]{64}$/u.test(encoded);
  return /^[a-z0-9=_-]{16,}$/u.test(encoded);
}

function digestParts(reference: string): { repository: string; digest: string } | null {
  const separator = reference.lastIndexOf('@');
  if (separator < 1) return null;
  const repository = canonicalRepository(reference.slice(0, separator));
  const digest = reference.slice(separator + 1).trim().toLowerCase();
  return repository && validDigest(digest) ? { repository, digest } : null;
}

export function exactDigestImageReference(imageReference: string, digest: string): string {
  const repository = stripTagAndDigest(imageReference);
  if (!repository || /\s/u.test(repository)) {
    throw new ComposeIntentError('INVALID_IMAGE_REFERENCE', 'Snapshot image reference cannot be converted to an exact repository reference.');
  }
  const normalizedDigest = digest.trim().toLowerCase();
  if (!validDigest(normalizedDigest)) {
    throw new ComposeIntentError('INVALID_IMAGE_DIGEST', 'Registry candidate digest is not valid for executable image pinning.');
  }
  return `${repository}@${normalizedDigest}`;
}

export function isExactDigestImageReference(reference: string): boolean {
  return digestParts(reference) !== null;
}

export function sameExactImageReference(actual: string, expected: string): boolean {
  const left = digestParts(actual);
  const right = digestParts(expected);
  return Boolean(left && right && left.repository === right.repository && left.digest === right.digest);
}

export function composeDigestOverrideJson(service: string, exactImageReference: string): string {
  if (!service.trim() || service.length > 200) {
    throw new ComposeIntentError('COMPOSE_PIN_VALIDATION_FAILED', 'Compose service name is invalid.');
  }
  if (!isExactDigestImageReference(exactImageReference)) {
    throw new ComposeIntentError('INVALID_IMAGE_REFERENCE', 'Exact image reference must contain a valid digest.');
  }
  return `${JSON.stringify({ services: { [service]: { image: exactImageReference } } })}\n`;
}

export function composeContextArgv(context: ComposeSnapshotContext, includeStdinOverride = false): string[] {
  const argv = [
    'docker', 'compose',
    '-p', context.projectName,
    '--project-directory', context.workingDirectory,
  ];
  for (const environmentFile of context.environmentFiles) argv.push('--env-file', environmentFile);
  for (const file of context.configFiles) argv.push('-f', file);
  if (includeStdinOverride) argv.push('-f', '-');
  return argv;
}

export async function validateComposeDigestOverride(
  executor: ComposeInputExecutor,
  context: ComposeSnapshotContext,
  exactImageReference: string,
): Promise<{ readonly exactImageReference: string; readonly overrideJson: string }> {
  const overrideJson = composeDigestOverrideJson(context.service, exactImageReference);
  const result = await executor.exec(
    [...composeContextArgv(context, true), 'config', '--images', context.service],
    overrideJson,
  );
  if (result.exitCode !== 0) {
    throw new ComposeIntentError('COMPOSE_PIN_VALIDATION_FAILED', 'Digest-pinned Compose override could not be validated.');
  }
  const images = [...new Set(result.stdout.split(/\r?\n/u).map((value) => value.trim()).filter(Boolean))];
  if (images.length !== 1 || !sameExactImageReference(images[0], exactImageReference)) {
    throw new ComposeIntentError('COMPOSE_PIN_MISMATCH', 'Compose did not resolve the service to the intended digest-pinned image.');
  }
  return { exactImageReference, overrideJson };
}
