import type { StoredAuditEvent } from '@orc/core';
import {
  SqliteAuditQueryRepository,
  type StoredAuditQuery,
} from '@orc/db/audit-query';
import { redactAuditParameters } from './audit.js';

const HISTORY_DEFAULT_LIMIT = 50;
const HISTORY_MAX_LIMIT = 100;
const HISTORY_MAX_OFFSET = 10_000;
const EXPORT_MAX_ROWS = 5_000;
const EXPORT_MAX_BYTES = 4 * 1024 * 1024;
const PARAMETERS_MAX_BYTES = 32 * 1024;
const DEFAULT_RETENTION_DAYS = 90;
const DEFAULT_RETENTION_BATCH_SIZE = 1_000;
const DEFAULT_RETENTION_MAX_BATCHES = 10;
const DAY_MS = 24 * 60 * 60 * 1_000;

export class AuditReadError extends Error {
  constructor(
    readonly code: string,
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

export interface AuditHttpQuery {
  readonly targetId?: unknown;
  readonly hostId?: unknown;
  readonly actorUserId?: unknown;
  readonly action?: unknown;
  readonly result?: unknown;
  readonly from?: unknown;
  readonly to?: unknown;
  readonly limit?: unknown;
  readonly offset?: unknown;
}

export interface AuditEventView {
  readonly id: string;
  readonly timestamp: string;
  readonly actorUserId: string;
  readonly hostId: string | null;
  readonly targetId: string | null;
  readonly action: string;
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly result: string;
  readonly exitCode: number | null;
  readonly errorClass: string | null;
  readonly jobId: string | null;
}

export interface AuditFiltersView {
  readonly targetId?: string;
  readonly hostId?: string;
  readonly actorUserId?: string;
  readonly action?: string;
  readonly result?: string;
  readonly from?: string;
  readonly to?: string;
}

interface NormalizedAuditQuery {
  readonly filters: AuditFiltersView;
  readonly stored: Omit<StoredAuditQuery, 'limit' | 'offset'>;
}

export interface AuditReadServiceOptions {
  readonly retentionDays?: number;
  readonly retentionBatchSize?: number;
  readonly retentionMaxBatches?: number;
}

function optionalString(value: unknown, name: string, maxLength: number): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') {
    throw new AuditReadError('AUDIT_QUERY_INVALID', 400, `${name} must be a string.`);
  }
  const normalized = value.trim();
  if (!normalized) return undefined;
  if (normalized.length > maxLength) {
    throw new AuditReadError('AUDIT_QUERY_INVALID', 400, `${name} is too long.`);
  }
  return normalized;
}

function optionalTimestamp(value: unknown, name: string): string | undefined {
  const text = optionalString(value, name, 80);
  if (text === undefined) return undefined;
  const epoch = Date.parse(text);
  if (!Number.isFinite(epoch)) {
    throw new AuditReadError('AUDIT_QUERY_INVALID', 400, `${name} must be a valid timestamp.`);
  }
  return new Date(epoch).toISOString();
}

function boundedInteger(value: unknown, name: string, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined || value === null || value === '') return fallback;
  const text = typeof value === 'number' ? String(value) : value;
  if (typeof text !== 'string' || !/^\d+$/u.test(text)) {
    throw new AuditReadError('AUDIT_QUERY_INVALID', 400, `${name} must be an integer.`);
  }
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new AuditReadError('AUDIT_QUERY_INVALID', 400, `${name} must be between ${minimum} and ${maximum}.`);
  }
  return parsed;
}

function normalizeAuditQuery(input: AuditHttpQuery): NormalizedAuditQuery {
  const filters: AuditFiltersView = {
    targetId: optionalString(input.targetId, 'targetId', 200),
    hostId: optionalString(input.hostId, 'hostId', 200),
    actorUserId: optionalString(input.actorUserId, 'actorUserId', 200),
    action: optionalString(input.action, 'action', 160),
    result: optionalString(input.result, 'result', 120),
    from: optionalTimestamp(input.from, 'from'),
    to: optionalTimestamp(input.to, 'to'),
  };
  if (filters.from !== undefined && filters.to !== undefined && filters.from > filters.to) {
    throw new AuditReadError('AUDIT_QUERY_INVALID', 400, 'from must not be after to.');
  }
  return {
    filters,
    stored: {
      targetId: filters.targetId,
      hostId: filters.hostId,
      actorUserId: filters.actorUserId,
      action: filters.action,
      result: filters.result,
      fromTimestamp: filters.from,
      toTimestamp: filters.to,
    },
  };
}

function unavailableParameters(reason: 'malformed_json' | 'invalid_shape' | 'too_large'): Readonly<Record<string, unknown>> {
  return Object.freeze({
    _redacted: true,
    _status: 'unavailable',
    _reason: reason,
  });
}

export function parseStoredAuditParameters(raw: string): Readonly<Record<string, unknown>> {
  if (Buffer.byteLength(raw, 'utf8') > PARAMETERS_MAX_BYTES) return unavailableParameters('too_large');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return unavailableParameters('malformed_json');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return unavailableParameters('invalid_shape');
  return redactAuditParameters(parsed as Readonly<Record<string, unknown>>);
}

function publicEvent(event: StoredAuditEvent): AuditEventView {
  return {
    id: event.id,
    timestamp: event.timestamp,
    actorUserId: event.actorUserId,
    hostId: event.hostId,
    targetId: event.targetId,
    action: event.action,
    parameters: parseStoredAuditParameters(event.parametersRedactedJson),
    result: event.result,
    exitCode: event.exitCode,
    errorClass: event.errorClass,
    jobId: event.jobId,
  };
}

function spreadsheetSafe(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = typeof value === 'string' ? value : String(value);
  return /^[\t\r\n ]*[=+\-@]/u.test(text) ? `'${text}` : text;
}

function csvCell(value: unknown): string {
  return `"${spreadsheetSafe(value).replaceAll('"', '""')}"`;
}

export function auditEventsToCsv(events: readonly AuditEventView[]): string {
  const columns = [
    'timestamp',
    'actorUserId',
    'hostId',
    'targetId',
    'action',
    'result',
    'exitCode',
    'errorClass',
    'jobId',
    'parameters',
  ] as const;
  const lines = [columns.map(csvCell).join(',')];
  for (const event of events) {
    lines.push([
      event.timestamp,
      event.actorUserId,
      event.hostId,
      event.targetId,
      event.action,
      event.result,
      event.exitCode,
      event.errorClass,
      event.jobId,
      JSON.stringify(event.parameters),
    ].map(csvCell).join(','));
  }
  return `${lines.join('\r\n')}\r\n`;
}

function enforceExportSize(body: string): string {
  if (Buffer.byteLength(body, 'utf8') > EXPORT_MAX_BYTES) {
    throw new AuditReadError('AUDIT_EXPORT_TOO_LARGE', 413, 'Audit export exceeds the server byte limit. Narrow the filters.');
  }
  return body;
}

export class AuditReadService {
  private readonly retentionDays: number;
  private readonly retentionBatchSize: number;
  private readonly retentionMaxBatches: number;

  constructor(
    private readonly repository: SqliteAuditQueryRepository,
    private readonly now: () => Date = () => new Date(),
    options: AuditReadServiceOptions = {},
  ) {
    this.retentionDays = options.retentionDays ?? DEFAULT_RETENTION_DAYS;
    this.retentionBatchSize = options.retentionBatchSize ?? DEFAULT_RETENTION_BATCH_SIZE;
    this.retentionMaxBatches = options.retentionMaxBatches ?? DEFAULT_RETENTION_MAX_BATCHES;
    if (!Number.isInteger(this.retentionDays) || this.retentionDays < 1 || this.retentionDays > 3_650) {
      throw new Error('Audit retention days must be an integer between 1 and 3650.');
    }
    if (!Number.isInteger(this.retentionBatchSize) || this.retentionBatchSize < 1 || this.retentionBatchSize > 5_000) {
      throw new Error('Audit retention batch size must be an integer between 1 and 5000.');
    }
    if (!Number.isInteger(this.retentionMaxBatches) || this.retentionMaxBatches < 1 || this.retentionMaxBatches > 100) {
      throw new Error('Audit retention max batches must be an integer between 1 and 100.');
    }
  }

  history(input: AuditHttpQuery) {
    const normalized = normalizeAuditQuery(input);
    const limit = boundedInteger(input.limit, 'limit', HISTORY_DEFAULT_LIMIT, 1, HISTORY_MAX_LIMIT);
    const offset = boundedInteger(input.offset, 'offset', 0, 0, HISTORY_MAX_OFFSET);
    const rows = this.repository.query({
      ...normalized.stored,
      limit: limit + 1,
      offset,
    });
    return {
      redacted: true as const,
      filters: normalized.filters,
      events: rows.slice(0, limit).map(publicEvent),
      page: {
        limit,
        offset,
        hasMore: rows.length > limit,
      },
    };
  }

  exportJson(input: AuditHttpQuery): string {
    const normalized = normalizeAuditQuery(input);
    const events = this.exportEvents(normalized);
    return enforceExportSize(JSON.stringify({
      generatedAt: this.now().toISOString(),
      redacted: true,
      filters: normalized.filters,
      events,
    }, null, 2));
  }

  exportCsv(input: AuditHttpQuery): string {
    const normalized = normalizeAuditQuery(input);
    return enforceExportSize(auditEventsToCsv(this.exportEvents(normalized)));
  }

  purgeExpired() {
    const cutoff = new Date(this.now().getTime() - this.retentionDays * DAY_MS).toISOString();
    let purged = 0;
    let complete = false;
    for (let batch = 0; batch < this.retentionMaxBatches; batch += 1) {
      const removed = this.repository.purgeOlderThan(cutoff, this.retentionBatchSize);
      purged += removed;
      if (removed < this.retentionBatchSize) {
        complete = true;
        break;
      }
    }
    return { cutoff, purged, complete };
  }

  private exportEvents(normalized: NormalizedAuditQuery): readonly AuditEventView[] {
    const rows = this.repository.query({
      ...normalized.stored,
      limit: EXPORT_MAX_ROWS + 1,
      offset: 0,
    });
    if (rows.length > EXPORT_MAX_ROWS) {
      throw new AuditReadError('AUDIT_EXPORT_TOO_LARGE', 413, `Audit export is limited to ${EXPORT_MAX_ROWS} rows. Narrow the filters.`);
    }
    return rows.map(publicEvent);
  }
}
