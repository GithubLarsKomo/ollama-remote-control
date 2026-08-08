import assert from 'node:assert/strict';
import test from 'node:test';
import { DockerDiscoveryError } from '@orc/docker';
import { safeDockerDiscoveryError } from '../dist/targets.js';

const SECRET = 'REMOTE-DOCKER-SECRET-SENTINEL';

test('Docker discovery errors preserve classification without exposing remote stderr', () => {
  const cases = [
    {
      source: new DockerDiscoveryError('DOCKER_UNAVAILABLE', `docker ps failed token=${SECRET}`),
      statusCode: 502,
      message: 'Docker is unavailable on the remote host.',
    },
    {
      source: new DockerDiscoveryError('DOCKER_OUTPUT_INVALID', `invalid output ${SECRET}`),
      statusCode: 502,
      message: 'Docker discovery returned invalid data.',
    },
    {
      source: new DockerDiscoveryError('CONTAINER_NOT_FOUND', `missing container ${SECRET}`),
      statusCode: 404,
      message: 'Docker container was not found during discovery.',
    },
  ];

  for (const expectation of cases) {
    const error = safeDockerDiscoveryError(expectation.source);
    assert.equal(error.code, expectation.source.code);
    assert.equal(error.statusCode, expectation.statusCode);
    assert.equal(error.message, expectation.message);
    assert.equal(error.message.includes(SECRET), false);
    assert.equal(error.cause, expectation.source);
  }
});
