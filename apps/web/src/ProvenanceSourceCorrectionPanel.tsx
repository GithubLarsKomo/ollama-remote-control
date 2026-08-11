import { useMemo, useState } from 'react';
import { ApiError } from './api.js';
import {
  correctModelSource,
  type ModelSourceView,
  type PersistedProvenanceSourceView,
  type ProvenanceSourceCorrectionRequest,
} from './model-inventory.js';

interface ProvenanceSourceCorrectionPanelProps {
  readonly disabled: boolean;
  readonly sources: ModelSourceView;
  readonly onCorrected: (source: PersistedProvenanceSourceView) => void;
  readonly onSignedOut: () => void;
}

export function activePersistedSource(
  sources: readonly PersistedProvenanceSourceView[],
): PersistedProvenanceSourceView | null {
  const superseded = new Set(sources.map((source) => source.supersedesSourceId).filter((id): id is string => Boolean(id)));
  return sources.find((source) => !superseded.has(source.id)) ?? null;
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return `${error.code}: ${error.message}`;
  if (error instanceof Error) return error.message;
  return 'Unexpected provenance correction error.';
}

export default function ProvenanceSourceCorrectionPanel({
  disabled,
  sources,
  onCorrected,
  onSignedOut,
}: ProvenanceSourceCorrectionPanelProps) {
  const current = useMemo(() => activePersistedSource(sources.persistedSources), [sources.persistedSources]);
  const [sourceKind, setSourceKind] = useState<ProvenanceSourceCorrectionRequest['sourceKind']>(current?.sourceKind ?? 'unknown');
  const [sourceReference, setSourceReference] = useState(current?.sourceReference ?? '');
  const [confidence, setConfidence] = useState<'high' | 'medium' | 'low'>(
    current?.confidence === 'high' || current?.confidence === 'medium' || current?.confidence === 'low'
      ? current.confidence
      : 'medium',
  );
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const nodeId = sources.persistedGraph.currentNodeId;
  const isUnknown = sourceKind === 'unknown';

  async function submit() {
    if (!nodeId || disabled || busy) return;
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const created = await correctModelSource(nodeId, {
        sourceKind,
        sourceReference: isUnknown ? null : sourceReference,
        confidence: isUnknown ? 'unknown' : confidence,
        note: note.trim() || null,
        supersedesSourceId: current?.id ?? null,
      });
      onCorrected(created);
      setNote('');
      setSaved(true);
    } catch (saveError) {
      if (saveError instanceof ApiError && saveError.status === 401) {
        onSignedOut();
        return;
      }
      setError(errorMessage(saveError));
    } finally {
      setBusy(false);
    }
  }

  if (!nodeId) {
    return (
      <section className="model-detail-sources" aria-label="Manual provenance source correction">
        <h4>Operator source evidence</h4>
        <p className="muted">No persisted exact-digest model node exists yet, so manual source evidence cannot be attached safely.</p>
      </section>
    );
  }

  return (
    <section className="model-detail-sources" aria-label="Manual provenance source correction">
      <h4>Operator source evidence</h4>
      {current ? (
        <p className="muted">
          Current: <strong>{current.sourceKind}</strong> · {current.confidence}
          {current.sourceReference ? <> · <code>{current.sourceReference}</code></> : ' · no source reference'}
          {' · '}{current.origin}
        </p>
      ) : (
        <p className="muted">No operator source evidence is recorded for this exact target/model/digest.</p>
      )}
      <p className="muted">
        Saving appends a new immutable evidence row. It never rewrites history. If another correction wins first, this form fails stale and must be refreshed.
      </p>

      <div className="model-detail-grid">
        <label>
          <span>Source type</span>
          <select disabled={disabled || busy} value={sourceKind} onChange={(event) => setSourceKind(event.target.value as ProvenanceSourceCorrectionRequest['sourceKind'])}>
            <option value="unknown">Unknown</option>
            <option value="huggingface">Hugging Face</option>
            <option value="ollama">Ollama</option>
            <option value="url">Other HTTPS URL</option>
          </select>
        </label>
        {!isUnknown ? (
          <label>
            <span>HTTPS source</span>
            <input
              disabled={disabled || busy}
              onChange={(event) => setSourceReference(event.target.value)}
              placeholder="https://…"
              type="url"
              value={sourceReference}
            />
          </label>
        ) : null}
        {!isUnknown ? (
          <label>
            <span>Confidence</span>
            <select disabled={disabled || busy} value={confidence} onChange={(event) => setConfidence(event.target.value as 'high' | 'medium' | 'low')}>
              <option value="high">High</option>
              <option value="medium">Medium</option>
              <option value="low">Low</option>
            </select>
          </label>
        ) : null}
        <label>
          <span>Operator note (optional)</span>
          <input disabled={disabled || busy} maxLength={1024} onChange={(event) => setNote(event.target.value)} value={note} />
        </label>
      </div>

      <div className="model-detail-actions">
        <button
          className="secondary-button"
          disabled={disabled || busy || (!isUnknown && !sourceReference.trim())}
          onClick={() => void submit()}
          type="button"
        >
          {busy ? 'Saving evidence…' : current ? 'Append source correction' : 'Record source evidence'}
        </button>
      </div>
      {saved ? <p className="success-box" role="status">Source evidence appended.</p> : null}
      {error ? <p className="error-box" role="alert">{error}</p> : null}
    </section>
  );
}
