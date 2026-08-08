import assert from 'node:assert/strict';
import test from 'node:test';
import { discoverOllamaContainers } from '../dist/index.js';

function success(stdout = '') {
  return { stdout, stderr: '', exitCode: 0 };
}

function executorFor(rows, inspections = {}) {
  const calls = [];
  return {
    calls,
    executor: {
      async exec(argv) {
        calls.push([...argv]);
        if (argv[0] !== 'docker') throw new Error('unexpected command');
        if (argv[1] === 'version') return success('0.32.5\n');
        if (argv[1] === 'ps') return success(rows.map((row) => JSON.stringify(row)).join('\n'));
        if (argv[1] === 'inspect') return success(JSON.stringify([inspections[argv[2]]]));
        throw new Error(`unexpected docker argv: ${argv.join(' ')}`);
      },
    },
  };
}

const ollamaInspect = {
  Config: {
    Image: 'ollama/ollama:latest',
    Env: ['OLLAMA_HOST=0.0.0.0:11434'],
    Labels: { 'com.docker.compose.service': 'ollama' },
  },
  State: { Running: true },
  Mounts: [{ Source: '/srv/ollama', Destination: '/root/.ollama', Type: 'bind' }],
  HostConfig: { PortBindings: { '11434/tcp': [{ HostIp: '127.0.0.1', HostPort: '11434' }] } },
};

test('discovery uses only docker version, ps and inspect and recommends a unique strongest candidate', async () => {
  const fixture = executorFor([
    { ID: 'ollama-id', Names: 'ollama', Image: 'ollama/ollama:latest', State: 'running', Status: 'Up', Ports: '127.0.0.1:11434->11434/tcp', Labels: 'com.docker.compose.service=ollama' },
    { ID: 'other-id', Names: 'database', Image: 'mariadb:11', State: 'running', Status: 'Up', Ports: '3306/tcp', Labels: '' },
  ], { 'ollama-id': ollamaInspect });

  const result = await discoverOllamaContainers(fixture.executor);
  assert.equal(result.dockerVersion, '0.32.5');
  assert.equal(result.candidates.length, 1);
  assert.equal(result.recommendedContainerId, 'ollama-id');
  assert.equal(result.ambiguous, false);
  assert.equal(result.candidates[0].inspect.running, true);
  assert.deepEqual(fixture.calls.map((argv) => argv.slice(0, 2)), [
    ['docker', 'version'],
    ['docker', 'ps'],
    ['docker', 'inspect'],
  ]);
  assert.equal(fixture.calls.some((argv) => ['start', 'stop', 'restart', 'rm', 'update', 'pull'].includes(argv[1])), false);
});

test('equally strong Ollama candidates remain ambiguous until explicit selection', async () => {
  const rows = [
    { ID: 'a', Names: 'ollama-a', Image: 'ollama/ollama:latest', State: 'running', Status: 'Up', Ports: '11434/tcp', Labels: '' },
    { ID: 'b', Names: 'ollama-b', Image: 'ollama/ollama:latest', State: 'exited', Status: 'Exited', Ports: '11434/tcp', Labels: '' },
  ];
  const fixture = executorFor(rows, { a: ollamaInspect, b: { ...ollamaInspect, State: { Running: false } } });
  const result = await discoverOllamaContainers(fixture.executor);
  assert.equal(result.candidates.length, 2);
  assert.equal(result.recommendedContainerId, null);
  assert.equal(result.ambiguous, true);
});

test('zero scored candidates returns an empty discovery result', async () => {
  const fixture = executorFor([
    { ID: 'db', Names: 'db', Image: 'postgres:18', State: 'running', Status: 'Up', Ports: '5432/tcp', Labels: '' },
  ]);
  const result = await discoverOllamaContainers(fixture.executor);
  assert.deepEqual(result.candidates, []);
  assert.equal(result.recommendedContainerId, null);
});
