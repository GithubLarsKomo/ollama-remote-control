import type { StoredJob } from '@orc/core';
import type { DatabaseConnection } from './index.js';

function mapJob(row: Record<string, unknown> | undefined): StoredJob | null {
  if (!row) return null;
  return {
    id: String(row.id),
    targetId: String(row.target_id),
    actorUserId: String(row.actor_user_id),
    kind: String(row.kind),
    mutating: Number(row.mutating) === 1,
    state: String(row.state) as StoredJob['state'],
    createdAt: String(row.created_at),
    startedAt: row.started_at === null ? null : String(row.started_at),
    finishedAt: row.finished_at === null ? null : String(row.finished_at),
    resultJson: row.result_json === null ? null : String(row.result_json),
    errorClass: row.error_class === null ? null : String(row.error_class),
    exitCode: row.exit_code === null ? null : Number(row.exit_code),
  };
}

export class SqliteUpdateHistoryRepository {
  constructor(private readonly database: DatabaseConnection) {}

  latestSuccessfulUpdate(targetId: string): StoredJob | null {
    return mapJob(this.database.prepare(`
      SELECT id, target_id, actor_user_id, kind, mutating, state, created_at,
             started_at, finished_at, result_json, error_class, exit_code
      FROM jobs
      WHERE target_id = ?
        AND kind = 'container.update'
        AND state = 'succeeded'
      ORDER BY finished_at DESC, created_at DESC, id DESC
      LIMIT 1
    `).get(targetId));
  }
}
