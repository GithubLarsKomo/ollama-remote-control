import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parsePullEventCursor,
  publicPullEvent,
  PullJobEventError,
} from '../dist/pull-job-events.js';

function event(sequence, eventType, payload) {
  return {
    id: `event-${sequence}`,
    jobId: 'job-1',
    sequence,
    eventType,
    payloadJson: JSON.stringify(payload),
    createdAt: '2026-08-09T06:00:00.000Z',
  };
}

test('pull job event mapper exposes only bounded known event fields', () => {
  assert.deepEqual(publicPullEvent(event(1, 'progress', {
    status: 'pulling layer',
    digest: 'sha256:abc',
    totalBytes: 1000,
    completedBytes: 500,
    percentage: 50,
    ignored: 'not-public',
  })), {
    sequence: 1,
    event: 'progress',
    data: {
      status: 'pulling layer',
      digest: 'sha256:abc',
      totalBytes: 1000,
      completedBytes: 500,
      percentage: 50,
    },
    createdAt: '2026-08-09T06:00:00.000Z',
  });

  assert.deepEqual(publicPullEvent(event(2, 'state', {
    state: 'failed',
    errorClass: 'CANCEL_UNVERIFIED',
    result: { internal: 'not-public' },
  })), {
    sequence: 2,
    event: 'state',
    data: { state: 'failed', errorClass: 'CANCEL_UNVERIFIED', exitCode: null },
    createdAt: '2026-08-09T06:00:00.000Z',
  });

  assert.equal(publicPullEvent(event(3, 'internal-debug', { value: 'ignored' })), null);
});

test('pull job event mapper rejects malformed public events and oversized persisted payloads', () => {
  assert.throws(
    () => publicPullEvent(event(1, 'progress', { status: 'bad\nstatus' })),
    (error) => error instanceof PullJobEventError && error.code === 'JOB_EVENT_INVALID',
  );
  assert.throws(
    () => publicPullEvent(event(2, 'progress', { status: 'ok', percentage: 101 })),
    (error) => error instanceof PullJobEventError && error.code === 'JOB_EVENT_INVALID',
  );
  const oversized = event(3, 'progress', { status: 'ok', ignored: 'x'.repeat(17 * 1024) });
  assert.throws(
    () => publicPullEvent(oversized),
    (error) => error instanceof PullJobEventError && error.code === 'JOB_EVENT_INVALID',
  );
});

test('pull SSE replay cursor is bounded and decimal only', () => {
  assert.equal(parsePullEventCursor(undefined), 0);
  assert.equal(parsePullEventCursor('0'), 0);
  assert.equal(parsePullEventCursor('42'), 42);
  for (const invalid of ['-1', '1.5', 'abc', '99999999999']) {
    assert.throws(
      () => parsePullEventCursor(invalid),
      (error) => error instanceof PullJobEventError && error.code === 'INVALID_JOB_CURSOR',
    );
  }
});
