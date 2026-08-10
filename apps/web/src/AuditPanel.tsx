import {
  type FormEvent,
  useCallback,
  useEffect,
  useState,
} from 'react';
import { ApiError, type TargetCatalogEntry } from './api.js';
import {
  auditApi,
  type AuditEventView,
  type AuditFilters,
} from './audit-api.js';
import { displayValue, formatTimestamp } from './format.js';

const PAGE_SIZE = 25;

interface AuditPanelProps {
  readonly targets: readonly TargetCatalogEntry[];
  readonly onSignedOut: () => void;
}

interface DraftFilters {
  readonly targetId: string;
  readonly actorUserId: string;
  readonly action: string;
  readonly result: string;
  readonly from: string;
  readonly to: string;
}

const EMPTY_FILTERS: DraftFilters = {
  targetId: '',
  actorUserId: '',
  action: '',
  result: '',
  from: '',
  to: '',
};

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return `${error.code}: ${error.message}`;
  if (error instanceof Error) return error.message;
  return 'Unexpected audit error.';
}

function localDateTimeToIso(value: string): string | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return undefined;
  return parsed.toISOString();
}

function normalizedFilters(draft: DraftFilters): AuditFilters {
  return {
    targetId: draft.targetId || undefined,
    actorUserId: draft.actorUserId.trim() || undefined,
    action: draft.action.trim() || undefined,
    result: draft.result.trim() || undefined,
    from: localDateTimeToIso(draft.from),
    to: localDateTimeToIso(draft.to),
  };
}

function resultClass(result: string): string {
  if (result === 'succeeded' || result === 'success' || result === 'ok') return 'status-ok';
  if (result === 'failed' || result === 'error') return 'status-danger';
  return 'status-muted';
}

function AuditEventCard({ event }: { readonly event: AuditEventView }) {
  return (
    <article className="device-card">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">{formatTimestamp(event.timestamp)}</p>
          <h3>{event.action}</h3>
        </div>
        <span className={`status-pill ${resultClass(event.result)}`}>{event.result}</span>
      </div>
      <dl className="metrics-grid compact">
        <div className="metric"><dt>Actor</dt><dd>{event.actorUserId}</dd></div>
        <div className="metric"><dt>Target</dt><dd>{displayValue(event.targetId)}</dd></div>
        <div className="metric"><dt>Host</dt><dd>{displayValue(event.hostId)}</dd></div>
        <div className="metric"><dt>Job</dt><dd>{displayValue(event.jobId)}</dd></div>
        <div className="metric"><dt>Exit code</dt><dd>{event.exitCode === null ? 'Unavailable' : String(event.exitCode)}</dd></div>
        <div className="metric"><dt>Error</dt><dd>{displayValue(event.errorClass)}</dd></div>
      </dl>
      <details style={{ marginTop: '1rem' }}>
        <summary>Redacted parameters</summary>
        <pre style={{ marginBottom: 0, overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' }}>
          <code>{JSON.stringify(event.parameters, null, 2)}</code>
        </pre>
      </details>
    </article>
  );
}

export default function AuditPanel({ targets, onSignedOut }: AuditPanelProps) {
  const [draft, setDraft] = useState<DraftFilters>(EMPTY_FILTERS);
  const [filters, setFilters] = useState<AuditFilters>({});
  const [events, setEvents] = useState<readonly AuditEventView[]>([]);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [busy, setBusy] = useState(true);
  const [exportBusy, setExportBusy] = useState<'json' | 'csv' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await auditApi.history(filters, PAGE_SIZE, offset);
      setEvents(response.events);
      setHasMore(response.page.hasMore);
    } catch (loadError) {
      if (loadError instanceof ApiError && loadError.status === 401) {
        onSignedOut();
        return;
      }
      setEvents([]);
      setHasMore(false);
      setError(errorMessage(loadError));
    } finally {
      setBusy(false);
    }
  }, [filters, offset, onSignedOut]);

  useEffect(() => { void load(); }, [load]);

  function apply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setOffset(0);
    setFilters(normalizedFilters(draft));
  }

  function reset() {
    setDraft(EMPTY_FILTERS);
    setOffset(0);
    setFilters({});
  }

  async function exportAudit(format: 'json' | 'csv') {
    setExportBusy(format);
    setError(null);
    try {
      const blob = await auditApi.export(filters, format);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `ollama-remote-control-audit.${format}`;
      document.body.append(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (exportError) {
      if (exportError instanceof ApiError && exportError.status === 401) {
        onSignedOut();
        return;
      }
      setError(errorMessage(exportError));
    } finally {
      setExportBusy(null);
    }
  }

  return (
    <section className="panel" aria-labelledby="audit-title" style={{ marginTop: '1rem' }}>
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Operator audit</p>
          <h2 id="audit-title">Audit history</h2>
          <p className="muted" style={{ marginBottom: 0 }}>
            Parameters are server-side redacted before persistence and defensively redacted again when displayed or exported.
          </p>
        </div>
        <span className="status-pill status-ok">Redacted</span>
      </div>

      <form onSubmit={apply}>
        <div className="metrics-grid">
          <label>
            Target
            <select
              onChange={(event) => setDraft((current) => ({ ...current, targetId: event.target.value }))}
              value={draft.targetId}
            >
              <option value="">All targets</option>
              {targets.map((target) => <option key={target.id} value={target.id}>{target.displayName}</option>)}
            </select>
          </label>
          <label>
            Actor ID
            <input
              maxLength={200}
              onChange={(event) => setDraft((current) => ({ ...current, actorUserId: event.target.value }))}
              placeholder="Exact actor ID"
              value={draft.actorUserId}
            />
          </label>
          <label>
            Action
            <input
              maxLength={160}
              onChange={(event) => setDraft((current) => ({ ...current, action: event.target.value }))}
              placeholder="Exact action"
              value={draft.action}
            />
          </label>
          <label>
            Result
            <input
              maxLength={120}
              onChange={(event) => setDraft((current) => ({ ...current, result: event.target.value }))}
              placeholder="Exact result"
              value={draft.result}
            />
          </label>
          <label>
            From
            <input
              onChange={(event) => setDraft((current) => ({ ...current, from: event.target.value }))}
              type="datetime-local"
              value={draft.from}
            />
          </label>
          <label>
            To
            <input
              onChange={(event) => setDraft((current) => ({ ...current, to: event.target.value }))}
              type="datetime-local"
              value={draft.to}
            />
          </label>
        </div>
        <div className="user-actions" style={{ flexWrap: 'wrap', marginTop: '1rem' }}>
          <button className="secondary-button" disabled={busy} type="submit">Apply filters</button>
          <button className="secondary-button" disabled={busy} onClick={reset} type="button">Reset</button>
          <button className="secondary-button" disabled={exportBusy !== null} onClick={() => void exportAudit('json')} type="button">
            {exportBusy === 'json' ? 'Exporting…' : 'Export JSON'}
          </button>
          <button className="secondary-button" disabled={exportBusy !== null} onClick={() => void exportAudit('csv')} type="button">
            {exportBusy === 'csv' ? 'Exporting…' : 'Export CSV'}
          </button>
        </div>
      </form>

      {error ? <p className="error-box" role="alert" style={{ marginTop: '1rem' }}>{error}</p> : null}
      {busy ? <p className="loading-box" role="status" style={{ marginTop: '1rem' }}>Loading audit history…</p> : null}
      {!busy && events.length === 0 ? <p className="empty-state" style={{ marginTop: '1rem' }}>No audit events match the active filters.</p> : null}
      {!busy && events.length > 0 ? (
        <div className="device-list" aria-live="polite" style={{ marginTop: '1rem' }}>
          {events.map((event) => <AuditEventCard event={event} key={event.id} />)}
        </div>
      ) : null}

      <div className="user-actions" style={{ justifyContent: 'space-between', marginTop: '1rem' }}>
        <button
          className="secondary-button"
          disabled={busy || offset === 0}
          onClick={() => setOffset((current) => Math.max(0, current - PAGE_SIZE))}
          type="button"
        >
          Previous
        </button>
        <span className="muted">Rows {events.length === 0 ? 0 : offset + 1}–{offset + events.length}</span>
        <button
          className="secondary-button"
          disabled={busy || !hasMore}
          onClick={() => setOffset((current) => current + PAGE_SIZE)}
          type="button"
        >
          Next
        </button>
      </div>
    </section>
  );
}
