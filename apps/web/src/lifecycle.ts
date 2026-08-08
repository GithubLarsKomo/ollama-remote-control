import type { ContainerLifecycleAction } from './api.js';

export function availableLifecycleActions(running: boolean): readonly ContainerLifecycleAction[] {
  return running ? ['stop', 'restart'] : ['start'];
}

export function lifecycleActionNeedsConfirmation(action: ContainerLifecycleAction): boolean {
  return action === 'stop' || action === 'restart';
}

export function lifecycleConfirmationReady(
  action: ContainerLifecycleAction,
  targetDisplayName: string,
  typedTargetDisplayName: string,
  acknowledged: boolean,
): boolean {
  if (!lifecycleActionNeedsConfirmation(action)) return true;
  return acknowledged && typedTargetDisplayName === targetDisplayName;
}

export function lifecycleActionLabel(action: ContainerLifecycleAction): string {
  if (action === 'start') return 'Start';
  if (action === 'stop') return 'Stop';
  return 'Restart';
}
