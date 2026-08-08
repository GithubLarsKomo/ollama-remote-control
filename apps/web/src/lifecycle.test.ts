import { describe, expect, it } from 'vitest';
import {
  availableLifecycleActions,
  lifecycleActionNeedsConfirmation,
  lifecycleConfirmationReady,
} from './lifecycle.js';

describe('container lifecycle UI rules', () => {
  it('offers only state-appropriate actions', () => {
    expect(availableLifecycleActions(false)).toEqual(['start']);
    expect(availableLifecycleActions(true)).toEqual(['stop', 'restart']);
  });

  it('requires extra confirmation only for stop and restart', () => {
    expect(lifecycleActionNeedsConfirmation('start')).toBe(false);
    expect(lifecycleActionNeedsConfirmation('stop')).toBe(true);
    expect(lifecycleActionNeedsConfirmation('restart')).toBe(true);
  });

  it('requires acknowledgment plus the exact target display name for disruptive actions', () => {
    expect(lifecycleConfirmationReady('stop', 'Primary Ollama', 'Primary Ollama', true)).toBe(true);
    expect(lifecycleConfirmationReady('restart', 'Primary Ollama', 'Primary Ollama', true)).toBe(true);
    expect(lifecycleConfirmationReady('stop', 'Primary Ollama', 'primary ollama', true)).toBe(false);
    expect(lifecycleConfirmationReady('restart', 'Primary Ollama', 'Primary Ollama', false)).toBe(false);
  });

  it('allows start without inventing a second confirmation contract', () => {
    expect(lifecycleConfirmationReady('start', 'Primary Ollama', '', false)).toBe(true);
  });
});
