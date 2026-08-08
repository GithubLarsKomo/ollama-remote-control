import assert from 'node:assert/strict';
import test from 'node:test';
import {
  resolveCurrentImageDigest,
  UpdatePlanError,
} from '../dist/update-plan.js';

test('current digest resolution preserves digest pins and normalizes Docker Hub repository aliases', () => {
  assert.deepEqual(
    resolveCurrentImageDigest('ollama/ollama@sha256:pinned', []),
    { pinned: true, digest: 'sha256:pinned' },
  );
  assert.deepEqual(
    resolveCurrentImageDigest('ollama/ollama:latest', ['docker.io/ollama/ollama@sha256:current']),
    { pinned: false, digest: 'sha256:current' },
  );
  assert.deepEqual(
    resolveCurrentImageDigest('ubuntu:24.04', ['docker.io/library/ubuntu@sha256:ubuntu-current']),
    { pinned: false, digest: 'sha256:ubuntu-current' },
  );
});

test('current digest resolution fails closed when configured repository digest is absent or ambiguous', () => {
  assert.throws(
    () => resolveCurrentImageDigest('ollama/ollama:latest', []),
    (error) => error instanceof UpdatePlanError && error.code === 'CURRENT_IMAGE_DIGEST_UNAVAILABLE',
  );
  assert.throws(
    () => resolveCurrentImageDigest('ollama/ollama:latest', [
      'ollama/ollama@sha256:first',
      'docker.io/ollama/ollama@sha256:second',
    ]),
    (error) => error instanceof UpdatePlanError && error.code === 'CURRENT_IMAGE_DIGEST_UNAVAILABLE',
  );
});
