import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DockerDiscoveryError,
  inspectDockerContainer,
} from '../dist/index.js';

const inspectFixture = [{
  Id: 'container-id',
  Name: '/ollama',
  RestartCount: 2,
  Config: {
    Image: 'ollama/ollama:latest',
    Env: ['OLLAMA_HOST=0.0.0.0:11434', 'OLLAMA_API_KEY=top-secret'],
    Labels: { 'com.docker.compose.service': 'ollama' },
  },
  State: {
    Running: true,
    Status: 'running',
    StartedAt: '2026-08-08T06:00:00.000000000Z',
    OOMKilled: false,
    Health: { Status: 'healthy' },
  },
  Mounts: [{ Source: '/srv/ollama', Destination: '/root/.ollama', Type: 'bind' }],
  HostConfig: {
    PortBindings: { '11434/tcp': [{ HostIp: '127.0.0.1', HostPort: '11434' }] },
  },
}];

test('inspectDockerContainer exposes read-only runtime state from docker inspect', async () => {
  const calls = [];
  const snapshot = await inspectDockerContainer({
    async exec(argv) {
      calls.push([...argv]);
      return { stdout: JSON.stringify(inspectFixture), stderr: '', exitCode: 0 };
    },
  }, 'container-id');

  assert.deepEqual(calls, [['docker', 'inspect', 'container-id']]);
  assert.equal(snapshot.id, 'container-id');
  assert.equal(snapshot.name, 'ollama');
  assert.equal(snapshot.image, 'ollama/ollama:latest');
  assert.equal(snapshot.running, true);
  assert.equal(snapshot.state, 'running');
  assert.equal(snapshot.status, 'healthy');
  assert.equal(snapshot.restartCount, 2);
  assert.equal(snapshot.oomKilled, false);
  assert.equal(snapshot.mounts[0].destination, '/root/.ollama');
});

test('inspectDockerContainer maps a missing persisted container explicitly', async () => {
  await assert.rejects(
    () => inspectDockerContainer({
      async exec() {
        return { stdout: '', stderr: 'Error: No such object: missing-id', exitCode: 1 };
      },
    }, 'missing-id'),
    (error) => error instanceof DockerDiscoveryError && error.code === 'CONTAINER_NOT_FOUND',
  );
});
