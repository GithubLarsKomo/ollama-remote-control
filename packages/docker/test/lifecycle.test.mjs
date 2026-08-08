import assert from 'node:assert/strict';
import test from 'node:test';
import {
  changeDockerContainerState,
  DockerLifecycleError,
} from '../dist/index.js';

function inspectFixture(running) {
  return JSON.stringify([{
    Id: 'container-id',
    Name: '/ollama',
    RestartCount: 2,
    Config: {
      Image: 'ollama/ollama:latest',
      Env: ['OLLAMA_API_KEY=top-secret'],
      Labels: { 'com.docker.compose.service': 'ollama' },
    },
    State: {
      Running: running,
      Status: running ? 'running' : 'exited',
      StartedAt: running ? '2026-08-08T09:00:00.000000000Z' : '2026-08-08T06:00:00.000000000Z',
      OOMKilled: false,
      Health: { Status: running ? 'healthy' : 'none' },
    },
    Mounts: [],
    HostConfig: { PortBindings: {} },
  }]);
}

for (const [action, expectedRunning] of [['start', true], ['stop', false], ['restart', true]]) {
  test(`changeDockerContainerState executes only docker ${action} and verifies the resulting state`, async () => {
    const calls = [];
    const executor = {
      async exec(argv) {
        calls.push([...argv]);
        if (argv[1] === action) return { stdout: 'container-id\n', stderr: '', exitCode: 0 };
        if (argv[1] === 'inspect') return { stdout: inspectFixture(expectedRunning), stderr: '', exitCode: 0 };
        throw new Error(`unexpected command: ${argv.join(' ')}`);
      },
    };

    const result = await changeDockerContainerState(executor, 'container-id', action);
    assert.equal(result.running, expectedRunning);
    assert.deepEqual(calls, [
      ['docker', action, 'container-id'],
      ['docker', 'inspect', 'container-id'],
    ]);
  });
}

test('changeDockerContainerState fails closed when the post-command state cannot be verified', async () => {
  const calls = [];
  await assert.rejects(
    () => changeDockerContainerState({
      async exec(argv) {
        calls.push([...argv]);
        if (argv[1] === 'stop') return { stdout: 'container-id\n', stderr: '', exitCode: 0 };
        return { stdout: inspectFixture(true), stderr: '', exitCode: 0 };
      },
    }, 'container-id', 'stop'),
    (error) => error instanceof DockerLifecycleError && error.code === 'CONTAINER_STATE_UNVERIFIED',
  );
  assert.deepEqual(calls, [
    ['docker', 'stop', 'container-id'],
    ['docker', 'inspect', 'container-id'],
  ]);
});

test('changeDockerContainerState classifies command failure without leaking remote stderr', async () => {
  await assert.rejects(
    () => changeDockerContainerState({
      async exec() {
        return { stdout: '', stderr: 'daemon rejected secret=REMOTE-TOP-SECRET', exitCode: 125 };
      },
    }, 'container-id', 'restart'),
    (error) => {
      assert(error instanceof DockerLifecycleError);
      assert.equal(error.code, 'DOCKER_UNAVAILABLE');
      assert.equal(error.exitCode, 125);
      assert.equal(error.message.includes('REMOTE-TOP-SECRET'), false);
      return true;
    },
  );
});
