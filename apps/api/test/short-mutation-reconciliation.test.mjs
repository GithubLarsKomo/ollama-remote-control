import assert from 'node:assert/strict';
import test from 'node:test';
import { ShortMutationReconciliationService } from '../dist/short-mutation-reconciliation.js';

function job(kind, result, overrides = {}) {
  return {
    id: `${kind}-job`,
    targetId: 'target-1',
    actorUserId: 'user-1',
    kind,
    mutating: true,
    state: 'running',
    createdAt: '2026-08-12T10:00:00.000Z',
    startedAt: '2026-08-12T10:00:01.000Z',
    finishedAt: null,
    resultJson: result === null ? null : JSON.stringify(result),
    errorClass: null,
    exitCode: null,
    ...overrides,
  };
}

function harness(initialJobs, { inventory, container, target } = {}) {
  const rows = new Map(initialJobs.map((entry) => [entry.id, { ...entry }]));
  const transitions = [];
  const jobs = {
    jobsNeedingReconciliation: () => [...rows.values()].filter((entry) => ['queued', 'running', 'cancelling'].includes(entry.state)),
    get(id) {
      const value = rows.get(id);
      if (!value) throw new Error('missing job');
      return value;
    },
    transition(id, state, options = {}) {
      const current = rows.get(id);
      if (!current) throw new Error('missing job');
      const next = {
        ...current,
        state,
        resultJson: options.result === undefined ? current.resultJson : JSON.stringify(options.result),
        errorClass: options.errorClass ?? null,
        exitCode: options.exitCode ?? null,
      };
      rows.set(id, next);
      transitions.push({ id, state, options });
      return next;
    },
  };
  const audits = [];
  const service = new ShortMutationReconciliationService(
    jobs,
    { record: (entry) => audits.push(entry) },
    { findById: () => target ?? { id: 'target-1', enabled: true, selectedContainerId: 'container-1' } },
    { read: async () => inventory ?? { installed: [], running: [] } },
    { observe: async () => container ?? { id: 'container-1', running: true, startedAt: '2026-08-12T10:01:00.000Z' } },
  );
  return { service, rows, transitions, audits };
}

const digest = 'a'.repeat(64);
const modelMetadata = { model: 'fixture:latest', digest, selectedContainerId: 'container-1' };

function installedModel() {
  return { name: 'fixture:latest', model: 'fixture:latest', digest };
}

function runningModel() {
  return { name: 'fixture:latest', model: 'fixture:latest', digest };
}

test('restart reconciliation proves unload success only from observed absence', async () => {
  const h = harness([job('model-unload', modelMetadata)], {
    inventory: { installed: [installedModel()], running: [] },
  });
  await h.service.reconcile();
  assert.equal(h.rows.get('model-unload-job').state, 'succeeded');
  assert.equal(JSON.parse(h.rows.get('model-unload-job').resultJson).reconciledAfterRestart, true);

  const loaded = harness([job('model-unload', modelMetadata)], {
    inventory: { installed: [installedModel()], running: [runningModel()] },
  });
  await loaded.service.reconcile();
  assert.equal(loaded.rows.get('model-unload-job').state, 'failed');
  assert.equal(loaded.rows.get('model-unload-job').errorClass, 'MODEL_UNLOAD_RESTART_UNVERIFIED');
});

test('restart reconciliation never claims an interrupted smoke inference succeeded', async () => {
  const clean = harness([job('model-smoke-test', modelMetadata)], {
    inventory: { installed: [installedModel()], running: [] },
  });
  await clean.service.reconcile();
  assert.equal(clean.rows.get('model-smoke-test-job').state, 'failed');
  assert.equal(clean.rows.get('model-smoke-test-job').errorClass, 'MODEL_SMOKE_RESTART_INTERRUPTED_CLEAN');

  const residual = harness([job('model-smoke-test', modelMetadata)], {
    inventory: { installed: [installedModel()], running: [runningModel()] },
  });
  await residual.service.reconcile();
  assert.equal(residual.rows.get('model-smoke-test-job').errorClass, 'MODEL_SMOKE_RESTART_RESIDUAL_LOAD');
});

test('lifecycle restart reconciliation requires an observable postcondition', async () => {
  const metadata = {
    action: 'restart',
    containerId: 'container-1',
    initialRunning: true,
    initialStartedAt: '2026-08-12T09:00:00.000Z',
  };
  const verified = harness([job('container.restart', metadata)], {
    container: { id: 'container-1', running: true, startedAt: '2026-08-12T10:01:00.000Z' },
  });
  await verified.service.reconcile();
  assert.equal(verified.rows.get('container.restart-job').state, 'succeeded');

  const unchanged = harness([job('container.restart', metadata)], {
    container: { id: 'container-1', running: true, startedAt: metadata.initialStartedAt },
  });
  await unchanged.service.reconcile();
  assert.equal(unchanged.rows.get('container.restart-job').state, 'failed');
  assert.equal(unchanged.rows.get('container.restart-job').errorClass, 'CONTAINER_RESTART_STATE_UNVERIFIED');
});

test('missing metadata or stale target binding fails closed and releases the persistent lock', async () => {
  const missing = harness([job('container.stop', null)]);
  await missing.service.reconcile();
  assert.equal(missing.rows.get('container.stop-job').state, 'failed');
  assert.equal(missing.rows.get('container.stop-job').errorClass, 'RESTART_METADATA_MISSING');

  const stale = harness([job('model-unload', modelMetadata)], {
    target: { id: 'target-1', enabled: true, selectedContainerId: 'container-2' },
  });
  await stale.service.reconcile();
  assert.equal(stale.rows.get('model-unload-job').state, 'failed');
  assert.equal(stale.rows.get('model-unload-job').errorClass, 'TARGET_BINDING_STALE');
});
