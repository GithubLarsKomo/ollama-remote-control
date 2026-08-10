import assert from 'node:assert/strict';
import test from 'node:test';
import { ModelfileValidationService } from '../dist/modelfile-validation.js';

const NOW = new Date('2026-08-10T13:00:00.000Z');
const SHA = 'a'.repeat(64);
const DIGEST = 'b'.repeat(64);

function fixture({ raw = 'FROM llama3.2:latest\n', plan = null, deployment = null, selectedContainerId = 'container-1' } = {}) {
  const artifact = {
    id: 'mf-1', displayName: 'Model file', description: null, currentRevisionId: 'rev-1',
    createdByUserId: 'user-1', updatedByUserId: 'user-1', createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
  };
  const revision = {
    id: 'rev-1', modelfileId: 'mf-1', revisionNumber: 1, parentRevisionId: null,
    rawText: raw, contentSha256: SHA, sourceKind: 'manual', importedTargetId: null,
    importedModel: null, importedDigest: null, createdByUserId: 'user-1', createdAt: NOW.toISOString(),
  };
  const modelfiles = {
    findById(id) { return id === artifact.id ? artifact : null; },
    findRevisionById(id) { return id === revision.id ? revision : null; },
  };
  const plans = {
    latestForRevisionTargetModel() { return plan; },
  };
  const deployments = {
    listForRevision(id) { return id === revision.id && deployment ? [deployment] : []; },
  };
  const targets = {
    findById(id) {
      return id === 'target-1'
        ? { id, hostId: 'host-1', displayName: 'Target', selectedContainerId, enabled: true, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() }
        : null;
    },
  };
  return new ModelfileValidationService(modelfiles, plans, deployments, targets, () => NOW);
}

function plan(overrides = {}) {
  return {
    id: 'plan-1', targetId: 'target-1', modelfileId: 'mf-1', revisionId: 'rev-1', revisionSha256: SHA,
    selectedContainerId: 'container-1', outputModel: 'custom:model', baseModel: 'llama3.2:latest',
    createdAt: '2026-08-10T12:58:00.000Z', expiresAt: '2026-08-10T13:03:00.000Z', consumedAt: null,
    ...overrides,
  };
}

function deployment() {
  return {
    id: 'create-1', targetId: 'target-1', modelfileId: 'mf-1', revisionId: 'rev-1', revisionSha256: SHA,
    outputModel: 'custom:model', modelDigest: DIGEST, sizeBytes: 1234, baseModel: 'llama3.2:latest',
    sourceCreateJobId: 'create-1', actorUserId: 'user-1', selectedContainerId: 'container-1',
    verifiedAt: '2026-08-10T12:59:00.000Z',
  };
}

test('local validation is deterministic and target evidence remains explicitly not requested', () => {
  const result = fixture().read('mf-1', 'rev-1');
  assert.equal(result.local.state, 'passed');
  assert.equal(result.local.revisionSha256, SHA);
  assert.equal(result.local.baseModel, 'llama3.2:latest');
  assert.deepEqual(result.preflight, { state: 'not-requested' });
  assert.deepEqual(result.targetVerification, { state: 'not-requested' });
});

test('local compile failure is surfaced without inventing preflight or target success', () => {
  const result = fixture({ raw: 'PARAMETER num_ctx 8192\n' }).read('mf-1', 'rev-1');
  assert.equal(result.local.state, 'failed');
  assert.equal(result.local.code, 'DEPLOY_FROM_REQUIRED');
  assert.deepEqual(result.preflight, { state: 'not-requested' });
  assert.deepEqual(result.targetVerification, { state: 'not-requested' });
});

test('historical passed preflight is distinct from current execution authority and target verification', () => {
  let result = fixture({ plan: plan() }).read('mf-1', 'rev-1', 'target-1', 'custom:model');
  assert.equal(result.preflight.state, 'passed');
  assert.equal(result.preflight.authorityState, 'usable');
  assert.deepEqual(result.targetVerification, { state: 'not-run' });

  result = fixture({ plan: plan({ consumedAt: '2026-08-10T12:59:30.000Z' }) }).read('mf-1', 'rev-1', 'target-1', 'custom:model');
  assert.equal(result.preflight.authorityState, 'consumed');

  result = fixture({ plan: plan({ expiresAt: '2026-08-10T12:59:59.000Z' }) }).read('mf-1', 'rev-1', 'target-1', 'custom:model');
  assert.equal(result.preflight.authorityState, 'expired');

  result = fixture({ plan: plan(), selectedContainerId: 'container-2' }).read('mf-1', 'rev-1', 'target-1', 'custom:model');
  assert.equal(result.preflight.authorityState, 'stale-binding');
});

test('only persisted verified deployment evidence produces target verified state', () => {
  const result = fixture({ plan: plan({ consumedAt: '2026-08-10T12:59:30.000Z' }), deployment: deployment() })
    .read('mf-1', 'rev-1', 'target-1', 'custom:model');
  assert.equal(result.preflight.state, 'passed');
  assert.equal(result.preflight.authorityState, 'consumed');
  assert.deepEqual(result.targetVerification, {
    state: 'verified',
    deploymentId: 'create-1',
    sourceCreateJobId: 'create-1',
    modelDigest: DIGEST,
    sizeBytes: 1234,
    selectedContainerId: 'container-1',
    verifiedAt: '2026-08-10T12:59:00.000Z',
  });
});

test('target and model are a strict pair and unknown evidence stays not-run', () => {
  const service = fixture();
  assert.throws(() => service.read('mf-1', 'rev-1', 'target-1'), /targetId and model/u);
  const result = service.read('mf-1', 'rev-1', 'target-1', 'custom:model');
  assert.deepEqual(result.preflight, { state: 'not-run' });
  assert.deepEqual(result.targetVerification, { state: 'not-run' });
});
