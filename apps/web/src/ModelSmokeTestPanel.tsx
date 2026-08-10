import { useMemo, useState } from 'react';
import { ApiError } from './api.js';
import type { ModelInventoryView } from './model-inventory.js';
import { runModelSmokeTest, type ModelSmokeResultView } from './model-smoke.js';

interface ModelSmokeTestPanelProps {
  readonly targetId: string;
  readonly targetName: string;
  readonly inventory: ModelInventoryView;
  readonly disabled: boolean;
  readonly onSignedOut: () => void;
  readonly onSucceeded: () => Promise<void> | void;
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return `${error.code}: ${error.message}`;
  if (error instanceof Error) return error.message;
  return 'Unexpected model smoke-test error.';
}

export default function ModelSmokeTestPanel({
  targetId,
  targetName,
  inventory,
  disabled,
  onSignedOut,
  onSucceeded,
}: ModelSmokeTestPanelProps) {
  const loadedDigests = useMemo(() => new Set(inventory.running.map((model) => model.digest)), [inventory.running]);
  const idle = useMemo(
    () => inventory.installed.filter((model) => !loadedDigests.has(model.digest)),
    [inventory.installed, loadedDigests],
  );
  const [selectedKey, setSelectedKey] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ModelSmokeResultView | null>(null);

  const selected = idle.find((model) => `${model.model}\u0000${model.digest}` === selectedKey) ?? idle[0] ?? null;

  async function execute() {
    if (!selected) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const next = await runModelSmokeTest({ targetId, model: selected.model, digest: selected.digest });
      if (!next.verified || next.job.state !== 'succeeded') throw new Error('Smoke test did not reach a verified terminal state.');
      setResult(next);
      setConfirming(false);
      await onSucceeded();
    } catch (smokeError) {
      if (smokeError instanceof ApiError && smokeError.status === 401) {
        onSignedOut();
        return;
      }
      setError(errorMessage(smokeError));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="model-pull-panel" aria-labelledby="model-smoke-title">
      <div className="models-section-heading">
        <div>
          <p className="eyebrow">Fixed administrative diagnostic</p>
          <h3 id="model-smoke-title">Model smoke test</h3>
          <p className="muted">
            Tests one installed idle model with a server-defined prompt and deterministic bounded options. The model is released with <code>keep_alive: 0</code>; already-loaded models are deliberately excluded.
          </p>
        </div>
      </div>

      {idle.length === 0 ? (
        <p className="models-notice">No installed idle model is currently eligible for the fixed smoke test.</p>
      ) : (
        <div className="model-pull-form">
          <label>
            Idle installed model
            <select
              disabled={disabled || busy || confirming}
              onChange={(event) => { setSelectedKey(event.target.value); setResult(null); setError(null); }}
              value={selected ? `${selected.model}\u0000${selected.digest}` : ''}
            >
              {idle.map((model) => (
                <option key={`${model.model}:${model.digest}`} value={`${model.model}\u0000${model.digest}`}>
                  {model.name} · {model.digest.slice(0, 12)}…
                </option>
              ))}
            </select>
          </label>

          {!confirming ? (
            <button
              className="secondary-button"
              disabled={disabled || busy || !selected}
              onClick={() => { setConfirming(true); setError(null); setResult(null); }}
              type="button"
            >
              Smoke test selected model
            </button>
          ) : null}
        </div>
      )}

      {confirming && selected ? (
        <div className="model-pull-confirmation">
          <p>
            Run the fixed smoke test for <strong>{selected.name}</strong> on target <strong>{targetName}</strong>?
          </p>
          <p className="muted">
            Installed digest <code>{selected.digest.slice(0, 12)}…</code>. The server re-checks this exact identity, refuses if the model is already loaded, sends the fixed diagnostic request, and verifies the model is released afterwards.
          </p>
          <div className="model-pull-actions">
            <button className="primary-button" disabled={disabled || busy} onClick={() => void execute()} type="button">
              {busy ? 'Running verified test…' : `Confirm smoke test ${selected.name}`}
            </button>
            <button className="secondary-button" disabled={busy} onClick={() => setConfirming(false)} type="button">Cancel</button>
          </div>
        </div>
      ) : null}

      {error ? <p className="error-box" role="alert">{error}</p> : null}
      {result ? (
        <p className="models-notice" role="status">
          Verified smoke test passed for <strong>{result.model}</strong>: {result.elapsedMs.toLocaleString('en-US')} ms, {result.responseChars.toLocaleString('en-US')} generated characters{result.doneReason ? `, done reason ${result.doneReason}` : ''}. Generated text was not persisted.
        </p>
      ) : null}
    </section>
  );
}
