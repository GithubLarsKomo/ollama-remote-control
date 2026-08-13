import { describe, expect, it } from 'vitest';

describe('beta acceptance repository-policy negative verification', () => {
  it('fails intentionally and must never be merged', () => {
    expect('beta-acceptance-required').toBe('intentionally-red');
  });
});
