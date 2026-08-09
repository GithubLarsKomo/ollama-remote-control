import {
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react';
import {
  ApiError,
  type TargetStatusResult,
} from './api.js';
import { formatBytes, formatTimestamp } from './format.js';
import LocalModelfilesPanel from './LocalModelfilesPanel.js';
import ModelDetailsPanel from './ModelDetailsPanel.js';
import ModelPullPanel from './ModelPullPanel.js';
import {
  fetchModelInventory,
  runningModelDigests,
  summarizeModelInventory,
  type ModelInventoryView,
  type RunningModelView,
} from './model-inventory.js';
import './models.css';

interface ModelsPanelProps {
  readonly status: TargetStatusResult;
  readonly disabled: boolean;
  readonly onSignedOut: () => void;
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return `${error.code}: ${error.message}`;
  if (error instanceof Error) return error.message;
  return 'Unexpected model inventory error.';
}

function display(value: string | null): string {
  return value || 'Unavailable';
}

function contextLabel(value: number): string {
  return value > 0 ? value.toLocaleString('en-US') : 'Unavailable';
}

function RunningModelCard({ model }: { readonly model: RunningModelView }) {
  return (
    <article className="running-model-card">
      <div className="model-row-heading">
        <strong>{model.name}</strong>
        <span className="model-loaded-badge">Loaded</span>
      </div>
      <dl className="model-small-grid">
        <div><dt>VRAM</dt><dd>{formatBytes(model.sizeVramBytes)}</dd></div>
        <div><dt>Context</dt><dd>{contextLabel(model.contextLength)}</dd></div>
        <div><dt>Expires</dt><dd>{model.expiresAt ? formatTimestamp(model.expiresAt) : 'Unavailable'}</dd></div>
        <div><dt>Quantization</dt><dd>{display(model.details.quantizationLevel)}</dd></div>
      </dl>
    </article>
  );
}

export default function ModelsPanel({ status, disabled, onSignedOut }: ModelsPanelProps) {
  const [inventory, setInventory] = useState<ModelInventoryView | null>(null);
  const [selectedModel, setSelectedModel] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!status.container.running || disabled) return;
    setBusy(true);
    setError(null);
    try {
      const next = await fetchModelInventory(status.target.id);
      setInventory(next);
      setSelectedModel((current) => current && next.installed.some((model) => model.model === current) ? current : null);
    } catch (loadError) {
      if (loadError instanceof ApiError && loadError.status === 401) {
        onSignedOut();
        return;
      }
      setInventory(null);
      setSelectedModel(null);
      setError(errorMessage(loadError));
    } finally {
      setBusy(false);
    }
  }, [disabled, onSignedOut, status.container.running, status.target.id]);

  useEffect(() => {
    if (!status.container.running) {
      setInventory(null);
      setSelectedModel(null);
      setError(null);
      return;
    }
    void load();
  }, [load, status.container.running]);

  const summary = useMemo(
    () => inventory ? summarizeModelInventory(inventory) : null,
    [inventory],
  );
  const loadedDigests = useMemo(
    () => inventory ? runningModelDigests(inventory) : new Set<string>(),
    [inventory],
  );

  return (
    <section className="models-panel" aria-labelledby="models-title">
      <div className="models-heading">
        <div>
          <p className="eyebrow">Ollama API over pinned SSH</p>
          <h2 id="models-title">Models</h2>
          <p className="muted">
            Inventory, details and local Modelfile revisions stay server-authoritative. Model pulls run as persistent jobs through a fixed Ollama API operation. Port 11434 remains private.
          </p>
        </div>
        <button
          className="secondary-button"
          disabled={disabled || busy || !status.container.running}
          onClick={() => void load()}
          type="button"
        >
          {busy ? 'Refreshing…' : 'Refresh models'}
        </button>
      </div>

      <ModelPullPanel
        disabled={disabled || busy || !status.container.running}
        onSignedOut={onSignedOut}
        onSucceeded={load}
        targetId={status.target.id}
      />

      {!status.container.running ? (
        <p className="models-notice">Start the Ollama container to read its model inventory or begin a new pull.</p>
      ) : null}
      {error ? <p className="error-box" role="alert">{error}</p> : null}
      {busy && !inventory ? <p className="loading-box" role="status">Reading Ollama model inventory…</p> : null}

      {inventory && summary ? (
        <>
          <div className="models-summary" aria-label="Model inventory summary">
            <div><span>Installed</span><strong>{summary.installedCount}</strong><small>{formatBytes(summary.installedBytes)}</small></div>
            <div><span>Loaded</span><strong>{summary.runningCount}</strong><small>{formatBytes(summary.runningVramBytes)} VRAM</small></div>
            <div><span>Transport</span><strong>{inventory.transport.mode === 'published-binding' ? 'SSH → host binding' : 'SSH → container network'}</strong><small>Ollama API</small></div>
          </div>

          <div className="models-section-heading">
            <div>
              <h3>Installed models</h3>
              <p className="muted">Equivalent to the read-only inventory behind <code>ollama ls</code>.</p>
            </div>
          </div>

          {inventory.installed.length === 0 ? (
            <p className="models-notice">No installed models reported by Ollama.</p>
          ) : (
            <div className="model-table-wrap">
              <table className="model-table">
                <thead>
                  <tr>
                    <th>Model</th>
                    <th>Size</th>
                    <th>Parameters</th>
                    <th>Quantization</th>
                    <th>Family</th>
                    <th>Modified</th>
                    <th>State</th>
                    <th>Details</th>
                  </tr>
                </thead>
                <tbody>
                  {inventory.installed.map((model) => (
                    <tr key={`${model.digest}:${model.model}`}>
                      <td>
                        <strong>{model.name}</strong>
                        <code title={model.digest}>{model.digest.slice(0, 12)}…</code>
                      </td>
                      <td>{formatBytes(model.sizeBytes)}</td>
                      <td>{display(model.details.parameterSize)}</td>
                      <td>{display(model.details.quantizationLevel)}</td>
                      <td>{display(model.details.family)}</td>
                      <td>{model.modifiedAt ? formatTimestamp(model.modifiedAt) : 'Unavailable'}</td>
                      <td>{loadedDigests.has(model.digest) ? <span className="model-loaded-badge">Loaded</span> : <span className="status-pill status-muted">Idle</span>}</td>
                      <td>
                        <button
                          className="secondary-button model-detail-button"
                          disabled={disabled || busy}
                          onClick={() => setSelectedModel(model.model)}
                          type="button"
                        >
                          {selectedModel === model.model ? 'Selected' : 'Details'}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {selectedModel ? (
            <ModelDetailsPanel
              disabled={disabled || busy}
              key={`${status.target.id}:${status.target.selectedContainerId}:${status.container.startedAt ?? 'stopped'}:${selectedModel}`}
              modelName={selectedModel}
              onClose={() => setSelectedModel(null)}
              onSignedOut={onSignedOut}
              targetId={status.target.id}
            />
          ) : null}

          <div className="models-section-heading models-running-heading">
            <div>
              <h3>Loaded models</h3>
              <p className="muted">Equivalent to the read-only inventory behind <code>ollama ps</code>.</p>
            </div>
          </div>
          {inventory.running.length === 0 ? (
            <p className="models-notice">No models are currently loaded in Ollama memory.</p>
          ) : (
            <div className="running-model-grid">
              {inventory.running.map((model) => <RunningModelCard key={`${model.digest}:${model.model}`} model={model} />)}
            </div>
          )}

          <LocalModelfilesPanel
            disabled={disabled || busy}
            inventory={inventory}
            onSignedOut={onSignedOut}
            status={status}
          />
        </>
      ) : null}
    </section>
  );
}
