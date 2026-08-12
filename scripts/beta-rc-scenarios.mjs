import { spawnSync } from 'node:child_process';
import { writeBetaReleaseEvidence } from './beta-rc-evidence.mjs';

export const betaRcScenarios = Object.freeze([
  {
    id: 'identity-target-onboarding',
    command: process.execPath,
    args: ['--test', '--test-concurrency=1',
      'apps/api/test/auth.test.mjs',
      'apps/api/test/hosts.test.mjs',
      'apps/api/test/docker-discovery.test.mjs',
      'apps/api/test/target-status.test.mjs',
    ],
  },
  {
    id: 'model-runtime-smoke',
    command: process.execPath,
    args: ['--test', '--test-concurrency=1',
      'apps/api/test/ollama-health-route.test.mjs',
      'apps/api/test/model-inventory-route.test.mjs',
      'apps/api/test/model-smoke-route.test.mjs',
      'apps/api/test/model-smoke-binding-route.test.mjs',
      'apps/api/test/model-unload-route.test.mjs',
    ],
  },
  {
    id: 'pull-reconnect-recovery',
    command: process.execPath,
    args: ['--test', '--test-concurrency=1',
      'apps/api/test/model-pull-route.test.mjs',
      'apps/api/test/pull-job-events.test.mjs',
      'apps/api/test/model-pull-reconciliation.test.mjs',
    ],
  },
  {
    id: 'modelfile-deploy-lineage',
    command: process.execPath,
    args: ['--test', '--test-concurrency=1',
      'apps/api/test/modelfile-route.test.mjs',
      'apps/api/test/modelfile-validation.test.mjs',
      'apps/api/test/modelfile-deploy-plan.test.mjs',
      'apps/api/test/modelfile-replace-plan.test.mjs',
      'apps/api/test/model-create-route.test.mjs',
      'apps/api/test/model-create-reconciliation.test.mjs',
      'apps/api/test/model-source-route.test.mjs',
      'apps/api/test/model-provenance-graph.test.mjs',
    ],
  },
  {
    id: 'container-audit-safety',
    command: process.execPath,
    args: ['--test', '--test-concurrency=1',
      'apps/api/test/live-logs.test.mjs',
      'apps/api/test/container-lifecycle.test.mjs',
      'apps/api/test/audit-feature.test.mjs',
      'apps/api/test/jobs-audit.test.mjs',
      'apps/api/test/model-unload-active-mutation.test.mjs',
    ],
  },
  {
    id: 'restart-update-rollback',
    command: process.execPath,
    args: ['--test', '--test-concurrency=1',
      'apps/api/test/update-reconciliation-startup.test.mjs',
      'apps/api/test/update-reconciliation.test.mjs',
      'apps/api/test/manual-rollback-reconciliation.test.mjs',
    ],
  },
  {
    id: 'browser-reconnect-surfaces',
    command: 'npm',
    args: ['run', 'test', '--workspace', '@orc/web', '--',
      'src/model-pull.test.ts',
      'src/model-create-replace.test.ts',
      'src/log-stream.test.ts',
      'src/onboarding-api.test.ts',
      'src/audit-api.test.ts',
      'src/RawModelfileImportPanel.test.ts',
    ],
  },
]);

export function validateScenarioDefinitions(scenarios = betaRcScenarios) {
  if (!Array.isArray(scenarios) || scenarios.length === 0 || scenarios.length > 64) {
    throw new TypeError('RC scenarios must contain between 1 and 64 entries.');
  }
  const ids = new Set();
  for (const scenario of scenarios) {
    if (!scenario || typeof scenario !== 'object') throw new TypeError('Invalid RC scenario.');
    if (typeof scenario.id !== 'string' || !/^[a-z0-9][a-z0-9.-]{0,63}$/u.test(scenario.id)) {
      throw new TypeError('RC scenario id is invalid.');
    }
    if (ids.has(scenario.id)) throw new TypeError(`Duplicate RC scenario id: ${scenario.id}`);
    ids.add(scenario.id);
    if (typeof scenario.command !== 'string' || !scenario.command || !Array.isArray(scenario.args)) {
      throw new TypeError(`RC scenario ${scenario.id} has an invalid command.`);
    }
    for (const argument of scenario.args) {
      if (typeof argument !== 'string' || argument.includes('\u0000')) {
        throw new TypeError(`RC scenario ${scenario.id} has an invalid command argument.`);
      }
    }
  }
  return scenarios;
}

export function runBetaRcScenario(scenario, options = {}) {
  const spawn = options.spawnSync ?? spawnSync;
  const result = spawn(scenario.command, scenario.args, {
    cwd: options.cwd ?? process.cwd(),
    env: options.env ?? process.env,
    stdio: options.stdio ?? 'inherit',
    shell: false,
  });
  return result.status === 0 ? 'passed' : 'failed';
}

export async function runBetaRcScenarios({ outputPath, commitSha, scenarios = betaRcScenarios, spawnSync: spawn } = {}) {
  if (!outputPath) throw new TypeError('outputPath is required.');
  validateScenarioDefinitions(scenarios);
  const results = [];
  for (const scenario of scenarios) {
    console.log(`::group::beta RC scenario ${scenario.id}`);
    const status = runBetaRcScenario(scenario, { spawnSync: spawn });
    console.log(`::endgroup::`);
    results.push({ id: scenario.id, status });
  }
  const evidence = await writeBetaReleaseEvidence(outputPath, { commitSha, scenarios: results });
  return evidence;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [outputPath, commitSha] = process.argv.slice(2);
  if (!outputPath || !commitSha) {
    console.error('usage: node scripts/beta-rc-scenarios.mjs <output> <commit-sha>');
    process.exit(64);
  }
  try {
    const evidence = await runBetaRcScenarios({ outputPath, commitSha });
    if (evidence.overall !== 'passed') process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Beta RC scenario runner failed.');
    process.exitCode = 64;
  }
}
