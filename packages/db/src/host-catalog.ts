import type { HostCatalogEntry, HostCatalogRepository } from '@orc/core';
import type { DatabaseConnection } from './index.js';

export class SqliteHostCatalogRepository implements HostCatalogRepository {
  constructor(private readonly database: DatabaseConnection) {}

  listEnabled(): readonly HostCatalogEntry[] {
    return this.database.prepare(`
      SELECT id, display_name, hostname, port, username, host_key_fingerprint
      FROM hosts
      WHERE enabled = 1
      ORDER BY display_name, id
    `).all().map((row) => ({
      id: String(row.id),
      displayName: String(row.display_name),
      hostname: String(row.hostname),
      port: Number(row.port),
      username: String(row.username),
      hostKeyFingerprint: String(row.host_key_fingerprint),
    }));
  }
}
