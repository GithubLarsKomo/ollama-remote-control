import { ApiError, csrfTokenFromCookie } from './api.js';

export interface PublicModelUnloadJob {
  readonly id: string;
  readonly targetId: string;
  readonly kind: 'model-unload';
  readonly state: 'queued' | 'running' | 'cancelling' | 'succeeded' | 'failed' | 'cancelled';
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly errorClass: string | null;
}

export interface ModelUnloadResultView {
  readonly job: PublicModelUnloadJob;
  readonly model: string;
  readonly digest: string;
  readonly verified: true;
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

export async function unloadLoadedModel(input: {
  readonly targetId: string;
  readonly model: string;
  readonly digest: string;
}): Promise<ModelUnloadResultView> {
  const csrf = csrfTokenFromCookie(document.cookie);
  if (!csrf) throw new ApiError(403, 'CSRF_MISSING', 'CSRF token is unavailable. Sign in again.');
  const response = await fetch(`/api/v1/targets/${encodeURIComponent(input.targetId)}/models/unload`, {
    method: 'POST',
    credentials: 'include',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      'x-csrf-token': csrf,
    },
    body: JSON.stringify({
      model: input.model,
      digest: input.digest,
      confirmation: {
        action: 'unload',
        targetId: input.targetId,
        model: input.model,
        digest: input.digest,
      },
    }),
  });
  if (response.ok) return (await response.json() as { readonly unload: ModelUnloadResultView }).unload;
  let payload: unknown = null;
  try { payload = await response.json(); } catch { /* generic error below */ }
  if (isApiErrorPayload(payload)) throw new ApiError(response.status, payload.error.code, payload.error.message);
  throw new ApiError(response.status, 'HTTP_ERROR', `Model unload failed with HTTP ${response.status}.`);
}
