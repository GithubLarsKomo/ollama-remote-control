import type { RemoteExecResult } from '@orc/core';

export type DockerRegistryErrorCode =
  | 'REGISTRY_LOOKUP_UNAVAILABLE'
  | 'IMAGE_REGISTRY_LOOKUP_FAILED'
  | 'REGISTRY_OUTPUT_INVALID'
  | 'IMAGE_PLATFORM_NOT_FOUND';

export class DockerRegistryError extends Error {
  constructor(readonly code: DockerRegistryErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

export interface RegistryCommandExecutor {
  exec(argv: readonly string[]): Promise<RemoteExecResult>;
}

export interface DockerImagePlatform {
  readonly os: string;
  readonly architecture: string;
  readonly variant: string | null;
}

export interface DockerRegistryCandidate {
  readonly imageReference: string;
  readonly indexDigest: string | null;
  readonly platformDigest: string;
  readonly platform: DockerImagePlatform;
  readonly version: string | null;
}

interface ManifestDescriptor {
  readonly digest?: unknown;
  readonly manifests?: unknown;
  readonly platform?: unknown;
}

function parseJsonObject(stdout: string, subject: string): Record<string, any> {
  try {
    const parsed = JSON.parse(stdout.trim());
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    return parsed as Record<string, any>;
  } catch (error) {
    throw new DockerRegistryError('REGISTRY_OUTPUT_INVALID', `${subject} returned invalid JSON.`, { cause: error as Error });
  }
}

function normalizedVariant(value: unknown): string | null {
  const normalized = String(value ?? '').trim();
  return normalized || null;
}

function samePlatform(candidate: Record<string, any>, platform: DockerImagePlatform): boolean {
  return String(candidate.os ?? '') === platform.os
    && String(candidate.architecture ?? '') === platform.architecture
    && normalizedVariant(candidate.variant) === normalizedVariant(platform.variant);
}

function repositoryFromImageReference(imageReference: string): string {
  const withoutDigest = imageReference.split('@', 1)[0];
  const slash = withoutDigest.lastIndexOf('/');
  const colon = withoutDigest.lastIndexOf(':');
  return colon > slash ? withoutDigest.slice(0, colon) : withoutDigest;
}

function candidateVersion(image: Record<string, any>): string | null {
  const labels = image.config?.Labels && typeof image.config.Labels === 'object'
    ? image.config.Labels as Record<string, unknown>
    : {};
  const value = labels['org.opencontainers.image.version'];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export async function inspectDockerRegistryCandidate(
  executor: RegistryCommandExecutor,
  imageReference: string,
  platform: DockerImagePlatform,
): Promise<DockerRegistryCandidate> {
  const buildx = await executor.exec(['docker', 'buildx', 'version']);
  if (buildx.exitCode !== 0) {
    throw new DockerRegistryError('REGISTRY_LOOKUP_UNAVAILABLE', 'Docker Buildx registry inspection is unavailable on the target host.');
  }

  const manifestResult = await executor.exec([
    'docker', 'buildx', 'imagetools', 'inspect', imageReference,
    '--format', '{{json .Manifest}}',
  ]);
  if (manifestResult.exitCode !== 0) {
    throw new DockerRegistryError('IMAGE_REGISTRY_LOOKUP_FAILED', 'Registry manifest lookup failed.');
  }
  const manifest = parseJsonObject(manifestResult.stdout, 'Registry manifest lookup');
  const indexDigest = typeof manifest.digest === 'string' && manifest.digest ? manifest.digest : null;

  let platformDigest: string;
  const descriptors = Array.isArray(manifest.manifests) ? manifest.manifests : null;
  if (descriptors) {
    const matches = descriptors.filter((entry: unknown) => {
      if (!entry || typeof entry !== 'object') return false;
      const descriptor = entry as Record<string, any>;
      return descriptor.platform && typeof descriptor.platform === 'object'
        && samePlatform(descriptor.platform as Record<string, any>, platform);
    });
    if (matches.length !== 1 || typeof (matches[0] as ManifestDescriptor).digest !== 'string') {
      throw new DockerRegistryError('IMAGE_PLATFORM_NOT_FOUND', 'Registry image does not contain exactly one manifest for the snapshot platform.');
    }
    platformDigest = String((matches[0] as ManifestDescriptor).digest);
  } else if (typeof manifest.digest === 'string' && manifest.digest) {
    platformDigest = manifest.digest;
  } else {
    throw new DockerRegistryError('REGISTRY_OUTPUT_INVALID', 'Registry manifest did not contain a usable digest.');
  }

  const repository = repositoryFromImageReference(imageReference);
  if (!repository) throw new DockerRegistryError('REGISTRY_OUTPUT_INVALID', 'Configured image reference has no repository.');
  const candidateReference = `${repository}@${platformDigest}`;
  const imageResult = await executor.exec([
    'docker', 'buildx', 'imagetools', 'inspect', candidateReference,
    '--format', '{{json .Image}}',
  ]);
  if (imageResult.exitCode !== 0) {
    throw new DockerRegistryError('IMAGE_REGISTRY_LOOKUP_FAILED', 'Registry image configuration lookup failed.');
  }
  const image = parseJsonObject(imageResult.stdout, 'Registry image configuration lookup');
  const candidatePlatform: DockerImagePlatform = {
    os: String(image.os ?? ''),
    architecture: String(image.architecture ?? ''),
    variant: normalizedVariant(image.variant),
  };
  if (!candidatePlatform.os || !candidatePlatform.architecture || !samePlatform(candidatePlatform as unknown as Record<string, any>, platform)) {
    throw new DockerRegistryError('IMAGE_PLATFORM_NOT_FOUND', 'Registry candidate configuration does not match the snapshot platform.');
  }

  return {
    imageReference,
    indexDigest: descriptors ? indexDigest : null,
    platformDigest,
    platform: candidatePlatform,
    version: candidateVersion(image),
  };
}
