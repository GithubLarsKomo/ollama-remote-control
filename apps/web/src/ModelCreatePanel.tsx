import { useCallback, useEffect, useMemo, useState } from 'react';
import { ApiError } from './api.js';
import { formatTimestamp } from './format.js';
import ModelfileLifecyclePanel from './ModelfileLifecyclePanel.js';
import {
  listLocalModelfileRevisions,
  listLocalModelfiles,
  type ModelfileRevisionSummaryView,
  type ModelfileSummaryView,
} from './modelfile-library.js';
import {
  cancelModelCreateJob,
  confirmModelfileDeploy,
  createModelfileDeployPlan,
  modelCreateEventUrl,
  readActiveModelCreateJob,
  readModelCreateJob,
  type ModelfileDeployPlanView,
  type PublicCreateJob,
} from './model-create.js';
import './model-create.css';

interface ModelCreatePanelProps {
  readonly targetId: string;
  readonly disabled: boolean;
  readonly onSignedOut: () => void;
  readonly onSucceeded: () => Promise<void> | void;
}

type EventPayload = Readonly<Record<string, unknown>>;

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return `${error.code}: ${error.message}`;
  if (error instanceof Error) return error.message;
  return 'Unexpected model-create error.';
}

function terminal(job: PublicCreateJob | null): boolean {
  return Boolean(job && ['succeeded', 'failed', 'cancelled'].includes(job.state));
}

function shortHash(hash: string): string {
  return `${hash.slice(0, 12)}…`;
}

function parseEvent(event: MessageEvent<string>): EventPayload | null {
  try {
    const parsed = JSON.parse(event.data);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as EventPayload : null;
  } catch {
    return null;
  }
}

export default function ModelCreatePanel({ targetId, disabled, onSignedOut, onSucceeded }: ModelCreatePanelProps) {
  const [artifacts, setArtifacts] = useState<readonly ModelfileSummaryView[]>([]);
  const [artifactId, setArtifactId] = useState('');
  const [revisions, setRevisions] = useState<readonly ModelfileRevisionSummaryView[]>([]);
  const [revisionId, setRevisionId] = useState('');
  const [outputModel, setOutputModel] = useState('');
  const [plan, setPlan] = useState<ModelfileDeployPlanView | null>(null);
  const [job, setJob] = useState<PublicCreateJob | null>(null);
  const [progress, setProgress] = useState<readonly string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const handleError = useCallback((operationError: unknown) => {
    if (operationError instanceof ApiError && operationError.status === 401) {
      onSignedOut();
      return;
    }
    setError(errorMessage(operationError));
  }, [onSignedOut]);

  const loadArtifacts = useCallback(async () => {
    try {
      const response = await listLocalModelfiles();
      setArtifacts(response.modelfiles);
      setArtifactId((current) => {
        if (current && response.modelfiles.some((item) => item.id === current)) return current;
        return response.modelfiles[0]?.id ?? '';
      });
    } catch (loadError) {
      handleError(loadError);
    }
  }, [handleError]);

  useEffect(() => { void loadArtifacts(); }, [loadArtifacts]);

  useEffect(() => {
    let closed = false;
    setPlan(null);
    setJob(null);
    setProgress([]);
    setError(null);
    setNotice(null);
    void readActiveModelCreateJob(targetId)
      .then((response) => {
        if (closed || !response.job) return;
        setJob(response.job);
        setNotice('Resumed active model-create job. Progress continues from persisted server state.');
      })
      .catch(handleError);
    return () => { closed = true; };
  }, [handleError, targetId]);

  useEffect(() => {
    setPlan(null);
    if (!job || terminal(job)) {
      setJob(null);
      setProgress([]);
      setError(null);
      setNotice(null);
    }
    if (!artifactId) {
      setRevisions([]);
      setRevisionId('');
      return;
    }
    void listLocalModelfileRevisions(artifactId)
      .then((response) => {
        setRevisions(response.revisions);
        const artifact = artifacts.find((item) => item.id === artifactId);
        const preferred = artifact?.currentRevisionId;
        setRevisionId(preferred && response.revisions.some((item) => item.id === preferred)
          ? preferred
          : response.revisions[0]?.id ?? '');
      })
      .catch(handleError);
  }, [artifactId, artifacts, handleError]);

  useEffect(() => {
    if (job && !terminal(job)) return;
    setPlan(null);
    setJob(null);
    setProgress([]);
    setError(null);
    setNotice(null);
  }, [outputModel, revisionId, targetId]);

  useEffect(() => {
    if (!job || terminal(job)) return;
    let closed = false;
    const source = new EventSource(modelCreateEventUrl(job.id), { withCredentials: true });
    const onProgress = (event: Event) => {
      const payload = parseEvent(event as MessageEvent<string>);
      const status = typeof payload?.status === 'string' ? payload.status : null;
      if (!status) return;
      setProgress((current) => [...current.slice(-11), status]);
    };
    const onState = (event: Event) => {
      const payload = parseEvent(event as MessageEvent<string>);
      if (!payload || typeof payload.state !== 'string') return;
      void readModelCreateJob(job.id).then((response) => {
        if (!closed) setJob(response.job);
      }).catch(handleError);
    };
    const onEnd = (event: Event) => {
      const payload = parseEvent(event as MessageEvent<string>);
      const next = payload?.job;
      if (next && typeof next === 'object' && !Array.isArray(next)) {
        setJob(next as unknown as PublicCreateJob);
      } else {
        void readModelCreateJob(job.id).then((response) => setJob(response.job)).catch(handleError);
      }
      source.close();
    };
    source.addEventListener('progress', onProgress);
    source.addEventListener('state', onState);
    source.addEventListener('end', onEnd);
    source.onerror = () => {
      source.close();
      void readModelCreateJob(job.id).then((response) => {
        if (!closed) setJob(response.job);
      }).catch(handleError);
    };
    return () => {
      closed = true;
      source.close();
    };
  }, [handleError, job]);

  useEffect(() => {
    if (job?.state !== 'succeeded') return;
    setNotice('Created model passed remote inventory and semantic /api/show verification.');
    void onSucceeded();
  }, [job?.state, onSucceeded]);

  const selectedArtifact = useMemo(
    () => artifacts.find((item) => item.id === artifactId) ?? null,
    [artifactId, artifacts],
  );
  const selectedRevision = useMemo(
    () => revisions.find((item) => item.id === revisionId) ?? null,
    [revisionId, revisions],
  );
  const historicalRevisionSelected = Boolean(
    selectedArtifact && selectedRevision && selectedRevision.id !== selectedArtifact.currentRevisionId,
  );
  const lifecycleRefreshKey = `${plan?.planId ?? 'no-plan'}:${job?.id ?? 'no-job'}:${job?.state ?? 'no-state'}`;

  async function preparePlan() {
    if (!artifactId || !revisionId || !outputModel.trim()) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    setPlan(null);
    setJob(null);
    setProgress([]);
    try {
      const response = await createModelfileDeployPlan(targetId, artifactId, revisionId, outputModel);
      setPlan(response.plan);
      setNotice('Plan created. Review the immutable revision, destination and verification scope before confirming.');
    } catch (planError) {
      handleError(planError);
    } finally {
      setBusy(false);
    }
  }

  async function confirmPlan() {
    if (!plan) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const response = await confirmModelfileDeploy(targetId, artifactId, revisionId, plan);
      setJob(response.job);
      setNotice('Create job accepted. API stream success is provisional until remote verification completes.');
    } catch (confirmError) {
      handleError(confirmError);
    } finally {
      setBusy(false);
    }
  }

  async function cancelJob() {
    if (!job || terminal(job)) return;
    setBusy(true);
    setError(null);
    try {
      const response = await cancelModelCreateJob(job.id);
      setJob(response.job);
    } catch (cancelError) {
      handleError(cancelError);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="model-create-panel" aria-labelledby="model-create-title">
      <div className="models-section-heading">
        <div>
          <p className="eyebrow">Confirmed immutable deployment</p>
          <h3 id="model-create-title">Create model from Modelfile revision</h3>
          <p className="muted">
            First create a short-lived server-authoritative plan. A second confirmation starts the persistent job; success is reported only after fresh Ollama inventory and semantic <code>/api/show</code> verification.
          </p>
        </div>
      </div>

      {error ? <p className="error-box" role="alert">{error}</p> : null}
      {notice ? <p className="modelfile-notice" role="status">{notice}</p> : null}

      <div className="model-create-form-grid">
        <label>
          Local Modelfile
          <select disabled={disabled || busy || Boolean(job && !terminal(job))} onChange={(event) => setArtifactId(event.target.value)} value={artifactId}>
            {artifacts.length === 0 ? <option value="">No local Modelfiles</option> : null}
            {artifacts.map((item) => <option key={item.id} value={item.id}>{item.displayName}</option>)}
          </select>
        </label>
        <label>
          Immutable revision
          <select disabled={disabled || busy || !artifactId || Boolean(job && !terminal(job))} onChange={(event) => setRevisionId(event.target.value)} value={revisionId}>
            {revisions.map((revision) => (
              <option key={revision.id} value={revision.id}>
                r{revision.revisionNumber}{revision.id === selectedArtifact?.currentRevisionId ? ' · current' : ' · historical'} · {shortHash(revision.contentSha256)}
              </option>
            ))}
          </select>
        </label>
        <label>
          Destination model
          <input
            disabled={disabled || busy || Boolean(job && !terminal(job))}
            maxLength={512}
            onChange={(event) => setOutputModel(event.target.value)}
            placeholder="my-model:latest"
            value={outputModel}
          />
        </label>
        <button
          className="secondary-button"
          disabled={disabled || busy || !artifactId || !revisionId || !outputModel.trim() || Boolean(job && !terminal(job))}
          onClick={() => void preparePlan()}
          type="button"
        >
          {busy && !plan ? 'Planning…' : 'Create fresh deploy plan'}
        </button>
      </div>

      {historicalRevisionSelected ? (
        <p className="models-notice" role="note">
          Historical immutable revision selected. Redeployment always creates a fresh server-side plan and still refuses an existing destination model; selecting an older revision does not enable overwrite or reuse stale authority.
        </p>
      ) : null}

      {artifactId && revisionId ? (
        <ModelfileLifecyclePanel
          disabled={disabled || busy}
          modelfileId={artifactId}
          onSignedOut={onSignedOut}
          outputModel={outputModel}
          refreshKey={lifecycleRefreshKey}
          revisionId={revisionId}
          targetId={targetId}
        />
      ) : null}

      {plan ? (
        <section className="model-create-plan" aria-label="Deploy plan confirmation">
          <div className="model-row-heading">
            <h4>Review before confirmation</h4>
            <span className="status-pill status-muted">Expires {formatTimestamp(plan.expiresAt)}</span>
          </div>
          <dl className="model-create-plan-grid">
            <div><dt>Revision</dt><dd>r{selectedRevision?.revisionNumber ?? '?'} · <code>{shortHash(plan.revisionSha256)}</code></dd></div>
            <div><dt>Destination</dt><dd><strong>{plan.outputModel}</strong></dd></div>
            <div><dt>Base model</dt><dd>{plan.baseModel}</dd></div>
            <div><dt>Container</dt><dd><code>{plan.selectedContainerId}</code></dd></div>
            <div><dt>Ollama API</dt><dd>{plan.apiVersion}</dd></div>
            <div><dt>Verification</dt><dd>{plan.expectedFields.join(', ') || 'model presence'}</dd></div>
          </dl>
          <p className="muted">
            The browser cannot alter SYSTEM, TEMPLATE, parameters, messages, license, renderer or parser here. Those fields are recompiled from revision <code>{plan.revisionId}</code> when you confirm.
          </p>
          <button
            className="primary-button"
            disabled={disabled || busy || Boolean(job && !terminal(job))}
            onClick={() => void confirmPlan()}
            type="button"
          >
            Confirm and create {plan.outputModel}
          </button>
        </section>
      ) : null}

      {job ? (
        <section className="model-create-job" aria-label="Model create job">
          <div className="model-row-heading">
            <h4>Create job</h4>
            <span className={`status-pill ${job.state === 'succeeded' ? 'status-ok' : job.state === 'failed' ? 'status-danger' : 'status-muted'}`}>{job.state}</span>
          </div>
          <p className="muted">Job <code>{job.id}</code>{job.errorClass ? <> · {job.errorClass}</> : null}</p>
          {progress.length ? (
            <ol className="model-create-progress">
              {progress.map((status, index) => <li key={`${status}:${index}`}>{status}</li>)}
            </ol>
          ) : <p className="models-notice">Waiting for create progress…</p>}
          {!terminal(job) ? (
            <button className="secondary-button" disabled={disabled || busy} onClick={() => void cancelJob()} type="button">Cancel create</button>
          ) : null}
          {job.state === 'failed' && job.errorClass === 'CREATE_VERIFICATION_FAILED' ? (
            <p className="error-box">Ollama reported create progress, but the deployed model did not match all requested verifiable semantics.</p>
          ) : null}
        </section>
      ) : null}
    </section>
  );
}
