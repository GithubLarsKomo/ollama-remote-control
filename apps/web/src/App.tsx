import {
  type FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react';
import {
  ApiError,
  api,
  type SessionView,
  type TargetCatalogEntry,
  type TargetStatusResult,
} from './api.js';
import {
  displayValue,
  formatBytes,
  formatPercent,
  formatTemperature,
  formatTimestamp,
} from './format.js';
import UpdatePanel from './UpdatePanel.js';

type AppPhase = 'loading' | 'bootstrap' | 'login' | 'authenticated' | 'fatal';

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return `${error.code}: ${error.message}`;
  if (error instanceof Error) return error.message;
  return 'Unexpected application error.';
}

interface CredentialsFormProps {
  readonly mode: 'bootstrap' | 'login';
  readonly busy: boolean;
  readonly error: string | null;
  readonly onSubmit: (username: string, password: string) => Promise<void>;
}

function CredentialsForm({ mode, busy, error, onSubmit }: CredentialsFormProps) {
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const currentPassword = password;
    setPassword('');
    await onSubmit(username, currentPassword);
  }

  const bootstrap = mode === 'bootstrap';
  return (
    <main className="auth-shell">
      <section className="auth-card" aria-labelledby="auth-title">
        <div className="brand-mark" aria-hidden="true">ORC</div>
        <p className="eyebrow">Ollama Remote Control</p>
        <h1 id="auth-title">{bootstrap ? 'Create the administrator' : 'Sign in'}</h1>
        <p className="muted">
          {bootstrap
            ? 'Create the first local administrator account for this installation.'
            : 'Use the local administrator account. Session credentials stay in secure cookies.'}
        </p>
        <form onSubmit={(event) => void submit(event)}>
          <label>
            Username
            <input
              autoComplete="username"
              disabled={busy}
              maxLength={120}
              onChange={(event) => setUsername(event.target.value)}
              required
              value={username}
            />
          </label>
          <label>
            Password
            <input
              autoComplete={bootstrap ? 'new-password' : 'current-password'}
              disabled={busy}
              onChange={(event) => setPassword(event.target.value)}
              required
              type="password"
              value={password}
            />
          </label>
          {error ? <p className="error-box" role="alert">{error}</p> : null}
          <button className="primary-button" disabled={busy} type="submit">
            {busy ? 'Working…' : bootstrap ? 'Create administrator' : 'Sign in'}
          </button>
        </form>
      </section>
    </main>
  );
}

function CapabilityState({ available, errorClass }: { readonly available: boolean; readonly errorClass: string | null }) {
  return (
    <span className={`status-pill ${available ? 'status-ok' : 'status-muted'}`}>
      {available ? 'Available' : displayValue(errorClass)}
    </span>
  );
}

function Metric({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="metric">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function ContainerCard({ status }: { readonly status: TargetStatusResult }) {
  return (
    <article className="panel">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Container</p>
          <h2>{displayValue(status.container.name)}</h2>
        </div>
        <span className={`status-pill ${status.container.running ? 'status-ok' : 'status-danger'}`}>
          {status.container.running ? 'Running' : 'Stopped'}
        </span>
      </div>
      <dl className="metrics-grid">
        <Metric label="Image" value={displayValue(status.container.image)} />
        <Metric label="State" value={displayValue(status.container.state)} />
        <Metric label="Health" value={displayValue(status.container.status)} />
        <Metric label="Restarts" value={String(status.container.restartCount)} />
        <Metric label="Started" value={status.container.startedAt ? formatTimestamp(status.container.startedAt) : 'Unavailable'} />
        <Metric label="OOM killed" value={status.container.oomKilled ? 'Yes' : 'No'} />
      </dl>
    </article>
  );
}

function OllamaCard({ status }: { readonly status: TargetStatusResult }) {
  return (
    <article className="panel">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Ollama</p>
          <h2>{status.ollama.available ? displayValue(status.ollama.version) : 'Unavailable'}</h2>
        </div>
        <CapabilityState available={status.ollama.available} errorClass={status.ollama.errorClass} />
      </div>
      <div className="environment-list" aria-label="Ollama environment">
        {status.environment.length === 0 ? (
          <p className="muted">No OLLAMA_* environment values reported.</p>
        ) : status.environment.map((entry) => (
          <div className="environment-row" key={entry.name}>
            <code>{entry.name}</code>
            <span>{entry.redacted ? '••••••••' : displayValue(entry.value)}</span>
          </div>
        ))}
      </div>
    </article>
  );
}

function GpuCard({ status }: { readonly status: TargetStatusResult }) {
  return (
    <article className="panel">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">GPU</p>
          <h2>{status.gpu.available ? `${status.gpu.devices.length} device${status.gpu.devices.length === 1 ? '' : 's'}` : 'Unavailable'}</h2>
        </div>
        <CapabilityState available={status.gpu.available} errorClass={status.gpu.errorClass} />
      </div>
      {status.gpu.available && status.gpu.devices.length > 0 ? (
        <div className="device-list">
          {status.gpu.devices.map((device, index) => (
            <section className="device-card" key={`${device.name}-${index}`}>
              <h3>{displayValue(device.name)}</h3>
              <dl className="metrics-grid compact">
                <Metric label="Driver" value={displayValue(device.driverVersion)} />
                <Metric label="Utilization" value={device.utilizationPercent === null ? 'Unavailable' : formatPercent(device.utilizationPercent)} />
                <Metric label="VRAM used" value={device.memoryUsedMiB === null ? 'Unavailable' : formatBytes(device.memoryUsedMiB * 1024 ** 2)} />
                <Metric label="VRAM total" value={device.memoryTotalMiB === null ? 'Unavailable' : formatBytes(device.memoryTotalMiB * 1024 ** 2)} />
                <Metric label="Temperature" value={device.temperatureC === null ? 'Unavailable' : formatTemperature(device.temperatureC)} />
              </dl>
            </section>
          ))}
        </div>
      ) : <p className="muted">GPU telemetry is optional and does not block target status.</p>}
    </article>
  );
}

function StorageCard({ status }: { readonly status: TargetStatusResult }) {
  const disk = status.modelStorage.disk;
  const mount = status.modelStorage.mount;
  return (
    <article className="panel">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Model storage</p>
          <h2>{status.modelStorage.available && disk ? formatPercent(disk.capacityPercent) : 'Unavailable'}</h2>
        </div>
        <CapabilityState available={status.modelStorage.available} errorClass={status.modelStorage.errorClass} />
      </div>
      {disk ? (
        <>
          <div className="storage-bar" aria-label={`${disk.capacityPercent}% used`}>
            <span style={{ width: `${Math.max(0, Math.min(100, disk.capacityPercent))}%` }} />
          </div>
          <dl className="metrics-grid">
            <Metric label="Used" value={formatBytes(disk.usedKiB * 1024)} />
            <Metric label="Total" value={formatBytes(disk.totalKiB * 1024)} />
            <Metric label="Available" value={formatBytes(disk.availableKiB * 1024)} />
            <Metric label="Mounted on" value={displayValue(disk.mountedOn)} />
            <Metric label="Source" value={displayValue(mount?.source)} />
            <Metric label="Container path" value={displayValue(mount?.destination)} />
          </dl>
        </>
      ) : <p className="muted">Model storage telemetry is optional and does not block target status.</p>}
    </article>
  );
}

function Dashboard({ session, onSignedOut }: { readonly session: SessionView; readonly onSignedOut: () => void }) {
  const [targets, setTargets] = useState<readonly TargetCatalogEntry[]>([]);
  const [selectedTargetId, setSelectedTargetId] = useState<string>('');
  const [status, setStatus] = useState<TargetStatusResult | null>(null);
  const [catalogBusy, setCatalogBusy] = useState(true);
  const [statusBusy, setStatusBusy] = useState(false);
  const [updateBusy, setUpdateBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState(false);

  const selectedTarget = useMemo(
    () => targets.find((target) => target.id === selectedTargetId) ?? null,
    [selectedTargetId, targets],
  );

  const loadCatalog = useCallback(async () => {
    setCatalogBusy(true);
    setError(null);
    try {
      const response = await api.listTargets();
      setTargets(response.targets);
      setSelectedTargetId((current) => (
        response.targets.some((target) => target.id === current)
          ? current
          : response.targets[0]?.id ?? ''
      ));
    } catch (loadError) {
      if (loadError instanceof ApiError && loadError.status === 401) {
        onSignedOut();
        return;
      }
      setError(errorMessage(loadError));
    } finally {
      setCatalogBusy(false);
    }
  }, [onSignedOut]);

  const loadStatus = useCallback(async (targetId: string) => {
    if (!targetId) {
      setStatus(null);
      return;
    }
    setStatusBusy(true);
    setError(null);
    try {
      setStatus(await api.targetStatus(targetId));
    } catch (loadError) {
      if (loadError instanceof ApiError && loadError.status === 401) {
        onSignedOut();
        return;
      }
      setStatus(null);
      setError(errorMessage(loadError));
    } finally {
      setStatusBusy(false);
    }
  }, [onSignedOut]);

  useEffect(() => { void loadCatalog(); }, [loadCatalog]);
  useEffect(() => { void loadStatus(selectedTargetId); }, [loadStatus, selectedTargetId]);

  async function logout() {
    setSigningOut(true);
    setError(null);
    try {
      await api.logout();
      onSignedOut();
    } catch (logoutError) {
      setError(errorMessage(logoutError));
    } finally {
      setSigningOut(false);
    }
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Ollama Remote Control</p>
          <strong>Operations dashboard</strong>
        </div>
        <div className="user-actions">
          <span>{session.user.username}</span>
          <button className="secondary-button" disabled={signingOut || updateBusy} onClick={() => void logout()} type="button">
            {signingOut ? 'Signing out…' : 'Sign out'}
          </button>
        </div>
      </header>

      <main className="dashboard">
        <section className="dashboard-header" aria-labelledby="dashboard-title">
          <div>
            <p className="eyebrow">Target operations overview</p>
            <h1 id="dashboard-title">Ollama status</h1>
            <p className="muted">SSH, Docker and Ollama remain server-side. Mutating workflows use server-issued plans and explicit confirmation.</p>
          </div>
          <div className="target-controls">
            <label>
              Target
              <select
                disabled={catalogBusy || targets.length === 0 || updateBusy}
                onChange={(event) => setSelectedTargetId(event.target.value)}
                value={selectedTargetId}
              >
                {targets.map((target) => <option key={target.id} value={target.id}>{target.displayName}</option>)}
              </select>
            </label>
            <button
              className="secondary-button"
              disabled={!selectedTargetId || statusBusy || updateBusy}
              onClick={() => void loadStatus(selectedTargetId)}
              type="button"
            >
              {statusBusy ? 'Refreshing…' : 'Refresh'}
            </button>
          </div>
        </section>

        {error ? <p className="error-box" role="alert">{error}</p> : null}
        {catalogBusy ? <p className="loading-box" role="status">Loading targets…</p> : null}
        {!catalogBusy && targets.length === 0 ? (
          <section className="empty-state">
            <h2>No enabled Ollama target</h2>
            <p className="muted">Create and select a target through the API onboarding flow before using the dashboard.</p>
          </section>
        ) : null}

        {selectedTarget ? (
          <section className="target-summary" aria-label="Selected target">
            <div>
              <span className="muted">Selected target</span>
              <strong>{selectedTarget.displayName}</strong>
            </div>
            <code>{selectedTarget.selectedContainerId}</code>
          </section>
        ) : null}

        {statusBusy && !status ? <p className="loading-box" role="status">Reading remote status…</p> : null}
        {status ? (
          <section className="panel-grid" aria-live="polite">
            <ContainerCard status={status} />
            <OllamaCard status={status} />
            <GpuCard status={status} />
            <StorageCard status={status} />
          </section>
        ) : null}

        {selectedTarget && status ? (
          <UpdatePanel
            key={selectedTarget.id}
            onBusyChange={setUpdateBusy}
            onSignedOut={onSignedOut}
            onUpdated={() => loadStatus(selectedTarget.id)}
            target={selectedTarget}
          />
        ) : null}
      </main>
    </div>
  );
}

export default function App() {
  const [phase, setPhase] = useState<AppPhase>('loading');
  const [session, setSession] = useState<SessionView | null>(null);
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [fatalError, setFatalError] = useState<string | null>(null);

  const signedOut = useCallback(() => {
    setSession(null);
    setAuthError(null);
    setPhase('login');
  }, []);

  useEffect(() => {
    let active = true;
    async function bootstrap() {
      try {
        const setup = await api.setupStatus();
        if (!active) return;
        if (setup.requiresAdminBootstrap) {
          setPhase('bootstrap');
          return;
        }
        try {
          const currentSession = await api.session();
          if (!active) return;
          setSession(currentSession);
          setPhase('authenticated');
        } catch (sessionError) {
          if (!active) return;
          if (sessionError instanceof ApiError && sessionError.status === 401) {
            setPhase('login');
            return;
          }
          throw sessionError;
        }
      } catch (bootError) {
        if (!active) return;
        setFatalError(errorMessage(bootError));
        setPhase('fatal');
      }
    }
    void bootstrap();
    return () => { active = false; };
  }, []);

  async function authenticate(username: string, password: string) {
    setAuthBusy(true);
    setAuthError(null);
    try {
      if (phase === 'bootstrap') await api.bootstrapAdmin(username, password);
      const authenticated = await api.login(username, password);
      setSession(authenticated);
      setPhase('authenticated');
    } catch (error) {
      setAuthError(errorMessage(error));
    } finally {
      setAuthBusy(false);
    }
  }

  if (phase === 'loading') {
    return <main className="centered-message" role="status">Starting Ollama Remote Control…</main>;
  }
  if (phase === 'fatal') {
    return (
      <main className="centered-message">
        <section className="error-box" role="alert">
          <strong>Application startup failed</strong>
          <span>{fatalError}</span>
        </section>
      </main>
    );
  }
  if (phase === 'bootstrap' || phase === 'login') {
    return <CredentialsForm busy={authBusy} error={authError} mode={phase} onSubmit={authenticate} />;
  }
  if (!session) return <CredentialsForm busy={false} error={null} mode="login" onSubmit={authenticate} />;
  return <Dashboard onSignedOut={signedOut} session={session} />;
}
