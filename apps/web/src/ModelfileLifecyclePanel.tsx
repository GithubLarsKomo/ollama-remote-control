import { useCallback, useEffect, useState } from 'react';
import { ApiError } from './api.js';
import { formatBytes, formatTimestamp } from './format.js';
import {
  listRevisionDeployments,
  localValidationLabel,
  preflightValidationLabel,
  readModelfileValidation,
  targetValidationLabel,
  type ModelfileDeploymentView,
  type ModelfileValidationView,
} from './modelfile-lifecycle.js';

interface ModelfileLifecyclePanelProps {
  readonly modelfileId: string;
  readonly revisionId: string;
  readonly targetId: string;
  readonly outputModel: string;
  readonly disabled: boolean;
  readonly refreshKey?: string;
  readonly onSignedOut: () => void;
}

function shortHash(value: string): string {
  return value.length > 12 ? `${value.slice(0, 12)}…` : value;
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return `${error.code}: ${error.message}`;
  if (error instanceof Error) return error.message;
  return 'Unexpected lifecycle evidence error.';
}

export default function ModelfileLifecyclePanel({
  modelfileId,
  revisionId,
  targetId,
  outputModel,
  disabled,
  refreshKey = '',
  onSignedOut,
}: ModelfileLifecyclePanelProps) {
  const [validation, setValidation] = useState<ModelfileValidationView | null>(null);
  const [deployments, setDeployments] = useState<readonly ModelfileDeploymentView[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!modelfileId || !revisionId) {
      setValidation(null);
      setDeployments([]);
      setError(null);
      return;
    }
    setBusy(true);
    setError(null);
    const model = outputModel.trim();
    try {
      const [validationResponse, deploymentResponse] = await Promise.all([
        model
          ? readModelfileValidation(modelfileId, revisionId, targetId, model)
          : readModelfileValidation(modelfileId, revisionId),
        listRevisionDeployments(modelfileId, revisionId),
      ]);
      setValidation(validationResponse.validation);
      setDeployments(deploymentResponse.deployments);
    } catch (loadError) {
      if (loadError instanceof ApiError && loadError.status === 401) {
        onSignedOut();
        return;
      }
      setValidation(null);
      setDeployments([]);
      setError(errorMessage(loadError));
    } finally {
      setBusy(false);
    }
  }, [modelfileId, onSignedOut, outputModel, revisionId, targetId]);

  useEffect(() => { void load(); }, [load, refreshKey]);

  return (
    <section className="model-create-plan" aria-label="Modelfile lifecycle evidence">
      <div className="model-row-heading">
        <div>
          <h4>Lifecycle evidence</h4>
          <p className="muted">Immutable revision status from local compile, persisted deploy-plan evidence and verified target deployments.</p>
        </div>
        <button className="secondary-button" disabled={disabled || busy} onClick={() => void load()} type="button">
          {busy ? 'Refreshing…' : 'Refresh evidence'}
        </button>
      </div>

      {error ? <p className="error-box" role="alert">{error}</p> : null}
      {validation ? (
        <>
          <dl className="model-create-plan-grid">
            <div><dt>Revision hash</dt><dd><code title={validation.revisionSha256}>{shortHash(validation.revisionSha256)}</code></dd></div>
            <div><dt>Local compile</dt><dd>{localValidationLabel(validation.local)}</dd></div>
            <div><dt>Deploy preflight</dt><dd>{preflightValidationLabel(validation.preflight)}</dd></div>
            <div><dt>Target verification</dt><dd>{targetValidationLabel(validation.targetVerification)}</dd></div>
          </dl>
          {validation.local.state === 'failed' ? (
            <p className="error-box">{validation.local.message}</p>
          ) : null}
          {!outputModel.trim() ? (
            <p className="models-notice">Enter a destination model to correlate this revision with target-specific preflight and verification evidence.</p>
          ) : null}
          {validation.preflight.state === 'passed' && validation.preflight.authorityState !== 'usable' ? (
            <p className="models-notice">
              The recorded deploy preflight passed historically, but its authority is now <strong>{validation.preflight.authorityState}</strong>. Create a fresh deploy plan before any new deployment.
            </p>
          ) : null}
        </>
      ) : busy ? <p className="loading-box" role="status">Reading lifecycle evidence…</p> : null}

      <div className="models-section-heading">
        <div>
          <h4>Verified deployment history for this revision</h4>
          <p className="muted">Only deployments that passed the existing post-create inventory and semantic verification are listed.</p>
        </div>
      </div>
      {deployments.length === 0 ? (
        <p className="models-notice">No verified deployment has been recorded for this immutable revision.</p>
      ) : (
        <div className="model-table-wrap">
          <table className="model-table">
            <thead><tr><th>Model</th><th>Target</th><th>Digest</th><th>Size</th><th>Verified</th><th>Library status</th></tr></thead>
            <tbody>
              {deployments.map((deployment) => (
                <tr key={deployment.id}>
                  <td><strong>{deployment.outputModel}</strong></td>
                  <td><code>{deployment.targetId}</code></td>
                  <td><code title={deployment.modelDigest}>{shortHash(deployment.modelDigest)}</code></td>
                  <td>{formatBytes(deployment.sizeBytes)}</td>
                  <td>{formatTimestamp(deployment.verifiedAt)}</td>
                  <td>{deployment.producingRevisionIsLibraryCurrent ? 'Current revision' : 'Historical revision'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
