import fs from 'node:fs';
import path from 'node:path';

const REQUIRED_DIMENSIONS = Object.freeze([
  'preflight',
  'transport',
  'verification',
  'cancellation',
  'restart',
  'race',
  'lock',
  'terminalState',
]);

export const betaFailureRecoveryMatrix = Object.freeze({
  schemaVersion: 1,
  scope: '0.1-beta-target-mutations',
  deferred: Object.freeze([
    { id: 'model-delete', reason: 'Deferred from 0.1 beta by SPEC amendment #111.' },
    { id: 'expert-mode', reason: 'Deferred from 0.1 beta by SPEC amendment #111.' },
  ]),
  operations: Object.freeze([
    {
      id: 'model-pull',
      jobKinds: ['model-pull'],
      dimensions: {
        preflight: 'Pinned SSH/container/API route is resolved before remote pull work.',
        transport: 'Transport/stream failures terminalize the job; secrets remain redacted.',
        verification: 'Installed model identity/digest is re-read before success.',
        cancellation: 'Cancellation enters cancelling and verifies observed remote state.',
        restart: 'Nonterminal pull jobs reconcile from installed-model state without replaying an unbounded browser request.',
        race: 'Selected-container binding is persisted and rechecked.',
        lock: 'Persistent per-target mutating job lock.',
        terminalState: 'succeeded only after observation; otherwise failed/cancelled with explicit class.',
      },
      tests: [
        'apps/api/test/model-pull-route.test.mjs',
        'apps/api/test/model-pull-reconciliation.test.mjs',
        'apps/api/test/pull-job-events.test.mjs',
        'apps/api/test/jobs-audit.test.mjs',
      ],
      rcScenarios: ['pull-reconnect-recovery'],
      status: 'covered',
    },
    {
      id: 'model-create-replace',
      jobKinds: ['model-create'],
      dimensions: {
        preflight: 'Immutable revision, base model, target binding and optional replacement digest are plan-bound.',
        transport: 'Create stream failures terminalize without treating HTTP acceptance as success.',
        verification: 'Fresh inventory/show semantics verify the resulting destination before success.',
        cancellation: 'Cancellation is bounded and target state is observed before terminal cancellation.',
        restart: 'Startup reconciliation never replays POST /api/create; it verifies resulting remote state.',
        race: 'Plan/revision/container/destination digest authority is revalidated immediately before mutation.',
        lock: 'Persistent per-target mutating job lock.',
        terminalState: 'succeeded only after semantic verification; otherwise explicit failure/cancellation.',
      },
      tests: [
        'apps/api/test/modelfile-deploy-plan.test.mjs',
        'apps/api/test/modelfile-replace-plan.test.mjs',
        'apps/api/test/model-create-route.test.mjs',
        'apps/api/test/model-create-reconciliation.test.mjs',
        'apps/api/test/modelfile-deploy-verification.test.mjs',
        'apps/api/test/jobs-audit.test.mjs',
      ],
      rcScenarios: ['modelfile-deploy-lineage'],
      status: 'covered',
    },
    {
      id: 'model-smoke-test',
      jobKinds: ['model-smoke-test'],
      dimensions: {
        preflight: 'Exact installed model/digest and idle-state confirmation are checked before the fixed smoke request.',
        transport: 'Pinned SSH/API failures fail the job without persisting generated text.',
        verification: 'Postcondition verifies the model is not left loaded.',
        cancellation: 'Not applicable: bounded synchronous administrative request has no public cancel endpoint.',
        restart: 'GAP: no startup reconciliation currently owns a nonterminal smoke-test job.',
        race: 'Target binding and exact digest are rechecked.',
        lock: 'Persistent per-target mutating job lock.',
        terminalState: 'succeeded only after smoke response and unloaded postcondition; otherwise failed.',
      },
      tests: [
        'apps/api/test/model-smoke-route.test.mjs',
        'apps/api/test/model-smoke-binding-route.test.mjs',
        'apps/api/test/jobs-audit.test.mjs',
      ],
      rcScenarios: ['model-runtime-smoke'],
      status: 'gap',
    },
    {
      id: 'model-unload',
      jobKinds: ['model-unload'],
      dimensions: {
        preflight: 'Exact loaded model/digest is observed before unload.',
        transport: 'Pinned SSH/API failures produce a failed persistent job.',
        verification: 'Fresh /api/ps verifies the exact digest is no longer loaded.',
        cancellation: 'Not applicable: bounded synchronous unload has no public cancel endpoint.',
        restart: 'GAP: no startup reconciliation currently owns a nonterminal unload job.',
        race: 'Binding/digest races fail closed.',
        lock: 'Persistent per-target mutating job lock and active-mutation UI gate.',
        terminalState: 'succeeded only after absence is observed; otherwise failed.',
      },
      tests: [
        'apps/api/test/model-unload-route.test.mjs',
        'apps/api/test/model-unload-binding-route.test.mjs',
        'apps/api/test/model-unload-preflight-jobs.test.mjs',
        'apps/api/test/model-unload-active-mutation.test.mjs',
      ],
      rcScenarios: ['model-runtime-smoke', 'container-audit-safety'],
      status: 'gap',
    },
    {
      id: 'container-lifecycle',
      jobKinds: ['container.start', 'container.stop', 'container.restart'],
      dimensions: {
        preflight: 'Server-derived target/container and concrete confirmation for stop/restart.',
        transport: 'Typed Docker-over-SSH operation; transport/command failure fails the job.',
        verification: 'Container state is inspected after the operation before success.',
        cancellation: 'Not applicable: bounded synchronous Docker lifecycle calls have no public cancel endpoint.',
        restart: 'GAP: no startup reconciliation currently owns nonterminal lifecycle jobs.',
        race: 'Persistent target lock serializes lifecycle with all other target mutations.',
        lock: 'Persistent per-target mutating job lock.',
        terminalState: 'succeeded only after verified Docker state; otherwise failed.',
      },
      tests: [
        'apps/api/test/container-lifecycle.test.mjs',
        'apps/api/test/jobs-audit.test.mjs',
      ],
      rcScenarios: ['container-audit-safety'],
      status: 'gap',
    },
    {
      id: 'container-update',
      jobKinds: ['container.update'],
      dimensions: {
        preflight: 'Authenticated snapshot/intent, exact candidate digest and Compose context are revalidated.',
        transport: 'SSH/Compose replacement errors are classified and terminalized.',
        verification: 'Candidate Ollama health is mandatory before success.',
        cancellation: 'No public mid-replacement cancellation; execution is bounded by typed remote steps and recovery.',
        restart: 'Startup reconciliation verifies candidate/current Compose state and rolls back or fails closed.',
        race: 'Target binding and Compose container identity are checked and re-bound with compare-and-swap semantics.',
        lock: 'Persistent per-target mutating job lock.',
        terminalState: 'updated only after health; failed update records verified rollback success or explicit rollback failure.',
      },
      tests: [
        'apps/api/test/update-preflight.test.mjs',
        'apps/api/test/update-orchestrator.test.mjs',
        'apps/api/test/update-reconciliation.test.mjs',
        'apps/api/test/update-reconciliation-startup.test.mjs',
        'apps/api/test/ollama-candidate-health.test.mjs',
        'apps/api/test/jobs-audit.test.mjs',
      ],
      rcScenarios: ['restart-update-rollback'],
      status: 'covered',
    },
    {
      id: 'container-manual-rollback',
      jobKinds: ['container.rollback'],
      dimensions: {
        preflight: 'Server-derived prior successful update/snapshot and explicit concrete confirmation are authenticated.',
        transport: 'SSH/Compose replacement failures are classified without inventing recovery success.',
        verification: 'Rollback container Ollama health is mandatory before success.',
        cancellation: 'No public mid-replacement cancellation; rollback is a bounded recovery transaction.',
        restart: 'Startup reconciliation verifies observed Compose/container state and restores the previous healthy candidate when necessary.',
        race: 'Authority is re-derived after acquiring the persistent target lock; binding changes fail closed.',
        lock: 'Persistent per-target mutating job lock.',
        terminalState: 'succeeded only after healthy rollback; otherwise failed with explicit restoration/recovery outcome.',
      },
      tests: [
        'apps/api/test/manual-rollback-candidate.test.mjs',
        'apps/api/test/manual-rollback-execution.test.mjs',
        'apps/api/test/manual-rollback-reconciliation.test.mjs',
        'apps/api/test/manual-rollback-route.test.mjs',
        'apps/api/test/jobs-audit.test.mjs',
      ],
      rcScenarios: ['restart-update-rollback'],
      status: 'covered',
    },
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
  if (!matrix || matrix.schemaVersion !== 1 || !Array.isArray(matrix.operations) || matrix.operations.length === 0) {
    throw new TypeError('Failure/recovery matrix schema is invalid.');
  }
  const ids = new Set();
  const kinds = new Set();
  const gaps = [];
  for (const operation of matrix.operations) {
    if (!operation || typeof operation.id !== 'string' || !/^[a-z0-9][a-z0-9.-]{0,63}$/u.test(operation.id)) {
      throw new TypeError('Failure/recovery operation id is invalid.');
    }
    if (ids.has(operation.id)) throw new TypeError(`Duplicate failure/recovery operation: ${operation.id}`);
    ids.add(operation.id);
    if (!Array.isArray(operation.jobKinds) || operation.jobKinds.length === 0) throw new TypeError(`${operation.id} has no job kinds.`);
    for (const kind of operation.jobKinds) {
      if (typeof kind !== 'string' || !kind || kinds.has(kind)) throw new TypeError(`${operation.id} has invalid or duplicate job kind ${String(kind)}.`);
      kinds.add(kind);
    }
    for (const dimension of REQUIRED_DIMENSIONS) {
      if (typeof operation.dimensions?.[dimension] !== 'string' || !operation.dimensions[dimension].trim()) {
        throw new TypeError(`${operation.id} is missing recovery dimension ${dimension}.`);
      }
    }
    if (!Array.isArray(operation.tests) || operation.tests.length === 0) throw new TypeError(`${operation.id} has no automated test evidence.`);
    for (const testFile of operation.tests) {
      assertSafeRelativeFile(testFile, `${operation.id} test`);
      if (!fs.existsSync(path.join(root, testFile))) throw new TypeError(`${operation.id} references missing test ${testFile}.`);
    }
    if (!Array.isArray(operation.rcScenarios) || operation.rcScenarios.length === 0) throw new TypeError(`${operation.id} has no RC scenario evidence.`);
    if (scenarios.size > 0) {
      for (const scenario of operation.rcScenarios) if (!scenarios.has(scenario)) throw new TypeError(`${operation.id} references missing RC scenario ${scenario}.`);
    }
    if (!['covered', 'gap'].includes(operation.status)) throw new TypeError(`${operation.id} has invalid status.`);
    if (operation.status === 'gap') gaps.push(operation.id);
  }
  const deferredIds = new Set((matrix.deferred ?? []).map((entry) => entry?.id));
  for (const required of ['model-delete', 'expert-mode']) if (!deferredIds.has(required)) throw new TypeError(`Deferred beta operation ${required} is not explicit.`);
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
