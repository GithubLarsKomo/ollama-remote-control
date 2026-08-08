export type HostId = string;
export type OllamaTargetId = string;
export type JobId = string;
export type UserRole = 'admin';

export interface RemoteExecRequest {
  readonly argv: readonly string[];
  readonly stdin?: string;
  readonly timeoutMs?: number;
}

export interface RemoteExecResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly signal?: string;
}

export interface HostKeyObservation {
  readonly algorithm: string;
  readonly fingerprint: string;
}

export interface SSHTransportPort {
  probeHostKey(): Promise<HostKeyObservation>;
  exec(request: RemoteExecRequest): Promise<RemoteExecResult>;
}

export interface StoredUser {
  readonly id: string;
  readonly username: string;
  readonly passwordHash: string;
  readonly role: UserRole;
  readonly createdAt: string;
}

export interface StoredSession {
  readonly id: string;
  readonly userId: string;
  readonly username: string;
  readonly role: UserRole;
  readonly tokenHash: string;
  readonly csrfTokenHash: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly revokedAt: string | null;
}

export interface AuthRepository {
  countUsers(): number;
  createAdminIfNoneExists(user: StoredUser): boolean;
  findUserByUsername(username: string): StoredUser | null;
  createSession(session: Omit<StoredSession, 'username' | 'role' | 'revokedAt'>): void;
  findActiveSessionByTokenHash(tokenHash: string, nowIso: string): StoredSession | null;
  revokeSession(sessionId: string, revokedAt: string): void;
}

export interface ApiHealthResponse {
  readonly status: 'ok';
  readonly service: 'ollama-remote-control-api';
  readonly version: string;
  readonly database: {
    readonly status: 'ok';
    readonly schemaVersion: number;
  };
}
