import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseUpdateExecutionRequest,
  UpdateExecutionRequestError,
} from '../dist/update-execution.js';

const TARGET = 'target-1';
const INTENT = 'intent-1';

function request(extra = {}) {
  return {
    intentId: INTENT,
    confirmation: { action: 'update', targetId: TARGET, intentId: INTENT },
    ...extra,
  };
}

test('update execution request accepts only exact intent and confirmation authority', () => {
  assert.deepEqual(parseUpdateExecutionRequest(request(), TARGET), {
    intentId: INTENT,
    confirmation: { action: 'update', targetId: TARGET, intentId: INTENT },
  });
});

test('update execution request rejects hidden browser authority and malformed intent IDs', () => {
  for (const body of [
    null,
    {},
    { intentId: '' },
    { intentId: ' '.repeat(2), confirmation: { action: 'update', targetId: TARGET, intentId: '' } },
    request({ candidateDigest: `sha256:${'a'.repeat(64)}` }),
    request({ containerId: 'browser-container' }),
    request({ imageReference: 'evil/image:latest' }),
    request({ composeService: 'evil' }),
  ]) {
    assert.throws(
      () => parseUpdateExecutionRequest(body, TARGET),
      (error) => error instanceof UpdateExecutionRequestError && error.code === 'INVALID_UPDATE_EXECUTION_REQUEST',
    );
  }
});

test('update execution confirmation must match literal action, path target and supplied intent exactly', () => {
  for (const confirmation of [
    undefined,
    { action: 'update', targetId: `${TARGET}-wrong`, intentId: INTENT },
    { action: 'restart', targetId: TARGET, intentId: INTENT },
    { action: 'update', targetId: TARGET, intentId: `${INTENT}-wrong` },
    { action: 'update', targetId: TARGET, intentId: INTENT, digest: `sha256:${'a'.repeat(64)}` },
  ]) {
    assert.throws(
      () => parseUpdateExecutionRequest({ intentId: INTENT, confirmation }, TARGET),
      (error) => error instanceof UpdateExecutionRequestError && error.code === 'CONFIRMATION_REQUIRED',
    );
  }
});
