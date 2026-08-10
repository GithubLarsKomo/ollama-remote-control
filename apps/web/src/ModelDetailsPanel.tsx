import { useEffect, useMemo, useState } from 'react';
import { ApiError } from './api.js';
import { formatTimestamp } from './format.js';
import {
  fetchModelDetail,
  fetchModelSources,
  type ModelDetailView,
  type ModelSourceResolutionView,
  type ModelSourceView,
  type ProvenanceReferencePreview,
} from './model-inventory.js';

type DetailTab = 'overview' | 'modelfile' | 'runtime';

interface ModelDetailsPanelProps {
  readonly targetId: string;
  readonly modelName: string;
  readonly disabled: boolean;
  readonly onClose: () => void;
  readonly onSignedOut: () => void;
}

function display(value: string | null): string {
  return value || 'Unavailable';
}

function numberLabel(value: number | null): string {
  return value === null ? 'Unavailable' : value.toLocaleString('en-US');
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return `${error.code}: ${error.message}`;
  if (error instanceof Error) return error.message;
  return 'Unexpected model detail error.';
}

function provenanceLabel(preview: ProvenanceReferencePreview | null): string {
  if (!preview) return 'Unavailable';
  if (preview.kind === 'local-artifact') return `${preview.reference} · local artifact`;
  if (preview.kind === 'model-reference') return `${preview.reference} · model reference`;
  return `${preview.reference} · unclassified`;
}

export function safeModelSourceHref(source: ModelSourceResolutionView): string | null {
  if (source.state !== 'resolved' || source.provider !== 'huggingface' || !source.url) return null;
  try {
    const url = new URL(source.url);
    if (
      url.protocol !== 'https:'
      || url.hostname !== 'huggingface.co'
      || url.username
      || url.password
      || url.search
      || url.hash
      || !/^\/[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(url.pathname)
    ) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function SourceReference({ source }: { readonly source: ModelSourceResolutionView }) {
  const href = safeModelSourceHref(source);
  if (href) {
    return (
      <a href={href} rel="noopener noreferrer" target="_blank">
        {source.reference} · Hugging Face
      </a>
    );
  }
  if (source.state === 'local-artifact') return <span>{source.reference} · local artifact · no upstream link</span>;
  return <span>{source.reference} · unresolved source</span>;
}

function TextBlock({ label, value }: { readonly label: string; readonly value: string | null }) {
  return (
    <section className="model-detail-text-block">
      <h4>{label}</h4>
      {value ? <pre>{value}</pre> : <p className="muted">Unavailable</p>}
    </section>
  );
}

export default function ModelDetailsPanel({
  targetId,
  modelName,
  disabled,
  onClose,
  onSignedOut,
}: ModelDetailsPanelProps) {
  const [detail, setDetail] = useState<ModelDetailView | null>(null);
  const [sources, setSources] = useState<ModelSourceView | null>(null);
  const [busy, setBusy] = useState(false);
  const [sourceBusy, setSourceBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sourceError, setSourceError] = useState<string | null>(null);
  const [tab, setTab] = useState<DetailTab>('overview');

  useEffect(() => {
    let active = true;
    setDetail(null);
    setError(null);
    setTab('overview');
    if (disabled) return () => { active = false; };
    setBusy(true);
    void fetchModelDetail(targetId, modelName).then(
      (result) => {
        if (!active) return;
        setDetail(result);
        setBusy(false);
      },
      (loadError: unknown) => {
        if (!active) return;
        setBusy(false);
        if (loadError instanceof ApiError && loadError.status === 401) {
          onSignedOut();
          return;
        }
        setError(errorMessage(loadError));
      },
    );
    return () => { active = false; };
  }, [disabled, modelName, onSignedOut, targetId]);

  useEffect(() => {
    let active = true;
    setSources(null);
    setSourceError(null);
    if (disabled) return () => { active = false; };
    setSourceBusy(true);
    void fetchModelSources(targetId, modelName).then(
      (result) => {
        if (!active) return;
        setSources(result);
        setSourceBusy(false);
      },
      (loadError: unknown) => {
        if (!active) return;
        setSourceBusy(false);
        if (loadError instanceof ApiError && loadError.status === 401) {
          onSignedOut();
          return;
        }
        setSourceError(errorMessage(loadError));
      },
    );
    return () => { active = false; };
  }, [disabled, modelName, onSignedOut, targetId]);

  const adapters = useMemo(
    () => detail?.provenancePreview.adapters.map((adapter) => provenanceLabel(adapter)) ?? [],
    [detail],
  );

  return (
    <section className="model-detail-panel" aria-labelledby="model-detail-title">
      <div className="model-detail-heading">
        <div>
          <p className="eyebrow">Read-only model detail</p>
          <h3 id="model-detail-title">{modelName}</h3>
          <p className="muted">Loaded from Ollama <code>/api/show</code> through the pinned SSH tunnel.</p>
        </div>
        <button className="secondary-button" disabled={busy} onClick={onClose} type="button">Close details</button>
      </div>

      {busy ? <p className="loading-box" role="status">Reading model details…</p> : null}
      {error ? <p className="error-box" role="alert">{error}</p> : null}

      {detail ? (
        <>
          <div className="model-detail-tabs" role="tablist" aria-label="Model detail sections">
            {(['overview', 'modelfile', 'runtime'] as const).map((candidate) => (
              <button
                aria-selected={tab === candidate}
                className={tab === candidate ? 'model-detail-tab active' : 'model-detail-tab'}
                key={candidate}
                onClick={() => setTab(candidate)}
                role="tab"
                type="button"
              >
                {candidate === 'overview' ? 'Overview' : candidate === 'modelfile' ? 'Modelfile' : 'Runtime metadata'}
              </button>
            ))}
          </div>

          {tab === 'overview' ? (
            <div className="model-detail-body" role="tabpanel">
              <dl className="model-detail-grid">
                <div><dt>Canonical model</dt><dd>{detail.identity.model}</dd></div>
                <div><dt>Digest</dt><dd><code>{detail.identity.digest}</code></dd></div>
                <div><dt>Format</dt><dd>{display(detail.details.format)}</dd></div>
                <div><dt>Family</dt><dd>{display(detail.details.family)}</dd></div>
                <div><dt>Parameter size</dt><dd>{display(detail.details.parameterSize)}</dd></div>
                <div><dt>Quantization</dt><dd>{display(detail.details.quantizationLevel)}</dd></div>
                <div><dt>Architecture</dt><dd>{display(detail.architecture.architecture)}</dd></div>
                <div><dt>Parameter count</dt><dd>{numberLabel(detail.architecture.parameterCount)}</dd></div>
                <div><dt>Context length</dt><dd>{numberLabel(detail.architecture.contextLength)}</dd></div>
                <div><dt>Embedding length</dt><dd>{numberLabel(detail.architecture.embeddingLength)}</dd></div>
                <div><dt>Block count</dt><dd>{numberLabel(detail.architecture.blockCount)}</dd></div>
                <div><dt>Parent metadata</dt><dd>{display(detail.details.parentModel)}</dd></div>
                <div><dt>FROM preview</dt><dd>{provenanceLabel(detail.provenancePreview.from)}</dd></div>
                <div><dt>Capabilities</dt><dd>{detail.capabilities.length ? detail.capabilities.join(', ') : 'Unavailable'}</dd></div>
              </dl>
              {adapters.length ? (
                <section className="model-detail-sources">
                  <h4>ADAPTER preview</h4>
                  <ul>{adapters.map((adapter) => <li key={adapter}>{adapter}</li>)}</ul>
                </section>
              ) : null}

              <section className="model-detail-sources" aria-label="Evidence-bound source links">
                <h4>Source links</h4>
                {sourceBusy ? <p className="muted">Resolving explicit model references…</p> : null}
                {sourceError ? <p className="muted">Source resolution unavailable: {sourceError}</p> : null}
                {sources?.sources.from ? (
                  <p><strong>FROM:</strong> <SourceReference source={sources.sources.from} /></p>
                ) : !sourceBusy ? <p className="muted">No explicit FROM source reference available.</p> : null}
                {sources?.sources.adapters.length ? (
                  <ul>{sources.sources.adapters.map((source, index) => <li key={`${source.reference}:${index}`}><SourceReference source={source} /></li>)}</ul>
                ) : null}
              </section>

              <p className="model-provenance-note">
                Source links are derived only from explicit server-observed references. Local blob or file references are not treated as verified upstream lineage and never receive an external link.
              </p>
            </div>
          ) : null}

          {tab === 'modelfile' ? (
            <div className="model-detail-body" role="tabpanel">
              <TextBlock label="Generated Modelfile" value={detail.modelfile} />
            </div>
          ) : null}

          {tab === 'runtime' ? (
            <div className="model-detail-body" role="tabpanel">
              <dl className="model-detail-grid">
                <div><dt>Modified</dt><dd>{detail.identity.modifiedAt ? formatTimestamp(detail.identity.modifiedAt) : 'Unavailable'}</dd></div>
                <div><dt>Transport</dt><dd>{detail.transport.mode}</dd></div>
                <div><dt>Requires</dt><dd>{display(detail.requires)}</dd></div>
                <div><dt>Quantization version</dt><dd>{numberLabel(detail.architecture.quantizationVersion)}</dd></div>
              </dl>
              <div className="model-detail-text-grid">
                <TextBlock label="Parameters" value={detail.parameters} />
                <TextBlock label="System prompt" value={detail.system} />
                <TextBlock label="Template" value={detail.template} />
                <TextBlock label="License" value={detail.license} />
              </div>
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
