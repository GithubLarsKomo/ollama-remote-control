import fs from 'node:fs';
import path from 'node:path';

const REQUIRED_DIMENSIONS = Object.freeze([
  'preflight', 'transport', 'verification', 'cancellation', 'restart', 'race', 'lock', 'terminalState',
]);

const operation = (id, jobKinds, dimensions, tests, rcScenarios) => Object.freeze({
  id, jobKinds: Object.freeze(jobKinds), dimensions: Object.freeze(dimensions),
  tests: Object.freeze(tests), rcScenarios: Object.freeze(rcScenarios), status: 'covered',
});

export const betaFailureRecoveryMatrix = Object.freeze({
  schemaVersion: 1,
  scope: '0.1-beta-target-mutations',
  deferred: Object.freeze([
    { id: 'model-delete', reason: 'Deferred from 0.1 beta by SPEC amendment #111.' },
    { id: 'expert-mode', reason: 'Deferred from 0.1 beta by SPEC amendment #111.' },
  ]),
  operations: Object.freeze([
    operation('model-pull', ['model-pull'], {
      preflight: 'Pinned SSH/container/API route before remote pull.',
      transport: 'Stream/transport failure terminalizes explicitly.',
      verification: 'Installed model/digest re-read before success.',
      cancellation: 'Cancelling observes remote state before terminal cancellation.',
      restart: 'Startup reconciliation observes installed state without replay.',
      race: 'Selected container binding persisted and rechecked.',
      lock: 'Persistent per-target mutation lock.',
      terminalState: 'Success only after observed model state.',
    }, ['apps/api/test/model-pull-route.test.mjs','apps/api/test/model-pull-reconciliation.test.mjs','apps/api/test/pull-job-events.test.mjs','apps/api/test/jobs-audit.test.mjs'], ['pull-reconnect-recovery']),

    operation('model-create-replace', ['model-create'], {
      preflight: 'Immutable revision/base/target and optional replacement digest are plan-bound.',
      transport: 'Create stream failure is never treated as success.',
      verification: 'Inventory/show semantics verify destination.',
      cancellation: 'Cancellation is bounded and target state is observed.',
      restart: 'Startup never replays create; it verifies remote state.',
      race: 'Revision/container/destination digest revalidated immediately before mutation.',
      lock: 'Persistent per-target mutation lock.',
      terminalState: 'Success only after semantic destination verification.',
    }, ['apps/api/test/modelfile-deploy-plan.test.mjs','apps/api/test/modelfile-replace-plan.test.mjs','apps/api/test/model-create-route.test.mjs','apps/api/test/model-create-reconciliation.test.mjs','apps/api/test/modelfile-deploy-verification.test.mjs','apps/api/test/jobs-audit.test.mjs'], ['modelfile-deploy-lineage']),

    operation('model-smoke-test', ['model-smoke-test'], {
      preflight: 'Exact installed model/digest and idle state checked.',
      transport: 'Pinned SSH/API failure fails without generated-text persistence.',
      verification: 'Postcondition requires no residual loaded model.',
      cancellation: 'No public cancel endpoint for this bounded synchronous request.',
      restart: 'Startup observes installed/loaded state, never replays generation, and never claims lost inference success.',
      race: 'Target binding and exact digest rechecked.',
      lock: 'Persistent per-target mutation lock.',
      terminalState: 'Interrupted smoke is failed even when cleanup postcondition is proven.',
    }, ['apps/api/test/model-smoke-route.test.mjs','apps/api/test/model-smoke-binding-route.test.mjs','apps/api/test/short-mutation-reconciliation.test.mjs','apps/api/test/jobs-audit.test.mjs'], ['model-runtime-smoke','mutation-failure-recovery-matrix']),

    operation('model-unload', ['model-unload'], {
      preflight: 'Exact loaded model/digest observed before unload.',
      transport: 'Pinned SSH/API failure produces explicit failed job.',
      verification: 'Fresh loaded-model inventory proves absence.',
      cancellation: 'No public cancel endpoint for bounded synchronous unload.',
      restart: 'Startup observes exact digest; absence can prove desired postcondition without replay.',
      race: 'Binding/digest races fail closed.',
      lock: 'Persistent per-target mutation lock.',
      terminalState: 'Success only when exact digest absence is observed.',
    }, ['apps/api/test/model-unload-route.test.mjs','apps/api/test/model-unload-binding-route.test.mjs','apps/api/test/model-unload-preflight-jobs.test.mjs','apps/api/test/model-unload-active-mutation.test.mjs','apps/api/test/short-mutation-reconciliation.test.mjs'], ['model-runtime-smoke','container-audit-safety','mutation-failure-recovery-matrix']),

    operation('container-lifecycle', ['container.start','container.stop','container.restart'], {
      preflight: 'Server-derived target/container; concrete confirmation for stop/restart.',
      transport: 'Typed Docker-over-SSH operation with explicit failure.',
      verification: 'Docker state inspected before success.',
      cancellation: 'No public cancel endpoint for bounded lifecycle operation.',
      restart: 'Initial state/start timestamp persisted; startup observes exact container and never replays action.',
      race: 'Target binding checked; changed binding fails closed.',
      lock: 'Persistent per-target mutation lock.',
      terminalState: 'Restart success after recovery requires changed startedAt; start/stop require desired running state.',
    }, ['apps/api/test/container-lifecycle.test.mjs','apps/api/test/short-mutation-reconciliation.test.mjs','apps/api/test/jobs-audit.test.mjs'], ['container-audit-safety','mutation-failure-recovery-matrix']),

    operation('container-update', ['container.update'], {
      preflight: 'Authenticated snapshot/intent, exact digest and Compose context revalidated.',
      transport: 'SSH/Compose failures classified and terminalized.',
      verification: 'Candidate Ollama health mandatory.',
      cancellation: 'No unsafe mid-replacement public cancellation; bounded recovery transaction.',
      restart: 'Startup reconciles Compose/container state and rolls back or fails closed.',
      race: 'Binding/Compose identity checked with compare-and-swap rebinding.',
      lock: 'Persistent per-target mutation lock.',
      terminalState: 'Updated only after health; failures record rollback outcome explicitly.',
    }, ['apps/api/test/update-preflight.test.mjs','apps/api/test/update-orchestrator.test.mjs','apps/api/test/update-reconciliation.test.mjs','apps/api/test/update-reconciliation-startup.test.mjs','apps/api/test/ollama-candidate-health.test.mjs','apps/api/test/jobs-audit.test.mjs'], ['restart-update-rollback']),

    operation('container-manual-rollback', ['container.rollback'], {
      preflight: 'Server-derived authenticated prior update/snapshot plus concrete confirmation.',
      transport: 'SSH/Compose failures never invent recovery success.',
      verification: 'Rollback Ollama health mandatory.',
      cancellation: 'No unsafe mid-replacement public cancellation; bounded recovery transaction.',
      restart: 'Startup observes Compose/container state and restores previous healthy candidate when necessary.',
      race: 'Authority re-derived after acquiring target lock.',
      lock: 'Persistent per-target mutation lock.',
      terminalState: 'Success only after healthy rollback; failure records restoration outcome.',
    }, ['apps/api/test/manual-rollback-candidate.test.mjs','apps/api/test/manual-rollback-execution.test.mjs','apps/api/test/manual-rollback-reconciliation.test.mjs','apps/api/test/manual-rollback-route.test.mjs','apps/api/test/jobs-audit.test.mjs'], ['restart-update-rollback']),
  ]),
});

function assertSafeRelativeFile(value, field) {
  if (typeof value !== 'string' || !value || path.isAbsolute(value) || value.includes('..') || value.includes('\u0000')) {
    throw new TypeError(`${field} must be a safe repository-relative path.`);
  }
}

export function validateBetaFailureRecoveryMatrix(matrix = betaFailureRecoveryMatrix, options = {}) {
  const root = options.root ?? process.cwd();
  const requireComplete = options.requireComplete ?? false;
  const scenarios = new Set(options.scenarioIds ?? []);
  if (!matrix || matrix.schemaVersion !== 1 || !Array.isArray(matrix.operations) || matrix.operations.length === 0) throw new TypeError('Failure/recovery matrix schema is invalid.');
  const ids = new Set();
  const kinds = new Set();
  const gaps = [];
  for (const entry of matrix.operations) {
    if (!entry || typeof entry.id !== 'string' || !/^[a-z0-9][a-z0-9.-]{0,63}$/u.test(entry.id)) throw new TypeError('Failure/recovery operation id is invalid.');
    if (ids.has(entry.id)) throw new TypeError(`Duplicate failure/recovery operation: ${entry.id}`);
    ids.add(entry.id);
    if (!Array.isArray(entry.jobKinds) || entry.jobKinds.length === 0) throw new TypeError(`${entry.id} has no job kinds.`);
    for (const kind of entry.jobKinds) {
      if (typeof kind !== 'string' || !kind || kinds.has(kind)) throw new TypeError(`${entry.id} has invalid or duplicate job kind ${String(kind)}.`);
      kinds.add(kind);
    }
    for (const dimension of REQUIRED_DIMENSIONS) if (typeof entry.dimensions?.[dimension] !== 'string' || !entry.dimensions[dimension].trim()) throw new TypeError(`${entry.id} is missing recovery dimension ${dimension}.`);
    if (!Array.isArray(entry.tests) || entry.tests.length === 0) throw new TypeError(`${entry.id} has no automated test evidence.`);
    for (const testFile of entry.tests) {
      assertSafeRelativeFile(testFile, `${entry.id} test`);
      if (!fs.existsSync(path.join(root, testFile))) throw new TypeError(`${entry.id} references missing test ${testFile}.`);
    }
    if (!Array.isArray(entry.rcScenarios) || entry.rcScenarios.length === 0) throw new TypeError(`${entry.id} has no RC scenario evidence.`);
    if (scenarios.size > 0) for (const scenario of entry.rcScenarios) if (!scenarios.has(scenario)) throw new TypeError(`${entry.id} references missing RC scenario ${scenario}.`);
    if (!['covered','gap'].includes(entry.status)) throw new TypeError(`${entry.id} has invalid status.`);
    if (entry.status === 'gap') gaps.push(entry.id);
  }
  const deferredIds = new Set((matrix.deferred ?? []).map((entry) => entry?.id));
  for (const required of ['model-delete','expert-mode']) if (!deferredIds.has(required)) throw new TypeError(`Deferred beta operation ${required} is not explicit.`);
  if (requireComplete && gaps.length > 0) throw new TypeError(`Failure/recovery matrix has uncovered operations: ${gaps.join(', ')}`);
  return { operationCount: matrix.operations.length, jobKindCount: kinds.size, gaps };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const result = validateBetaFailureRecoveryMatrix(betaFailureRecoveryMatrix, { requireComplete: process.argv.includes('--require-complete') });
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Failure/recovery matrix validation failed.');
    process.exitCode = 1;
  }
}
