import assert from 'node:assert/strict';
import test from 'node:test';
import {
  captureDockerRollbackState,
  DockerPreflightError,
} from '../dist/index.js';

function containerInspect(running = true) {
  return JSON.stringify([{
    Id: 'ollama-container-id',
    Name: '/ollama',
    Image: 'sha256:image-current',
    Config: {
      Image: 'ollama/ollama:latest',
      Env: ['OLLAMA_API_KEY=top-secret'],
      Labels: {
        'com.docker.compose.project': 'orc-stack',
        'com.docker.compose.service': 'ollama',
        'com.docker.compose.project.config_files': '/srv/orc/compose.yml',
        'com.docker.compose.project.working_dir': '/srv/orc',
      },
    },
    State: { Running: running },
    Mounts: [{ Source: '/srv/ollama', Destination: '/root/.ollama', Type: 'bind' }],
    HostConfig: {
      PortBindings: { '11434/tcp': [{ HostIp: '127.0.0.1', HostPort: '11434' }] },
      RestartPolicy: { Name: 'unless-stopped' },
      DeviceRequests: [{ Driver: 'nvidia', Count: -1 }],
    },
    NetworkSettings: { Networks: { orc_default: {} } },
  }]);
}

const IMAGE_INSPECT = JSON.stringify([{
  Id: 'sha256:image-current',
  RepoDigests: ['ollama/ollama@sha256:current-digest'],
}]);

test('captureDockerRollbackState uses read-only inspect/version commands and separates public metadata from raw secrets', async () => {
  const calls = [];
  const capture = await captureDockerRollbackState({
    async exec(argv) {
      calls.push([...argv]);
      if (argv[1] === 'inspect') return { stdout: containerInspect(true), stderr: '', exitCode: 0 };
      if (argv[1] === 'image') return { stdout: IMAGE_INSPECT, stderr: '', exitCode: 0 };
      if (argv[1] === 'exec') return { stdout: 'ollama version is 0.32.5\n', stderr: '', exitCode: 0 };
      throw new Error(`unexpected command: ${argv.join(' ')}`);
    },
  }, 'ollama-container-id');

  assert.deepEqual(calls, [
    ['docker', 'inspect', 'ollama-container-id'],
    ['docker', 'image', 'inspect', 'ollama/ollama:latest'],
    ['docker', 'exec', 'ollama-container-id', 'ollama', '--version'],
  ]);
  assert.equal(capture.metadata.imageReference, 'ollama/ollama:latest');
  assert.equal(capture.metadata.imageId, 'sha256:image-current');
  assert.deepEqual(capture.metadata.repoDigests, ['ollama/ollama@sha256:current-digest']);
  assert.equal(capture.metadata.restartPolicy, 'unless-stopped');
  assert.deepEqual(capture.metadata.networkNames, ['orc_default']);
  assert.equal(capture.metadata.gpuDeviceRequestCount, 1);
  assert.equal(capture.metadata.ollamaVersion, 'ollama version is 0.32.5');
  assert.deepEqual(capture.metadata.compose, {
    managed: true,
    project: 'orc-stack',
    service: 'ollama',
    configFiles: '/srv/orc/compose.yml',
    workingDir: '/srv/orc',
  });
  assert.equal(JSON.stringify(capture.metadata).includes('top-secret'), false);
  assert.equal(capture.rawPayloadJson.includes('OLLAMA_API_KEY=top-secret'), true);
});

test('stopped container preflight never starts the container or executes Ollama CLI', async () => {
  const calls = [];
  const capture = await captureDockerRollbackState({
    async exec(argv) {
      calls.push([...argv]);
      if (argv[1] === 'inspect') return { stdout: containerInspect(false), stderr: '', exitCode: 0 };
      if (argv[1] === 'image') return { stdout: IMAGE_INSPECT, stderr: '', exitCode: 0 };
      throw new Error(`unexpected command: ${argv.join(' ')}`);
    },
  }, 'ollama-container-id');

  assert.equal(capture.metadata.running, false);
  assert.equal(capture.metadata.ollamaVersion, null);
  assert.deepEqual(calls, [
    ['docker', 'inspect', 'ollama-container-id'],
    ['docker', 'image', 'inspect', 'ollama/ollama:latest'],
  ]);
});

test('running preflight fails closed when Ollama version cannot be captured', async () => {
  await assert.rejects(
    () => captureDockerRollbackState({
      async exec(argv) {
        if (argv[1] === 'inspect') return { stdout: containerInspect(true), stderr: '', exitCode: 0 };
        if (argv[1] === 'image') return { stdout: IMAGE_INSPECT, stderr: '', exitCode: 0 };
        return { stdout: '', stderr: 'secret remote detail', exitCode: 1 };
      },
    }, 'ollama-container-id'),
    (error) => {
      assert(error instanceof DockerPreflightError);
      assert.equal(error.code, 'OLLAMA_CLI_ERROR');
      assert.equal(error.message.includes('secret remote detail'), false);
      return true;
    },
  );
});
