import { ApiError, csrfTokenFromCookie } from './api.js';

export type RollbackUnavailableReason = 'NO_SUCCESSFUL_UPDATE' | 'TARGET_BINDING_CHANGED';

export interface ManualRollbackCandidate {
  readonly sourceUpdateJobId: string;
  readonly sourceIntentId: string;
  readonly snapshotId: string;
  readonly updatedAt: string;
  readonly currentContainerId: string;
  readonly previousContainerId: string;
  readonly currentImageReference: string;
  readonly rollbackImageReference: string;
  readonly currentDigest: string;
  readonly rollbackDigest: string;
  readonly composeService: string;
  readonly modelVolumeBackup: {
    readonly included: false;
    readonly warning: string;
  };
}

export interface ManualRollbackCandidateResponse {
  readonly candidate: ManualRollbackCandidate | null;
  readonly reason: RollbackUnavailableReason | null;
}

export interface ManualRollbackResult {
  readonly jobId: string;
  readonly outcome: 'rolled_back';
  readonly sourceUpdateJobId: string;
  readonly snapshotId: string;
  readonly previousContainerId: string;
  readonly replacedContainerId: string;
  readonly containerId: string;
  readonly rollbackDigest: string;
}

interface ApiErrorPayload {
  readonly error?: {
    readonly code?: unknown;
    readonly message?: unknown;
  };
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
  if (response.ok) return await response.json() as T;
  let payload: ApiErrorPayload | null = null;
  try { payload = await response.json() as ApiErrorPayload; } catch { /* generic error below */ }
  const code = payload?.error?.code;
  const message = payload?.error?.message;
  if (typeof code === 'string' && typeof message === 'string') {
    throw new ApiError(response.status, code, message);
  }
  throw new ApiError(response.status, 'HTTP_ERROR', `Request failed with HTTP ${response.status}.`);
}

function targetPath(targetId: string): string {
  return `/api/v1/targets/${encodeURIComponent(targetId)}`;
}

function mutationHeaders(): Readonly<Record<string, string>> {
  const token = csrfTokenFromCookie(document.cookie);
  if (!token) throw new ApiError(403, 'CSRF_MISSING', 'CSRF token is unavailable. Sign in again.');
  return {
    'content-type': 'application/json',
    'x-csrf-token': token,
  };
}

export const manualRollbackApi = {
  candidate(targetId: string): Promise<ManualRollbackCandidateResponse> {
    return requestJson(`${targetPath(targetId)}/container/rollback-candidate`);
  },

  execute(targetId: string, candidate: ManualRollbackCandidate): Promise<{ readonly rollback: ManualRollbackResult }> {
    return requestJson(`${targetPath(targetId)}/container/rollback`, {
      method: 'POST',
      headers: mutationHeaders(),
      body: JSON.stringify({
        confirmation: {
          targetId,
          sourceUpdateJobId: candidate.sourceUpdateJobId,
          currentContainerId: candidate.currentContainerId,
          rollbackDigest: candidate.rollbackDigest,
          acknowledgeModelVolumeBoundary: true,
        },
      }),
    });
  },
};
