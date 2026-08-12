import { useEffect, useState } from 'react';
import { ApiError } from './api.js';
import { formatTimestamp } from './format.js';
import { listLocalModelfiles, type ModelfileSummaryView } from './modelfile-library.js';
import {
  listRevisionDeployments,
  localValidationLabel,
  readModelfileValidation,
  type ModelfileDeploymentView,
  type ModelfileValidationView,
} from './modelfile-lifecycle.js';

export interface ModelfileLibraryEvidenceSummary {
  readonly validationLabel: string;
  readonly lastDeploymentAt: string | null;
  readonly deploymentTargetId: string | null;
  readonly deploymentModel: string | null;
}

export function summarizeModelfileLibraryEvidence(
  validation: ModelfileValidationView,
  deployments: readonly ModelfileDeploymentView[],
): ModelfileLibraryEvidenceSummary {
  const latest = [...deployments].sort((left, right) => right.verifiedAt.localeCompare(left.verifiedAt))[0] ?? null;
  return {
    validationLabel: localValidationLabel(validation.local),
    lastDeploymentAt: latest?.verifiedAt ?? null,
    deploymentTargetId: latest?.targetId ?? null,
    deploymentModel: latest?.outputModel ?? null,
  };
}

type EvidenceState =
  | { readonly state: 'loading' }
  | { readonly state: 'unavailable' }
  | { readonly state: 'ready'; readonly summary: ModelfileLibraryEvidenceSummary };

export default function ModelfileLibrarySummaryPanel({ onSignedOut }: { readonly onSignedOut: () => void }) {
  const [artifacts, setArtifacts] = useState<readonly ModelfileSummaryView[]>([]);
  const [evidence, setEvidence] = useState<Readonly<Record<string, EvidenceState>>>({});
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await listLocalModelfiles();
        if (cancelled) return;
        setArtifacts(response.modelfiles);
        setEvidence(Object.fromEntries(response.modelfiles.map((artifact) => [artifact.id, { state: 'loading' } as const])));

        await Promise.all(response.modelfiles.map(async (artifact) => {
          try {
            const [validationResponse, deploymentResponse] = await Promise.all([
              readModelfileValidation(artifact.id, artifact.currentRevisionId),
              listRevisionDeployments(artifact.id, artifact.currentRevisionId),
            ]);
            if (cancelled) return;
            const summary = summarizeModelfileLibraryEvidence(validationResponse.validation, deploymentResponse.deployments);
            setEvidence((current) => ({ ...current, [artifact.id]: { state: 'ready', summary } }));
          } catch (readError) {
            if (readError instanceof ApiError && readError.status === 401) {
              onSignedOut();
              return;
            }
            if (!cancelled) setEvidence((current) => ({ ...current, [artifact.id]: { state: 'unavailable' } }));
          }
        }));
      } catch (loadError) {
        if (loadError instanceof ApiError && loadError.status === 401) {
          onSignedOut();
          return;
        }
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : 'Modelfile library summary could not be loaded.');
      }
    })();
    return () => { cancelled = true; };
  }, [onSignedOut]);

  return (
    <section className="local-modelfiles" aria-labelledby="modelfile-library-summary-title">
      <div className="local-modelfiles-heading">
        <div>
          <p className="eyebrow">Library overview</p>
          <h3 id="modelfile-library-summary-title">Modelfile library state</h3>
          <p className="muted">Only persisted revision, validation and verified deployment evidence is shown. Missing evidence stays explicit.</p>
        </div>
      </div>
      {error ? <p className="error-box" role="alert">{error}</p> : null}
      {artifacts.length === 0 && !error ? <p className="models-notice">No local Modelfiles yet.</p> : null}
      {artifacts.length > 0 ? (
        <div className="modelfile-artifacts" role="list" aria-label="Modelfile library summary">
          {artifacts.map((artifact) => {
            const state = evidence[artifact.id];
            return (
              <article className="modelfile-artifact" key={artifact.id} role="listitem">
                <strong>{artifact.displayName}</strong>
                <span>Current revision r{artifact.currentRevisionNumber}</span>
                <span>Validation: {state?.state === 'ready' ? state.summary.validationLabel : state?.state === 'unavailable' ? 'Evidence unavailable' : 'Loading…'}</span>
                <span>Last changed: {formatTimestamp(artifact.updatedAt)}</span>
                {state?.state === 'ready' && state.summary.lastDeploymentAt ? (
                  <>
                    <span>Last deployed: {formatTimestamp(state.summary.lastDeploymentAt)}</span>
                    <span>Deployment: {state.summary.deploymentTargetId} · {state.summary.deploymentModel}</span>
                  </>
                ) : <span>Deployment: No verified deployment evidence</span>}
                <small>Actions in this workspace: Edit · Clone · Validate · Diff · Deploy/Create · Import · Export</small>
              </article>
            );
          })}
        </div>
      ) : null}
    </section>
  );
}
