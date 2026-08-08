import { describe, expect, it } from 'vitest';
import type { PublicDockerDiscoveryResult } from './api.js';
import {
  candidateRecommendation,
  candidateSelectionReady,
  fingerprintAcknowledgmentReady,
  type ProbedHostIdentity,
} from './onboarding.js';

const fingerprint = `SHA256:${'A'.repeat(43)}`;
const probe: ProbedHostIdentity = {
  hostname: 'server.internal',
  port: 22,
  observation: { algorithm: 'ssh-ed25519', fingerprint },
};

const discovery: PublicDockerDiscoveryResult = {
  dockerVersion: '27.5.1',
  recommendedContainerId: 'container-a',
  ambiguous: false,
  candidates: [
    {
      id: 'container-a', name: 'ollama', image: 'ollama/ollama:latest', state: 'running', status: 'Up', ports: '',
      score: 8, reasons: ['image'], inspect: { image: 'ollama/ollama:latest', running: true, mountCount: 1, portBindingCount: 0, labelCount: 2 },
    },
    {
      id: 'container-b', name: 'other', image: 'custom/ollama:latest', state: 'running', status: 'Up', ports: '',
      score: 4, reasons: ['name'], inspect: { image: 'custom/ollama:latest', running: true, mountCount: 0, portBindingCount: 0, labelCount: 0 },
    },
  ],
};

describe('fingerprint acknowledgment', () => {
  it('is valid only for the exact probed endpoint and exact observed fingerprint', () => {
    expect(fingerprintAcknowledgmentReady(probe, 'server.internal', 22, fingerprint)).toBe(true);
    expect(fingerprintAcknowledgmentReady(probe, 'changed.internal', 22, fingerprint)).toBe(false);
    expect(fingerprintAcknowledgmentReady(probe, 'server.internal', 2222, fingerprint)).toBe(false);
    expect(fingerprintAcknowledgmentReady(probe, 'server.internal', 22, `SHA256:${'B'.repeat(43)}`)).toBe(false);
    expect(fingerprintAcknowledgmentReady(null, 'server.internal', 22, fingerprint)).toBe(false);
  });
});

describe('container selection', () => {
  it('never converts a recommendation into implicit selection', () => {
    expect(candidateRecommendation(discovery, 'container-a')).toBe(true);
    expect(candidateSelectionReady(discovery, null)).toBe(false);
  });

  it('accepts only a container explicitly selected from the current discovery result', () => {
    expect(candidateSelectionReady(discovery, 'container-a')).toBe(true);
    expect(candidateSelectionReady(discovery, 'container-b')).toBe(true);
    expect(candidateSelectionReady(discovery, 'stale-container')).toBe(false);
  });
});
