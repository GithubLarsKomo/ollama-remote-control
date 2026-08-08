import type { RemoteExecResult } from '@orc/core';
import {
  ComposeIntentError,
  composeContextArgv,
  composeDigestOverrideJson,
  isExactDigestImageReference,
  sameExactImageReference,
  validateComposeDigestOverride,
} from './compose-intent.js';
import type { ComposeSnapshotContext } from './reconstruct.js';

export type ComposeImageSource = 'pull-exact' | 'local-only';

export type ComposeReplacementErrorCode =
  | 'INVALID_CONTAINER_ID'
  | 'INVALID_IMAGE_REFERENCE'
  | 'COMPOSE_CONTEXT_CHANGED'
  | 'IMAGE_PULL_FAILED'
  | 'IMAGE_NOT_AVAILABLE'
  | 'IMAGE_INSPECT_INVALID'
  | 'IMAGE_REFERENCE_MISMATCH'
  | 'COMPOSE_RECREATE_FAILED'
  | 'COMPOSE_SERVICE_LOOKUP_FAILED'
  | 'COMPOSE_SERVICE_AMBIGUOUS'
  | 'COMPOSE_CONTAINER_NOT_RECREATED'
  | 'REPLACEMENT_INSPECT_FAILED'
  | 'REPLACEMENT_INSPECT_INVALID'
  | 'REPLACEMENT_NOT_RUNNING'
  | 'REPLACEMENT_IMAGE_MISMATCH';

export class ComposeReplacementError extends Error {
  constructor(readonly code: ComposeReplacementErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

export interface ComposeReplacementExecutor {
  exec(argv: readonly string[], stdin?: string): Promise<RemoteExecResult>;
}

export interface ComposeReplacementResult {
  readonly source: ComposeImageSource;
  readonly exactImageReference: string;
  readonly imageId: string;
  readonly previousContainerId: string;
  readonly containerId: string;
}

interface LocalImageIdentity {
  readonly imageId: string;
  readonly exactImageReference: string;
}

function normalizedContainerId(value: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u.test(normalized)) {
    throw new ComposeReplacementError('INVALID_CONTAINER_ID', 'Container identifier is invalid.');
  }
  return normalized;
}

function parseJsonObjectArray(stdout: string, code: ComposeReplacementErrorCode, message: string): Record<string, any> {
  try {
    const parsed = JSON.parse(stdout);
    const value = Array.isArray(parsed) && parsed.length === 1 ? parsed[0] : null;
    if (!value || typeof value !== 'object') throw new Error('expected one object');
    return value as Record<string, any>;
  } catch {
    throw new ComposeReplacementError(code, message);
  }
}

function validImageId(value: unknown): string | null {
  const id = String(value ?? '').trim().toLowerCase();
  return /^sha256:[0-9a-f]{64}$/u.test(id) ? id : null;
}

async function materializeExactImage(
  executor: ComposeReplacementExecutor,
  exactImageReference: string,
  source: ComposeImageSource,
): Promise<LocalImageIdentity> {
  if (!isExactDigestImageReference(exactImageReference)) {
    throw new ComposeReplacementError('INVALID_IMAGE_REFERENCE', 'Replacement image must be an exact digest reference.');
  }

  if (source === 'pull-exact') {
    const pull = await executor.exec(['docker', 'image', 'pull', exactImageReference]);
    if (pull.exitCode !== 0) {
      throw new ComposeReplacementError('IMAGE_PULL_FAILED', 'Exact replacement image could not be pulled.');
    }
  }

  const inspect = await executor.exec(['docker', 'image', 'inspect', exactImageReference]);
  if (inspect.exitCode !== 0) {
    throw new ComposeReplacementError(
      source === 'local-only' ? 'IMAGE_NOT_AVAILABLE' : 'IMAGE_INSPECT_INVALID',
      source === 'local-only'
        ? 'Exact rollback image is not available locally.'
        : 'Pulled replacement image could not be inspected.',
    );
  }
  const value = parseJsonObjectArray(inspect.stdout, 'IMAGE_INSPECT_INVALID', 'Replacement image inspect returned invalid data.');
  const imageId = validImageId(value.Id);
  if (!imageId) throw new ComposeReplacementError('IMAGE_INSPECT_INVALID', 'Replacement image ID is invalid.');
  const repoDigests = Array.isArray(value.RepoDigests) ? value.RepoDigests.map(String) : [];
  if (!repoDigests.some((reference) => sameExactImageReference(reference, exactImageReference))) {
    throw new ComposeReplacementError('IMAGE_REFERENCE_MISMATCH', 'Local image does not match the requested exact digest reference.');
  }
  return { imageId, exactImageReference };
}

async function assertComposeContextStillPins(
  executor: ComposeReplacementExecutor,
  context: ComposeSnapshotContext,
  exactImageReference: string,
): Promise<void> {
  try {
    await validateComposeDigestOverride({
      exec: (argv, stdin) => executor.exec(argv, stdin),
    }, context, exactImageReference);
  } catch (error) {
    if (error instanceof ComposeIntentError) {
      throw new ComposeReplacementError('COMPOSE_CONTEXT_CHANGED', 'Compose context no longer resolves the intended exact image.');
    }
    throw error;
  }
}

async function recreateService(
  executor: ComposeReplacementExecutor,
  context: ComposeSnapshotContext,
  exactImageReference: string,
  expectedPreviousContainerId: string,
  imageId: string,
): Promise<string> {
  const overrideJson = composeDigestOverrideJson(context.service, exactImageReference);
  const up = await executor.exec([
    ...composeContextArgv(context, true),
    'up', '-d', '--no-deps', '--force-recreate', '--pull', 'never', '--no-build', context.service,
  ], overrideJson);
  if (up.exitCode !== 0) {
    throw new ComposeReplacementError('COMPOSE_RECREATE_FAILED', 'Compose service replacement failed.');
  }

  const lookup = await executor.exec([
    ...composeContextArgv(context),
    'ps', '--all', '-q', context.service,
  ]);
  if (lookup.exitCode !== 0) {
    throw new ComposeReplacementError('COMPOSE_SERVICE_LOOKUP_FAILED', 'Compose replacement container lookup failed.');
  }
  const ids = [...new Set(lookup.stdout.split(/\r?\n/u).map((value) => value.trim()).filter(Boolean))];
  if (ids.length !== 1) {
    throw new ComposeReplacementError('COMPOSE_SERVICE_AMBIGUOUS', 'Compose service did not resolve to exactly one replacement container.');
  }
  const containerId = normalizedContainerId(ids[0]);
  if (containerId === expectedPreviousContainerId) {
    throw new ComposeReplacementError('COMPOSE_CONTAINER_NOT_RECREATED', 'Compose did not create a new service container.');
  }

  const inspect = await executor.exec(['docker', 'inspect', containerId]);
  if (inspect.exitCode !== 0) {
    throw new ComposeReplacementError('REPLACEMENT_INSPECT_FAILED', 'Replacement container could not be inspected.');
  }
  const value = parseJsonObjectArray(inspect.stdout, 'REPLACEMENT_INSPECT_INVALID', 'Replacement container inspect returned invalid data.');
  if (!Boolean(value.State?.Running)) {
    throw new ComposeReplacementError('REPLACEMENT_NOT_RUNNING', 'Replacement container is not running.');
  }
  const actualImageId = validImageId(value.Image);
  if (!actualImageId || actualImageId !== imageId) {
    throw new ComposeReplacementError('REPLACEMENT_IMAGE_MISMATCH', 'Replacement container is not using the expected local image.');
  }
  if (!sameExactImageReference(String(value.Config?.Image ?? ''), exactImageReference)) {
    throw new ComposeReplacementError('REPLACEMENT_IMAGE_MISMATCH', 'Replacement container configuration is not pinned to the expected image digest.');
  }
  return containerId;
}

export async function replaceComposeServiceImage(
  executor: ComposeReplacementExecutor,
  context: ComposeSnapshotContext,
  exactImageReference: string,
  expectedPreviousContainerId: string,
  source: ComposeImageSource,
): Promise<ComposeReplacementResult> {
  const previousContainerId = normalizedContainerId(expectedPreviousContainerId);
  if (!isExactDigestImageReference(exactImageReference)) {
    throw new ComposeReplacementError('INVALID_IMAGE_REFERENCE', 'Replacement image must be an exact digest reference.');
  }

  // Revalidate captured Compose context before the first remote mutation (pull or recreate).
  await assertComposeContextStillPins(executor, context, exactImageReference);
  const image = await materializeExactImage(executor, exactImageReference, source);
  const containerId = await recreateService(
    executor,
    context,
    exactImageReference,
    previousContainerId,
    image.imageId,
  );
  return {
    source,
    exactImageReference,
    imageId: image.imageId,
    previousContainerId,
    containerId,
  };
}
