import { useCallback, useEffect, useMemo, useState } from 'react';
import { ApiError } from './api.js';
import {
  cloneLocalModelfileRevision,
  downloadModelfileRevision,
  listLocalModelfileRevisions,
  listLocalModelfiles,
  readLocalModelfileRevision,
  type ModelfileRevisionSummaryView,
  type ModelfileSummaryView,
  type ModelfileRevisionView,
} from './modelfile-library.js';

interface ModelfilePortabilityPanelProps {
  readonly disabled: boolean;
  readonly onSignedOut: () => void;
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return `${error.code}: ${error.message}`;
  if (error instanceof Error) return error.message;
  return 'Unexpected Modelfile portability error.';
}

export default function ModelfilePortabilityPanel({ disabled, onSignedOut }: ModelfilePortabilityPanelProps) {
  const [artifacts, setArtifacts] = useState<readonly ModelfileSummaryView[]>([]);
  const [artifactId, setArtifactId] = useState('');
  const [revisions, setRevisions] = useState<readonly ModelfileRevisionSummaryView[]>([]);
  const [revisionId, setRevisionId] = useState('');
  const [revision, setRevision] = useState<ModelfileRevisionView | null>(null);
  const [cloneName, setCloneName] = useState('');
  const [cloneDescription, setCloneDescription] = useState('');
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

  const loadArtifacts = useCallback(async (preferId?: string) => {
    try {
      const response = await listLocalModelfiles();
      setArtifacts(response.modelfiles);
      setArtifactId((current) => {
        if (preferId && response.modelfiles.some((item) => item.id === preferId)) return preferId;
        if (current && response.modelfiles.some((item) => item.id === current)) return current;
        return response.modelfiles[0]?.id ?? '';
      });
    } catch (loadError) {
      handleError(loadError);
    }
  }, [handleError]);

  useEffect(() => { void loadArtifacts(); }, [loadArtifacts]);

  useEffect(() => {
    setRevision(null);
    setRevisionId('');
    setRevisions([]);
    setNotice(null);
    if (!artifactId) return;
    void listLocalModelfileRevisions(artifactId).then(
      (response) => {
        setRevisions(response.revisions);
        const artifact = artifacts.find((item) => item.id === artifactId);
        const preferred = artifact?.currentRevisionId;
        setRevisionId(preferred && response.revisions.some((item) => item.id === preferred)
          ? preferred
          : response.revisions[0]?.id ?? '');
      },
      handleError,
    );
  }, [artifactId, artifacts, handleError]);

  useEffect(() => {
    setRevision(null);
    setNotice(null);
    if (!artifactId || !revisionId) return;
    void readLocalModelfileRevision(artifactId, revisionId).then(
      (response) => setRevision(response.revision),
      handleError,
    );
  }, [artifactId, handleError, revisionId]);

  const artifact = useMemo(
    () => artifacts.find((item) => item.id === artifactId) ?? null,
    [artifactId, artifacts],
  );

  function exportRevision() {
    if (!artifact || !revision) return;
    setError(null);
    setNotice(null);
    downloadModelfileRevision({
      displayName: artifact.displayName,
      revisionNumber: revision.revisionNumber,
      rawText: revision.rawText,
    });
    setNotice(`Exported ${artifact.displayName} revision ${revision.revisionNumber} exactly as stored.`);
  }

  async function cloneRevision() {
    if (!artifact || !revision || !cloneName.trim()) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const response = await cloneLocalModelfileRevision(artifact.id, revision.id, {
        displayName: cloneName,
        ...(cloneDescription ? { description: cloneDescription } : {}),
      });
      setCloneName('');
      setCloneDescription('');
      setNotice(`Created independent clone ${response.modelfile.displayName} from revision ${revision.revisionNumber}.`);
      await loadArtifacts(response.modelfile.id);
    } catch (cloneError) {
      handleError(cloneError);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="modelfile-library" aria-labelledby="modelfile-portability-title">
      <div className="models-section-heading">
        <div>
          <p className="eyebrow">Local-only portability</p>
          <h3 id="modelfile-portability-title">Clone or export an immutable revision</h3>
          <p className="muted">
            Export preserves the selected stored raw text exactly. Clone creates a new independent local artifact at revision 1; neither operation contacts Ollama.
          </p>
        </div>
      </div>

      {error ? <p className="error-box" role="alert">{error}</p> : null}
      {notice ? <p className="modelfile-notice" role="status">{notice}</p> : null}

      <div className="modelfile-create-grid">
        <label>
          Local Modelfile
          <select disabled={disabled || busy} onChange={(event) => setArtifactId(event.target.value)} value={artifactId}>
            {artifacts.length === 0 ? <option value="">No local Modelfiles</option> : null}
            {artifacts.map((item) => <option key={item.id} value={item.id}>{item.displayName}</option>)}
          </select>
        </label>
        <label>
          Immutable revision
          <select disabled={disabled || busy || !artifactId} onChange={(event) => setRevisionId(event.target.value)} value={revisionId}>
            {revisions.map((item) => (
              <option key={item.id} value={item.id}>
                r{item.revisionNumber}{item.id === artifact?.currentRevisionId ? ' · current' : ''} · {item.contentSha256.slice(0, 12)}…
              </option>
            ))}
          </select>
        </label>
        <button
          className="secondary-button"
          disabled={disabled || busy || !artifact || !revision}
          onClick={exportRevision}
          type="button"
        >
          Export selected .Modelfile
        </button>
      </div>

      <div className="modelfile-create-grid">
        <label>
          Clone name
          <input
            disabled={disabled || busy || !revision}
            maxLength={160}
            onChange={(event) => setCloneName(event.target.value)}
            placeholder="Independent clone"
            value={cloneName}
          />
        </label>
        <label>
          Clone description (optional)
          <input
            disabled={disabled || busy || !revision}
            maxLength={2000}
            onChange={(event) => setCloneDescription(event.target.value)}
            placeholder="Why this clone exists"
            value={cloneDescription}
          />
        </label>
        <button
          className="primary-button"
          disabled={disabled || busy || !revision || !cloneName.trim()}
          onClick={() => void cloneRevision()}
          type="button"
        >
          {busy ? 'Cloning…' : 'Clone selected revision'}
        </button>
      </div>

      {revision ? (
        <p className="muted">
          Selected r{revision.revisionNumber} · <code>{revision.contentSha256}</code> · {revision.rawText.length.toLocaleString('en-US')} characters stored.
        </p>
      ) : null}
    </section>
  );
}
