export interface ApiErrorPayload {
  readonly error: {
    readonly code: string;
    readonly message: string;
  };
}

export interface SetupStatus {
  readonly requiresAdminBootstrap: boolean;
}

export interface SessionView {
  readonly user: {
    readonly id: string;
    readonly username: string;
    readonly role: 'admin';
  };
  readonly expiresAt: string;
}

export interface HostKeyObservation {
  readonly algorithm: string;
  readonly fingerprint: string;
}

export interface HostCatalogEntry {
  readonly id: string;
  readonly displayName: string;
  readonly hostname: string;
  readonly port: number;
  readonly username: string;
  readonly hostKeyFingerprint: string;
}

export interface CreatedHost extends HostCatalogEntry {
  readonly enabled: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly hostKeyAlgorithm: string;
}

export interface PublicDockerDiscoveryCandidate {
  readonly id: string;
  readonly name: string;
  readonly image: string;
  readonly state: string;
  readonly status: string;
  readonly ports: string;
  readonly score: number;
  readonly reasons: readonly string[];
  readonly inspect: {
    readonly image: string;
    readonly running: boolean;
    readonly mountCount: number;
    readonly portBindingCount: number;
    readonly labelCount: number;
  };
}

export interface PublicDockerDiscoveryResult {
  readonly dockerVersion: string;
  readonly candidates: readonly PublicDockerDiscoveryCandidate[];
  readonly recommendedContainerId: string | null;
  readonly ambiguous: boolean;
}

export interface TargetCatalogEntry {
  readonly id: string;
  readonly hostId: string;
  readonly displayName: string;
  readonly selectedContainerId: string;
}

export interface DockerMountView {
  readonly source: string;
  readonly destination: string;
  readonly type: string;
}

export interface TargetStatusResult {
  readonly target: TargetCatalogEntry;
  readonly container: {
    readonly id: string;
    readonly name: string;
    readonly image: string;
    readonly running: boolean;
    readonly state: string;
    readonly status: string;
    readonly startedAt: string | null;
    readonly restartCount: number;
    readonly oomKilled: boolean;
    readonly mounts: readonly DockerMountView[];
    readonly portBindings: Readonly<Record<string, unknown>>;
    readonly labels: Readonly<Record<string, string>>;
  };
  readonly ollama: {
    readonly available: boolean;
    readonly version: string | null;
    readonly errorClass: string | null;
  };
  readonly environment: readonly {
    readonly name: string;
    readonly value: string | null;
    readonly redacted: boolean;
  }[];
  readonly gpu: {
    readonly available: boolean;
    readonly devices: readonly {
      readonly name: string;
      readonly driverVersion: string;
      readonly utilizationPercent: number | null;
      readonly memoryTotalMiB: number | null;
      readonly memoryUsedMiB: number | null;
      readonly memoryFreeMiB: number | null;
      readonly temperatureC: number | null;
    }[];
    readonly errorClass: string | null;
  };
  readonly modelStorage: {
    readonly available: boolean;
    readonly mount: DockerMountView | null;
    readonly disk: {
      readonly totalKiB: number;
      readonly usedKiB: number;
      readonly availableKiB: number;
      readonly capacityPercent: number;
      readonly mountedOn: string;
    } | null;
    readonly errorClass: string | null;
  };
}

export type ContainerLifecycleAction = 'start' | 'stop' | 'restart';

export interface ContainerLifecycleResult {
  readonly job: {
    readonly id: string;
    readonly targetId: string;
    readonly actorUserId: string;
    readonly kind: string;
    readonly mutating: boolean;
    readonly state: 'queued' | 'running' | 'cancelling' | 'succeeded' | 'failed' | 'cancelled';
    readonly createdAt: string;
    readonly startedAt: string | null;
    readonly finishedAt: string | null;
    readonly resultJson: string | null;
    readonly errorClass: string | null;
    readonly exitCode: number | null;
  };
  readonly container: TargetStatusResult['container'];
}

export interface DockerUpdatePreflightMetadata {
  readonly containerId: string;
  readonly containerName: string;
  readonly running: boolean;
  readonly imageReference: string;
  readonly imageId: string;
  readonly repoDigests: readonly string[];
  readonly restartPolicy: string;
  readonly mountCount: number;
  readonly portBindingCount: number;
  readonly networkNames: readonly string[];
  readonly gpuDeviceRequestCount: number;
  readonly ollamaVersion: string | null;
  readonly compose: {
    readonly managed: boolean;
    readonly project: string | null;
    readonly service: string | null;
    readonly configFiles: string | null;
    readonly workingDir: string | null;
  };
}

export interface PublicUpdateSnapshot {
  readonly id: string;
  readonly targetId: string;
  readonly createdAt: string;
  readonly metadata: DockerUpdatePreflightMetadata;
}

export interface DockerImagePlatform {
  readonly os: string;
  readonly architecture: string;
  readonly variant: string | null;
}

export interface UpdatePlan {
  readonly snapshotId: string;
  readonly targetId: string;
  readonly imageReference: string;
  readonly pinned: boolean;
  readonly currentDigest: string;
  readonly candidateDigest: string;
  readonly candidateIndexDigest: string | null;
  readonly platform: DockerImagePlatform;
  readonly updateAvailable: boolean;
  readonly currentOllamaVersion: string | null;
  readonly candidateImageVersion: string | null;
  readonly composeManaged: boolean;
  readonly modelVolumeBackup: {
    readonly included: false;
    readonly warning: string;
  };
}

export interface ValidatedComposeStrategy {
  readonly type: 'compose';
  readonly executable: true;
  readonly projectName: string;
  readonly service: string;
  readonly workingDirectory: string;
  readonly configFiles: readonly string[];
  readonly environmentFiles: readonly string[];
  readonly composeVersion: string;
  readonly containerId: string;
}

export interface StandaloneUpdateStrategy {
  readonly type: 'standalone';
  readonly executable: boolean;
  readonly unsupportedFields: readonly string[];
  readonly summary: {
    readonly environmentCount: number;
    readonly labelCount: number;
    readonly mountCount: number;
    readonly portBindingCount: number;
    readonly networkNames: readonly string[];
    readonly restartPolicy: string;
    readonly hasCommandOverride: boolean;
    readonly hasEntrypointOverride: boolean;
  };
}

export interface UpdateStrategyResult {
  readonly snapshotId: string;
  readonly targetId: string;
  readonly strategy: ValidatedComposeStrategy | StandaloneUpdateStrategy;
}

export interface UpdateExecutionIntent {
  readonly intentVersion: 1;
  readonly intentId: string;
  readonly targetId: string;
  readonly snapshotId: string;
  readonly imageReference: string;
  readonly currentDigest: string;
  readonly candidateDigest: string;
  readonly candidateIndexDigest: string | null;
  readonly exactCandidateReference: string;
  readonly candidateImageVersion: string | null;
  readonly strategy: 'compose';
  readonly composeService: string;
  readonly createdAt: string;
}

export interface UpdateExecutionResult {
  readonly jobId: string;
  readonly outcome: 'updated';
  readonly intentId: string;
  readonly snapshotId: string;
  readonly previousContainerId: string;
  readonly containerId: string;
  readonly candidateDigest: string;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function isApiErrorPayload(value: unknown): value is ApiErrorPayload {
  if (!value || typeof value !== 'object') return false;
  const error = (value as { error?: unknown }).error;
  return Boolean(
    error
    && typeof error === 'object'
    && typeof (error as { code?: unknown }).code === 'string'
    && typeof (error as { message?: unknown }).message === 'string',
  );
}

async function requestJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: 'include',
    headers: {
      accept: 'application/json',
      ...init.headers,
    },
  });
  if (response.ok) {
    if (response.status === 204) return undefined as T;
    return await response.json() as T;
  }

  let payload: unknown = null;
  try { payload = await response.json(); } catch { /* safe generic error below */ }
  if (isApiErrorPayload(payload)) {
    throw new ApiError(response.status, payload.error.code, payload.error.message);
  }
  throw new ApiError(response.status, 'HTTP_ERROR', `Request failed with HTTP ${response.status}.`);
}

function jsonBody(value: unknown): Pick<RequestInit, 'body' | 'headers'> {
  return {
    body: JSON.stringify(value),
    headers: { 'content-type': 'application/json' },
  };
}

export function csrfTokenFromCookie(cookieHeader: string): string | null {
  for (const part of cookieHeader.split(';')) {
    const [rawName, ...rawValue] = part.trim().split('=');
    if (rawName !== 'orc_csrf') continue;
    const value = rawValue.join('=');
    try { return decodeURIComponent(value); } catch { return value; }
  }
  return null;
}

function csrfHeader(): Readonly<Record<string, string>> {
  const token = csrfTokenFromCookie(document.cookie);
  if (!token) throw new ApiError(403, 'CSRF_MISSING', 'CSRF token is unavailable. Sign in again.');
  return { 'x-csrf-token': token };
}

function mutationJson(value: unknown): Pick<RequestInit, 'body' | 'headers'> {
  const json = jsonBody(value);
  return {
    body: json.body,
    headers: { ...json.headers, ...csrfHeader() },
  };
}

function targetPath(targetId: string): string {
  return `/api/v1/targets/${encodeURIComponent(targetId)}`;
}

function hostPath(hostId: string): string {
  return `/api/v1/hosts/${encodeURIComponent(hostId)}`;
}

export const api = {
  setupStatus(): Promise<SetupStatus> {
    return requestJson<SetupStatus>('/api/v1/setup/status');
  },

  bootstrapAdmin(username: string, password: string): Promise<{ readonly user: SessionView['user'] }> {
    return requestJson('/api/v1/setup/admin', { method: 'POST', ...jsonBody({ username, password }) });
  },

  login(username: string, password: string): Promise<SessionView> {
    return requestJson('/api/v1/session', { method: 'POST', ...jsonBody({ username, password }) });
  },

  session(): Promise<SessionView> {
    return requestJson('/api/v1/session');
  },

  logout(): Promise<void> {
    return requestJson('/api/v1/session', {
      method: 'DELETE',
      headers: csrfHeader(),
    });
  },

  listHosts(): Promise<{ readonly hosts: readonly HostCatalogEntry[] }> {
    return requestJson('/api/v1/hosts');
  },

  probeHost(hostname: string, port: number): Promise<HostKeyObservation> {
    return requestJson('/api/v1/hosts/probe', {
      method: 'POST',
      ...mutationJson({ hostname, port }),
    });
  },

  createHost(input: {
    readonly displayName: string;
    readonly hostname: string;
    readonly port: number;
    readonly username: string;
    readonly confirmedFingerprint: string;
    readonly privateKey: string;
  }): Promise<{ readonly host: CreatedHost }> {
    return requestJson('/api/v1/hosts', {
      method: 'POST',
      ...mutationJson(input),
    });
  },

  discoverOllama(hostId: string): Promise<PublicDockerDiscoveryResult> {
    return requestJson(`${hostPath(hostId)}/discover-ollama`, {
      method: 'POST',
      headers: csrfHeader(),
    });
  },

  selectTarget(hostId: string, containerId: string, displayName: string): Promise<{ readonly target: TargetCatalogEntry }> {
    return requestJson(`${hostPath(hostId)}/targets`, {
      method: 'POST',
      ...mutationJson({ containerId, displayName }),
    });
  },

  listTargets(): Promise<{ readonly targets: readonly TargetCatalogEntry[] }> {
    return requestJson('/api/v1/targets');
  },

  targetStatus(targetId: string): Promise<TargetStatusResult> {
    return requestJson(`${targetPath(targetId)}/status`);
  },

  containerLifecycle(
    targetId: string,
    action: ContainerLifecycleAction,
    selectedContainerId?: string,
  ): Promise<ContainerLifecycleResult> {
    const path = `${targetPath(targetId)}/container/${action}`;
    if (action === 'start') {
      return requestJson(path, {
        method: 'POST',
        headers: csrfHeader(),
      });
    }
    if (!selectedContainerId) {
      throw new ApiError(400, 'CLIENT_CONFIRMATION_MISSING', `Container ${action} requires the current selected container ID.`);
    }
    return requestJson(path, {
      method: 'POST',
      ...mutationJson({
        confirmation: {
          action,
          targetId,
          containerId: selectedContainerId,
        },
      }),
    });
  },

  updatePreflight(targetId: string): Promise<{ readonly snapshot: PublicUpdateSnapshot }> {
    return requestJson(`${targetPath(targetId)}/container/update-preflight`, {
      method: 'POST',
      headers: csrfHeader(),
    });
  },

  updatePlan(targetId: string, snapshotId: string): Promise<{ readonly plan: UpdatePlan }> {
    return requestJson(`${targetPath(targetId)}/container/update-plan?snapshotId=${encodeURIComponent(snapshotId)}`);
  },

  updateStrategy(targetId: string, snapshotId: string): Promise<UpdateStrategyResult> {
    return requestJson(`${targetPath(targetId)}/container/update-strategy?snapshotId=${encodeURIComponent(snapshotId)}`);
  },

  createUpdateExecutionIntent(targetId: string, snapshotId: string): Promise<{ readonly intent: UpdateExecutionIntent }> {
    return requestJson(`${targetPath(targetId)}/container/update-execution-intent`, {
      method: 'POST',
      ...mutationJson({ snapshotId }),
    });
  },

  executeUpdate(targetId: string, intentId: string): Promise<{ readonly update: UpdateExecutionResult }> {
    return requestJson(`${targetPath(targetId)}/container/update`, {
      method: 'POST',
      ...mutationJson({
        intentId,
        confirmation: {
          action: 'update',
          targetId,
          intentId,
        },
      }),
    });
  },
};