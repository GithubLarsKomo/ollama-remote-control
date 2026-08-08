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

export interface TargetCatalogEntry {
  readonly id: string;
  readonly hostId: string;
  readonly displayName: string;
  readonly selectedContainerId: string;
}

export interface TargetStatusResult {
  readonly targetId: string;
  readonly container: {
    readonly id: string;
    readonly name: string;
    readonly imageReference: string;
    readonly running: boolean;
    readonly status: string;
    readonly health: string;
    readonly restartCount: number;
    readonly startedAt: string;
  };
  readonly ollama: {
    readonly version: string;
    readonly environment: Readonly<Record<string, string>>;
  };
  readonly gpu:
    | {
      readonly available: false;
      readonly errorClass: string;
    }
    | {
      readonly available: true;
      readonly devices: readonly {
        readonly index: number;
        readonly name: string;
        readonly driverVersion: string;
        readonly utilizationGpuPercent: number;
        readonly memoryTotalBytes: number;
        readonly memoryUsedBytes: number;
        readonly memoryFreeBytes: number;
        readonly temperatureC: number;
      }[];
    };
  readonly modelStorage:
    | {
      readonly available: false;
      readonly errorClass: string;
    }
    | {
      readonly available: true;
      readonly filesystem: string;
      readonly mountPoint: string;
      readonly totalBytes: number;
      readonly usedBytes: number;
      readonly availableBytes: number;
      readonly usedPercent: number;
      readonly modelPath: string;
    };
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

  listTargets(): Promise<{ readonly targets: readonly TargetCatalogEntry[] }> {
    return requestJson('/api/v1/targets');
  },

  targetStatus(targetId: string): Promise<TargetStatusResult> {
    return requestJson(`/api/v1/targets/${encodeURIComponent(targetId)}/status`);
  },
};
