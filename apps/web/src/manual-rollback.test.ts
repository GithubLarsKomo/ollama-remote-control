import { describe, expect, it } from 'vitest';
import { manualRollbackConfirmationReady } from './manual-rollback.js';

describe('manualRollbackConfirmationReady', () => {
  it('requires the exact target display name and explicit model-volume acknowledgement', () => {
    expect(manualRollbackConfirmationReady('Primary Ollama', 'Primary Ollama', true)).toBe(true);
    expect(manualRollbackConfirmationReady('Primary Ollama', 'Primary Ollama', false)).toBe(false);
  });

  it('does not normalize, trim or case-fold destructive confirmation text', () => {
    expect(manualRollbackConfirmationReady('Primary Ollama', 'primary ollama', true)).toBe(false);
    expect(manualRollbackConfirmationReady('Primary Ollama', ' Primary Ollama', true)).toBe(false);
    expect(manualRollbackConfirmationReady('Primary Ollama', 'Primary Ollama ', true)).toBe(false);
    expect(manualRollbackConfirmationReady('', '', true)).toBe(false);
  });
});
