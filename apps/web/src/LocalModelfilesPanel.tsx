import {
  type FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { ApiError, type TargetStatusResult } from './api.js';
import { formatTimestamp } from './format.js';
import type { ModelInventoryView } from './model-inventory.js';
import {
  appendLocalModelfileRevision,
  createLocalModelfile,
  importInstalledModelfile,
  listLocalModelfileRevisions,
  listLocalModelfiles,
  readLocalModelfile,
  readLocalModelfileRevision,
  type ModelfileRevisionSummaryView,
  type ModelfileRevisionView,
  type ModelfileSummaryView,
  type ModelfileView,
} from './modelfile-library.js';
import './modelfiles.css';

interface LocalModelfilesPanelProps {
  readonly status: TargetStatusResult;
  readonly inventory: ModelInventoryView;
  readonly disabled: boolean;
  readonly onSignedOut: () => void;
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return `${error.code}: ${error.message}`;
  if (error instanceof Error) return error.message;
  return 'Unexpected local Modelfile error.';
}

function sourceLabel(source: ModelfileSummaryView['currentSourceKind']): string {
  return source === 'installed-model-import' ? 'Installed model import' : 'Manual';
}

function shortHash(hash: string): string {
  return `${hash.slice(0, 12)}…`;
}

export default function LocalModelfilesPanel({
  status,
  inventory,
  disabled,
  onSignedOut,
}: LocalModelfilesPanelProps) {
  const [artifacts, setArtifacts] = useState<readonly ModelfileSummaryView[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selected, setSelected] = useState<ModelfileView | null>(null);
  const [history, setHistory] = useState<readonly ModelfileRevisionSummaryView[]>([]);
  const [historicalRevision, setHistoricalRevision] = useState<ModelfileRevisionView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [createName, setCreateName] = useState('');
  const [createDescription, setCreateDescription] = useState('');
  const [createRaw, setCreateRaw] = useState('FROM model:latest\n');

  const [importModel, setImportModel] = useState(inventory.installed[0]?.model ?? '');
  const [importName, setImportName] = useState('');
  const [importDescription, setImportDescription] = useState('');

  const [revisionRaw, setRevisionRaw] = useState('');

  const handleError = useCallback((operationError: unknown) => {
    if (operationError instanceof ApiError && operationError.status === 401) {
      onSignedOut();
      return;
    }
    setError(errorMessage(operationError));
  }, [onSignedOut]);

  const loadList = useCallback(async (preferredId?: string | null) => {
    setBusy(true);
    setError(null);
    try {
      const response = await listLocalModelfiles();
      setArtifacts(response.modelfiles);
      setSelectedId((current) => {
        if (preferredId && response.modelfiles.some((artifact) => artifact.id === preferredId)) return preferredId;
        if (current && response.modelfiles.some((artifact) => artifact.id === current)) return current;
        return response.modelfiles[0]?.id ?? null;
      });
    } catch (loadError) {
      handleError(loadError);
    } finally {
      setBusy(false);
    }
  }, [handleError]);

  const loadSelected = useCallback(async (modelfileId: string) => {
    setBusy(true);
    setError(null);
    setHistoricalRevision(null);
    try {
      const [detailResponse, historyResponse] = await Promise.all([
        readLocalModelfile(modelfileId),
        listLocalModelfileRevisions(modelfileId),
      ]);
      setSelected(detailResponse.modelfile);
      setHistory(historyResponse.revisions);
      setRevisionRaw(detailResponse.modelfile.currentRevision.rawText);
    } catch (loadError) {
      setSelected(null);
      setHistory([]);
      handleError(loadError);
    } finally {
      setBusy(false);
    }
  }, [handleError]);

  useEffect(() => { void loadList(); }, [loadList]);
  useEffect(() => {
    if (selectedId) void loadSelected(selectedId);
    else {
      setSelected(null);
      setHistory([]);
      setHistoricalRevision(null);
    }
  }, [loadSelected, selectedId]);
  useEffect(() => {
    if (inventory.installed.some((model) => model.model === importModel)) return;
    setImportModel(inventory.installed[0]?.model ?? '');
  }, [importModel, inventory.installed]);

  const selectedSummary = useMemo(
    () => artifacts.find((artifact) => artifact.id === selectedId) ?? null,
    [artifacts, selectedId],
  );

  async function createArtifact(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const response = await createLocalModelfile({
        displayName: createName,
        description: createDescription || undefined,
        rawText: createRaw,
      });
      setCreateName('');
      setCreateDescription('');
      setCreateRaw('FROM model:latest\n');
      setNotice(`Created local Modelfile ${response.modelfile.displayName} at revision 1.`);
      await loadList(response.modelfile.id);
      await loadSelected(response.modelfile.id);
    } catch (createError) {
      handleError(createError);
    } finally {
      setBusy(false);
    }
  }

  async function importArtifact(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!importModel) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const response = await importInstalledModelfile({
        targetId: status.target.id,
        model: importModel,
        displayName: importName || undefined,
        description: importDescription || undefined,
      });
      setImportName('');
      setImportDescription('');
      setNotice(`Imported ${response.modelfile.currentRevision.importedModel} as an immutable revision 1 snapshot.`);
      await loadList(response.modelfile.id);
      await loadSelected(response.modelfile.id);
    } catch (importError) {
      handleError(importError);
    } finally {
      setBusy(false);
    }
  }

  async function appendRevision(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected) return;
    const expectedCurrentRevisionId = selected.currentRevisionId;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const response = await appendLocalModelfileRevision(selected.id, {
        expectedCurrentRevisionId,
        rawText: revisionRaw,
      });
      setSelected(response.modelfile);
      setRevisionRaw(response.modelfile.currentRevision.rawText);
      setHistoricalRevision(null);
      setNotice(`Created revision ${response.modelfile.currentRevision.revisionNumber}; earlier revisions remain immutable.`);
      await loadList(response.modelfile.id);
      const historyResponse = await listLocalModelfileRevisions(response.modelfile.id);
      setHistory(historyResponse.revisions);
    } catch (appendError) {
      handleError(appendError);
      if (appendError instanceof ApiError && appendError.code === 'MODEFILE_REVISION_CONFLICT') {
        try {
          const current = await readLocalModelfile(selected.id);
          setSelected(current.modelfile);
          const currentHistory = await listLocalModelfileRevisions(selected.id);
          setHistory(currentHistory.revisions);
          setNotice('The server has a newer current revision. Your draft remains in the editor; compare it before retrying.');
        } catch (refreshError) {
          handleError(refreshError);
        }
      }
    } finally {
      setBusy(false);
    }
  }

  async function viewHistoricalRevision(revisionId: string) {
    if (!selectedId) return;
    setBusy(true);
    setError(null);
    try {
      const response = await readLocalModelfileRevision(selectedId, revisionId);
      setHistoricalRevision(response.revision);
    } catch (readError) {
      handleError(readError);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="local-modelfiles" aria-labelledby="local-modelfiles-title">
      <div className="local-modelfiles-heading">
        <div>
          <p className="eyebrow">Local versioned source</p>
          <h3 id="local-modelfiles-title">Local Modelfiles</h3>
          <p className="muted">
            Raw Modelfile text is the canonical source. Every save creates a new immutable server-side revision.
          </p>
        </div>
        <button className="secondary-button" disabled={disabled || busy} onClick={() => void loadList(selectedId)} type="button">
          {busy ? 'Working…' : 'Refresh library'}
        </button>
      </div>

      {error ? <p className="error-box" role="alert">{error}</p> : null}
      {notice ? <p className="modelfile-notice" role="status">{notice}</p> : null}

      <div className="modelfile-create-grid">
        <form className="modelfile-form" onSubmit={(event) => void createArtifact(event)}>
          <h4>Create from raw source</h4>
          <label>
            Display name
            <input disabled={disabled || busy} maxLength={160} onChange={(event) => setCreateName(event.target.value)} required value={createName} />
          </label>
          <label>
            Description
            <input disabled={disabled || busy} maxLength={1000} onChange={(event) => setCreateDescription(event.target.value)} value={createDescription} />
          </label>
          <label>
            Raw Modelfile
            <textarea disabled={disabled || busy} onChange={(event) => setCreateRaw(event.target.value)} required rows={8} spellCheck={false} value={createRaw} />
          </label>
          <button className="primary-button" disabled={disabled || busy} type="submit">Create revision 1</button>
        </form>

        <form className="modelfile-form" onSubmit={(event) => void importArtifact(event)}>
          <h4>Import installed model</h4>
          <p className="muted">The server re-reads Ollama and records the observed model digest and generated Modelfile. Browser-supplied provenance is not accepted.</p>
          <label>
            Installed model
            <select disabled={disabled || busy || inventory.installed.length === 0} onChange={(event) => setImportModel(event.target.value)} value={importModel}>
              {inventory.installed.map((model) => <option key={`${model.digest}:${model.model}`} value={model.model}>{model.name}</option>)}
            </select>
          </label>
          <label>
            Local display name (optional)
            <input disabled={disabled || busy} maxLength={160} onChange={(event) => setImportName(event.target.value)} value={importName} />
          </label>
          <label>
            Description (optional)
            <input disabled={disabled || busy} maxLength={1000} onChange={(event) => setImportDescription(event.target.value)} value={importDescription} />
          </label>
          <button className="primary-button" disabled={disabled || busy || !importModel} type="submit">Import observed Modelfile</button>
        </form>
      </div>

      <div className="modelfile-library-grid">
        <section className="modelfile-list" aria-label="Local Modelfile artifacts">
          <div className="models-section-heading">
            <div>
              <h4>Artifacts</h4>
              <p className="muted">{artifacts.length} local Modelfile{artifacts.length === 1 ? '' : 's'}</p>
            </div>
          </div>
          {artifacts.length === 0 ? <p className="models-notice">No local Modelfiles yet.</p> : (
            <div className="modelfile-artifacts">
              {artifacts.map((artifact) => (
                <button
                  className={artifact.id === selectedId ? 'modelfile-artifact selected' : 'modelfile-artifact'}
                  disabled={disabled || busy}
                  key={artifact.id}
                  onClick={() => setSelectedId(artifact.id)}
                  type="button"
                >
                  <strong>{artifact.displayName}</strong>
                  <span>r{artifact.currentRevisionNumber} · {sourceLabel(artifact.currentSourceKind)}</span>
                  <small>{formatTimestamp(artifact.updatedAt)}</small>
                </button>
              ))}
            </div>
          )}
        </section>

        <section className="modelfile-editor" aria-label="Selected local Modelfile">
          {selected && selectedSummary ? (
            <>
              <div className="modelfile-editor-heading">
                <div>
                  <h4>{selected.displayName}</h4>
                  <p className="muted">Current revision {selected.currentRevisionNumber} · {shortHash(selected.currentRevision.contentSha256)}</p>
                </div>
                <span className="status-pill status-ok">Immutable history</span>
              </div>
              {selected.description ? <p>{selected.description}</p> : null}
              {selected.currentRevision.sourceKind === 'installed-model-import' ? (
                <dl className="modelfile-import-evidence">
                  <div><dt>Imported target</dt><dd>{selected.currentRevision.importedTargetId}</dd></div>
                  <div><dt>Observed model</dt><dd>{selected.currentRevision.importedModel}</dd></div>
                  <div><dt>Observed digest</dt><dd><code>{selected.currentRevision.importedDigest}</code></dd></div>
                </dl>
              ) : null}

              <form className="modelfile-revision-form" onSubmit={(event) => void appendRevision(event)}>
                <label>
                  New revision based on r{selected.currentRevisionNumber}
                  <textarea
                    disabled={disabled || busy}
                    onChange={(event) => setRevisionRaw(event.target.value)}
                    rows={14}
                    spellCheck={false}
                    value={revisionRaw}
                  />
                </label>
                <div className="modelfile-revision-actions">
                  <span className="muted">Base: <code>{shortHash(selected.currentRevision.contentSha256)}</code></span>
                  <button className="primary-button" disabled={disabled || busy || !revisionRaw} type="submit">Create next revision</button>
                </div>
              </form>

              <div className="modelfile-history">
                <h4>Revision history</h4>
                {history.map((revision) => (
                  <button
                    className="modelfile-history-row"
                    disabled={disabled || busy}
                    key={revision.id}
                    onClick={() => void viewHistoricalRevision(revision.id)}
                    type="button"
                  >
                    <strong>r{revision.revisionNumber}</strong>
                    <span>{sourceLabel(revision.sourceKind)}</span>
                    <code>{shortHash(revision.contentSha256)}</code>
                    <small>{formatTimestamp(revision.createdAt)}</small>
                  </button>
                ))}
              </div>

              {historicalRevision ? (
                <section className="modelfile-history-preview">
                  <div className="model-row-heading">
                    <h4>Revision {historicalRevision.revisionNumber}</h4>
                    <button className="secondary-button" onClick={() => setHistoricalRevision(null)} type="button">Close snapshot</button>
                  </div>
                  <p className="muted">Read-only historical source · <code>{historicalRevision.contentSha256}</code></p>
                  <pre>{historicalRevision.rawText}</pre>
                </section>
              ) : null}
            </>
          ) : <p className="models-notice">Select or create a local Modelfile.</p>}
        </section>
      </div>
    </section>
  );
}
