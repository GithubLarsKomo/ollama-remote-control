import { ApiError, csrfTokenFromCookie } from './api.js';

export interface ModelfileDeployPlanView {
  readonly planId: string;
  readonly confirmationToken: string;
  readonly targetId: string;
  readonly selectedContainerId: string;
  readonly modelfileId: string;
  readonly revisionId: string;
  readonly revisionSha256: string;
  readonly outputModel: string;
  readonly baseModel: string;
  readonly operation: 'create' | 'replace';
  readonly existingDestination: { readonly digest: string; readonly sizeBytes: number } | null;
  readonly apiVersion: string;
  readonly directiveCounts: Readonly<Record<string, number>>;
  readonly expectedFields: readonly string[];
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface PublicCreateJob {
  readonly id: string;
  readonly targetId: string;
  readonly kind: 'model-create';
  readonly state: 'queued' | 'running' | 'cancelling' | 'succeeded' | 'failed' | 'cancelled';
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly errorClass: string | null;
}

function isApiErrorPayload(value: unknown): value is { readonly error: { readonly code: string; readonly message: string } } {
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
    headers: { accept: 'application/json', ...init.headers },
  });
  if (response.ok) return await response.json() as T;
  let payload: unknown = null;
  try { payload = await response.json(); } catch { /* generic error below */ }
  if (isApiErrorPayload(payload)) throw new ApiError(response.status, payload.error.code, payload.error.message);
  throw new ApiError(response.status, 'HTTP_ERROR', `Request failed with HTTP ${response.status}.`);
}

function mutationHeaders(): Readonly<Record<string, string>> {
  const token = csrfTokenFromCookie(document.cookie);
  if (!token) throw new ApiError(403, 'CSRF_MISSING', 'CSRF token is unavailable. Sign in again.');
  return {
    accept: 'application/json',
    'content-type': 'application/json',
    'x-csrf-token': token,
  };
}

function revisionPath(targetId: string, modelfileId: string, revisionId: string): string {
  return `/api/v1/targets/${encodeURIComponent(targetId)}/modelfiles/${encodeURIComponent(modelfileId)}/revisions/${encodeURIComponent(revisionId)}`;
}

export function createModelfileDeployPlan(
  targetId: string,
  modelfileId: string,
  revisionId: string,
  outputModel: string,
  replaceExisting = false,
): Promise<{ readonly plan: ModelfileDeployPlanView }> {
  return requestJson(`${revisionPath(targetId, modelfileId, revisionId)}/deploy-plan`, {
    method: 'POST',
    headers: mutationHeaders(),
    body: JSON.stringify({ outputModel, replaceExisting }),
  });
}

export function confirmModelfileDeploy(
  targetId: string,
  modelfileId: string,
  revisionId: string,
  plan: ModelfileDeployPlanView,
): Promise<{ readonly job: PublicCreateJob }> {
  return requestJson(`${revisionPath(targetId, modelfileId, revisionId)}/deploy`, {
    method: 'POST',
    headers: mutationHeaders(),
    body: JSON.stringify({ planId: plan.planId, confirmationToken: plan.confirmationToken }),
  });
}

export function readActiveModelCreateJob(targetId: string): Promise<{ readonly job: PublicCreateJob | null }> {
  return requestJson(`/api/v1/targets/${encodeURIComponent(targetId)}/model-create/active`);
}

export function readModelCreateJob(jobId: string): Promise<{ readonly job: PublicCreateJob }> {
  return requestJson(`/api/v1/model-create-jobs/${encodeURIComponent(jobId)}`);
}

export function cancelModelCreateJob(jobId: string): Promise<{ readonly job: PublicCreateJob }> {
  return requestJson(`/api/v1/model-create-jobs/${encodeURIComponent(jobId)}/cancel`, {
    method: 'POST',
    headers: mutationHeaders(),
    body: '{}',
  });
}

export function modelCreateEventUrl(jobId: string): string {
  return `/api/v1/model-create-jobs/${encodeURIComponent(jobId)}/events`;
}
