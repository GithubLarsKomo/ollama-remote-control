import { ApiError, csrfTokenFromCookie } from './api.js';

export type PullJobState = 'queued' | 'running' | 'cancelling' | 'succeeded' | 'failed' | 'cancelled';

export interface PullJobView {
  readonly id: string;
  readonly targetId: string;
  readonly kind: 'model-pull';
  readonly state: PullJobState;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly errorClass: string | null;
}

export interface PullProgressView {
  readonly status: string;
  readonly digest: string | null;
  readonly totalBytes: number | null;
  readonly completedBytes: number | null;
  readonly percentage: number | null;
  readonly createdAt: string | null;
}

export interface PullUiState {
  readonly job: PullJobView | null;
  readonly model: string | null;
  readonly progress: PullProgressView | null;
}

export type PullSseEvent =
  | { readonly type: 'ready'; readonly data: { readonly job: PullJobView } }
  | { readonly type: 'state'; readonly data: { readonly state: PullJobState; readonly errorClass?: string | null } }
  | { readonly type: 'pull-request'; readonly data: { readonly model: string } }
  | { readonly type: 'progress'; readonly data: PullProgressView }
  | { readonly type: 'end'; readonly data: { readonly job: PullJobView } };

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
  try { payload = await response.json(); } catch { /* generic safe error below */ }
  if (isApiErrorPayload(payload)) throw new ApiError(response.status, payload.error.code, payload.error.message);
  throw new ApiError(response.status, 'HTTP_ERROR', `Model pull request failed with HTTP ${response.status}.`);
}

function csrfHeader(): Readonly<Record<string, string>> {
  const token = csrfTokenFromCookie(document.cookie);
  if (!token) throw new ApiError(403, 'CSRF_MISSING', 'CSRF token is unavailable. Sign in again.');
  return { 'x-csrf-token': token };
}

function targetPath(targetId: string): string {
  return `/api/v1/targets/${encodeURIComponent(targetId)}`;
}

function jobPath(jobId: string): string {
  return `/api/v1/jobs/${encodeURIComponent(jobId)}`;
}

export function startModelPull(targetId: string, model: string): Promise<{ readonly job: PullJobView }> {
  return requestJson(`${targetPath(targetId)}/models/pull`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...csrfHeader() },
    body: JSON.stringify({ model }),
  });
}

export function activeModelPull(targetId: string): Promise<{ readonly job: PullJobView | null }> {
  return requestJson(`${targetPath(targetId)}/models/pull/active`);
}

export function readModelPullJob(jobId: string): Promise<{ readonly job: PullJobView }> {
  return requestJson(jobPath(jobId));
}

export function cancelModelPull(jobId: string): Promise<{ readonly job: PullJobView }> {
  return requestJson(`${jobPath(jobId)}/cancel`, {
    method: 'POST',
    headers: csrfHeader(),
  });
}

export function modelPullEventUrl(jobId: string): string {
  return `${jobPath(jobId)}/events`;
}

export function isTerminalPullState(state: PullJobState): boolean {
  return state === 'succeeded' || state === 'failed' || state === 'cancelled';
}

export function applyPullSseEvent(current: PullUiState, event: PullSseEvent): PullUiState {
  if (event.type === 'ready' || event.type === 'end') {
    return { ...current, job: event.data.job };
  }
  if (event.type === 'pull-request') {
    return { ...current, model: event.data.model };
  }
  if (event.type === 'progress') {
    return { ...current, progress: event.data };
  }
  if (!current.job) return current;
  return {
    ...current,
    job: {
      ...current.job,
      state: event.data.state,
      errorClass: event.data.errorClass ?? current.job.errorClass,
    },
  };
}

export function parsePullSseData<T>(event: MessageEvent<string>): T {
  try { return JSON.parse(event.data) as T; }
  catch { throw new ApiError(502, 'JOB_EVENT_INVALID', 'Pull job event stream returned invalid JSON.'); }
}
