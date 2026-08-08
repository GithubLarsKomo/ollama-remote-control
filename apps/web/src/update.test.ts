import { describe, expect, it } from 'vitest';
import type { UpdatePlan, UpdateStrategyResult } from './api.js';
import {
  evaluateUpdateEligibility,
  platformLabel,
  shortDigest,
  updateConfirmationReady,
} from './update.js';

function plan(overrides: Partial<UpdatePlan> = {}): UpdatePlan {
  return {
    snapshotId: 'snapshot-1',
    targetId: 'target-1',
    imageReference: 'ollama/ollama:latest',
    pinned: false,
    currentDigest: `sha256:${'a'.repeat(64)}`,
    candidateDigest: `sha256:${'b'.repeat(64)}`,
    candidateIndexDigest: null,
    platform: { os: 'linux', architecture: 'amd64', variant: null },
    updateAvailable: true,
    currentOllamaVersion: '0.32.5',
    candidateImageVersion: '0.33.0',
    composeManaged: true,
    modelVolumeBackup: { included: false, warning: 'Model volumes are not backed up.' },
    ...overrides,
  };
}

function composeStrategy(): UpdateStrategyResult {
  return {
    snapshotId: 'snapshot-1',
    targetId: 'target-1',
    strategy: {
      type: 'compose',
      executable: true,
      projectName: 'ollama',
      service: 'ollama',
      workingDirectory: '/srv/ollama',
      configFiles: ['/srv/ollama/compose.yaml'],
      environmentFiles: [],
      composeVersion: '2.39.1',
      containerId: 'container-1',
    },
  };
}

describe('update eligibility', () => {
  it('allows only a newer candidate with validated Compose strategy', () => {
    expect(evaluateUpdateEligibility(plan(), composeStrategy())).toMatchObject({ executable: true, code: 'ready' });
  });

  it('blocks digest-pinned sources before considering execution strategy', () => {
    expect(evaluateUpdateEligibility(plan({ pinned: true, updateAvailable: false }), composeStrategy())).toMatchObject({
      executable: false,
      code: 'source-pinned',
    });
  });

  it('blocks matching registry candidate', () => {
    expect(evaluateUpdateEligibility(plan({ updateAvailable: false }), composeStrategy())).toMatchObject({
      executable: false,
      code: 'no-update',
    });
  });

  it('blocks standalone reconstruction even when an update exists', () => {
    const standalone: UpdateStrategyResult = {
      snapshotId: 'snapshot-1',
      targetId: 'target-1',
      strategy: {
        type: 'standalone',
        executable: false,
        unsupportedFields: ['HostConfig.SecurityOpt'],
        summary: {
          environmentCount: 2,
          labelCount: 1,
          mountCount: 1,
          portBindingCount: 1,
          networkNames: ['bridge'],
          restartPolicy: 'unless-stopped',
          hasCommandOverride: false,
          hasEntrypointOverride: false,
        },
      },
    };
    expect(evaluateUpdateEligibility(plan(), standalone)).toMatchObject({ executable: false, code: 'strategy-unsupported' });
  });
});

describe('update confirmation', () => {
  it('requires both warning acknowledgement and an exact target display-name match', () => {
    expect(updateConfirmationReady('Production Ollama', 'Production Ollama', true)).toBe(true);
    expect(updateConfirmationReady('Production Ollama', ' Production Ollama ', true)).toBe(true);
    expect(updateConfirmationReady('Production Ollama', 'production ollama', true)).toBe(false);
    expect(updateConfirmationReady('Production Ollama', 'Production Ollama', false)).toBe(false);
  });
});

describe('update display helpers', () => {
  it('shortens digests without losing algorithm and both ends', () => {
    const digest = `sha256:${'a'.repeat(64)}`;
    expect(shortDigest(digest)).toBe(`sha256:${'a'.repeat(12)}…${'a'.repeat(8)}`);
    expect(shortDigest('sha256:small')).toBe('sha256:small');
  });

  it('renders platform labels including optional variant', () => {
    expect(platformLabel({ os: 'linux', architecture: 'amd64', variant: null })).toBe('linux/amd64');
    expect(platformLabel({ os: 'linux', architecture: 'arm64', variant: 'v8' })).toBe('linux/arm64/v8');
  });
});
