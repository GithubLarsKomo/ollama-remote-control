import assert from 'node:assert/strict';
import test from 'node:test';
import {
  analyzeStandaloneReconstruction,
  composeContextFromInspect,
  DockerReconstructError,
  validateComposeStrategy,
} from '../dist/reconstruct.js';

function composeInspect(labels = {}) {
  return {
    Config: {
      Labels: {
        'com.docker.compose.project': 'orc-stack',
        'com.docker.compose.service': 'ollama',
        'com.docker.compose.project.config_files': 'compose.yml,/srv/orc/override.yml',
        'com.docker.compose.project.working_dir': '/srv/orc',
        ...labels,
      },
    },
  };
}

test('Compose context comes only from snapshot labels and normalizes config paths', () => {
  assert.deepEqual(composeContextFromInspect(composeInspect()), {
    projectName: 'orc-stack',
    service: 'ollama',
    workingDirectory: '/srv/orc',
    configFiles: ['/srv/orc/compose.yml', '/srv/orc/override.yml'],
    environmentFiles: [],
  });
  assert.equal(composeContextFromInspect({ Config: { Labels: {} } }), null);
  assert.throws(
    () => composeContextFromInspect({ Config: { Labels: { 'com.docker.compose.project': 'partial' } } }),
    (error) => error instanceof DockerReconstructError && error.code === 'COMPOSE_CONTEXT_INVALID',
  );
});

test('Compose strategy uses exact read-only argv and verifies the persisted container identity', async () => {
  const context = composeContextFromInspect({
    Config: {
      Labels: {
        'com.docker.compose.project': 'orc-stack',
        'com.docker.compose.service': 'ollama',
        'com.docker.compose.project.config_files': '/srv/orc/compose.yml',
        'com.docker.compose.project.working_dir': '/srv/orc',
      },
    },
  });
  const calls = [];
  const result = await validateComposeStrategy({
    async exec(argv) {
      calls.push([...argv]);
      if (argv[2] === 'version') return { stdout: '2.40.3\n', stderr: '', exitCode: 0 };
      if (argv.includes('config')) return { stdout: 'ollama\ndatabase\n', stderr: '', exitCode: 0 };
      if (argv.includes('ps')) return { stdout: 'ollama-container-id\n', stderr: '', exitCode: 0 };
      throw new Error(`unexpected command: ${argv.join(' ')}`);
    },
  }, context, 'ollama-container-id');

  assert.equal(result.type, 'compose');
  assert.equal(result.executable, true);
  assert.equal(result.containerId, 'ollama-container-id');
  assert.deepEqual(calls, [
    ['docker', 'compose', 'version', '--short'],
    ['docker', 'compose', '-p', 'orc-stack', '--project-directory', '/srv/orc', '-f', '/srv/orc/compose.yml', 'config', '--services'],
    ['docker', 'compose', '-p', 'orc-stack', '--project-directory', '/srv/orc', '-f', '/srv/orc/compose.yml', 'ps', '--all', '-q', 'ollama'],
  ]);
});

test('Compose validation fails safely for unavailable CLI and container mismatch', async () => {
  const context = composeContextFromInspect({
    Config: {
      Labels: {
        'com.docker.compose.project': 'orc-stack',
        'com.docker.compose.service': 'ollama',
        'com.docker.compose.project.config_files': '/srv/orc/compose.yml',
        'com.docker.compose.project.working_dir': '/srv/orc',
      },
    },
  });
  await assert.rejects(
    () => validateComposeStrategy({
      async exec() { return { stdout: '', stderr: 'secret=COMPOSE-SECRET', exitCode: 1 }; },
    }, context, 'ollama-container-id'),
    (error) => {
      assert(error instanceof DockerReconstructError);
      assert.equal(error.code, 'COMPOSE_UNAVAILABLE');
      assert.equal(error.message.includes('COMPOSE-SECRET'), false);
      return true;
    },
  );

  let call = 0;
  await assert.rejects(
    () => validateComposeStrategy({
      async exec() {
        call += 1;
        if (call === 1) return { stdout: '2.40.3\n', stderr: '', exitCode: 0 };
        if (call === 2) return { stdout: 'ollama\n', stderr: '', exitCode: 0 };
        return { stdout: 'other-container\n', stderr: '', exitCode: 0 };
      },
    }, context, 'ollama-container-id'),
    (error) => error instanceof DockerReconstructError && error.code === 'COMPOSE_CONTEXT_MISMATCH',
  );
});

test('standalone analyzer permits simple Ollama config but enumerates unsupported high-impact settings', () => {
  const simple = analyzeStandaloneReconstruction({
    Config: {
      Env: ['OLLAMA_HOST=0.0.0.0:11434'],
      Labels: { purpose: 'ollama' },
      Cmd: ['serve'],
      Entrypoint: null,
    },
    HostConfig: {
      PortBindings: { '11434/tcp': [{ HostIp: '127.0.0.1', HostPort: '11434' }] },
      RestartPolicy: { Name: 'unless-stopped' },
      NetworkMode: 'bridge',
    },
    Mounts: [{ Type: 'bind', Source: '/srv/ollama', Destination: '/root/.ollama' }],
    NetworkSettings: { Networks: { bridge: {} } },
  });
  assert.equal(simple.type, 'standalone');
  assert.equal(simple.executable, true);
  assert.deepEqual(simple.unsupportedFields, []);
  assert.equal(simple.summary.environmentCount, 1);
  assert.equal(simple.summary.mountCount, 1);

  const blocked = analyzeStandaloneReconstruction({
    Config: { Env: ['OLLAMA_API_KEY=must-not-leak'] },
    HostConfig: {
      Privileged: true,
      DeviceRequests: [{ Driver: 'nvidia', Count: -1 }],
      CapAdd: ['SYS_ADMIN'],
    },
    Mounts: [{ Type: 'tmpfs', Destination: '/tmp' }],
    NetworkSettings: { Networks: { first: {}, second: {} } },
  });
  assert.equal(blocked.executable, false);
  assert.deepEqual(blocked.unsupportedFields, [
    'HostConfig.CapAdd',
    'HostConfig.DeviceRequests',
    'HostConfig.Privileged',
    'Mounts.type:tmpfs',
    'NetworkSettings.Networks.multiple',
  ]);
  assert.equal(JSON.stringify(blocked).includes('must-not-leak'), false);
});
