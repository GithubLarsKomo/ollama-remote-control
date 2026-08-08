import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DockerRegistryError,
  inspectDockerRegistryCandidate,
} from '../dist/registry.js';

const PLATFORM = { os: 'linux', architecture: 'amd64', variant: null };

function manifest(candidateDigest = 'sha256:candidate-digest') {
  return JSON.stringify({
    schemaVersion: 2,
    mediaType: 'application/vnd.oci.image.index.v1+json',
    digest: 'sha256:index-digest',
    manifests: [
      { digest: candidateDigest, platform: { os: 'linux', architecture: 'amd64' } },
      { digest: 'sha256:arm64-digest', platform: { os: 'linux', architecture: 'arm64' } },
    ],
  });
}

const IMAGE = JSON.stringify({
  architecture: 'amd64',
  os: 'linux',
  config: { Labels: { 'org.opencontainers.image.version': '0.33.0' } },
});

test('registry inspection selects the matching platform digest and validates its image config', async () => {
  const calls = [];
  const result = await inspectDockerRegistryCandidate({
    async exec(argv) {
      calls.push([...argv]);
      if (argv[1] === 'buildx' && argv[2] === 'version') return { stdout: 'buildx v0.30.1\n', stderr: '', exitCode: 0 };
      if (argv.includes('{{json .Manifest}}')) return { stdout: manifest(), stderr: '', exitCode: 0 };
      if (argv.includes('{{json .Image}}')) return { stdout: IMAGE, stderr: '', exitCode: 0 };
      throw new Error(`unexpected command: ${argv.join(' ')}`);
    },
  }, 'ollama/ollama:latest', PLATFORM);

  assert.equal(result.indexDigest, 'sha256:index-digest');
  assert.equal(result.platformDigest, 'sha256:candidate-digest');
  assert.deepEqual(result.platform, PLATFORM);
  assert.equal(result.version, '0.33.0');
  assert.deepEqual(calls, [
    ['docker', 'buildx', 'version'],
    ['docker', 'buildx', 'imagetools', 'inspect', 'ollama/ollama:latest', '--format', '{{json .Manifest}}'],
    ['docker', 'buildx', 'imagetools', 'inspect', 'ollama/ollama@sha256:candidate-digest', '--format', '{{json .Image}}'],
  ]);
});

test('registry inspection rejects missing platform instead of comparing the index digest', async () => {
  await assert.rejects(
    () => inspectDockerRegistryCandidate({
      async exec(argv) {
        if (argv[2] === 'version') return { stdout: 'buildx\n', stderr: '', exitCode: 0 };
        return {
          stdout: JSON.stringify({
            schemaVersion: 2,
            digest: 'sha256:index-digest',
            manifests: [{ digest: 'sha256:arm64', platform: { os: 'linux', architecture: 'arm64' } }],
          }),
          stderr: '',
          exitCode: 0,
        };
      },
    }, 'ollama/ollama:latest', PLATFORM),
    (error) => error instanceof DockerRegistryError && error.code === 'IMAGE_PLATFORM_NOT_FOUND',
  );
});

test('registry inspection classifies missing Buildx and registry errors without stderr leakage', async () => {
  await assert.rejects(
    () => inspectDockerRegistryCandidate({
      async exec() { return { stdout: '', stderr: 'secret=BUILDX-SECRET', exitCode: 1 }; },
    }, 'ollama/ollama:latest', PLATFORM),
    (error) => {
      assert(error instanceof DockerRegistryError);
      assert.equal(error.code, 'REGISTRY_LOOKUP_UNAVAILABLE');
      assert.equal(error.message.includes('BUILDX-SECRET'), false);
      return true;
    },
  );

  let call = 0;
  await assert.rejects(
    () => inspectDockerRegistryCandidate({
      async exec() {
        call += 1;
        return call === 1
          ? { stdout: 'buildx\n', stderr: '', exitCode: 0 }
          : { stdout: '', stderr: 'token=REGISTRY-SECRET', exitCode: 1 };
      },
    }, 'ollama/ollama:latest', PLATFORM),
    (error) => {
      assert(error instanceof DockerRegistryError);
      assert.equal(error.code, 'IMAGE_REGISTRY_LOOKUP_FAILED');
      assert.equal(error.message.includes('REGISTRY-SECRET'), false);
      return true;
    },
  );
});
