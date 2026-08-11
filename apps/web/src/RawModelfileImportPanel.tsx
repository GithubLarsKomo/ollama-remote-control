import { useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { ApiError } from './api.js';
import { createLocalModelfile } from './modelfile-library.js';

const MAX_MODEFILE_BYTES = 512 * 1024;

export function defaultImportedModelfileName(filename: string): string {
  const basename = filename.normalize('NFKC').split(/[\\/]/u).pop() ?? '';
  const withoutExtension = basename.replace(/\.(?:modelfile|txt)$/iu, '');
  const cleaned = withoutExtension
    .replace(/[\u0000-\u001f\u007f]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 160);
  return cleaned || 'Imported Modelfile';
}

export async function readRawModelfile(file: File): Promise<string> {
  if (file.size === 0 || file.size > MAX_MODEFILE_BYTES) {
    throw new ApiError(400, 'INVALID_MODEFILE_FILE', `Modelfile file must contain 1-${MAX_MODEFILE_BYTES} UTF-8 bytes.`);
  }
  let rawText: string;
  try {
    rawText = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
  } catch {
    throw new ApiError(400, 'INVALID_MODEFILE_ENCODING', 'Modelfile file must be valid UTF-8 text.');
  }
  if (!rawText || rawText.includes('\u0000')) {
    throw new ApiError(400, 'INVALID_MODEFILE_FILE', 'Modelfile file must be non-empty UTF-8 text without NUL characters.');
  }
  return rawText;
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return `${error.code}: ${error.message}`;
  if (error instanceof Error) return error.message;
  return 'Unexpected Modelfile import error.';
}

export default function RawModelfileImportPanel({
  disabled,
  onImported,
  onSignedOut,
}: {
  readonly disabled: boolean;
  readonly onImported: () => Promise<void> | void;
  readonly onSignedOut: () => void;
}) {
  const fileInput = useRef<HTMLInputElement | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [displayName, setDisplayName] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  function selectFile(event: ChangeEvent<HTMLInputElement>) {
    const next = event.target.files?.[0] ?? null;
    setFile(next);
    setError(null);
    setNotice(null);
    if (next) setDisplayName(defaultImportedModelfileName(next.name));
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!file) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const rawText = await readRawModelfile(file);
      const response = await createLocalModelfile({
        displayName,
        description: description || undefined,
        rawText,
      });
      setNotice(`Imported ${response.modelfile.displayName} as immutable revision 1.`);
      setFile(null);
      setDisplayName('');
      setDescription('');
      if (fileInput.current) fileInput.current.value = '';
      await onImported();
    } catch (importError) {
      if (importError instanceof ApiError && importError.status === 401) {
        onSignedOut();
        return;
      }
      setError(errorMessage(importError));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="modelfile-form" aria-labelledby="raw-modelfile-import-title">
      <h3 id="raw-modelfile-import-title">Import raw Modelfile</h3>
      <p className="muted">Reads a local UTF-8 text file in the browser and sends only its text plus local metadata to the existing immutable library. Browser filesystem paths and provenance claims are never sent.</p>
      {error ? <p className="error-box" role="alert">{error}</p> : null}
      {notice ? <p className="modelfile-notice" role="status">{notice}</p> : null}
      <form onSubmit={(event) => void submit(event)}>
        <label>
          Modelfile
          <input
            accept=".modelfile,.txt,text/plain"
            disabled={disabled || busy}
            onChange={selectFile}
            ref={fileInput}
            required
            type="file"
          />
        </label>
        <label>
          Display name
          <input disabled={disabled || busy} maxLength={160} onChange={(event) => setDisplayName(event.target.value)} required value={displayName} />
        </label>
        <label>
          Description (optional)
          <input disabled={disabled || busy} maxLength={1000} onChange={(event) => setDescription(event.target.value)} value={description} />
        </label>
        <button className="primary-button" disabled={disabled || busy || !file || !displayName.trim()} type="submit">
          {busy ? 'Importing…' : 'Import as revision 1'}
        </button>
      </form>
    </section>
  );
}
