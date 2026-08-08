import type {
  HostKeyObservation,
  PublicDockerDiscoveryResult,
} from './api.js';

export interface ProbedHostIdentity {
  readonly hostname: string;
  readonly port: number;
  readonly observation: HostKeyObservation;
}

export function fingerprintAcknowledgmentReady(
  probe: ProbedHostIdentity | null,
  hostname: string,
  port: number,
  acknowledgedFingerprint: string | null,
): boolean {
  if (!probe || !acknowledgedFingerprint) return false;
  return probe.hostname === hostname
    && probe.port === port
    && probe.observation.fingerprint === acknowledgedFingerprint;
}

export function candidateSelectionReady(
  discovery: PublicDockerDiscoveryResult | null,
  selectedContainerId: string | null,
): boolean {
  if (!discovery || !selectedContainerId) return false;
  return discovery.candidates.some((candidate) => candidate.id === selectedContainerId);
}

export function candidateRecommendation(
  discovery: PublicDockerDiscoveryResult,
  candidateId: string,
): boolean {
  return discovery.recommendedContainerId === candidateId;
}
