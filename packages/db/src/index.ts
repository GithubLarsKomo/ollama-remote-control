import { createRequire } from 'node:module';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const require = createRequire(import.meta.url);

interface Statement {
  get(...params: unknown[]): Record<string, unknown> | undefined;
  run(...params: unknown[]): unknown;
}

export interface DatabaseConnection {
  pragma(source: string, options?: { simple?: boolean }): unknown;
  exec(source: string): void;
  prepare(source: string): Statement;
  close(): void;
}

type DatabaseConstructor = new (filename: string) => DatabaseConnection;
const Database = require('better-sqlite3') as DatabaseConstructor;

interface Migration {
  readonly version: number;
  readonly name: string;
  readonly source: URL;
}

const migrations: readonly Migration[] = [
  {
    version: 1,
    name: 'foundation',
    source: new URL('../migrations/0001_foundation.sql', import.meta.url),
  },
];

export function openDatabase(filename: string): DatabaseConnection {
  if (filename !== ':memory:') {
    mkdirSync(dirname(resolve(filename)), { recursive: true });
  }

  const database = new Database(filename);
  if (filename !== ':memory:') {
    database.pragma('journal_mode = WAL');
  }
  database.pragma('foreign_keys = ON');
  return database;
}

export function applyMigrations(database: DatabaseConnection): number {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);

  const current = getSchemaVersion(database);
  for (const migration of migrations) {
    if (migration.version <= current) continue;

    const sql = readFileSync(migration.source, 'utf8');
    database.exec('BEGIN IMMEDIATE');
    try {
      database.exec(sql);
      database
        .prepare('INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)')
        .run(migration.version, migration.name, new Date().toISOString());
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  }

  return getSchemaVersion(database);
}

export function getSchemaVersion(database: DatabaseConnection): number {
  const row = database
    .prepare('SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations')
    .get();
  return Number(row?.version ?? 0);
}

export function pingDatabase(database: DatabaseConnection): boolean {
  const row = database.prepare('SELECT 1 AS ok').get();
  return Number(row?.ok ?? 0) === 1;
}
