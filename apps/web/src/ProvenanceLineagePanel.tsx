import { useMemo, useState } from 'react';
import { ApiError } from './api.js';
import { formatTimestamp } from './format.js';
import {
  recordModelLineage,
  type ModelSourceView,
  type PersistedProvenanceEdgeView,
  type PersistedProvenanceNodeView,
  type ProvenanceLineageRequest,
  type RecordedProvenanceLineageView,
} from './model-inventory.js';

interface ProvenanceLineagePanelProps {
  readonly disabled: boolean;
  readonly sources: ModelSourceView;
  readonly onRecorded: (recorded: RecordedProvenanceLineageView) => void;
  readonly onSignedOut: () => void;
}

function nodeLabel(node: PersistedProvenanceNodeView | undefined): string {
  if (!node) return 'Unknown node';
  if (node.kind === 'installed-model') return `${node.modelName ?? 'installed model'} · ${node.modelDigest?.slice(0, 12) ?? 'no digest'}…`;
  if (node.kind === 'model-reference') return node.modelName ?? 'model reference';
  return `Modelfile revision ${node.revisionId ?? 'unknown'}`;
}

function relationLabel(relation: PersistedProvenanceEdgeView['relation']): string {
  if (relation === 'base-model') return 'base model';
  if (relation === 'adapter') return 'adapter';
  if (relation === 'quantized-from') return 'quantized from';
  if (relation === 'created-from-revision') return 'created from revision';
  return 'captured as revision';
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return `${error.code}: ${error.message}`;
  if (error instanceof Error) return error.message;
  return 'Unexpected provenance lineage error.';
}

export default function ProvenanceLineagePanel({
  disabled,
  sources,
  onRecorded,
  onSignedOut,
}: ProvenanceLineagePanelProps) {
  const [relation, setRelation] = useState<ProvenanceLineageRequest['relation']>('quantized-from');
  const [parentModel, setParentModel] = useState('');
  const [confidence, setConfidence] = useState<ProvenanceLineageRequest['confidence']>('medium');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const nodes = useMemo(
    () => new Map(sources.persistedGraph.nodes.map((node) => [node.id, node])),
    [sources.persistedGraph.nodes],
  );
  const currentNodeId = sources.persistedGraph.currentNodeId;

  async function submit() {
    if (!currentNodeId || disabled || busy || !parentModel.trim()) return;
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const recorded = await recordModelLineage(currentNodeId, {
        relation,
        parentModel: parentModel.trim(),
        confidence,
      });
      onRecorded(recorded);
      setParentModel('');
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

  return (
    <section className="model-detail-sources" aria-label="Persisted provenance lineage">
      <h4>Persisted lineage</h4>
      {sources.persistedGraph.edges.length ? (
        <ul>
          {sources.persistedGraph.edges.map((edge) => (
            <li key={edge.id}>
              <strong>{nodeLabel(nodes.get(edge.fromNodeId))}</strong>
              {' → '}{relationLabel(edge.relation)}{' → '}
              <strong>{nodeLabel(nodes.get(edge.toNodeId))}</strong>
              {' · '}{edge.origin} · {edge.confidence} confidence · {formatTimestamp(edge.createdAt)}
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">No persisted lineage edges are recorded for this exact model digest.</p>
      )}

      {!currentNodeId ? (
        <p className="muted">A persisted exact-digest installed-model node is required before operator lineage evidence can be attached.</p>
      ) : (
        <>
          <p className="muted">
            Add lineage only when you have explicit evidence. Quantization is never inferred from names such as Q4/Q8. Operator evidence is append-only and visibly marked as operator-supplied.
          </p>
          <div className="model-detail-grid">
            <label>
              <span>Relationship</span>
              <select disabled={disabled || busy} value={relation} onChange={(event) => setRelation(event.target.value as ProvenanceLineageRequest['relation'])}>
                <option value="quantized-from">Quantized from</option>
                <option value="adapter">Adapter</option>
              </select>
            </label>
            <label>
              <span>Parent model reference</span>
              <input
                disabled={disabled || busy}
                maxLength={512}
                onChange={(event) => setParentModel(event.target.value)}
                placeholder="hf.co/org/model:tag or model:tag"
                value={parentModel}
              />
            </label>
            <label>
              <span>Confidence</span>
              <select disabled={disabled || busy} value={confidence} onChange={(event) => setConfidence(event.target.value as ProvenanceLineageRequest['confidence'])}>
                <option value="high">High</option>
                <option value="medium">Medium</option>
                <option value="low">Low</option>
              </select>
            </label>
          </div>
          <div className="model-detail-actions">
            <button
              className="secondary-button"
              disabled={disabled || busy || !parentModel.trim()}
              onClick={() => void submit()}
              type="button"
            >
              {busy ? 'Recording lineage…' : 'Record lineage evidence'}
            </button>
          </div>
          {saved ? <p className="success-box" role="status">Lineage evidence recorded.</p> : null}
          {error ? <p className="error-box" role="alert">{error}</p> : null}
        </>
      )}
    </section>
  );
}
