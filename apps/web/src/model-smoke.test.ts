import { describe, expect, it } from 'vitest';
import { modelSmokeRequestBody } from './model-smoke.js';

describe('modelSmokeRequestBody', () => {
  it('contains only model/digest and exact structural confirmation', () => {
    const digest = 'a'.repeat(64);
    const body = modelSmokeRequestBody({
      targetId: 'target-1',
      model: 'hf.co/example/smoke-model:Q4_K_M',
      digest,
    });
    expect(body).toEqual({
      model: 'hf.co/example/smoke-model:Q4_K_M',
      digest,
      confirmation: {
        action: 'smoke-test',
        targetId: 'target-1',
        model: 'hf.co/example/smoke-model:Q4_K_M',
        digest,
      },
    });
    expect(JSON.stringify(body)).not.toContain('prompt');
    expect(JSON.stringify(body)).not.toContain('keep_alive');
    expect(JSON.stringify(body)).not.toContain('options');
    expect(JSON.stringify(body)).not.toContain('stream');
  });
});
