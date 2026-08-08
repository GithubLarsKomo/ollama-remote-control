import type { TargetCatalogEntry, TargetCatalogRepository } from '@orc/core';
import type { DatabaseConnection } from './index.js';

export class SqliteTargetCatalogRepository implements TargetCatalogRepository {
  constructor(private readonly database: DatabaseConnection) {}

  listEnabled(): readonly TargetCatalogEntry[] {
    return this.database.prepare(`
      SELECT id, host_id, display_name, selected_container_id
      FROM ollama_targets
      WHERE enabled = 1 AND selected_container_id IS NOT NULL
      ORDER BY display_name, id
    `).all().map((row) => ({
      id: String(row.id),
      hostId: String(row.host_id),
      displayName: String(row.display_name),
      selectedContainerId: String(row.selected_container_id),
    }));
  }
}
