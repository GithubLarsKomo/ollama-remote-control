import { ApiError } from './api.js';

export interface AuditFilters {
  readonly targetId?: string;
  readonly actorUserId?: string;
  readonly action?: string;
  readonly result?: string;
  readonly from?: string;
  readonly to?: string;
}

export interface AuditEventView {
  readonly id: string;
  readonly timestamp: string;
  readonly actorUserId: string;
  readonly hostId: string | null;
  readonly targetId: string | null;
  readonly action: string;
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly result: string;
  readonly exitCode: number | null;
  readonly errorClass: string | null;
  readonly jobId: string | null;
}

export interface AuditHistoryResponse {
  readonly redacted: true;
  readonly filters: AuditFilters;
  readonly events: readonly AuditEventView[];
  readonly page: {
    readonly limit: number;
    readonly offset: number;
    readonly hasMore: boolean;
  };
}

interface ApiErrorPayload {
  readonly error?: {
    readonly code?: unknown;
    readonly message?: unknown;
  };
}

function appendFilter(params: URLSearchParams, name: keyof AuditFilters, value: string | undefined): void {
  const normalized = value?.trim();
  if (normalized) params.set(name, normalized);
}

export function auditQueryString(filters: AuditFilters, page?: { readonly limit: number; readonly offset: number }): string {
  const params = new URLSearchParams();
  appendFilter(params, 'targetId', filters.targetId);
  appendFilter(params, 'actorUserId', filters.actorUserId);
  appendFilter(params, 'action', filters.action);
  appendFilter(params, 'result', filters.result);
  appendFilter(params, 'from', filters.from);
  appendFilter(params, 'to', filters.to);
  if (page) {
    params.set('limit', String(page.limit));
    params.set('offset', String(page.offset));
  }
  const query = params.toString();
  return query ? `?${query}` : '';
}

async function throwApiError(response: Response): Promise<never> {
  let payload: ApiErrorPayload | null = null;
  try { payload = await response.json() as ApiErrorPayload; } catch { /* generic error below */ }
  const code = payload?.error?.code;
  const message = payload?.error?.message;
  if (typeof code === 'string' && typeof message === 'string') throw new ApiError(response.status, code, message);
  throw new ApiError(response.status, 'HTTP_ERROR', `Request failed with HTTP ${response.status}.`);
}

async function requestJson<T>(path: string): Promise<T> {
  const response = await fetch(path, {
    credentials: 'include',
    headers: { accept: 'application/json' },
  });
  if (!response.ok) return await throwApiError(response);
  return await response.json() as T;
}

async function requestBlob(path: string): Promise<Blob> {
  const response = await fetch(path, {
    credentials: 'include',
    headers: { accept: '*/*' },
  });
  if (!response.ok) return await throwApiError(response);
  return await response.blob();
}

export const auditApi = {
  history(filters: AuditFilters, limit: number, offset: number): Promise<AuditHistoryResponse> {
    return requestJson(`/api/v1/audit${auditQueryString(filters, { limit, offset })}`);
  },

  export(filters: AuditFilters, format: 'json' | 'csv'): Promise<Blob> {
    return requestBlob(`/api/v1/audit/export.${format}${auditQueryString(filters)}`);
  },
};
