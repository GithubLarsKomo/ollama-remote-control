import { useState } from 'react';
import { ApiError } from './api.js';
import { type RunningModelView } from './model-inventory.js';
import { unloadLoadedModel } from './model-unload.js';
import './model-unload.css';

interface ModelUnloadControlProps {
  readonly targetId: string;
  readonly targetName: string;
  readonly model: RunningModelView;
  readonly disabled: boolean;
  readonly onSignedOut: () => void;
  readonly onSucceeded: () => Promise<void> | void;
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return `${error.code}: ${error.message}`;
  if (error instanceof Error) return error.message;
  return 'Unexpected model unload error.';
}

export default function ModelUnloadControl({
  targetId,
  targetName,
  model,
  disabled,
  onSignedOut,
  onSucceeded,
}: ModelUnloadControlProps) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function unload() {
    setBusy(true);
    setError(null);
    try {
      const result = await unloadLoadedModel({
        targetId,
        model: model.model,
        digest: model.digest,
      });
      if (!result.verified || result.job.state !== 'succeeded') {
        throw new Error('Unload did not reach a verified terminal state.');
      }
      setConfirming(false);
      await onSucceeded();
    } catch (unloadError) {
      if (unloadError instanceof ApiError && unloadError.status === 401) {
        onSignedOut();
        return;
      }
      setError(errorMessage(unloadError));
    } finally {
      setBusy(false);
    }
  }

  if (!confirming) {
    return (
      <button
        className="secondary-button model-unload-button"
        disabled={disabled || busy}
        onClick={() => { setError(null); setConfirming(true); }}
        type="button"
      >
        Unload
      </button>
    );
  }

  return (
    <section className="model-unload-confirmation" aria-label={`Confirm unload ${model.name}`}>
      <p>
        Unload <strong>{model.name}</strong> from target <strong>{targetName}</strong>?
      </p>
      <p className="muted">
        Loaded digest <code>{model.digest.slice(0, 12)}…</code>. The server will re-check this exact model and digest before the fixed unload request and verify its absence afterwards.
      </p>
      {error ? <p className="error-box" role="alert">{error}</p> : null}
      <div className="model-unload-actions">
        <button
          className="primary-button"
          disabled={disabled || busy}
          onClick={() => void unload()}
          type="button"
        >
          {busy ? 'Verifying unload…' : `Confirm unload ${model.name}`}
        </button>
        <button
          className="secondary-button"
          disabled={busy}
          onClick={() => { setConfirming(false); setError(null); }}
          type="button"
        >
          Cancel
        </button>
      </div>
    </section>
  );
}
