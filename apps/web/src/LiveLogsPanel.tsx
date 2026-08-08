import {
  useEffect,
  useRef,
  useState,
} from 'react';
import { ApiError, type TargetStatusResult } from './api.js';
import {
  appendBoundedLogEntries,
  LOG_TAIL_OPTIONS,
  openLogStream,
  SseParser,
  type LogEntry,
  type LogStreamKind,
  type LogTail,
} from './log-stream.js';
import './live-logs.css';

type StreamState = 'idle' | 'connecting' | 'connected' | 'ended' | 'error';

interface LiveLogsPanelProps {
  readonly status: TargetStatusResult;
  readonly disabled: boolean;
  readonly onSignedOut: () => void;
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return `${error.code}: ${error.message}`;
  if (error instanceof Error) return error.message;
  return 'Unexpected live log error.';
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function parseLogEvent(data: string): { readonly stream: LogStreamKind; readonly chunk: string } | null {
  try {
    const value = JSON.parse(data) as { stream?: unknown; chunk?: unknown };
    if ((value.stream !== 'stdout' && value.stream !== 'stderr') || typeof value.chunk !== 'string') return null;
    return { stream: value.stream, chunk: value.chunk };
  } catch {
    return null;
  }
}

export default function LiveLogsPanel({ status, disabled, onSignedOut }: LiveLogsPanelProps) {
  const [tail, setTail] = useState<LogTail>(100);
  const [streamState, setStreamState] = useState<StreamState>('idle');
  const [entries, setEntries] = useState<readonly LogEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [endMessage, setEndMessage] = useState<string | null>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const controllerRef = useRef<AbortController | null>(null);
  const nextEntryId = useRef(1);
  const outputRef = useRef<HTMLDivElement | null>(null);
  const userDisconnectRef = useRef(false);

  const connected = streamState === 'connecting' || streamState === 'connected';

  useEffect(() => {
    if (!disabled) return;
    disconnect();
  // `disconnect` is intentionally stable over component lifetime and only touches refs/state setters.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [disabled]);

  useEffect(() => () => {
    userDisconnectRef.current = true;
    controllerRef.current?.abort();
    controllerRef.current = null;
  }, []);

  useEffect(() => {
    if (!autoScroll || !outputRef.current) return;
    outputRef.current.scrollTop = outputRef.current.scrollHeight;
  }, [entries, autoScroll]);

  function disconnect(): void {
    if (!controllerRef.current) return;
    userDisconnectRef.current = true;
    controllerRef.current.abort();
    controllerRef.current = null;
    setStreamState('idle');
    setEndMessage('Disconnected by operator.');
  }

  function append(stream: LogStreamKind, chunk: string): void {
    const entry: LogEntry = { id: nextEntryId.current++, stream, chunk };
    setEntries((current) => appendBoundedLogEntries(current, [entry]));
  }

  async function connect(): Promise<void> {
    if (disabled || connected) return;
    const controller = new AbortController();
    controllerRef.current = controller;
    userDisconnectRef.current = false;
    setError(null);
    setEndMessage(null);
    setStreamState('connecting');
    const parser = new SseParser();
    const decoder = new TextDecoder();

    try {
      const response = await openLogStream(status.target.id, tail, controller.signal);
      const reader = response.body!.getReader();
      setStreamState('connected');
      let terminalEvent = false;

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        for (const frame of parser.push(text)) {
          if (frame.event === 'ready') {
            setStreamState('connected');
            continue;
          }
          if (frame.event === 'log') {
            const log = parseLogEvent(frame.data);
            if (!log) throw new ApiError(502, 'LOG_STREAM_PROTOCOL_INVALID', 'Log stream returned an invalid log event.');
            append(log.stream, log.chunk);
            continue;
          }
          if (frame.event === 'end') {
            terminalEvent = true;
            let message = 'Remote log stream ended.';
            try {
              const data = JSON.parse(frame.data) as { exitCode?: unknown; signal?: unknown; cancelled?: unknown };
              message = `Remote log stream ended · exit ${String(data.exitCode ?? 'unknown')}${data.signal ? ` · signal ${String(data.signal)}` : ''}${data.cancelled ? ' · cancelled' : ''}.`;
            } catch { /* retain safe generic end message */ }
            setEndMessage(message);
            setStreamState('ended');
            continue;
          }
          if (frame.event === 'error') {
            terminalEvent = true;
            let message = 'LOG_STREAM_FAILED: Remote log stream failed.';
            try {
              const data = JSON.parse(frame.data) as { code?: unknown; message?: unknown };
              if (typeof data.code === 'string' && typeof data.message === 'string') message = `${data.code}: ${data.message}`;
            } catch { /* retain safe generic error */ }
            setError(message);
            setStreamState('error');
          }
        }
      }

      if (!terminalEvent && !controller.signal.aborted) {
        setEndMessage('Log stream connection closed. Reconnect explicitly to continue.');
        setStreamState('ended');
      }
    } catch (streamError) {
      if (isAbortError(streamError) || controller.signal.aborted) {
        if (!userDisconnectRef.current) setEndMessage('Log stream was cancelled.');
        setStreamState('idle');
      } else if (streamError instanceof ApiError && streamError.status === 401) {
        onSignedOut();
      } else {
        setError(errorMessage(streamError));
        setStreamState('error');
      }
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null;
    }
  }

  function clear(): void {
    setEntries([]);
    setError(null);
    setEndMessage(null);
  }

  return (
    <section className="logs-panel" aria-labelledby="live-logs-title">
      <div className="logs-heading">
        <div>
          <p className="eyebrow">Read-only stream</p>
          <h2 id="live-logs-title">Live container logs</h2>
          <p className="muted">
            Streams the selected container through the pinned server-side SSH connection. Disconnecting the browser stream cancels the remote follow process.
          </p>
        </div>
        <span className={`logs-state logs-state-${streamState}`}>{streamState}</span>
      </div>

      <div className="logs-controls">
        <label>
          Initial tail
          <select
            disabled={disabled || connected}
            onChange={(event) => setTail(Number(event.target.value) as LogTail)}
            value={tail}
          >
            {LOG_TAIL_OPTIONS.map((value) => (
              <option key={value} value={value}>{value === 0 ? 'New lines only' : `${value} lines`}</option>
            ))}
          </select>
        </label>
        <button
          className="primary-button"
          disabled={disabled || connected}
          onClick={() => void connect()}
          type="button"
        >
          {streamState === 'connecting' ? 'Connecting…' : 'Connect'}
        </button>
        <button
          className="secondary-button"
          disabled={!connected}
          onClick={disconnect}
          type="button"
        >
          Disconnect
        </button>
        <button className="secondary-button" disabled={entries.length === 0} onClick={clear} type="button">Clear</button>
        <label className="checkbox-label logs-auto-scroll">
          <input checked={autoScroll} onChange={(event) => setAutoScroll(event.target.checked)} type="checkbox" />
          Auto-scroll
        </label>
      </div>

      <div className="logs-meta">
        <span>Target <strong>{status.target.displayName}</strong></span>
        <span>Container <code>{status.target.selectedContainerId}</code></span>
        <span>{entries.length} buffered events</span>
      </div>

      {error ? <p className="error-box" role="alert">{error}</p> : null}
      {endMessage ? <p className="logs-notice" role="status">{endMessage}</p> : null}

      <div className="logs-output" ref={outputRef} role="log" aria-live="off" aria-label="Container log output">
        {entries.length === 0 ? (
          <p className="logs-empty">No buffered log events. Connect to start streaming.</p>
        ) : entries.map((entry) => (
          <div className={`logs-entry logs-entry-${entry.stream}`} key={entry.id}>
            <span className="logs-stream">{entry.stream}</span>
            <pre>{entry.chunk}</pre>
          </div>
        ))}
      </div>
    </section>
  );
}
