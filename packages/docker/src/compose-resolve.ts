import type { RemoteExecResult } from '@orc/core';
import { composeContextArgv } from './compose-intent.js';
import { ComposeReplacementError } from './compose-replacement.js';
import type { ComposeSnapshotContext } from './reconstruct.js';

export interface ComposeResolveExecutor {
  exec(argv: readonly string[]): Promise<RemoteExecResult>;
}

function normalizedContainerId(value: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u.test(normalized)) {
    throw new ComposeReplacementError('INVALID_CONTAINER_ID', 'Container identifier is invalid.');
  }
  return normalized;
}

export async function resolveComposeServiceContainer(
  executor: ComposeResolveExecutor,
  context: ComposeSnapshotContext,
): Promise<string> {
  const lookup = await executor.exec([
    ...composeContextArgv(context),
    'ps', '--all', '-q', context.service,
  ]);
  if (lookup.exitCode !== 0) {
    throw new ComposeReplacementError('COMPOSE_SERVICE_LOOKUP_FAILED', 'Compose service container lookup failed.');
  }
  const ids = [...new Set(lookup.stdout.split(/\r?\n/u).map((value) => value.trim()).filter(Boolean))];
  if (ids.length !== 1) {
    throw new ComposeReplacementError('COMPOSE_SERVICE_AMBIGUOUS', 'Compose service did not resolve to exactly one container.');
  }
  return normalizedContainerId(ids[0]);
}
