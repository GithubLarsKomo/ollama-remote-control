import { writeFile } from 'node:fs/promises';

const SHA_PATTERN = /^[a-f0-9]{40}$/u;
const STATUS = new Set(['passed', 'failed']);

export function buildBetaReleaseEvidence(input) {
  if (!input || typeof input !== 'object') throw new TypeError('Evidence input is required.');
  if (typeof input.commitSha !== 'string' || !SHA_PATTERN.test(input.commitSha)) {
    throw new TypeError('commitSha must be a full lowercase Git SHA.');
  }
  if (!Array.isArray(input.scenarios) || input.scenarios.length === 0 || input.scenarios.length > 64) {
    throw new TypeError('scenarios must contain between 1 and 64 bounded entries.');
  }
  const scenarios = input.scenarios.map((scenario) => {
    if (!scenario || typeof scenario !== 'object') throw new TypeError('Invalid scenario entry.');
    if (typeof scenario.id !== 'string' || !/^[a-z0-9][a-z0-9.-]{0,63}$/u.test(scenario.id)) {
      throw new TypeError('Scenario id is invalid.');
    }
    if (!STATUS.has(scenario.status)) throw new TypeError('Scenario status is invalid.');
    return { id: scenario.id, status: scenario.status };
  });
  const passed = scenarios.every((scenario) => scenario.status === 'passed');
  return {
    schemaVersion: 1,
    commitSha: input.commitSha,
    overall: passed ? 'passed' : 'failed',
    scenarios,
  };
}

export async function writeBetaReleaseEvidence(path, input) {
  const evidence = buildBetaReleaseEvidence(input);
  await writeFile(path, `${JSON.stringify(evidence, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  return evidence;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [outputPath, commitSha, ...scenarioArgs] = process.argv.slice(2);
  if (!outputPath || !commitSha || scenarioArgs.length === 0) {
    console.error('usage: node scripts/beta-rc-evidence.mjs <output> <commit-sha> <scenario>=<passed|failed> ...');
    process.exit(64);
  }
  try {
    const scenarios = scenarioArgs.map((entry) => {
      const index = entry.lastIndexOf('=');
      if (index <= 0) throw new TypeError('Scenario argument is invalid.');
      return { id: entry.slice(0, index), status: entry.slice(index + 1) };
    });
    const evidence = await writeBetaReleaseEvidence(outputPath, { commitSha, scenarios });
    if (evidence.overall !== 'passed') process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Failed to write beta release evidence.');
    process.exitCode = 64;
  }
}
