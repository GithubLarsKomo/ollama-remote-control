import { ApiError, csrfTokenFromCookie } from './api.js';

export type ModelfileSourceKind = 'manual' | 'installed-model-import';

export interface ModelfileRevisionSummaryView {
  readonly id: string;
  readonly revisionNumber: number;
  readonly parentRevisionId: string | null;
  readonly contentSha256: string;
  readonly sourceKind: ModelfileSourceKind;
  readonly importedTargetId: string | null;
  readonly importedModel: string | null;
  readonly importedDigest: string | null;
  readonly createdAt: string;
}

export interface ModelfileRevisionView extends ModelfileRevisionSummaryView {
  readonly rawText: string;
}

export interface ModelfileSummaryView {
  readonly id: string;
  readonly displayName: string;
  readonly description: string | null;
  readonly currentRevisionId: string;
  readonly currentRevisionNumber: number;
  readonly currentSourceKind: ModelfileSourceKind;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ModelfileView extends ModelfileSummaryView {
  readonly currentRevision: ModelfileRevisionView;
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
  try { payload = await response.json(); } catch { /* safe generic error below */ }
  if (isApiErrorPayload(payload)) {
    throw new ApiError(response.status, payload.error.code, payload.error.message);
  }
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

function modelfilePath(modelfileId: string): string {
  return `/api/v1/modelfiles/${encodeURIComponent(modelfileId)}`;
}

export function listLocalModelfiles(): Promise<{ readonly modelfiles: readonly ModelfileSummaryView[] }> {
  return requestJson('/api/v1/modelfiles');
}

export function readLocalModelfile(modelfileId: string): Promise<{ readonly modelfile: ModelfileView }> {
  return requestJson(modelfilePath(modelfileId));
}

export function listLocalModelfileRevisions(modelfileId: string): Promise<{ readonly revisions: readonly ModelfileRevisionSummaryView[] }> {
  return requestJson(`${modelfilePath(modelfileId)}/revisions`);
}

export function readLocalModelfileRevision(
  modelfileId: string,
  revisionId: string,
): Promise<{ readonly revision: ModelfileRevisionView }> {
  return requestJson(`${modelfilePath(modelfileId)}/revisions/${encodeURIComponent(revisionId)}`);
}

export function createLocalModelfile(input: {
  readonly displayName: string;
  readonly description?: string;
  readonly rawText: string;
}): Promise<{ readonly modelfile: ModelfileView }> {
  return requestJson('/api/v1/modelfiles', {
    method: 'POST',
    headers: mutationHeaders(),
    body: JSON.stringify(input),
  });
}

export function appendLocalModelfileRevision(
  modelfileId: string,
  input: {
    readonly expectedCurrentRevisionId: string;
    readonly rawText: string;
  },
): Promise<{ readonly modelfile: ModelfileView }> {
  return requestJson(`${modelfilePath(modelfileId)}/revisions`, {
    method: 'POST',
    headers: mutationHeaders(),
    body: JSON.stringify(input),
  });
}

export function cloneLocalModelfileRevision(
  modelfileId: string,
  revisionId: string,
  input: {
    readonly displayName: string;
    readonly description?: string;
  },
): Promise<{ readonly modelfile: ModelfileView }> {
  return requestJson(`${modelfilePath(modelfileId)}/revisions/${encodeURIComponent(revisionId)}/clone`, {
    method: 'POST',
    headers: mutationHeaders(),
    body: JSON.stringify(input),
  });
}

export function importInstalledModelfile(input: {
  readonly targetId: string;
  readonly model: string;
  readonly displayName?: string;
  readonly description?: string;
}): Promise<{ readonly modelfile: ModelfileView }> {
  return requestJson('/api/v1/modelfiles/import-installed', {
    method: 'POST',
    headers: mutationHeaders(),
    body: JSON.stringify(input),
  });
}

export function modelfileExportFilename(displayName: string, revisionNumber: number): string {
  const normalized = displayName.normalize('NFKC').trim();
  const stem = normalized
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .replace(/^\.+|\.+$/gu, '')
    .slice(0, 80) || 'modelfile';
  const revision = Number.isSafeInteger(revisionNumber) && revisionNumber > 0 ? revisionNumber : 1;
  return `${stem}-r${revision}.Modelfile`;
}

export function downloadModelfileRevision(input: {
  readonly displayName: string;
  readonly revisionNumber: number;
  readonly rawText: string;
}): void {
  const blob = new Blob([input.rawText], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = modelfileExportFilename(input.displayName, input.revisionNumber);
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  try { anchor.click(); }
  finally {
    anchor.remove();
    URL.revokeObjectURL(url);
  }
}
