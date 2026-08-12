import assert from 'node:assert/strict';
import test from 'node:test';
import {
  betaFailureRecoveryMatrix,
  validateBetaFailureRecoveryMatrix,
} from '../../../scripts/beta-failure-recovery-matrix.mjs';
import { betaRcScenarios } from '../../../scripts/beta-rc-scenarios.mjs';

const scenarioIds = betaRcScenarios.map((scenario) => scenario.id);

test('beta failure/recovery matrix is complete and references real evidence', () => {
  const result = validateBetaFailureRecoveryMatrix(betaFailureRecoveryMatrix, {
    scenarioIds,
    requireComplete: true,
  });
  assert.equal(result.operationCount, 7);
  assert.equal(result.jobKindCount, 9);
  assert.deepEqual(result.gaps, []);
});

test('beta failure/recovery matrix explicitly excludes deferred destructive/expert operations', () => {
  assert.deepEqual(
    betaFailureRecoveryMatrix.deferred.map((entry) => entry.id).sort(),
    ['expert-mode', 'model-delete'],
  );
});

test('matrix validator rejects stale test and scenario references', () => {
  const operation = betaFailureRecoveryMatrix.operations[0];
  assert.ok(operation);
  assert.throws(
    () => validateBetaFailureRecoveryMatrix({
      ...betaFailureRecoveryMatrix,
      operations: [{ ...operation, tests: ['apps/api/test/does-not-exist.test.mjs'] }],
    }, { scenarioIds }),
    /references missing test/u,
  );
  assert.throws(
    () => validateBetaFailureRecoveryMatrix({
      ...betaFailureRecoveryMatrix,
      operations: [{ ...operation, rcScenarios: ['does-not-exist'] }],
    }, { scenarioIds }),
    /references missing RC scenario/u,
  );
});

test('matrix validator fails closed if a covered operation regresses to a gap', () => {
  const operation = betaFailureRecoveryMatrix.operations[0];
  assert.ok(operation);
  assert.throws(
    () => validateBetaFailureRecoveryMatrix({
      ...betaFailureRecoveryMatrix,
      operations: [{ ...operation, status: 'gap' }],
    }, { scenarioIds, requireComplete: true }),
    /has uncovered operations/u,
  );
});