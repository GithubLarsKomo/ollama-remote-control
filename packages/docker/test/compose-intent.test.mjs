import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ComposeIntentError,
  composeDigestOverrideJson,
  exactDigestImageReference,
  validateComposeDigestOverride,
} from '../dist/compose-intent.js';

const context = {
  projectName: 'orc-stack',
  service: 'ollama',
  workingDirectory: '/srv/orc',
  configFiles: ['/srv/orc/compose.yml'],
  environmentFiles: [],
};

test('exact digest reference removes mutable tag and preserves repository spelling', () => {
  assert.equal(
    exactDigestImageReference('ollama/ollama:latest', 'sha256:candidate-digest'),
    'ollama/ollama@sha256:candidate-digest',
  );
  assert.equal(
    exactDigestImageReference('registry.example:5000/team/ollama:v1', 'SHA256:ABC_def-1234567890'),
    'registry.example:5000/team/ollama@sha256:abc_def-1234567890',
  );
  assert.throws(
    () => exactDigestImageReference('ollama/ollama:latest', 'not-a-digest'),
    (error) => error instanceof ComposeIntentError && error.code === 'INVALID_IMAGE_DIGEST',
  );
});

test('Compose override is generated as JSON without interpolating YAML or shell syntax', () => {
  const value = composeDigestOverrideJson(
    'ollama-service',
    'ollama/ollama@sha256:candidate-digest',
  );
  assert.deepEqual(JSON.parse(value), {
    services: { 'ollama-service': { image: 'ollama/ollama@sha256:candidate-digest' } },
  });
  assert.equal(value.includes(';'), false);
});

test('Compose digest validation sends exact read-only argv and override through stdin', async () => {
  const calls = [];
  const result = await validateComposeDigestOverride({
    async exec(argv, stdin) {
      calls.push({ argv: [...argv], stdin });
      return {
        stdout: 'docker.io/ollama/ollama@sha256:candidate-digest\n',
        stderr: '',
        exitCode: 0,
      };
    },
  }, context, 'ollama/ollama@sha256:candidate-digest');

  assert.equal(result.exactImageReference, 'ollama/ollama@sha256:candidate-digest');
  assert.deepEqual(calls, [{
    argv: [
      'docker', 'compose', '-p', 'orc-stack', '--project-directory', '/srv/orc',
      '-f', '/srv/orc/compose.yml', '-f', '-', 'config', '--images', 'ollama',
    ],
    stdin: '{"services":{"ollama":{"image":"ollama/ollama@sha256:candidate-digest"}}}\n',
  }]);
});

test('Compose digest validation fails closed on command failure or mismatched resolution without stderr leakage', async () => {
  await assert.rejects(
    () => validateComposeDigestOverride({
      async exec() {
        return { stdout: '', stderr: 'secret=COMPOSE-PIN-SECRET', exitCode: 1 };
      },
    }, context, 'ollama/ollama@sha256:candidate-digest'),
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
        return { stdout: 'ollama/ollama@sha256:different-digest\n', stderr: '', exitCode: 0 };
      },
    }, context, 'ollama/ollama@sha256:candidate-digest'),
    (error) => error instanceof ComposeIntentError && error.code === 'COMPOSE_PIN_MISMATCH',
  );
});
