import {
  useEffect,
  useMemo,
  useState,
} from 'react';
import {
  ApiError,
  api,
  type PublicUpdateSnapshot,
  type TargetCatalogEntry,
  type UpdateExecutionIntent,
  type UpdateExecutionResult,
  type UpdatePlan,
  type UpdateStrategyResult,
} from './api.js';
import { displayValue, formatTimestamp } from './format.js';
import {
  evaluateUpdateEligibility,
  platformLabel,
  shortDigest,
  updateConfirmationReady,
} from './update.js';
import './update.css';

type UpdatePhase =
  | 'idle'
  | 'preparing'
  | 'review'
  | 'intent-creating'
  | 'confirm'
  | 'executing'
  | 'success'
  | 'error';

interface UpdatePanelProps {
  readonly target: TargetCatalogEntry;
  readonly onBusyChange: (busy: boolean) => void;
  readonly onSignedOut: () => void;
  readonly onUpdated: () => Promise<void> | void;
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return `${error.code}: ${error.message}`;
  if (error instanceof Error) return error.message;
  return 'Unexpected update error.';
}

function Metric({ label, value, mono = false, title }: {
  readonly label: string;
  readonly value: string;
  readonly mono?: boolean;
  readonly title?: string;
}) {
  return (
    <div className="update-metric">
      <dt>{label}</dt>
      <dd className={mono ? 'update-mono' : undefined} title={title}>{value}</dd>
    </div>
  );
}

function StrategySummary({ strategyResult }: { readonly strategyResult: UpdateStrategyResult }) {
  const strategy = strategyResult.strategy;
  if (strategy.type === 'compose') {
    return (
      <div className="update-strategy update-strategy-ready">
        <div>
          <strong>Validated Docker Compose strategy</strong>
          <span>{strategy.projectName} / {strategy.service}</span>
        </div>
        <dl className="update-metrics compact">
          <Metric label="Compose" value={strategy.composeVersion} />
          <Metric label="Service" value={strategy.service} mono />
          <Metric label="Project" value={strategy.projectName} mono />
          <Metric label="Config files" value={String(strategy.configFiles.length)} />
        </dl>
      </div>
    );
  }
  return (
    <div className="update-strategy update-strategy-blocked">
      <div>
        <strong>Standalone reconstruction is not executable in this update slice</strong>
        <span>The server will not create an execution intent for this strategy.</span>
      </div>
      <dl className="update-metrics compact">
        <Metric label="Mounts" value={String(strategy.summary.mountCount)} />
        <Metric label="Port bindings" value={String(strategy.summary.portBindingCount)} />
        <Metric label="Networks" value={strategy.summary.networkNames.join(', ') || 'None'} />
        <Metric label="Restart policy" value={displayValue(strategy.summary.restartPolicy)} />
      </dl>
      {strategy.unsupportedFields.length > 0 ? (
        <p className="update-small">Unsupported fields: <code>{strategy.unsupportedFields.join(', ')}</code></p>
      ) : null}
    </div>
  );
}

export default function UpdatePanel({ target, onBusyChange, onSignedOut, onUpdated }: UpdatePanelProps) {
  const [phase, setPhase] = useState<UpdatePhase>('idle');
  const [snapshot, setSnapshot] = useState<PublicUpdateSnapshot | null>(null);
  const [plan, setPlan] = useState<UpdatePlan | null>(null);
  const [strategy, setStrategy] = useState<UpdateStrategyResult | null>(null);
  const [intent, setIntent] = useState<UpdateExecutionIntent | null>(null);
  const [result, setResult] = useState<UpdateExecutionResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [typedTargetName, setTypedTargetName] = useState('');
  const [rollbackAcknowledged, setRollbackAcknowledged] = useState(false);

  const busy = phase === 'preparing' || phase === 'intent-creating' || phase === 'executing';
  useEffect(() => {
    onBusyChange(busy);
    return () => onBusyChange(false);
  }, [busy, onBusyChange]);

  const eligibility = useMemo(
    () => plan && strategy ? evaluateUpdateEligibility(plan, strategy) : null,
    [plan, strategy],
  );
  const confirmationReady = intent
    ? updateConfirmationReady(target.displayName, typedTargetName, rollbackAcknowledged)
    : false;

  function clearTransactionState(): void {
    setSnapshot(null);
    setPlan(null);
    setStrategy(null);
    setIntent(null);
    setTypedTargetName('');
    setRollbackAcknowledged(false);
  }

  function reset(): void {
    clearTransactionState();
    setResult(null);
    setError(null);
    setPhase('idle');
  }

  function handleApiError(actionError: unknown, clearPlanning = false): void {
    if (actionError instanceof ApiError && actionError.status === 401) {
      onSignedOut();
      return;
    }
    if (clearPlanning) clearTransactionState();
    setError(errorMessage(actionError));
    setPhase('error');
  }

  async function prepare(): Promise<void> {
    clearTransactionState();
    setResult(null);
    setError(null);
    setPhase('preparing');
    try {
      const preflight = await api.updatePreflight(target.id);
      const snapshotValue = preflight.snapshot;
      setSnapshot(snapshotValue);
      const [planResponse, strategyResponse] = await Promise.all([
        api.updatePlan(target.id, snapshotValue.id),
        api.updateStrategy(target.id, snapshotValue.id),
      ]);
      setPlan(planResponse.plan);
      setStrategy(strategyResponse);
      setPhase('review');
    } catch (prepareError) {
      handleApiError(prepareError, true);
    }
  }

  async function createIntent(): Promise<void> {
    if (!snapshot || !eligibility?.executable) return;
    setError(null);
    setIntent(null);
    setTypedTargetName('');
    setRollbackAcknowledged(false);
    setPhase('intent-creating');
    try {
      const response = await api.createUpdateExecutionIntent(target.id, snapshot.id);
      setIntent(response.intent);
      setPhase('confirm');
    } catch (intentError) {
      handleApiError(intentError, true);
    }
  }

  async function execute(): Promise<void> {
    if (!intent || !confirmationReady) return;
    setError(null);
    setPhase('executing');
    try {
      const response = await api.executeUpdate(target.id, intent.intentId);
      const updateResult = response.update;
      clearTransactionState();
      setResult(updateResult);
      setPhase('success');
      await onUpdated();
    } catch (executeError) {
      // Never auto-retry a mutation whose client connection or remote outcome may be ambiguous.
      handleApiError(executeError, true);
      await onUpdated();
    }
  }

  return (
    <section className="update-panel" aria-labelledby="container-update-title">
      <div className="update-heading">
        <div>
          <p className="eyebrow">Controlled mutation</p>
          <h2 id="container-update-title">Container update</h2>
          <p className="muted">
            The server captures rollback state, resolves the registry candidate and validates Docker Compose before any replacement is allowed.
          </p>
        </div>
        <span className="update-target">{target.displayName}</span>
      </div>

      {phase === 'idle' ? (
        <div className="update-action-row">
          <div>
            <strong>Check for a safe update</strong>
            <p className="muted">Creates a fresh encrypted rollback snapshot, then performs read-only planning and strategy validation.</p>
          </div>
          <button className="primary-button update-primary" onClick={() => void prepare()} type="button">
            Check update
          </button>
        </div>
      ) : null}

      {phase === 'preparing' ? (
        <div className="update-progress" role="status">
          <span className="update-spinner" aria-hidden="true" />
          <div>
            <strong>Preparing a fresh update plan…</strong>
            <p>Capturing rollback state and validating the current remote configuration.</p>
          </div>
        </div>
      ) : null}

      {snapshot && plan && strategy && (phase === 'review' || phase === 'intent-creating') ? (
        <div className="update-review">
          <div className="update-section-heading">
            <div>
              <span className="update-step">1</span>
              <div>
                <strong>Server-generated plan</strong>
                <p>Snapshot {formatTimestamp(snapshot.createdAt)}</p>
              </div>
            </div>
            <span className={`status-pill ${eligibility?.executable ? 'status-ok' : 'status-muted'}`}>
              {eligibility?.executable ? 'Executable' : 'Blocked'}
            </span>
          </div>

          <dl className="update-metrics">
            <Metric label="Configured image" value={plan.imageReference} mono title={plan.imageReference} />
            <Metric label="Platform" value={platformLabel(plan.platform)} />
            <Metric label="Current digest" value={shortDigest(plan.currentDigest)} mono title={plan.currentDigest} />
            <Metric label="Candidate digest" value={shortDigest(plan.candidateDigest)} mono title={plan.candidateDigest} />
            <Metric label="Current Ollama" value={displayValue(plan.currentOllamaVersion)} />
            <Metric label="Candidate image" value={displayValue(plan.candidateImageVersion)} />
            <Metric label="Source pinned" value={plan.pinned ? 'Yes' : 'No'} />
            <Metric label="Update available" value={plan.updateAvailable ? 'Yes' : 'No'} />
          </dl>

          <StrategySummary strategyResult={strategy} />

          <div className="update-warning" role="note">
            <strong>Rollback boundary</strong>
            <p>{plan.modelVolumeBackup.warning}</p>
            <p className="update-small">Container/runtime configuration can be restored; model data volumes are not included in this snapshot.</p>
          </div>

          <div className={`update-eligibility ${eligibility?.executable ? 'update-eligibility-ready' : 'update-eligibility-blocked'}`}>
            <strong>{eligibility?.executable ? 'Ready for revalidation' : 'Update cannot execute'}</strong>
            <span>{eligibility?.message}</span>
          </div>

          <div className="update-action-row update-action-row-end">
            <button className="secondary-button" disabled={phase === 'intent-creating'} onClick={reset} type="button">Discard plan</button>
            {eligibility?.executable ? (
              <button className="primary-button update-primary" disabled={phase === 'intent-creating'} onClick={() => void createIntent()} type="button">
                {phase === 'intent-creating' ? 'Revalidating…' : 'Prepare confirmation'}
              </button>
            ) : (
              <button className="secondary-button" onClick={() => void prepare()} type="button">Check again</button>
            )}
          </div>
        </div>
      ) : null}

      {phase === 'confirm' && intent && plan ? (
        <div className="update-confirm">
          <div className="update-section-heading">
            <div>
              <span className="update-step">2</span>
              <div>
                <strong>Confirm the revalidated transaction</strong>
                <p>Intent created {formatTimestamp(intent.createdAt)}</p>
              </div>
            </div>
            <span className="status-pill status-muted">Mutation</span>
          </div>

          <p className="update-small">
            The server recomputed the plan and Compose strategy before issuing this intent. Execution is pinned to the candidate below.
          </p>
          <dl className="update-metrics">
            <Metric label="Target" value={target.displayName} />
            <Metric label="Compose service" value={intent.composeService} mono />
            <Metric label="Image" value={intent.imageReference} mono title={intent.imageReference} />
            <Metric label="Candidate image version" value={displayValue(intent.candidateImageVersion)} />
            <Metric label="Current digest" value={shortDigest(intent.currentDigest)} mono title={intent.currentDigest} />
            <Metric label="Candidate digest" value={shortDigest(intent.candidateDigest)} mono title={intent.candidateDigest} />
            <Metric label="Exact candidate" value={shortDigest(intent.exactCandidateReference)} mono title={intent.exactCandidateReference} />
            <Metric label="Intent ID" value={intent.intentId} mono title={intent.intentId} />
          </dl>

          <div className="update-warning update-warning-strong" role="alert">
            <strong>Model data volumes are not backed up</strong>
            <p>{plan.modelVolumeBackup.warning}</p>
          </div>

          <label className="update-check">
            <input
              checked={rollbackAcknowledged}
              onChange={(event) => setRollbackAcknowledged(event.target.checked)}
              type="checkbox"
            />
            <span>I understand the rollback boundary and that model data volumes are not backed up by this operation.</span>
          </label>

          <label className="update-confirm-name">
            Type <strong>{target.displayName}</strong> to confirm this exact target
            <input
              autoComplete="off"
              onChange={(event) => setTypedTargetName(event.target.value)}
              placeholder={target.displayName}
              spellCheck={false}
              value={typedTargetName}
            />
          </label>

          <div className="update-action-row update-action-row-end">
            <button className="secondary-button" onClick={reset} type="button">Cancel</button>
            <button
              className="danger-button"
              disabled={!confirmationReady}
              onClick={() => void execute()}
              type="button"
            >
              Execute update
            </button>
          </div>
        </div>
      ) : null}

      {phase === 'executing' ? (
        <div className="update-progress update-progress-danger" role="status">
          <span className="update-spinner" aria-hidden="true" />
          <div>
            <strong>Update transaction in progress…</strong>
            <p>The server is performing an exact-digest replacement, health verification and automatic rollback if required. Do not retry this mutation automatically.</p>
          </div>
        </div>
      ) : null}

      {phase === 'success' && result ? (
        <div className="update-success" role="status">
          <div>
            <strong>Update completed and health-verified</strong>
            <p>Target status has been refreshed. The new container binding is active.</p>
          </div>
          <dl className="update-metrics compact">
            <Metric label="Job" value={result.jobId} mono />
            <Metric label="Container" value={result.containerId} mono title={result.containerId} />
            <Metric label="Candidate digest" value={shortDigest(result.candidateDigest)} mono title={result.candidateDigest} />
            <Metric label="Outcome" value={result.outcome} />
          </dl>
          <button className="secondary-button" onClick={reset} type="button">Done</button>
        </div>
      ) : null}

      {phase === 'error' && error ? (
        <div className="update-error" role="alert">
          <strong>Update workflow stopped</strong>
          <p>{error}</p>
          <p className="update-small">No automatic retry is performed. Remote status was refreshed; create a fresh snapshot and plan before trying again.</p>
          <button className="secondary-button" onClick={() => void prepare()} type="button">Prepare fresh plan</button>
        </div>
      ) : null}
    </section>
  );
}
