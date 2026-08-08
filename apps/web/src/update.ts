import type { UpdatePlan, UpdateStrategyResult } from './api.js';

export type UpdateEligibilityCode =
  | 'ready'
  | 'source-pinned'
  | 'no-update'
  | 'strategy-unsupported';

export interface UpdateEligibility {
  readonly executable: boolean;
  readonly code: UpdateEligibilityCode;
  readonly message: string;
}

export function evaluateUpdateEligibility(
  plan: UpdatePlan,
  strategyResult: UpdateStrategyResult,
): UpdateEligibility {
  if (plan.pinned) {
    return {
      executable: false,
      code: 'source-pinned',
      message: 'The configured image is already digest-pinned, so there is no tag-based update candidate.',
    };
  }
  if (!plan.updateAvailable) {
    return {
      executable: false,
      code: 'no-update',
      message: 'The registry candidate matches the current image digest.',
    };
  }
  if (strategyResult.strategy.type !== 'compose' || !strategyResult.strategy.executable) {
    return {
      executable: false,
      code: 'strategy-unsupported',
      message: 'This update slice executes only a validated Docker Compose service.',
    };
  }
  return {
    executable: true,
    code: 'ready',
    message: 'A newer digest is available and the Compose reconstruction strategy is executable.',
  };
}

export function updateConfirmationReady(
  targetDisplayName: string,
  typedTargetName: string,
  rollbackWarningAcknowledged: boolean,
): boolean {
  return rollbackWarningAcknowledged && typedTargetName.trim() === targetDisplayName;
}

export function shortDigest(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return 'Unavailable';
  const prefix = trimmed.startsWith('sha256:') ? 'sha256:' : '';
  const digest = prefix ? trimmed.slice(prefix.length) : trimmed;
  if (digest.length <= 20) return trimmed;
  return `${prefix}${digest.slice(0, 12)}…${digest.slice(-8)}`;
}

export function platformLabel(platform: UpdatePlan['platform']): string {
  return [platform.os, platform.architecture, platform.variant].filter(Boolean).join('/') || 'Unavailable';
}
