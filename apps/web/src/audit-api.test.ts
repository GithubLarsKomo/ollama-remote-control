import { describe, expect, it } from 'vitest';
import { auditQueryString } from './audit-api.js';

describe('auditQueryString', () => {
  it('serializes only bounded named filters and pagination values', () => {
    const query = auditQueryString({
      targetId: 'target/one',
      actorUserId: 'user 1',
      action: 'container.restart.completed',
      result: 'succeeded',
      from: '2026-08-10T10:00:00.000Z',
      to: '2026-08-10T11:00:00.000Z',
    }, { limit: 25, offset: 50 });
    const params = new URLSearchParams(query.slice(1));
    expect(Object.fromEntries(params.entries())).toEqual({
      targetId: 'target/one',
      actorUserId: 'user 1',
      action: 'container.restart.completed',
      result: 'succeeded',
      from: '2026-08-10T10:00:00.000Z',
      to: '2026-08-10T11:00:00.000Z',
      limit: '25',
      offset: '50',
    });
  });

  it('omits blank optional filters', () => {
    expect(auditQueryString({ targetId: '   ', action: '' })).toBe('');
  });
});
