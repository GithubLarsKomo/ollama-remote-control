import { createRequire } from 'node:module';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type {
  AuthRepository,
  EncryptedSecret,
  HostOnboardingRepository,
  OllamaTargetRepository,
  SshCredentialRepository,
  StoredHost,
  StoredOllamaTarget,
  StoredSession,
  StoredSshCredential,
  StoredUser,
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
function insertCredential(database: DatabaseConnection, credential: StoredSshCredential): void {
  const encrypted = credential.encryptedPrivateKey;
  database.prepare(`INSERT INTO ssh_credentials(id, host_id, algorithm, key_version, nonce, ciphertext, auth_tag, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(credential.id, credential.hostId, encrypted.algorithm, encrypted.keyVersion, encrypted.nonce, encrypted.ciphertext, encrypted.authTag, credential.createdAt, credential.updatedAt);
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
