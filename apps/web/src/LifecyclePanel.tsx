import { useEffect, useState } from 'react';
import {
  ApiError,
  api,
  type ContainerLifecycleAction,
  type ContainerLifecycleResult,
  type TargetStatusResult,
} from './api.js';
import {
  availableLifecycleActions,
  lifecycleActionLabel,
  lifecycleActionNeedsConfirmation,
  lifecycleConfirmationReady,
} from './lifecycle.js';
import './lifecycle.css';

interface LifecyclePanelProps {
  readonly status: TargetStatusResult;
  readonly disabled: boolean;
  readonly onBusyChange: (busy: boolean) => void;
  readonly onSignedOut: () => void;
  readonly onChanged: () => Promise<void> | void;
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return `${error.code}: ${error.message}`;
  if (error instanceof Error) return error.message;
  return 'Unexpected container lifecycle error.';
}

export default function LifecyclePanel({
  status,
  disabled,
  onBusyChange,
  onSignedOut,
  onChanged,
}: LifecyclePanelProps) {
  const [executingAction, setExecutingAction] = useState<ContainerLifecycleAction | null>(null);
  const [pendingAction, setPendingAction] = useState<ContainerLifecycleAction | null>(null);
  const [typedTargetName, setTypedTargetName] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    readonly action: ContainerLifecycleAction;
    readonly response: ContainerLifecycleResult;
  } | null>(null);

  const busy = executingAction !== null;
  const target = status.target;
  const container = status.container;
  const actions = availableLifecycleActions(container.running);

  useEffect(() => {
    onBusyChange(busy);
    return () => onBusyChange(false);
  }, [busy, onBusyChange]);

  function resetConfirmation(): void {
    setPendingAction(null);
    setTypedTargetName('');
    setAcknowledged(false);
  }

  function requestAction(action: ContainerLifecycleAction): void {
    if (disabled || busy) return;
    setError(null);
    setResult(null);
    if (lifecycleActionNeedsConfirmation(action)) {
      setPendingAction(action);
      setTypedTargetName('');
      setAcknowledged(false);
      return;
    }
    void execute(action);
  }

  async function refreshAfterAttempt(): Promise<void> {
    try {
      await onChanged();
    } catch {
      // The lifecycle result/error is primary; dashboard refresh has its own error surface.
    }
  }

  async function execute(action: ContainerLifecycleAction): Promise<void> {
    if (disabled || busy) return;
    if (!lifecycleConfirmationReady(action, target.displayName, typedTargetName, acknowledged)) return;

    setError(null);
    setResult(null);
    setExecutingAction(action);
    try {
      const response = await api.containerLifecycle(
        target.id,
        action,
        action === 'start' ? undefined : target.selectedContainerId,
      );
      setResult({ action, response });
      resetConfirmation();
      await refreshAfterAttempt();
    } catch (actionError) {
      resetConfirmation();
      if (actionError instanceof ApiError && actionError.status === 401) {
        onSignedOut();
        return;
      }
      setError(errorMessage(actionError));
      await refreshAfterAttempt();
    } finally {
      setExecutingAction(null);
    }
  }

  const confirmationReady = pendingAction
    ? lifecycleConfirmationReady(pendingAction, target.displayName, typedTargetName, acknowledged)
    : false;

  return (
    <section className="lifecycle-panel" aria-labelledby="container-lifecycle-title">
      <div className="lifecycle-heading">
        <div>
          <p className="eyebrow">Controlled mutation</p>
          <h2 id="container-lifecycle-title">Container controls</h2>
          <p className="muted">
            Commands are fixed server-side Docker operations over pinned SSH. The application verifies the resulting container state before reporting success.
          </p>
        </div>
        <span className="lifecycle-state">{container.running ? 'Running' : 'Stopped'}</span>
      </div>

      <div className="lifecycle-actions" aria-label="Available container actions">
        {actions.map((action) => (
          <button
            className={action === 'stop' ? 'danger-button' : action === 'start' ? 'primary-button' : 'secondary-button'}
            disabled={disabled || busy}
            key={action}
            onClick={() => requestAction(action)}
            type="button"
          >
            {lifecycleActionLabel(action)}
          </button>
        ))}
        <span className="muted">
          Bound container: <code>{target.selectedContainerId}</code>
        </span>
      </div>

      {pendingAction ? (
        <div className="lifecycle-confirm" role="group" aria-labelledby="lifecycle-confirm-title">
          <div>
            <p className="eyebrow">Explicit confirmation</p>
            <h3 id="lifecycle-confirm-title">Confirm {lifecycleActionLabel(pendingAction).toLowerCase()}</h3>
          </div>
          <p>
            This will {pendingAction === 'stop' ? 'stop' : 'restart'} the selected Ollama container and can interrupt active model requests.
          </p>
          <p className="muted">
            Target <strong>{target.displayName}</strong> · container <code>{target.selectedContainerId}</code>
          </p>
          <label className="checkbox-label">
            <input
              checked={acknowledged}
              disabled={disabled || busy}
              onChange={(event) => setAcknowledged(event.target.checked)}
              type="checkbox"
            />
            I understand that this action can interrupt Ollama workloads.
          </label>
          <label>
            Type <strong>{target.displayName}</strong> to confirm
            <input
              autoComplete="off"
              disabled={disabled || busy}
              onChange={(event) => setTypedTargetName(event.target.value)}
              spellCheck={false}
              value={typedTargetName}
            />
          </label>
          <div className="lifecycle-confirm-actions">
            <button className="secondary-button" disabled={busy} onClick={resetConfirmation} type="button">Cancel</button>
            <button
              className={pendingAction === 'stop' ? 'danger-button' : 'primary-button'}
              disabled={disabled || busy || !confirmationReady}
              onClick={() => void execute(pendingAction)}
              type="button"
            >
              Confirm {lifecycleActionLabel(pendingAction).toLowerCase()}
            </button>
          </div>
        </div>
      ) : null}

      {busy && executingAction ? (
        <div className="lifecycle-progress" role="status">
          <span className="lifecycle-spinner" aria-hidden="true" />
          <div>
            <strong>{lifecycleActionLabel(executingAction)} in progress…</strong>
            <p>The server is executing the fixed Docker operation and verifying the resulting state.</p>
          </div>
        </div>
      ) : null}

      {error ? <p className="error-box" role="alert">{error}</p> : null}

      {result ? (
        <div className="lifecycle-result" role="status">
          <div>
            <strong>{lifecycleActionLabel(result.action)} verified</strong>
            <p>
              Container is {result.response.container.running ? 'running' : 'stopped'} · state {result.response.container.state} · job <code>{result.response.job.id}</code>
            </p>
          </div>
        </div>
      ) : null}
    </section>
  );
}
