import { describe, expect, it } from 'vitest';
import {
  localValidationLabel,
  preflightValidationLabel,
  targetValidationLabel,
} from './modelfile-lifecycle.js';

describe('Modelfile lifecycle labels', () => {
  it('never turns missing evidence into a success claim', () => {
    expect(preflightValidationLabel({ state: 'not-requested' })).toBe('Not requested');
    expect(preflightValidationLabel({ state: 'not-run' })).toBe('Not run');
    expect(targetValidationLabel({ state: 'not-requested' })).toBe('Not requested');
    expect(targetValidationLabel({ state: 'not-run' })).toBe('Not run');
  });

  it('distinguishes historical preflight success from usable authority', () => {
    const base = {
      state: 'passed' as const,
      planId: 'plan-1',
      createdAt: '2026-08-10T12:00:00.000Z',
      expiresAt: '2026-08-10T12:05:00.000Z',
      consumedAt: null,
      selectedContainerId: 'container-1',
      baseModel: 'llama3.2:latest',
    };
    expect(preflightValidationLabel({ ...base, authorityState: 'usable' })).toBe('Passed · current plan usable');
    expect(preflightValidationLabel({ ...base, authorityState: 'expired' })).toBe('Passed historically · expired');
    expect(preflightValidationLabel({ ...base, authorityState: 'consumed' })).toBe('Passed historically · consumed');
    expect(preflightValidationLabel({ ...base, authorityState: 'stale-binding' })).toBe('Passed historically · stale-binding');
  });

  it('shows local and target verification only from explicit states', () => {
    expect(localValidationLabel({
      state: 'failed',
      revisionSha256: 'a'.repeat(64),
      code: 'DEPLOY_SOURCE_DIAGNOSTICS',
      message: 'invalid',
    })).toBe('Failed · DEPLOY_SOURCE_DIAGNOSTICS');
    expect(targetValidationLabel({
      state: 'verified',
      deploymentId: 'create-1',
      sourceCreateJobId: 'create-1',
      modelDigest: 'b'.repeat(64),
      sizeBytes: 1,
      selectedContainerId: 'container-1',
      verifiedAt: '2026-08-10T12:00:00.000Z',
    })).toBe('Verified on target');
  });
});
