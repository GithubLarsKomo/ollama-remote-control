import { ApiError } from './api.js';

export type DeployPlanAuthorityState = 'usable' | 'consumed' | 'expired' | 'stale-binding';

export interface ModelfileDeploymentView {
  readonly id: string;
  readonly targetId: string;
  readonly modelfileId: string;
  readonly revisionId: string;
  readonly revisionSha256: string;
  readonly outputModel: string;
  readonly modelDigest: string;
  readonly sizeBytes: number;
  readonly baseModel: string;
  readonly sourceCreateJobId: string;
  readonly selectedContainerId: string;
  readonly verifiedAt: string;
  readonly libraryCurrentRevisionId: string;
  readonly producingRevisionIsLibraryCurrent: boolean;
}

export type LocalValidationView =
  | {
      readonly state: 'passed';
      readonly revisionSha256: string;
      readonly baseModel: string;
      readonly expectedFields: readonly string[];
      readonly directiveCounts: Readonly<Record<string, number>>;
    }
  | {
      readonly state: 'failed';
      readonly revisionSha256: string;
      readonly code: string;
      readonly message: string;
    };

export type PreflightValidationView =
  | { readonly state: 'not-requested' | 'not-run' }
  | {
      readonly state: 'passed';
      readonly planId: string;
      readonly createdAt: string;
      readonly expiresAt: string;
      readonly consumedAt: string | null;
      readonly selectedContainerId: string;
      readonly baseModel: string;
      readonly authorityState: DeployPlanAuthorityState;
    };

export type TargetValidationView =
  | { readonly state: 'not-requested' | 'not-run' }
  | {
      readonly state: 'verified';
      readonly deploymentId: string;
      readonly sourceCreateJobId: string;
      readonly modelDigest: string;
      readonly sizeBytes: number;
      readonly selectedContainerId: string;
      readonly verifiedAt: string;
    };

export interface ModelfileValidationView {
  readonly modelfileId: string;
  readonly revisionId: string;
  readonly revisionSha256: string;
  readonly local: LocalValidationView;
  readonly preflight: PreflightValidationView;
  readonly targetVerification: TargetValidationView;
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

async function requestJson<T>(path: string): Promise<T> {
  const response = await fetch(path, { credentials: 'include', headers: { accept: 'application/json' } });
  if (response.ok) return await response.json() as T;
  let payload: unknown = null;
  try { payload = await response.json(); } catch { /* safe generic error below */ }
  if (isApiErrorPayload(payload)) throw new ApiError(response.status, payload.error.code, payload.error.message);
  throw new ApiError(response.status, 'HTTP_ERROR', `Request failed with HTTP ${response.status}.`);
}

function revisionPath(modelfileId: string, revisionId: string): string {
  return `/api/v1/modelfiles/${encodeURIComponent(modelfileId)}/revisions/${encodeURIComponent(revisionId)}`;
}

export function readModelfileValidation(
  modelfileId: string,
  revisionId: string,
  targetId?: string,
  model?: string,
): Promise<{ readonly validation: ModelfileValidationView }> {
  const params = new URLSearchParams();
  if (targetId !== undefined) params.set('targetId', targetId);
  if (model !== undefined) params.set('model', model);
  const query = params.size ? `?${params.toString()}` : '';
  return requestJson(`${revisionPath(modelfileId, revisionId)}/validation${query}`);
}

export function listRevisionDeployments(
  modelfileId: string,
  revisionId: string,
): Promise<{ readonly deployments: readonly ModelfileDeploymentView[] }> {
  return requestJson(`${revisionPath(modelfileId, revisionId)}/deployments`);
}

export function localValidationLabel(value: LocalValidationView): string {
  return value.state === 'passed' ? 'Passed' : `Failed · ${value.code}`;
}

export function preflightValidationLabel(value: PreflightValidationView): string {
  if (value.state === 'not-requested') return 'Not requested';
  if (value.state === 'not-run') return 'Not run';
  if (value.authorityState === 'usable') return 'Passed · current plan usable';
  return `Passed historically · ${value.authorityState}`;
}

export function targetValidationLabel(value: TargetValidationView): string {
  if (value.state === 'not-requested') return 'Not requested';
  if (value.state === 'not-run') return 'Not run';
  return 'Verified on target';
}
