import { randomUUID } from 'node:crypto';
import type { AuditRepository, StoredAuditEvent } from '@orc/core';

const SENSITIVE_KEY = /(password|passphrase|private.?key|master.?key|secret|token|credential|authorization|cookie|session)/iu;
const REDACTED = '[REDACTED]';

function redactValue(value: unknown, seen: WeakSet<object>, depth: number): unknown {
  if (depth > 12) return '[MAX_DEPTH]';
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'undefined') return null;
  if (Array.isArray(value)) return value.map((item) => redactValue(item, seen, depth + 1));
  if (typeof value === 'object') {
    if (seen.has(value)) return '[CIRCULAR]';
    seen.add(value);
    const result: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      result[key] = SENSITIVE_KEY.test(key) ? REDACTED : redactValue(nested, seen, depth + 1);
    }
    return result;
  }
  return String(value);
}

export function redactAuditParameters(parameters: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  return redactValue(parameters, new WeakSet<object>(), 0) as Readonly<Record<string, unknown>>;
}

export interface AuditRecordInput {
  readonly actorUserId: string;
  readonly hostId?: string | null;
  readonly targetId?: string | null;
  readonly action: string;
  readonly parameters?: Readonly<Record<string, unknown>>;
  readonly result: string;
  readonly exitCode?: number | null;
  readonly errorClass?: string | null;
  readonly jobId?: string | null;
}

export class AuditService {
  constructor(
    private readonly repository: AuditRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  record(input: AuditRecordInput): StoredAuditEvent {
    const action = input.action.trim();
    if (!action || action.length > 160) throw new Error('Audit action is required and must be at most 160 characters.');
    const event: StoredAuditEvent = {
      id: randomUUID(),
      timestamp: this.now().toISOString(),
      actorUserId: input.actorUserId,
      hostId: input.hostId ?? null,
      targetId: input.targetId ?? null,
      action,
      parametersRedactedJson: JSON.stringify(redactAuditParameters(input.parameters ?? {})),
      result: input.result,
      exitCode: input.exitCode ?? null,
      errorClass: input.errorClass ?? null,
      jobId: input.jobId ?? null,
    };
    this.repository.append(event);
    return event;
  }

  forTarget(targetId: string): readonly StoredAuditEvent[] {
    return this.repository.listByTarget(targetId);
  }
}
