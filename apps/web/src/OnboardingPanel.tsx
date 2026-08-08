import {
  type FormEvent,
  useEffect,
  useMemo,
  useState,
} from 'react';
import {
  ApiError,
  api,
  type CreatedHost,
  type HostCatalogEntry,
  type PublicDockerDiscoveryResult,
  type TargetCatalogEntry,
} from './api.js';
import {
  candidateRecommendation,
  candidateSelectionReady,
  fingerprintAcknowledgmentReady,
  type ProbedHostIdentity,
} from './onboarding.js';
import './onboarding.css';

interface OnboardingPanelProps {
  readonly onCompleted: (target: TargetCatalogEntry) => Promise<void> | void;
  readonly onSignedOut: () => void;
}

type Phase = 'loading' | 'choose-host' | 'new-host' | 'discovering' | 'select-container' | 'saving-target';

function message(error: unknown): string {
  if (error instanceof ApiError) return `${error.code}: ${error.message}`;
  if (error instanceof Error) return error.message;
  return 'Unexpected onboarding error.';
}

function hostView(host: HostCatalogEntry | CreatedHost): HostCatalogEntry {
  return {
    id: host.id,
    displayName: host.displayName,
    hostname: host.hostname,
    port: host.port,
    username: host.username,
    hostKeyFingerprint: host.hostKeyFingerprint,
  };
}

export default function OnboardingPanel({ onCompleted, onSignedOut }: OnboardingPanelProps) {
  const [phase, setPhase] = useState<Phase>('loading');
  const [hosts, setHosts] = useState<readonly HostCatalogEntry[]>([]);
  const [activeHost, setActiveHost] = useState<HostCatalogEntry | null>(null);
  const [discovery, setDiscovery] = useState<PublicDockerDiscoveryResult | null>(null);
  const [selectedContainerId, setSelectedContainerId] = useState<string | null>(null);
  const [targetDisplayName, setTargetDisplayName] = useState('');
  const [error, setError] = useState<string | null>(null);

  const [displayName, setDisplayName] = useState('Ollama server');
  const [hostname, setHostname] = useState('');
  const [portText, setPortText] = useState('22');
  const [username, setUsername] = useState('');
  const [privateKey, setPrivateKey] = useState('');
  const [probe, setProbe] = useState<ProbedHostIdentity | null>(null);
  const [acknowledgedFingerprint, setAcknowledgedFingerprint] = useState<string | null>(null);
  const [probing, setProbing] = useState(false);
  const [creatingHost, setCreatingHost] = useState(false);

  const port = Number(portText);
  const endpointValid = hostname.trim().length > 0 && Number.isInteger(port) && port >= 1 && port <= 65535;
  const fingerprintReady = fingerprintAcknowledgmentReady(probe, hostname, port, acknowledgedFingerprint);
  const selectionReady = candidateSelectionReady(discovery, selectedContainerId) && targetDisplayName.trim().length > 0;
  const selectedCandidate = useMemo(
    () => discovery?.candidates.find((candidate) => candidate.id === selectedContainerId) ?? null,
    [discovery, selectedContainerId],
  );

  useEffect(() => {
    let active = true;
    void api.listHosts().then(
      (response) => {
        if (!active) return;
        setHosts(response.hosts);
        setPhase(response.hosts.length > 0 ? 'choose-host' : 'new-host');
      },
      (loadError) => {
        if (!active) return;
        if (loadError instanceof ApiError && loadError.status === 401) {
          onSignedOut();
          return;
        }
        setError(message(loadError));
        setPhase('new-host');
      },
    );
    return () => { active = false; };
  }, [onSignedOut]);

  function handleApiError(actionError: unknown): void {
    if (actionError instanceof ApiError && actionError.status === 401) {
      onSignedOut();
      return;
    }
    setError(message(actionError));
  }

  function invalidateProbe(): void {
    setProbe(null);
    setAcknowledgedFingerprint(null);
    setPrivateKey('');
  }

  function changeHostname(value: string): void {
    invalidateProbe();
    setHostname(value);
  }

  function changePort(value: string): void {
    invalidateProbe();
    setPortText(value);
  }

  async function probeHost(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!endpointValid) return;
    setError(null);
    setProbe(null);
    setAcknowledgedFingerprint(null);
    setPrivateKey('');
    setProbing(true);
    try {
      const observation = await api.probeHost(hostname, port);
      setProbe({ hostname, port, observation });
    } catch (probeError) {
      handleApiError(probeError);
    } finally {
      setProbing(false);
    }
  }

  async function discover(host: HostCatalogEntry): Promise<void> {
    setError(null);
    setActiveHost(host);
    setDiscovery(null);
    setSelectedContainerId(null);
    setTargetDisplayName('');
    setPhase('discovering');
    try {
      const result = await api.discoverOllama(host.id);
      setDiscovery(result);
      setPhase('select-container');
    } catch (discoverError) {
      handleApiError(discoverError);
      setPhase('choose-host');
    }
  }

  async function createHost(): Promise<void> {
    if (!probe || !fingerprintReady || !privateKey) return;
    const keyForRequest = privateKey;
    setPrivateKey('');
    setError(null);
    setCreatingHost(true);
    try {
      const response = await api.createHost({
        displayName,
        hostname,
        port,
        username,
        confirmedFingerprint: probe.observation.fingerprint,
        privateKey: keyForRequest,
      });
      const created = hostView(response.host);
      setHosts((current) => [...current.filter((host) => host.id !== created.id), created]);
      await discover(created);
    } catch (createError) {
      if (createError instanceof ApiError && createError.code === 'SSH_HOST_KEY_MISMATCH') {
        setProbe(null);
        setAcknowledgedFingerprint(null);
      }
      handleApiError(createError);
    } finally {
      setCreatingHost(false);
    }
  }

  function chooseCandidate(containerId: string, name: string): void {
    setSelectedContainerId(containerId);
    setTargetDisplayName(name || 'Primary Ollama');
  }

  async function saveTarget(): Promise<void> {
    if (!activeHost || !selectedContainerId || !selectionReady) return;
    setError(null);
    setPhase('saving-target');
    try {
      const response = await api.selectTarget(activeHost.id, selectedContainerId, targetDisplayName.trim());
      await onCompleted(response.target);
    } catch (selectionError) {
      handleApiError(selectionError);
      setSelectedContainerId(null);
      setPhase('discovering');
      try {
        const current = await api.discoverOllama(activeHost.id);
        setDiscovery(current);
        setPhase('select-container');
      } catch (rediscoverError) {
        handleApiError(rediscoverError);
        setPhase('choose-host');
      }
    }
  }

  return (
    <section className="onboarding-panel" aria-labelledby="onboarding-title">
      <div className="onboarding-heading">
        <div>
          <p className="eyebrow">First-run setup</p>
          <h2 id="onboarding-title">Connect an Ollama host</h2>
          <p className="muted">Trust the SSH identity first, verify private-key access second, then explicitly select a current Ollama container.</p>
        </div>
        <span className="onboarding-step-label">
          {phase === 'new-host' ? 'SSH trust' : phase === 'select-container' || phase === 'saving-target' ? 'Target selection' : 'Host selection'}
        </span>
      </div>

      {error ? <div className="onboarding-error" role="alert"><strong>Setup stopped</strong><span>{error}</span></div> : null}

      {phase === 'loading' ? <p className="loading-box" role="status">Loading stored hosts…</p> : null}

      {phase === 'choose-host' ? (
        <div className="onboarding-stack">
          <div className="onboarding-section-heading">
            <div>
              <strong>Continue with a stored host</strong>
              <p>Stored credentials remain encrypted on the server; the browser receives only host identity metadata.</p>
            </div>
            <button className="secondary-button" onClick={() => { setError(null); setPhase('new-host'); }} type="button">Add new host</button>
          </div>
          {hosts.length === 0 ? (
            <button className="primary-button onboarding-primary" onClick={() => setPhase('new-host')} type="button">Add first host</button>
          ) : (
            <div className="host-list">
              {hosts.map((host) => (
                <article className="host-card" key={host.id}>
                  <div>
                    <strong>{host.displayName}</strong>
                    <span>{host.username}@{host.hostname}:{host.port}</span>
                    <code title={host.hostKeyFingerprint}>{host.hostKeyFingerprint}</code>
                  </div>
                  <button className="secondary-button" onClick={() => void discover(host)} type="button">Discover Ollama</button>
                </article>
              ))}
            </div>
          )}
        </div>
      ) : null}

      {phase === 'new-host' ? (
        <div className="onboarding-stack">
          {hosts.length > 0 ? <button className="link-button" onClick={() => setPhase('choose-host')} type="button">← Stored hosts</button> : null}
          <form className="host-form" onSubmit={(event) => void probeHost(event)}>
            <div className="form-grid">
              <label>
                Display name
                <input maxLength={120} onChange={(event) => setDisplayName(event.target.value)} required value={displayName} />
              </label>
              <label>
                SSH username
                <input autoComplete="username" maxLength={128} onChange={(event) => setUsername(event.target.value)} required value={username} />
              </label>
              <label>
                Hostname or IP
                <input autoComplete="off" maxLength={253} onChange={(event) => changeHostname(event.target.value)} required value={hostname} />
              </label>
              <label>
                SSH port
                <input inputMode="numeric" max="65535" min="1" onChange={(event) => changePort(event.target.value)} required type="number" value={portText} />
              </label>
            </div>
            <button className="secondary-button" disabled={!endpointValid || probing} type="submit">{probing ? 'Probing…' : 'Probe SSH host key'}</button>
          </form>

          {probe ? (
            <div className="fingerprint-card">
              <div className="fingerprint-title">
                <div>
                  <strong>Observed SSH host key</strong>
                  <span>{probe.observation.algorithm}</span>
                </div>
                <span className="status-pill status-muted">Untrusted until confirmed</span>
              </div>
              <code>{probe.observation.fingerprint}</code>
              <p>Verify this SHA256 fingerprint against a trusted source for <strong>{probe.hostname}:{probe.port}</strong>. The server will probe it again during credential verification.</p>
              <label className="onboarding-check">
                <input
                  checked={acknowledgedFingerprint === probe.observation.fingerprint}
                  onChange={(event) => setAcknowledgedFingerprint(event.target.checked ? probe.observation.fingerprint : null)}
                  type="checkbox"
                />
                <span>I independently verified this exact SSH fingerprint.</span>
              </label>
            </div>
          ) : null}

          {probe && fingerprintReady ? (
            <div className="credential-card">
              <div>
                <strong>SSH private key</strong>
                <p>The key is sent only to the application API for verification and encrypted storage. This field is cleared before the request starts.</p>
              </div>
              <textarea
                autoComplete="off"
                onChange={(event) => setPrivateKey(event.target.value)}
                placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                rows={8}
                spellCheck={false}
                value={privateKey}
              />
              <button
                className="primary-button onboarding-primary"
                disabled={!privateKey || !username.trim() || !displayName.trim() || creatingHost}
                onClick={() => void createHost()}
                type="button"
              >
                {creatingHost ? 'Verifying and storing…' : 'Verify access and store host'}
              </button>
            </div>
          ) : null}
        </div>
      ) : null}

      {phase === 'discovering' ? (
        <div className="onboarding-progress" role="status">
          <span className="onboarding-spinner" aria-hidden="true" />
          <div><strong>Discovering current Ollama containers…</strong><p>Using the server-side encrypted SSH credential for {activeHost?.displayName ?? 'host'}.</p></div>
        </div>
      ) : null}

      {(phase === 'select-container' || phase === 'saving-target') && discovery && activeHost ? (
        <div className="onboarding-stack">
          <div className="onboarding-section-heading">
            <div>
              <strong>Select the Ollama container</strong>
              <p>Docker {discovery.dockerVersion}. A recommendation is guidance only; selection is always explicit.</p>
            </div>
            <button className="secondary-button" disabled={phase === 'saving-target'} onClick={() => void discover(activeHost)} type="button">Refresh discovery</button>
          </div>

          {discovery.candidates.length === 0 ? (
            <div className="empty-state"><h3>No Ollama candidate found</h3><p className="muted">Check Docker/Ollama on the remote host, then refresh discovery.</p></div>
          ) : (
            <div className="candidate-list">
              {discovery.candidates.map((candidate) => {
                const recommended = candidateRecommendation(discovery, candidate.id);
                return (
                  <label className={`candidate-card ${selectedContainerId === candidate.id ? 'candidate-selected' : ''}`} key={candidate.id}>
                    <input
                      checked={selectedContainerId === candidate.id}
                      disabled={phase === 'saving-target'}
                      name="ollama-container"
                      onChange={() => chooseCandidate(candidate.id, candidate.name)}
                      type="radio"
                    />
                    <div className="candidate-content">
                      <div className="candidate-title">
                        <div><strong>{candidate.name || candidate.id.slice(0, 12)}</strong><code>{candidate.image}</code></div>
                        {recommended ? <span className="status-pill status-ok">Recommended</span> : null}
                      </div>
                      <dl className="candidate-metrics">
                        <div><dt>State</dt><dd>{candidate.state}</dd></div>
                        <div><dt>Status</dt><dd>{candidate.status}</dd></div>
                        <div><dt>Ports</dt><dd>{candidate.ports || 'None reported'}</dd></div>
                        <div><dt>Score</dt><dd>{candidate.score}</dd></div>
                        <div><dt>Mounts</dt><dd>{candidate.inspect.mountCount}</dd></div>
                        <div><dt>Labels</dt><dd>{candidate.inspect.labelCount}</dd></div>
                      </dl>
                      <p className="candidate-reasons">Signals: {candidate.reasons.join(', ') || 'none'}</p>
                    </div>
                  </label>
                );
              })}
            </div>
          )}

          {selectedCandidate ? (
            <div className="target-name-card">
              <label>
                Target display name
                <input maxLength={120} onChange={(event) => setTargetDisplayName(event.target.value)} required value={targetDisplayName} />
              </label>
              <p>This creates the operation boundary for jobs and mutations. The server will re-run discovery before accepting the selected container.</p>
            </div>
          ) : null}

          <div className="onboarding-actions">
            <button className="secondary-button" disabled={phase === 'saving-target'} onClick={() => setPhase('choose-host')} type="button">Back to hosts</button>
            <button className="primary-button onboarding-primary" disabled={!selectionReady || phase === 'saving-target'} onClick={() => void saveTarget()} type="button">
              {phase === 'saving-target' ? 'Revalidating and saving…' : 'Use selected container'}
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
