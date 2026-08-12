import assert from 'node:assert/strict';
import test from 'node:test';
import { buildBetaReleaseEvidence } from '../../../scripts/beta-rc-evidence.mjs';

const sha = 'a'.repeat(40);

test('beta release evidence contains only bounded scenario status and exact commit identity', () => {
  const evidence = buildBetaReleaseEvidence({
    commitSha: sha,
    scenarios: [
      { id: 'foundation-spike', status: 'passed' },
      { id: 'production-container', status: 'passed' },
      { id: 'restart-recovery', status: 'passed' },
    ],
  });

  assert.deepEqual(evidence, {
    schemaVersion: 1,
    commitSha: sha,
    overall: 'passed',
    scenarios: [
      { id: 'foundation-spike', status: 'passed' },
      { id: 'production-container', status: 'passed' },
      { id: 'restart-recovery', status: 'passed' },
    ],
  });
  assert.equal(JSON.stringify(evidence).includes('secret'), false);
});

test('beta release evidence fails closed when any scenario fails', () => {
  const evidence = buildBetaReleaseEvidence({
    commitSha: sha,
    scenarios: [
      { id: 'foundation-spike', status: 'passed' },
      { id: 'release-path', status: 'failed' },
    ],
  });
  assert.equal(evidence.overall, 'failed');
});

test('beta release evidence rejects unbounded or unsafe identifiers', () => {
  assert.throws(() => buildBetaReleaseEvidence({ commitSha: 'short', scenarios: [{ id: 'x', status: 'passed' }] }));
  assert.throws(() => buildBetaReleaseEvidence({ commitSha: sha, scenarios: [{ id: '../secret', status: 'passed' }] }));
  assert.throws(() => buildBetaReleaseEvidence({ commitSha: sha, scenarios: [{ id: 'x', status: 'unknown' }] }));
});
