import assert from 'node:assert/strict';
import test from 'node:test';
import { publicDockerDiscovery } from '../dist/public-discovery.js';

test('public Docker discovery omits environment, label values, mount sources and raw port bindings', () => {
  const result = publicDockerDiscovery({
    dockerVersion: '27.5.1',
    recommendedContainerId: 'container-1',
    ambiguous: false,
    candidates: [{
      id: 'container-1',
      name: 'ollama',
      image: 'ollama/ollama:latest',
      state: 'running',
      status: 'Up 2 hours',
      ports: '127.0.0.1:11434->11434/tcp',
      labels: 'secret.label=SECRET-LABEL-VALUE',
      score: 11,
      reasons: ['image', 'name', 'port-11434'],
      inspect: {
        image: 'ollama/ollama:latest',
        running: true,
        env: ['OLLAMA_HOST=0.0.0.0', 'SECRET_ENV=SECRET-ENV-VALUE'],
        mounts: [{ source: '/secret/host/models', destination: '/root/.ollama', type: 'bind' }],
        portBindings: { '11434/tcp': [{ HostIp: '127.0.0.1', HostPort: '11434' }] },
        labels: { 'secret.label': 'SECRET-LABEL-VALUE' },
      },
    }],
  });

  assert.deepEqual(result, {
    dockerVersion: '27.5.1',
    recommendedContainerId: 'container-1',
    ambiguous: false,
    candidates: [{
      id: 'container-1',
      name: 'ollama',
      image: 'ollama/ollama:latest',
      state: 'running',
      status: 'Up 2 hours',
      ports: '127.0.0.1:11434->11434/tcp',
      score: 11,
      reasons: ['image', 'name', 'port-11434'],
      inspect: {
        image: 'ollama/ollama:latest',
        running: true,
        mountCount: 1,
        portBindingCount: 1,
        labelCount: 1,
      },
    }],
  });
  const serialized = JSON.stringify(result);
  for (const secret of ['SECRET_ENV', 'SECRET-ENV-VALUE', 'SECRET-LABEL-VALUE', '/secret/host/models']) {
    assert.equal(serialized.includes(secret), false, secret);
  }
});
