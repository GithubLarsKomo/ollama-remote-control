import {
  type FormEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { ApiError } from './api.js';
import { formatBytes, formatTimestamp } from './format.js';
import {
  activeModelPull,
  applyPullSseEvent,
  cancelModelPull,
  isTerminalPullState,
  modelPullEventUrl,
  parsePullSseData,
  startModelPull,
  type PullJobView,
  type PullProgressView,
  type PullUiState,
} from './model-pull.js';
import './model-pull.css';

interface ModelPullPanelProps {
  readonly targetId: string;
  readonly disabled: boolean;
  readonly onSignedOut: () => void;
  readonly onSucceeded: () => Promise<void> | void;
}

const EMPTY_STATE: PullUiState = { job: null, model: null, progress: null };

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return `${error.code}: ${error.message}`;
  if (error instanceof Error) return error.message;
  return 'Unexpected model pull error.';
}

function Progress({ progress }: { readonly progress: PullProgressView }) {
  const hasBytes = progress.totalBytes !== null && progress.completedBytes !== null;
  return (
    <div className="pull-progress" aria-live="polite">
      <div className="pull-progress-heading">
        <strong>{progress.status}</strong>
        {progress.percentage !== null ? <span>{progress.percentage}%</span> : null}
      </div>
      {progress.percentage !== null ? (
        <div className="pull-progress-bar" aria-label={`${progress.percentage}% complete`}>
          <span style={{ width: `${Math.max(0, Math.min(100, progress.percentage))}%` }} />
        </div>
      ) : null}
      <div className="pull-progress-meta">
        {hasBytes ? (
          <span>{formatBytes(progress.completedBytes!)} / {formatBytes(progress.totalBytes!)}</span>
        ) : <span>Waiting for byte progress…</span>}
        {progress.digest ? <code title={progress.digest}>{progress.digest.slice(0, 20)}…</code> : null}
      </div>
    </div>
  );
}

export default function ModelPullPanel({ targetId, disabled, onSignedOut, onSucceeded }: ModelPullPanelProps) {
  const [state, setState] = useState<PullUiState>(EMPTY_STATE);
  const [modelInput, setModelInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [streamNotice, setStreamNotice] = useState<string | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);

  const handleAuthError = useCallback((actionError: unknown): boolean => {
    if (actionError instanceof ApiError && actionError.status === 401) {
      onSignedOut();
      return true;
    }
    return false;
  }, [onSignedOut]);

  useEffect(() => {
    let active = true;
    setState(EMPTY_STATE);
    setError(null);
    setStreamNotice(null);
    setBusy(true);
    void activeModelPull(targetId).then(
      (response) => {
        if (!active) return;
        setState(response.job ? { job: response.job, model: null, progress: null } : EMPTY_STATE);
      },
      (activeError) => {
        if (!active || handleAuthError(activeError)) return;
        setError(errorMessage(activeError));
      },
    ).finally(() => {
      if (active) setBusy(false);
    });
    return () => { active = false; };
  }, [handleAuthError, targetId]);

  const jobId = state.job?.id ?? null;
  const terminal = state.job ? isTerminalPullState(state.job.state) : false;

  useEffect(() => {
    if (!jobId) return undefined;
    eventSourceRef.current?.close();
    const source = new EventSource(modelPullEventUrl(jobId), { withCredentials: true });
    eventSourceRef.current = source;
    setStreamNotice(null);

    const update = <T,>(type: 'ready' | 'state' | 'pull-request' | 'progress' | 'end', event: MessageEvent<string>) => {
      try {
        const data = parsePullSseData<T>(event);
        setState((current) => applyPullSseEvent(current, { type, data } as never));
        setStreamNotice(null);
        if (type === 'end') {
          source.close();
          const job = (data as { job: PullJobView }).job;
          if (job.state === 'succeeded') void onSucceeded();
        }
      } catch (parseError) {
        source.close();
        setError(errorMessage(parseError));
      }
    };

    source.addEventListener('ready', (event) => update<{ job: PullJobView }>('ready', event as MessageEvent<string>));
    source.addEventListener('state', (event) => update<{ state: PullJobView['state']; errorClass?: string | null }>('state', event as MessageEvent<string>));
    source.addEventListener('pull-request', (event) => update<{ model: string }>('pull-request', event as MessageEvent<string>));
    source.addEventListener('progress', (event) => update<PullProgressView>('progress', event as MessageEvent<string>));
    source.addEventListener('end', (event) => update<{ job: PullJobView }>('end', event as MessageEvent<string>));
    source.onerror = () => {
      if (source.readyState !== EventSource.CLOSED) {
        setStreamNotice('Live progress connection was interrupted. The browser will reconnect to persisted job events automatically.');
      }
    };

    return () => {
      source.close();
      if (eventSourceRef.current === source) eventSourceRef.current = null;
    };
  }, [jobId, onSucceeded]);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (disabled || busy || state.job && !terminal) return;
    const model = modelInput.trim();
    if (!model) return;
    setBusy(true);
    setError(null);
    setStreamNotice(null);
    try {
      const response = await startModelPull(targetId, model);
      setState({ job: response.job, model, progress: null });
      setModelInput('');
    } catch (startError) {
      if (!handleAuthError(startError)) setError(errorMessage(startError));
    } finally {
      setBusy(false);
    }
  }

  async function cancel(): Promise<void> {
    if (!state.job || terminal || busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await cancelModelPull(state.job.id);
      setState((current) => ({ ...current, job: response.job }));
    } catch (cancelError) {
      if (!handleAuthError(cancelError)) setError(errorMessage(cancelError));
    } finally {
      setBusy(false);
    }
  }

  function clearTerminal(): void {
    if (!terminal) return;
    eventSourceRef.current?.close();
    eventSourceRef.current = null;
    setState(EMPTY_STATE);
    setError(null);
    setStreamNotice(null);
  }

  const job = state.job;
  return (
    <section className="model-pull-panel" aria-labelledby="model-pull-title">
      <div className="model-pull-heading">
        <div>
          <p className="eyebrow">Persistent model job</p>
          <h3 id="model-pull-title">Pull model</h3>
          <p className="muted">Download a model through Ollama over the pinned SSH tunnel. The job continues if this page disconnects.</p>
        </div>
        {job ? <span className={`status-pill ${job.state === 'succeeded' ? 'status-ok' : job.state === 'failed' ? 'status-danger' : 'status-muted'}`}>{job.state}</span> : null}
      </div>

      {!job || terminal ? (
        <form className="model-pull-form" onSubmit={(event) => void submit(event)}>
          <label>
            Model
            <input
              autoComplete="off"
              disabled={disabled || busy}
              maxLength={512}
              onChange={(event) => setModelInput(event.target.value)}
              placeholder="qwen3.5:9b"
              required
              spellCheck={false}
              value={modelInput}
            />
          </label>
          <button className="primary-button" disabled={disabled || busy || !modelInput.trim()} type="submit">
            {busy ? 'Starting…' : 'Pull model'}
          </button>
        </form>
      ) : null}

      {job ? (
        <div className="pull-job-card">
          <div className="pull-job-summary">
            <div><span>Model</span><strong>{state.model ?? 'Loading job details…'}</strong></div>
            <div><span>Job</span><code title={job.id}>{job.id.slice(0, 12)}…</code></div>
            <div><span>Started</span><strong>{job.startedAt ? formatTimestamp(job.startedAt) : formatTimestamp(job.createdAt)}</strong></div>
          </div>
          {state.progress ? <Progress progress={state.progress} /> : !terminal ? <p className="models-notice">Waiting for Ollama pull progress…</p> : null}
          {streamNotice ? <p className="pull-stream-notice" role="status">{streamNotice}</p> : null}

          {job.state === 'failed' ? (
            <p className="error-box" role="alert">Pull failed: {job.errorClass ?? 'PULL_FAILED'}</p>
          ) : null}
          {job.state === 'cancelled' ? <p className="models-notice">Pull was cancelled before a remote transfer started.</p> : null}
          {job.state === 'succeeded' ? <p className="pull-success">Model pull completed and the installed model was verified.</p> : null}
          {job.state === 'cancelling' ? (
            <p className="pull-cancel-warning" role="status">Cancellation is being attempted. Ollama does not provide reliable proof that shared/resumable download work stopped, so the job will not be reported as cancelled unless that can be verified.</p>
          ) : null}

          <div className="pull-job-actions">
            {!terminal ? (
              <button className="secondary-button" disabled={busy} onClick={() => void cancel()} type="button">
                {busy ? 'Requesting cancel…' : 'Cancel pull'}
              </button>
            ) : (
              <button className="secondary-button" onClick={clearTerminal} type="button">Dismiss job</button>
            )}
          </div>
        </div>
      ) : null}

      {error ? <p className="error-box" role="alert">{error}</p> : null}
      <p className="model-pull-boundary">Pull uses a fixed server-side <code>/api/pull</code> operation. This UI cannot enable insecure registries or choose SSH, container or API endpoints.</p>
    </section>
  );
}
