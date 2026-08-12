import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  betaRcScenarios,
  resetDisposableRcFixture,
  runBetaRcScenario,
  runBetaRcScenarios,
  validateScenarioDefinitions,
} from '../../../scripts/beta-rc-scenarios.mjs';

const sha = 'b'.repeat(40);

test('beta RC scenario manifest is bounded, unique and includes amended beta paths', () => {
  assert.equal(validateScenarioDefinitions(), betaRcScenarios);
  const ids = betaRcScenarios.map((scenario) => scenario.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const expected of [
    'identity-target-onboarding',
    'model-runtime-smoke',
    'pull-reconnect-recovery',
    'modelfile-deploy-lineage',
    'container-audit-safety',
    'restart-update-rollback',
    'application-state-backup-restore',
    'browser-reconnect-surfaces',
  ]) assert.ok(ids.includes(expected));
  assert.ok(betaRcScenarios.every((scenario) => scenario.command !== 'sh' && scenario.command !== 'bash'));
});

test('scenario execution is fail-closed on nonzero or missing process status', () => {
  const scenario = { id: 'x', command: 'node', args: [] };
  assert.equal(runBetaRcScenario(scenario, { spawnSync: () => ({ status: 0 }), stdio: 'ignore' }), 'passed');
  assert.equal(runBetaRcScenario(scenario, { spawnSync: () => ({ status: 2 }), stdio: 'ignore' }), 'failed');
  assert.equal(runBetaRcScenario(scenario, { spawnSync: () => ({ status: null }), stdio: 'ignore' }), 'failed');
});

test('disposable fixture reset restores deterministic state and fails closed when partially configured', () => {
  assert.equal(resetDisposableRcFixture({}, () => assert.fail('no writes expected')), false);
  const environment = {
    ORC_DOCKER_FIXTURE_LOG: '/fixture/docker-log',
    ORC_SYSTEM_FIXTURE_LOG: '/fixture/system-log',
    ORC_LOG_PROCESS_STATE: '/fixture/log-state',
    ORC_LOG_PROCESS_PID: '/fixture/log-pid',
    ORC_CONTAINER_STATE: '/fixture/container-state',
    ORC_LIFECYCLE_MODE: '/fixture/lifecycle-mode',
    ORC_REGISTRY_MODE: '/fixture/registry-mode',
    ORC_COMPOSE_MODE: '/fixture/compose-mode',
    ORC_COMPOSE_STDIN: '/fixture/compose-stdin',
  };
  const writes = [];
  assert.equal(resetDisposableRcFixture(environment, (file, value) => writes.push([file, value])), true);
  assert.deepEqual(writes, [
    ['/tmp/orc-docker-fixture-mode', 'single'],
    ['/tmp/orc-status-fixture-mode', 'normal'],
    ['/fixture/container-state', 'running'],
    ['/fixture/lifecycle-mode', 'normal'],
    ['/fixture/registry-mode', 'changed'],
    ['/fixture/compose-mode', 'normal'],
    ['/fixture/docker-log', ''],
    ['/fixture/system-log', ''],
    ['/fixture/log-state', ''],
    ['/fixture/log-pid', ''],
    ['/fixture/compose-stdin', ''],
  ]);
  assert.throws(() => resetDisposableRcFixture({ ORC_CONTAINER_STATE: '/fixture/container' }, () => {}));
});

test('joined RC runner resets before every bucket and writes only bounded scenario status and exact SHA', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orc-beta-rc-scenarios-'));
  const output = path.join(directory, 'evidence.json');
  const scenarios = [
    { id: 'one', command: 'node', args: ['one'] },
    { id: 'two', command: 'node', args: ['two'] },
  ];
  let calls = 0;
  let resets = 0;
  const evidence = await runBetaRcScenarios({
    outputPath: output,
    commitSha: sha,
    scenarios,
    resetFixture: () => { resets += 1; },
    spawnSync: () => ({ status: calls++ === 0 ? 0 : 1 }),
  });
  assert.equal(resets, scenarios.length);
  assert.equal(evidence.overall, 'failed');
  assert.deepEqual(evidence.scenarios, [
    { id: 'one', status: 'passed' },
    { id: 'two', status: 'failed' },
  ]);
  const persisted = JSON.parse(fs.readFileSync(output, 'utf8'));
  assert.deepEqual(persisted, evidence);
  assert.deepEqual(Object.keys(persisted).sort(), ['commitSha', 'overall', 'scenarios', 'schemaVersion']);
});

test('scenario manifest rejects duplicate or unsafe identifiers', () => {
  assert.throws(() => validateScenarioDefinitions([
    { id: 'same', command: 'node', args: [] },
    { id: 'same', command: 'node', args: [] },
  ]));
  assert.throws(() => validateScenarioDefinitions([{ id: '../unsafe', command: 'node', args: [] }]));
});