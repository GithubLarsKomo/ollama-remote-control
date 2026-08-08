import type { TargetContainerBindingRepository } from '@orc/core';
import type { DatabaseConnection } from './index.js';

function isUniqueConstraint(error: unknown): boolean {
  return Boolean(
    error
    && typeof error === 'object'
    && 'code' in error
    && typeof (error as { code?: unknown }).code === 'string'
    && String((error as { code: string }).code).startsWith('SQLITE_CONSTRAINT'),
  );
}

export class SqliteTargetContainerBindingRepository implements TargetContainerBindingRepository {
  constructor(private readonly database: DatabaseConnection) {}

  rebindContainer(
    targetId: string,
    expectedContainerId: string,
    newContainerId: string,
    updatedAt: string,
  ): boolean {
    if (!targetId || !expectedContainerId || !newContainerId || !updatedAt) {
      throw new Error('Target binding compare-and-swap requires non-empty IDs and timestamp.');
    }
    if (expectedContainerId === newContainerId) return false;

    this.database.exec('BEGIN IMMEDIATE');
    try {
      const changed = this.database.prepare(`
        UPDATE ollama_targets
        SET selected_container_id = ?, updated_at = ?
        WHERE id = ? AND selected_container_id = ?
      `).run(newContainerId, updatedAt, targetId, expectedContainerId);
      if (changed.changes !== 1) {
        this.database.exec('ROLLBACK');
        return false;
      }
      this.database.exec('COMMIT');
      return true;
    } catch (error) {
      this.database.exec('ROLLBACK');
      if (isUniqueConstraint(error)) return false;
      throw error;
    }
  }
}
