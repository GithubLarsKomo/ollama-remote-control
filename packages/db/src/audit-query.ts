import type { StoredAuditEvent } from '@orc/core';
import type { DatabaseConnection } from './index.js';

export interface StoredAuditQuery {
  readonly targetId?: string;
  readonly hostId?: string;
  readonly actorUserId?: string;
  readonly action?: string;
  readonly result?: string;
  readonly fromTimestamp?: string;
  readonly toTimestamp?: string;
  readonly limit: number;
  readonly offset: number;
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

function whereClause(query: StoredAuditQuery): { readonly sql: string; readonly params: readonly unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];
  const exact = (column: string, value: string | undefined) => {
    if (value === undefined) return;
    clauses.push(`${column} = ?`);
    params.push(value);
  };

  exact('target_id', query.targetId);
  exact('host_id', query.hostId);
  exact('actor_user_id', query.actorUserId);
  exact('action', query.action);
  exact('result', query.result);
  if (query.fromTimestamp !== undefined) {
    clauses.push('timestamp >= ?');
    params.push(query.fromTimestamp);
  }
  if (query.toTimestamp !== undefined) {
    clauses.push('timestamp <= ?');
    params.push(query.toTimestamp);
  }

  return {
    sql: clauses.length === 0 ? '' : `WHERE ${clauses.join(' AND ')}`,
    params,
  };
}

export class SqliteAuditQueryRepository {
  constructor(private readonly database: DatabaseConnection) {}

  query(query: StoredAuditQuery): readonly StoredAuditEvent[] {
    const where = whereClause(query);
    return this.database.prepare(`
      SELECT id, timestamp, actor_user_id, host_id, target_id, action,
             parameters_redacted_json, result, exit_code, error_class, job_id
      FROM audit_events
      ${where.sql}
      ORDER BY timestamp DESC, id DESC
      LIMIT ? OFFSET ?
    `).all(...where.params, query.limit, query.offset).map(mapAuditEvent);
  }

  purgeOlderThan(cutoffTimestamp: string, maxRows: number): number {
    return this.database.prepare(`
      DELETE FROM audit_events
      WHERE id IN (
        SELECT id FROM audit_events
        WHERE timestamp < ?
        ORDER BY timestamp ASC, id ASC
        LIMIT ?
      )
    `).run(cutoffTimestamp, maxRows).changes;
  }
}
