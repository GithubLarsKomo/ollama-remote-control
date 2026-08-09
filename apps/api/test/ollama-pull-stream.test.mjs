import assert from 'node:assert/strict';
import test from 'node:test';
import {
  OllamaPullStreamError,
  parsePullProgressLine,
} from '../dist/ollama-pull-stream.js';

test('pull progress parser accepts bounded official progress shapes and drops unknown fields', () => {
  assert.deepEqual(parsePullProgressLine('{"status":"pulling manifest","unknown":"ignored"}'), {
    status: 'pulling manifest', digest: null, total: null, completed: null,
  });
  assert.deepEqual(parsePullProgressLine(JSON.stringify({
    status: 'pulling sha256:abc', digest: `sha256:${'a'.repeat(64)}`, total: 2142590208, completed: 241970,
  })), {
    status: 'pulling sha256:abc', digest: `sha256:${'a'.repeat(64)}`, total: 2142590208, completed: 241970,
  });
  assert.deepEqual(parsePullProgressLine('{"status":"success"}'), {
    status: 'success', digest: null, total: null, completed: null,
  });
});

test('pull progress parser rejects streaming errors, malformed counts, control text and oversized lines', () => {
  const invalid = [
    '{"error":"remote pull failed"}',
    '{"status":"pulling","total":10,"completed":11}',
    '{"status":"pulling","completed":-1}',
    '{"status":"bad\\nstatus"}',
    JSON.stringify({ status: 'x'.repeat(241) }),
    'not-json',
    JSON.stringify({ status: 'ok', digest: 'x'.repeat(129) }),
    ' '.repeat(70 * 1024),
  ];
  for (const source of invalid) {
    assert.throws(
      () => parsePullProgressLine(source),
      (error) => error instanceof OllamaPullStreamError,
    );
  }
});
