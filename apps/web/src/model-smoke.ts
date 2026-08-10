import { ApiError, csrfTokenFromCookie } from './api.js';

export interface ModelSmokeResultView {
  readonly job: {
    readonly id: string;
    readonly targetId: string;
    readonly kind: 'model-smoke-test';
    readonly state: 'succeeded';
    readonly createdAt: string;
    readonly startedAt: string | null;
    readonly finishedAt: string | null;
    readonly errorClass: null;
  };
  readonly model: string;
  readonly digest: string;
  readonly verified: true;
  readonly elapsedMs: number;
  readonly responseChars: number;
  readonly doneReason: string | null;
}

export interface ModelSmokeRequestBody {
  readonly model: string;
  readonly digest: string;
  readonly confirmation: {
    readonly action: 'smoke-test';
    readonly targetId: string;
    readonly model: string;
    readonly digest: string;
  };
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

export function modelSmokeRequestBody(input: {
  readonly targetId: string;
  readonly model: string;
  readonly digest: string;
}): ModelSmokeRequestBody {
  return {
    model: input.model,
    digest: input.digest,
    confirmation: {
      action: 'smoke-test',
      targetId: input.targetId,
      model: input.model,
      digest: input.digest,
    },
  };
}

export async function runModelSmokeTest(input: {
  readonly targetId: string;
  readonly model: string;
  readonly digest: string;
}): Promise<ModelSmokeResultView> {
  const csrf = csrfTokenFromCookie(document.cookie);
  if (!csrf) throw new ApiError(403, 'CSRF_MISSING', 'CSRF token is unavailable. Sign in again.');
  const response = await fetch(`/api/v1/targets/${encodeURIComponent(input.targetId)}/models/smoke-test`, {
    method: 'POST',
    credentials: 'include',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      'x-csrf-token': csrf,
    },
    body: JSON.stringify(modelSmokeRequestBody(input)),
  });
  if (response.ok) return (await response.json() as { readonly smokeTest: ModelSmokeResultView }).smokeTest;
  let payload: unknown = null;
  try { payload = await response.json(); } catch { /* generic error below */ }
  if (isApiErrorPayload(payload)) throw new ApiError(response.status, payload.error.code, payload.error.message);
  throw new ApiError(response.status, 'HTTP_ERROR', `Model smoke test failed with HTTP ${response.status}.`);
}
