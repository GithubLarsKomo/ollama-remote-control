export type HostId = string;
export type OllamaTargetId = string;
export type JobId = string;
export type UserRole = 'admin';
export type JobState = 'queued' | 'running' | 'cancelling' | 'succeeded' | 'failed' | 'cancelled';

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

export interface EncryptedSecret {
  readonly algorithm: 'aes-256-gcm';
  readonly keyVersion: number;
  readonly nonce: string;
  readonly ciphertext: string;
  readonly authTag: string;
}

export interface StoredSshCredential {
  readonly id: string;
  readonly hostId: HostId;
  readonly encryptedPrivateKey: EncryptedSecret;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SshCredentialRepository {
  save(credential: StoredSshCredential): void;
  findByHostId(hostId: HostId): StoredSshCredential | null;
}

export interface StoredHost {
  readonly id: HostId;
  readonly displayName: string;
  readonly hostname: string;
  readonly port: number;
  readonly username: string;
  readonly hostKeyFingerprint: string;
  readonly enabled: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface HostOnboardingRepository {
  createHostWithCredential(host: StoredHost, credential: StoredSshCredential): boolean;
  findHostById(hostId: HostId): StoredHost | null;
}

export interface StoredOllamaTarget {
  readonly id: OllamaTargetId;
  readonly hostId: HostId;
  readonly displayName: string;
  readonly selectedContainerId: string;
  readonly containerNameOverride: string | null;
  readonly enabled: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface OllamaTargetRepository {
  saveSelection(target: StoredOllamaTarget): void;
  findById(targetId: OllamaTargetId): StoredOllamaTarget | null;
  findByHostId(hostId: HostId): readonly StoredOllamaTarget[];
}

export interface TargetContainerBindingRepository {
  rebindContainer(
    targetId: OllamaTargetId,
    expectedContainerId: string,
    newContainerId: string,
    updatedAt: string,
  ): boolean;
}

export interface StoredJob {
  readonly id: JobId;
  readonly targetId: OllamaTargetId;
  readonly actorUserId: string;
  readonly kind: string;
  readonly mutating: boolean;
  readonly state: JobState;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly resultJson: string | null;
  readonly errorClass: string | null;
  readonly exitCode: number | null;
}

export interface StoredJobEvent {
  readonly id: string;
  readonly jobId: JobId;
  readonly sequence: number;
  readonly eventType: string;
  readonly payloadJson: string;
  readonly createdAt: string;
}

export interface JobTransitionUpdate {
  readonly state: JobState;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly resultJson: string | null;
  readonly errorClass: string | null;
  readonly exitCode: number | null;
}

export interface JobRepository {
  createWithInitialEvent(job: StoredJob, event: Omit<StoredJobEvent, 'sequence'>): boolean;
  findById(jobId: JobId): StoredJob | null;
  findNonTerminal(): readonly StoredJob[];
  transitionWithEvent(
    jobId: JobId,
    expectedState: JobState,
    update: JobTransitionUpdate,
    event: Omit<StoredJobEvent, 'sequence'>,
  ): boolean;
  appendEvent(event: Omit<StoredJobEvent, 'sequence'>): StoredJobEvent;
  listEvents(jobId: JobId): readonly StoredJobEvent[];
}

export interface StoredAuditEvent {
  readonly id: string;
  readonly timestamp: string;
  readonly actorUserId: string;
  readonly hostId: HostId | null;
  readonly targetId: OllamaTargetId | null;
  readonly action: string;
  readonly parametersRedactedJson: string;
  readonly result: string;
  readonly exitCode: number | null;
  readonly errorClass: string | null;
  readonly jobId: JobId | null;
}

export interface AuditRepository {
  append(event: StoredAuditEvent): void;
  listByTarget(targetId: OllamaTargetId): readonly StoredAuditEvent[];
}

export interface StoredUpdateSnapshot {
  readonly id: string;
  readonly targetId: OllamaTargetId;
  readonly actorUserId: string;
  readonly createdAt: string;
  readonly publicMetadataJson: string;
  readonly encryptedPayload: EncryptedSecret;
}

export interface UpdateSnapshotRepository {
  save(snapshot: StoredUpdateSnapshot): void;
  findById(snapshotId: string): StoredUpdateSnapshot | null;
  listByTarget(targetId: OllamaTargetId): readonly StoredUpdateSnapshot[];
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
