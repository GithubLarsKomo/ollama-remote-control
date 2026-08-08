import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ComposeIntentError,
  composeDigestOverrideJson,
  exactDigestImageReference,
  validateComposeDigestOverride,
} from '../dist/compose-intent.js';

const CANDIDATE_DIGEST = `sha256:${'a'.repeat(64)}`;
const OTHER_DIGEST = `sha256:${'b'.repeat(64)}`;
const CANDIDATE_IMAGE = `ollama/ollama@${CANDIDATE_DIGEST}`;

const context = {
  projectName: 'orc-stack',
  service: 'ollama',
  workingDirectory: '/srv/orc',
  configFiles: ['/srv/orc/compose.yml'],
  environmentFiles: [],
};

test('exact digest reference removes mutable tag and requires canonical SHA-256 encoding', () => {
  assert.equal(
    exactDigestImageReference('ollama/ollama:latest', CANDIDATE_DIGEST.toUpperCase()),
    CANDIDATE_IMAGE,
  );
  assert.equal(
    exactDigestImageReference('registry.example:5000/team/ollama:v1', CANDIDATE_DIGEST),
    `registry.example:5000/team/ollama@${CANDIDATE_DIGEST}`,
  );
  for (const invalid of ['not-a-digest', 'sha256:candidate-digest', `sha256:${'a'.repeat(63)}`, `sha256:${'g'.repeat(64)}`]) {
    assert.throws(
      () => exactDigestImageReference('ollama/ollama:latest', invalid),
      (error) => error instanceof ComposeIntentError && error.code === 'INVALID_IMAGE_DIGEST',
    );
  }
});

test('Compose override is generated as JSON without interpolating YAML or shell syntax', () => {
  const value = composeDigestOverrideJson('ollama-service', CANDIDATE_IMAGE);
  assert.deepEqual(JSON.parse(value), {
    services: { 'ollama-service': { image: CANDIDATE_IMAGE } },
  });
  assert.equal(value.includes(';'), false);
});

test('Compose digest validation sends exact read-only argv and override through stdin', async () => {
  const calls = [];
  const result = await validateComposeDigestOverride({
    async exec(argv, stdin) {
      calls.push({ argv: [...argv], stdin });
      return {
        stdout: `docker.io/ollama/ollama@${CANDIDATE_DIGEST}\n`,
        stderr: '',
        exitCode: 0,
      };
    },
  }, context, CANDIDATE_IMAGE);

  assert.equal(result.exactImageReference, CANDIDATE_IMAGE);
  assert.deepEqual(calls, [{
    argv: [
      'docker', 'compose', '-p', 'orc-stack', '--project-directory', '/srv/orc',
      '-f', '/srv/orc/compose.yml', '-f', '-', 'config', '--images', 'ollama',
    ],
    stdin: `${JSON.stringify({ services: { ollama: { image: CANDIDATE_IMAGE } } })}\n`,
  }]);
});

test('Compose digest validation fails closed on command failure or mismatched resolution without stderr leakage', async () => {
  await assert.rejects(
    () => validateComposeDigestOverride({
      async exec() {
        return { stdout: '', stderr: 'secret=COMPOSE-PIN-SECRET', exitCode: 1 };
      },
    }, context, CANDIDATE_IMAGE),
    (error) => {
      assert(error instanceof ComposeIntentError);
      assert.equal(error.code, 'COMPOSE_PIN_VALIDATION_FAILED');
      assert.equal(error.message.includes('COMPOSE-PIN-SECRET'), false);
      return true;
    },
  );

  await assert.rejects(
    () => validateComposeDigestOverride({
      async exec() {
        return { stdout: `ollama/ollama@${OTHER_DIGEST}\n`, stderr: '', exitCode: 0 };
      },
    }, context, CANDIDATE_IMAGE),
    (error) => error instanceof ComposeIntentError && error.code === 'COMPOSE_PIN_MISMATCH',
  );
});
