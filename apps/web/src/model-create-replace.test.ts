import { describe, expect, it } from 'vitest';
import { modelfileDeployPlanRequestBody } from './model-create.js';

describe('replacement deploy-plan request authority', () => {
  it('defaults to safe create-only planning', () => {
    expect(modelfileDeployPlanRequestBody('custom:latest')).toEqual({
      outputModel: 'custom:latest',
      replaceExisting: false,
    });
  });

  it('requires an explicit replacement intent at plan time', () => {
    expect(modelfileDeployPlanRequestBody('custom:latest', true)).toEqual({
      outputModel: 'custom:latest',
      replaceExisting: true,
    });
  });
});
