import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ComposeReplacementError,
  replaceComposeServiceImage,
} from '../dist/compose-replacement.js';

const CANDIDATE_DIGEST = `sha256:${'a'.repeat(64)}`;
const ROLLBACK_DIGEST = `sha256:${'b'.repeat(64)}`;
const CANDIDATE_REF = `ollama/ollama@${CANDIDATE_DIGEST}`;
const ROLLBACK_REF = `ollama/ollama@${ROLLBACK_DIGEST}`;
const CANDIDATE_IMAGE_ID = `sha256:${'c'.repeat(64)}`;
const ROLLBACK_IMAGE_ID = `sha256:${'d'.repeat(64)}`;

const context = {
  projectName: 'orc-stack',
  service: 'ollama',
  workingDirectory: '/srv/orc',
  configFiles: ['/srv/orc/compose.yml'],
  environmentFiles: [],
};

function override(reference) {
  return `${JSON.stringify({ services: { ollama: { image: reference } } })}\n`;
}

function imageInspect(reference, imageId) {
  return JSON.stringify([{
    Id: imageId,
    RepoDigests: [`docker.io/${reference}`],
  }]);
}

function containerInspect(containerId, reference, imageId, running = true) {
  return JSON.stringify([{
    Id: containerId,
    Image: imageId,
    Config: { Image: `docker.io/${reference}` },
    State: { Running: running },
  }]);
}

function successExecutor({ reference, imageId, previousId, nextId, source }) {
  const calls = [];
  return {
    calls,
    async exec(argv, stdin) {
      calls.push({ argv: [...argv], stdin });
      const command = argv.join(' ');
      if (command.endsWith('config --images ollama')) {
        return { stdout: `docker.io/${reference}\n`, stderr: '', exitCode: 0 };
      }
      if (argv[0] === 'docker' && argv[1] === 'image' && argv[2] === 'pull') {
        assert.equal(source, 'pull-exact');
        assert.equal(argv[3], reference);
        return { stdout: 'pull output is intentionally ignored', stderr: '', exitCode: 0 };
      }
      if (argv[0] === 'docker' && argv[1] === 'image' && argv[2] === 'inspect') {
        assert.equal(argv[3], reference);
        return { stdout: imageInspect(reference, imageId), stderr: '', exitCode: 0 };
      }
      if (command.includes(' up -d --no-deps --force-recreate --pull never --no-build ollama')) {
        assert.equal(stdin, override(reference));
        return { stdout: 'compose output ignored', stderr: '', exitCode: 0 };
      }
      if (command.endsWith('ps --all -q ollama')) {
        return { stdout: `${nextId}\n`, stderr: '', exitCode: 0 };
      }
      if (argv[0] === 'docker' && argv[1] === 'inspect') {
        assert.equal(argv[2], nextId);
        return { stdout: containerInspect(nextId, reference, imageId), stderr: '', exitCode: 0 };
      }
      throw new Error(`unexpected command after ${previousId}: ${command}`);
    },
  };
}

test('forward replacement uses exact pull then one-service no-deps forced recreate and verifies new image/container', async () => {
  const executor = successExecutor({
    reference: CANDIDATE_REF,
    imageId: CANDIDATE_IMAGE_ID,
    previousId: 'old-container-id',
    nextId: 'candidate-container-id',
    source: 'pull-exact',
  });
  const result = await replaceComposeServiceImage(
    executor,
    context,
    CANDIDATE_REF,
    'old-container-id',
    'pull-exact',
  );

  assert.deepEqual(result, {
    source: 'pull-exact',
    exactImageReference: CANDIDATE_REF,
    imageId: CANDIDATE_IMAGE_ID,
    previousContainerId: 'old-container-id',
    containerId: 'candidate-container-id',
  });
  assert.deepEqual(executor.calls.map((call) => call.argv), [
    ['docker', 'compose', '-p', 'orc-stack', '--project-directory', '/srv/orc', '-f', '/srv/orc/compose.yml', '-f', '-', 'config', '--images', 'ollama'],
    ['docker', 'image', 'pull', CANDIDATE_REF],
    ['docker', 'image', 'inspect', CANDIDATE_REF],
    ['docker', 'compose', '-p', 'orc-stack', '--project-directory', '/srv/orc', '-f', '/srv/orc/compose.yml', '-f', '-', 'up', '-d', '--no-deps', '--force-recreate', '--pull', 'never', '--no-build', 'ollama'],
    ['docker', 'compose', '-p', 'orc-stack', '--project-directory', '/srv/orc', '-f', '/srv/orc/compose.yml', 'ps', '--all', '-q', 'ollama'],
    ['docker', 'inspect', 'candidate-container-id'],
  ]);
  assert.equal(executor.calls[0].stdin, override(CANDIDATE_REF));
  assert.equal(executor.calls[3].stdin, override(CANDIDATE_REF));
});

test('rollback replacement is local-only and never pulls from registry', async () => {
  const executor = successExecutor({
    reference: ROLLBACK_REF,
    imageId: ROLLBACK_IMAGE_ID,
    previousId: 'candidate-container-id',
    nextId: 'rollback-container-id',
    source: 'local-only',
  });
  const result = await replaceComposeServiceImage(
    executor,
    context,
    ROLLBACK_REF,
    'candidate-container-id',
    'local-only',
  );
  assert.equal(result.containerId, 'rollback-container-id');
  assert.equal(result.source, 'local-only');
  assert.equal(executor.calls.some((call) => call.argv[1] === 'image' && call.argv[2] === 'pull'), false);
  assert.deepEqual(executor.calls[1].argv, ['docker', 'image', 'inspect', ROLLBACK_REF]);
});

test('replacement validates identifiers and exact digest reference before any remote command', async () => {
  let calls = 0;
  const executor = { async exec() { calls += 1; throw new Error('must not execute'); } };
  await assert.rejects(
    () => replaceComposeServiceImage(executor, context, 'ollama/ollama:latest', 'old-container-id', 'pull-exact'),
    (error) => error instanceof ComposeReplacementError && error.code === 'INVALID_IMAGE_REFERENCE',
  );
  await assert.rejects(
    () => replaceComposeServiceImage(executor, context, CANDIDATE_REF, 'bad container;id', 'pull-exact'),
    (error) => error instanceof ComposeReplacementError && error.code === 'INVALID_CONTAINER_ID',
  );
  assert.equal(calls, 0);
});

test('replacement fails closed on pull/local-image failures without stderr leakage', async () => {
  const cases = [
    {
      source: 'pull-exact',
      expected: 'IMAGE_PULL_FAILED',
      executor: {
        async exec(argv) {
          if (argv.at(-3) === 'config') return { stdout: `${CANDIDATE_REF}\n`, stderr: '', exitCode: 0 };
          if (argv[1] === 'image' && argv[2] === 'pull') return { stdout: '', stderr: 'token=REGISTRY-SECRET', exitCode: 1 };
          throw new Error(`unexpected ${argv.join(' ')}`);
        },
      },
    },
    {
      source: 'local-only',
      expected: 'IMAGE_NOT_AVAILABLE',
      executor: {
        async exec(argv) {
          if (argv.at(-3) === 'config') return { stdout: `${CANDIDATE_REF}\n`, stderr: '', exitCode: 0 };
          if (argv[1] === 'image' && argv[2] === 'inspect') return { stdout: '', stderr: 'local-secret', exitCode: 1 };
          throw new Error(`unexpected ${argv.join(' ')}`);
        },
      },
    },
  ];
  for (const item of cases) {
    await assert.rejects(
      () => replaceComposeServiceImage(item.executor, context, CANDIDATE_REF, 'old-container-id', item.source),
      (error) => {
        assert(error instanceof ComposeReplacementError);
        assert.equal(error.code, item.expected);
        assert.equal(error.message.includes('SECRET'), false);
        assert.equal(error.message.includes('local-secret'), false);
        return true;
      },
    );
  }
});

test('replacement rejects unchanged/ambiguous/stopped/wrong-image outcomes after recreate', async () => {
  const scenarios = [
    ['same-id', 'COMPOSE_CONTAINER_NOT_RECREATED'],
    ['multiple', 'COMPOSE_SERVICE_AMBIGUOUS'],
    ['stopped', 'REPLACEMENT_NOT_RUNNING'],
    ['wrong-image', 'REPLACEMENT_IMAGE_MISMATCH'],
  ];
  for (const [scenario, expectedCode] of scenarios) {
    const executor = {
      async exec(argv, stdin) {
        const command = argv.join(' ');
        if (command.endsWith('config --images ollama')) return { stdout: `${CANDIDATE_REF}\n`, stderr: '', exitCode: 0 };
        if (argv[1] === 'image' && argv[2] === 'pull') return { stdout: '', stderr: '', exitCode: 0 };
        if (argv[1] === 'image' && argv[2] === 'inspect') return { stdout: imageInspect(CANDIDATE_REF, CANDIDATE_IMAGE_ID), stderr: '', exitCode: 0 };
        if (command.includes(' up -d ')) { assert.equal(stdin, override(CANDIDATE_REF)); return { stdout: '', stderr: '', exitCode: 0 }; }
        if (command.endsWith('ps --all -q ollama')) {
          if (scenario === 'same-id') return { stdout: 'old-container-id\n', stderr: '', exitCode: 0 };
          if (scenario === 'multiple') return { stdout: 'one-container\ntwo-container\n', stderr: '', exitCode: 0 };
          return { stdout: 'new-container-id\n', stderr: '', exitCode: 0 };
        }
        if (argv[1] === 'inspect') {
          if (scenario === 'stopped') return { stdout: containerInspect('new-container-id', CANDIDATE_REF, CANDIDATE_IMAGE_ID, false), stderr: '', exitCode: 0 };
          return { stdout: containerInspect('new-container-id', CANDIDATE_REF, `sha256:${'e'.repeat(64)}`, true), stderr: '', exitCode: 0 };
        }
        throw new Error(`unexpected ${command}`);
      },
    };
    await assert.rejects(
      () => replaceComposeServiceImage(executor, context, CANDIDATE_REF, 'old-container-id', 'pull-exact'),
      (error) => error instanceof ComposeReplacementError && error.code === expectedCode,
    );
  }
});
