import {
  useCallback,
  useEffect,
  useState,
} from 'react';
import { ApiError, type TargetCatalogEntry } from './api.js';
import {
  manualRollbackApi,
  type ManualRollbackCandidate,
  type ManualRollbackResult,
  type RollbackUnavailableReason,
} from './manual-rollback-api.js';
import { manualRollbackConfirmationReady } from './manual-rollback.js';
import { formatTimestamp } from './format.js';
import { shortDigest } from './update.js';
import './update.css';

interface ManualRollbackPanelProps {
  readonly target: TargetCatalogEntry;
  readonly disabled?: boolean;
  readonly onBusyChange: (busy: boolean) => void;
  readonly onSignedOut: () => void;
  readonly onRolledBack: () => Promise<void> | void;
}

function messageForReason(reason: RollbackUnavailableReason | null): string {
  if (reason === 'TARGET_BINDING_CHANGED') {
    return 'The target no longer matches the container produced by the last successful update. The server will not reuse stale rollback authority.';
  }
  return 'No successful update with authenticated rollback authority is available for this target.';
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return `${error.code}: ${error.message}`;
  if (error instanceof Error) return error.message;
  return 'Unexpected rollback error.';
}

function Metric({ label, value, title }: {
  readonly label: string;
  readonly value: string;
  readonly title?: string;
}) {
  return (
    <div className="update-metric">
      <dt>{label}</dt>
      <dd className="update-mono" title={title}>{value}</dd>
    </div>
  );
}

export default function ManualRollbackPanel({
  target,
  disabled = false,
  onBusyChange,
  onSignedOut,
  onRolledBack,
}: ManualRollbackPanelProps) {
  const [candidate, setCandidate] = useState<ManualRollbackCandidate | null>(null);
  const [unavailableReason, setUnavailableReason] = useState<RollbackUnavailableReason | null>(null);
  const [loading, setLoading] = useState(true);
  const [executing, setExecuting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ManualRollbackResult | null>(null);
  const [typedTargetName, setTypedTargetName] = useState('');
  const [boundaryAcknowledged, setBoundaryAcknowledged] = useState(false);

  useEffect(() => {
    onBusyChange(executing);
    return () => onBusyChange(false);
  }, [executing, onBusyChange]);

  const loadCandidate = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await manualRollbackApi.candidate(target.id);
      setCandidate(response.candidate);
      setUnavailableReason(response.reason);
      setTypedTargetName('');
      setBoundaryAcknowledged(false);
    } catch (loadError) {
      if (loadError instanceof ApiError && loadError.status === 401) {
        onSignedOut();
        return;
      }
      setCandidate(null);
      setUnavailableReason(null);
      setError(errorMessage(loadError));
    } finally {
      setLoading(false);
    }
  }, [onSignedOut, target.id]);

  useEffect(() => {
    setResult(null);
    void loadCandidate();
  }, [loadCandidate]);

  const confirmationReady = candidate
    ? manualRollbackConfirmationReady(target.displayName, typedTargetName, boundaryAcknowledged)
    : false;

  async function execute(): Promise<void> {
    if (!candidate || !confirmationReady || disabled || executing) return;
    setExecuting(true);
    setError(null);
    setResult(null);
    try {
      const response = await manualRollbackApi.execute(target.id, candidate);
      setResult(response.rollback);
      await onRolledBack();
      await loadCandidate();
    } catch (executeError) {
      if (executeError instanceof ApiError && executeError.status === 401) {
        onSignedOut();
        return;
      }
      setError(errorMessage(executeError));
      // Never auto-retry an ambiguous mutation. Refresh only read-only target/candidate state.
      await onRolledBack();
      await loadCandidate();
    } finally {
      setExecuting(false);
    }
  }

  return (
    <section className="update-panel" aria-labelledby="manual-rollback-title">
      <div className="update-heading">
        <div>
          <p className="eyebrow">Controlled recovery</p>
          <h2 id="manual-rollback-title">Manual rollback</h2>
          <p className="muted">
            The rollback target is derived only from the last successful update, its persisted intent and its authenticated encrypted snapshot.
          </p>
        </div>
        <span className="update-target">{target.displayName}</span>
      </div>

      {loading ? (
        <div className="update-progress" role="status">
          <span className="update-spinner" aria-hidden="true" />
          <div>
            <strong>Checking rollback authority…</strong>
            <p>The server is validating the update history, snapshot, exact digests and current target binding.</p>
          </div>
        </div>
      ) : null}

      {!loading && !candidate && !error ? (
        <div className="update-eligibility update-eligibility-blocked">
          <strong>Manual rollback unavailable</strong>
          <span>{messageForReason(unavailableReason)}</span>
          <button className="secondary-button" disabled={disabled} onClick={() => void loadCandidate()} type="button">
            Check again
          </button>
        </div>
      ) : null}

      {candidate ? (
        <div className="update-review">
          <div className="update-section-heading">
            <div>
              <span className="update-step">R</span>
              <div>
                <strong>Server-derived rollback candidate</strong>
                <p>Source update completed {formatTimestamp(candidate.updatedAt)}</p>
              </div>
            </div>
            <span className="status-pill status-ok">Verified authority</span>
          </div>

          <dl className="update-metrics">
            <Metric label="Current container" value={candidate.currentContainerId} title={candidate.currentContainerId} />
            <Metric label="Previous container" value={candidate.previousContainerId} title={candidate.previousContainerId} />
            <Metric label="Current digest" value={shortDigest(candidate.currentDigest)} title={candidate.currentDigest} />
            <Metric label="Rollback digest" value={shortDigest(candidate.rollbackDigest)} title={candidate.rollbackDigest} />
            <Metric label="Compose service" value={candidate.composeService} />
            <Metric label="Source update job" value={candidate.sourceUpdateJobId} title={candidate.sourceUpdateJobId} />
          </dl>

          <div className="update-warning update-warning-strong" role="alert">
            <strong>Model data volumes are not rolled back</strong>
            <p>{candidate.modelVolumeBackup.warning}</p>
            <p className="update-small">Only the previous container/runtime configuration and exact image digest are restored.</p>
          </div>

          <label className="update-check">
            <input
              checked={boundaryAcknowledged}
              disabled={disabled || executing}
              onChange={(event) => setBoundaryAcknowledged(event.target.checked)}
              type="checkbox"
            />
            <span>I understand that model data volumes are not backed up or restored by this rollback.</span>
          </label>

          <label className="update-confirm-name">
            Type <strong>{target.displayName}</strong> to confirm this exact target
            <input
              autoComplete="off"
              disabled={disabled || executing}
              onChange={(event) => setTypedTargetName(event.target.value)}
              placeholder={target.displayName}
              spellCheck={false}
              value={typedTargetName}
            />
          </label>

          <div className="update-action-row update-action-row-end">
            <button
              className="secondary-button"
              disabled={disabled || executing}
              onClick={() => void loadCandidate()}
              type="button"
            >
              Revalidate
            </button>
            <button
              className="danger-button"
              disabled={disabled || executing || !confirmationReady}
              onClick={() => void execute()}
              type="button"
            >
              {executing ? 'Rolling back…' : 'Rollback to previous image'}
            </button>
          </div>
        </div>
      ) : null}

      {executing ? (
        <div className="update-progress update-progress-danger" role="status">
          <span className="update-spinner" aria-hidden="true" />
          <div>
            <strong>Verified rollback in progress…</strong>
            <p>The server revalidates Compose, uses only the exact local rollback digest, rebinds the target and verifies Ollama health. This mutation is never auto-retried by the browser.</p>
          </div>
        </div>
      ) : null}

      {result ? (
        <div className="update-success" role="status">
          <div>
            <strong>Rollback completed and health-verified</strong>
            <p>The selected target now points to the verified rollback container.</p>
          </div>
          <dl className="update-metrics compact">
            <Metric label="Job" value={result.jobId} title={result.jobId} />
            <Metric label="Container" value={result.containerId} title={result.containerId} />
            <Metric label="Rollback digest" value={shortDigest(result.rollbackDigest)} title={result.rollbackDigest} />
          </dl>
        </div>
      ) : null}

      {error ? (
        <div className="update-error" role="alert">
          <strong>Manual rollback stopped</strong>
          <p>{error}</p>
          <p className="update-small">No automatic browser retry is performed. The server recovery journal remains authoritative after reconnect or restart.</p>
          <button className="secondary-button" disabled={disabled || executing} onClick={() => void loadCandidate()} type="button">
            Re-check authority
          </button>
        </div>
      ) : null}
    </section>
  );
}
