import type { TargetCatalogRepository } from '@orc/core';
import type { DatabaseConnection } from './index.js';

export class SqliteTargetCatalogRepository implements TargetCatalogRepository {
  constructor(private readonly database: DatabaseConnection) {}

  listEnabled() {
    return [];
  }
}
