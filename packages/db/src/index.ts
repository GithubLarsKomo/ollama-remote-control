import { createRequire } from 'node:module';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type {
  AuditRepository,
  AuthRepository,
  EncryptedSecret,
  HostOnboardingRepository,
  JobRepository,
  JobState,
  JobTransitionUpdate,
  OllamaTargetRepository,
  SshCredentialRepository,
  StoredAuditEvent,
  StoredHost,
  StoredJob,
  StoredJobEvent,
  StoredOllamaTarget,
  StoredSession,
  StoredSshCredential,
  StoredUpdateSnapshot,
  StoredUser,
  UpdateSnapshotRepository,
  UserRole,
} from '@orc/core';

const require = createRequire(import.meta.url);

interface RunResult { readonly changes: number; }
interface Statement {
  get(...params: unknown[]): Record<string, unknown> | undefined;
  all(...params: unknown[]): Record<string, unknown>[];
  run(...params: unknown[]): RunResult;
}

export interface DatabaseConnection {
  pragma(source: string, options?: { simple?: boolean }): unknown;
  exec(source: string): void;
  prepare(source: string): Statement;
  close(): void;
}

type DatabaseConstructor = new (filename: string) => DatabaseConnection;
const Database = require('better-sqlite3') as DatabaseConstructor;

interface Migration { readonly version: number; readonly name: string; readonly source: URL; }
const migrations: readonly Migration[] = [
  { version: 1, name: 'foundation', source: new URL('../migrations/0001_foundation.sql', import.meta.url) },
  { version: 2, name: 'identity-sessions', source: new URL('../migrations/0002_identity_sessions.sql', import.meta.url) },
  { version: 3, name: 'ssh-credentials', source: new URL('../migrations/0003_ssh_credentials.sql', import.meta.url) },
  { version: 4, name: 'host-identity', source: new URL('../migrations/0004_host_identity.sql', import.meta.url) },
  { version: 5, name: 'target-binding', source: new URL('../migrations/0005_target_binding.sql', import.meta.url) },
  { version: 6, name: 'jobs-audit', source: new URL('../migrations/0006_jobs_audit.sql', import.meta.url) },
  { version: 7, name: 'update-snapshots', source: new URL('../migrations/0007_update_snapshots.sql', import.meta.url) },
  { version: 8, name: 'modelfile-library', source: new URL('../migrations/0008_modelfile_library.sql', import.meta.url) },
  { version: 9, name: 'modelfile-deploy-plans', source: new URL('../migrations/0009_modelfile_deploy_plans.sql', import.meta.url) },
  { version: 10, name: 'modelfile-deployments', source: new URL('../migrations/0010_modelfile_deployments.sql', import.meta.url) },
  { version: 11, name: 'provenance', source: new URL('../migrations/0011_provenance.sql', import.meta.url) },
];

export function openDatabase(filename: string): DatabaseConnection {
  if (filename !== ':memory:') mkdirSync(dirname(resolve(filename)), { recursive: true });
  const database = new Database(filename);
  if (filename !== ':memory:') database.pragma('journal_mode = WAL');
  database.pragma('foreign_keys = ON');
  return database;
}

export function applyMigrations(database: DatabaseConnection): number {
  database.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL);`);
  const current = getSchemaVersion(database);
  for (const migration of migrations) {
    if (migration.version <= current) continue;
    const sql = readFileSync(migration.source, 'utf8');
    database.exec('BEGIN IMMEDIATE');
    try {
      database.exec(sql);
      database.prepare('INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)').run(migration.version, migration.name, new Date().toISOString());
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  }
  return getSchemaVersion(database);
}

export function getSchemaVersion(database: DatabaseConnection): number {
  return Number(database.prepare('SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations').get()?.version ?? 0);
}
export function pingDatabase(database: DatabaseConnection): boolean {
  return Number(database.prepare('SELECT 1 AS ok').get()?.ok ?? 0) === 1;
}

function mapUser(row: Record<string, unknown> | undefined): StoredUser | null {
  if (!row) return null;
  return { id: String(row.id), username: String(row.username), passwordHash: String(row.password_hash), role: String(row.role) as UserRole, createdAt: String(row.created_at) };
}
function mapSession(row: Record<string, unknown> | undefined): StoredSession | null {
  if (!row) return null;
  return { id: String(row.id), userId: String(row.user_id), username: String(row.username), role: String(row.role) as UserRole, tokenHash: String(row.token_hash), csrfTokenHash: String(row.csrf_token_hash), createdAt: String(row.created_at), expiresAt: String(row.expires_at), revokedAt: row.revoked_at === null ? null : String(row.revoked_at) };
}
function mapEncryptedSecret(row: Record<string, unknown>): EncryptedSecret {
  return { algorithm: String(row.algorithm) as 'aes-256-gcm', keyVersion: Number(row.key_version), nonce: String(row.nonce), ciphertext: String(row.ciphertext), authTag: String(row.auth_tag) };
}
function mapSshCredential(row: Record<string, unknown> | undefined): StoredSshCredential | null {
  if (!row) return null;
  return { id: String(row.id), hostId: String(row.host_id), encryptedPrivateKey: mapEncryptedSecret(row), createdAt: String(row.created_at), updatedAt: String(row.updated_at) };
}
function mapHost(row: Record<string, unknown> | undefined): StoredHost | null {
  if (!row) return null;
  return { id: String(row.id), displayName: String(row.display_name), hostname: String(row.hostname), port: Number(row.port), username: String(row.username), hostKeyFingerprint: String(row.host_key_fingerprint), enabled: Number(row.enabled) === 1, createdAt: String(row.created_at), updatedAt: String(row.updated_at) };
}
function mapTarget(row: Record<string, unknown> | undefined): StoredOllamaTarget | null {
  if (!row) return null;
  return { id: String(row.id), hostId: String(row.host_id), displayName: String(row.display_name), selectedContainerId: String(row.selected_container_id), containerNameOverride: row.container_name_override === null ? null : String(row.container_name_override), enabled: Number(row.enabled) === 1, createdAt: String(row.created_at), updatedAt: String(row.updated_at) };
}
function mapJob(row: Record<string, unknown> | undefined): StoredJob | null {
  if (!row) return null;
  return {
    id: String(row.id),
    targetId: String(row.target_id),
    actorUserId: String(row.actor_user_id),
    kind: String(row.kind),
    mutating: Number(row.mutating) === 1,
    state: String(row.state) as JobState,
    createdAt: String(row.created_at),
    startedAt: row.started_at === null ? null : String(row.started_at),
    finishedAt: row.finished_at === null ? null : String(row.finished_at),
    resultJson: row.result_json === null ? null : String(row.result_json),
    errorClass: row.error_class === null ? null : String(row.error_class),
    exitCode: row.exit_code === null ? null : Number(row.exit_code),
  };
}
function mapJobEvent(row: Record<string, unknown>): StoredJobEvent {
  return {
    id: String(row.id),
    jobId: String(row.job_id),
    sequence: Number(row.sequence),
    eventType: String(row.event_type),
    payloadJson: String(row.payload_json),
    createdAt: String(row.created_at),
  };
}
function mapAuditEvent(row: Record<string, unknown>): StoredAuditEvent {
  return {
    id: String(row.id),
    timestamp: String(row.timestamp),
    actorUserId: String(row.actor_user_id),
    hostId: row.host_id === null ? null : String(row.host_id),
    targetId: row.target_id === null ? null : String(row.target_id),
    action: String(row.action),
    parametersRedactedJson: String(row.parameters_redacted_json),
    result: String(row.result),
    exitCode: row.exit_code === null ? null : Number(row.exit_code),
    errorClass: row.error_class === null ? null : String(row.error_class),
    jobId: row.job_id === null ? null : String(row.job_id),
  };
}
function mapUpdateSnapshot(row: Record<string, unknown> | undefined): StoredUpdateSnapshot | null {
  if (!row) return null;
  return {
    id: String(row.id),
    targetId: String(row.target_id),
    actorUserId: String(row.actor_user_id),
    createdAt: String(row.created_at),
    publicMetadataJson: String(row.public_metadata_json),
    encryptedPayload: mapEncryptedSecret(row),
  };
}
function insertCredential(database: DatabaseConnection, credential: StoredSshCredential): void {
  const encrypted = credential.encryptedPrivateKey;
  database.prepare(`INSERT INTO ssh_credentials(id, host_id, algorithm, key_version, nonce, ciphertext, auth_tag, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(credential.id, credential.hostId, encrypted.algorithm, encrypted.keyVersion, encrypted.nonce, encrypted.ciphertext, encrypted.authTag, credential.createdAt, credential.updatedAt);
}
function nextJobEventSequence(database: DatabaseConnection, jobId: string): number {
  return Number(database.prepare('SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM job_events WHERE job_id = ?').get(jobId)?.sequence ?? 1);
}
function insertJobEvent(database: DatabaseConnection, event: Omit<StoredJobEvent, 'sequence'>, sequence: number): StoredJobEvent {
  database.prepare(`INSERT INTO job_events(id, job_id, sequence, event_type, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)`).run(event.id, event.jobId, sequence, event.eventType, event.payloadJson, event.createdAt);
  return { ...event, sequence };
}

export class SqliteAuthRepository implements AuthRepository {
  constructor(private readonly database: DatabaseConnection) {}
  countUsers(): number { return Number(this.database.prepare('SELECT COUNT(*) AS count FROM users').get()?.count ?? 0); }
  createAdminIfNoneExists(user: StoredUser): boolean { return this.database.prepare(`INSERT INTO users(id, username, password_hash, role, created_at) SELECT ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM users)`).run(user.id, user.username, user.passwordHash, user.role, user.createdAt).changes === 1; }
  findUserByUsername(username: string): StoredUser | null { return mapUser(this.database.prepare(`SELECT id, username, password_hash, role, created_at FROM users WHERE username = ? COLLATE NOCASE`).get(username)); }
  createSession(session: Omit<StoredSession, 'username' | 'role' | 'revokedAt'>): void { this.database.prepare(`INSERT INTO sessions(id, user_id, token_hash, csrf_token_hash, created_at, expires_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, NULL)`).run(session.id, session.userId, session.tokenHash, session.csrfTokenHash, session.createdAt, session.expiresAt); }
  findActiveSessionByTokenHash(tokenHash: string, nowIso: string): StoredSession | null { return mapSession(this.database.prepare(`SELECT s.id, s.user_id, u.username, u.role, s.token_hash, s.csrf_token_hash, s.created_at, s.expires_at, s.revoked_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ?`).get(tokenHash, nowIso)); }
  revokeSession(sessionId: string, revokedAt: string): void { this.database.prepare('UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(revokedAt, sessionId); }
}

export class SqliteSshCredentialRepository implements SshCredentialRepository {
  constructor(private readonly database: DatabaseConnection) {}
  save(credential: StoredSshCredential): void {
    const encrypted = credential.encryptedPrivateKey;
    this.database.prepare(`INSERT INTO ssh_credentials(id, host_id, algorithm, key_version, nonce, ciphertext, auth_tag, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(host_id) DO UPDATE SET id = excluded.id, algorithm = excluded.algorithm, key_version = excluded.key_version, nonce = excluded.nonce, ciphertext = excluded.ciphertext, auth_tag = excluded.auth_tag, updated_at = excluded.updated_at`).run(credential.id, credential.hostId, encrypted.algorithm, encrypted.keyVersion, encrypted.nonce, encrypted.ciphertext, encrypted.authTag, credential.createdAt, credential.updatedAt);
  }
  findByHostId(hostId: string): StoredSshCredential | null { return mapSshCredential(this.database.prepare(`SELECT id, host_id, algorithm, key_version, nonce, ciphertext, auth_tag, created_at, updated_at FROM ssh_credentials WHERE host_id = ?`).get(hostId)); }
}

export class SqliteHostOnboardingRepository implements HostOnboardingRepository {
  constructor(private readonly database: DatabaseConnection) {}
  createHostWithCredential(host: StoredHost, credential: StoredSshCredential): boolean {
    if (credential.hostId !== host.id) throw new Error('SSH credential host ID must match the host being created.');
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const inserted = this.database.prepare(`INSERT OR IGNORE INTO hosts(id, display_name, hostname, port, username, host_key_fingerprint, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(host.id, host.displayName, host.hostname, host.port, host.username, host.hostKeyFingerprint, host.enabled ? 1 : 0, host.createdAt, host.updatedAt);
      if (inserted.changes !== 1) { this.database.exec('ROLLBACK'); return false; }
      insertCredential(this.database, credential);
      this.database.exec('COMMIT');
      return true;
    } catch (error) { this.database.exec('ROLLBACK'); throw error; }
  }
  findHostById(hostId: string): StoredHost | null { return mapHost(this.database.prepare(`SELECT id, display_name, hostname, port, username, host_key_fingerprint, enabled, created_at, updated_at FROM hosts WHERE id = ?`).get(hostId)); }
}

export class SqliteOllamaTargetRepository implements OllamaTargetRepository {
  constructor(private readonly database: DatabaseConnection) {}
  saveSelection(target: StoredOllamaTarget): void {
    this.database.prepare(`INSERT INTO ollama_targets(id, host_id, display_name, container_name_override, selected_container_id, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(host_id, selected_container_id) WHERE selected_container_id IS NOT NULL DO UPDATE SET display_name = excluded.display_name, container_name_override = excluded.container_name_override, enabled = excluded.enabled, updated_at = excluded.updated_at`).run(target.id, target.hostId, target.displayName, target.containerNameOverride, target.selectedContainerId, target.enabled ? 1 : 0, target.createdAt, target.updatedAt);
  }
  findById(targetId: string): StoredOllamaTarget | null {
    return mapTarget(this.database.prepare(`SELECT id, host_id, display_name, container_name_override, selected_container_id, enabled, created_at, updated_at FROM ollama_targets WHERE id = ? AND selected_container_id IS NOT NULL`).get(targetId));
  }
  findByHostId(hostId: string): readonly StoredOllamaTarget[] {
    return this.database.prepare(`SELECT id, host_id, display_name, container_name_override, selected_container_id, enabled, created_at, updated_at FROM ollama_targets WHERE host_id = ? AND selected_container_id IS NOT NULL ORDER BY display_name, id`).all(hostId).map((row) => mapTarget(row)!).filter(Boolean);
  }
}

export class SqliteJobRepository implements JobRepository {
  constructor(private readonly database: DatabaseConnection) {}

  createWithInitialEvent(job: StoredJob, event: Omit<StoredJobEvent, 'sequence'>): boolean {
    if (event.jobId !== job.id) throw new Error('Initial job event must belong to the created job.');
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const inserted = this.database.prepare(`
        INSERT OR IGNORE INTO jobs(
          id, target_id, actor_user_id, kind, mutating, state, created_at,
          started_at, finished_at, result_json, error_class, exit_code
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        job.id, job.targetId, job.actorUserId, job.kind, job.mutating ? 1 : 0, job.state,
        job.createdAt, job.startedAt, job.finishedAt, job.resultJson, job.errorClass, job.exitCode,
      );
      if (inserted.changes !== 1) {
        this.database.exec('ROLLBACK');
        return false;
      }
      insertJobEvent(this.database, event, 1);
      this.database.exec('COMMIT');
      return true;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  findById(jobId: string): StoredJob | null {
    return mapJob(this.database.prepare(`
      SELECT id, target_id, actor_user_id, kind, mutating, state, created_at,
             started_at, finished_at, result_json, error_class, exit_code
      FROM jobs WHERE id = ?
    `).get(jobId));
  }

  findNonTerminal(): readonly StoredJob[] {
    return this.database.prepare(`
      SELECT id, target_id, actor_user_id, kind, mutating, state, created_at,
             started_at, finished_at, result_json, error_class, exit_code
      FROM jobs
      WHERE state IN ('queued', 'running', 'cancelling')
      ORDER BY created_at, id
    `).all().map((row) => mapJob(row)!).filter(Boolean);
  }

  transitionWithEvent(
    jobId: string,
    expectedState: JobState,
    update: JobTransitionUpdate,
    event: Omit<StoredJobEvent, 'sequence'>,
  ): boolean {
    if (event.jobId !== jobId) throw new Error('Transition event must belong to the transitioned job.');
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const changed = this.database.prepare(`
        UPDATE jobs
        SET state = ?, started_at = ?, finished_at = ?, result_json = ?, error_class = ?, exit_code = ?
        WHERE id = ? AND state = ?
      `).run(
        update.state, update.startedAt, update.finishedAt, update.resultJson,
        update.errorClass, update.exitCode, jobId, expectedState,
      );
      if (changed.changes !== 1) {
        this.database.exec('ROLLBACK');
        return false;
      }
      insertJobEvent(this.database, event, nextJobEventSequence(this.database, jobId));
      this.database.exec('COMMIT');
      return true;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  appendEvent(event: Omit<StoredJobEvent, 'sequence'>): StoredJobEvent {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const stored = insertJobEvent(this.database, event, nextJobEventSequence(this.database, event.jobId));
      this.database.exec('COMMIT');
      return stored;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  listEvents(jobId: string): readonly StoredJobEvent[] {
    return this.database.prepare(`
      SELECT id, job_id, sequence, event_type, payload_json, created_at
      FROM job_events WHERE job_id = ? ORDER BY sequence
    `).all(jobId).map(mapJobEvent);
  }
}

export class SqliteAuditRepository implements AuditRepository {
  constructor(private readonly database: DatabaseConnection) {}

  append(event: StoredAuditEvent): void {
    this.database.prepare(`
      INSERT INTO audit_events(
        id, timestamp, actor_user_id, host_id, target_id, action,
        parameters_redacted_json, result, exit_code, error_class, job_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.id, event.timestamp, event.actorUserId, event.hostId, event.targetId,
      event.action, event.parametersRedactedJson, event.result, event.exitCode,
      event.errorClass, event.jobId,
    );
  }

  listByTarget(targetId: string): readonly StoredAuditEvent[] {
    return this.database.prepare(`
      SELECT id, timestamp, actor_user_id, host_id, target_id, action,
             parameters_redacted_json, result, exit_code, error_class, job_id
      FROM audit_events WHERE target_id = ? ORDER BY timestamp, id
    `).all(targetId).map(mapAuditEvent);
  }
}

export class SqliteUpdateSnapshotRepository implements UpdateSnapshotRepository {
  constructor(private readonly database: DatabaseConnection) {}

  save(snapshot: StoredUpdateSnapshot): void {
    const encrypted = snapshot.encryptedPayload;
    this.database.prepare(`
      INSERT INTO update_snapshots(
        id, target_id, actor_user_id, created_at, public_metadata_json,
        algorithm, key_version, nonce, ciphertext, auth_tag
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      snapshot.id,
      snapshot.targetId,
      snapshot.actorUserId,
      snapshot.createdAt,
      snapshot.publicMetadataJson,
      encrypted.algorithm,
      encrypted.keyVersion,
      encrypted.nonce,
      encrypted.ciphertext,
      encrypted.authTag,
    );
  }

  findById(snapshotId: string): StoredUpdateSnapshot | null {
    return mapUpdateSnapshot(this.database.prepare(`
      SELECT id, target_id, actor_user_id, created_at, public_metadata_json,
             algorithm, key_version, nonce, ciphertext, auth_tag
      FROM update_snapshots WHERE id = ?
    `).get(snapshotId));
  }

  listByTarget(targetId: string): readonly StoredUpdateSnapshot[] {
    return this.database.prepare(`
      SELECT id, target_id, actor_user_id, created_at, public_metadata_json,
             algorithm, key_version, nonce, ciphertext, auth_tag
      FROM update_snapshots WHERE target_id = ? ORDER BY created_at DESC, id DESC
    `).all(targetId).map((row) => mapUpdateSnapshot(row)!).filter(Boolean);
  }
}
