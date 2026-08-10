import { describe, expect, it } from 'vitest';
import { modelUnloadRequestBody } from './model-unload.js';

describe('modelUnloadRequestBody', () => {
  it('duplicates only the exact target, model and loaded digest into structural confirmation', () => {
    const digest = 'd'.repeat(64);
    expect(modelUnloadRequestBody({
      targetId: 'target-1',
      model: 'hf.co/example/model:Q4_K_M',
      digest,
    })).toEqual({
      model: 'hf.co/example/model:Q4_K_M',
      digest,
      confirmation: {
        action: 'unload',
        targetId: 'target-1',
        model: 'hf.co/example/model:Q4_K_M',
        digest,
      },
    });
  });
});
