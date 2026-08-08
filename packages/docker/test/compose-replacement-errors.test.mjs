import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ComposeReplacementError,
  replaceComposeServiceImage,
} from '../dist/compose-replacement.js';

const DIGEST = `sha256:${'a'.repeat(64)}`;
const REF = `ollama/ollama@${DIGEST}`;
const IMAGE_ID = `sha256:${'c'.repeat(64)}`;
const context = {
  projectName: 'orc-stack',
  service: 'ollama',
  workingDirectory: '/srv/orc',
  configFiles: ['/srv/orc/compose.yml'],
  environmentFiles: [],
};

function imageInspect({ repoDigest = REF, imageId = IMAGE_ID } = {}) {
  return JSON.stringify([{ Id: imageId, RepoDigests: [repoDigest] }]);
}

function replacementInspect({ running = true, imageId = IMAGE_ID, configImage = REF } = {}) {
  return JSON.stringify([{
    Id: 'new-container-id',
    Image: imageId,
    Config: { Image: configImage },
    State: { Running: running },
  }]);
}

function executorForFailure(stage) {
  return {
    async exec(argv, stdin) {
      const command = argv.join(' ');
      if (command.endsWith('config --images ollama')) {
        if (stage === 'context') return { stdout: 'other/repo@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n', stderr: 'secret=context', exitCode: 0 };
        return { stdout: `${REF}\n`, stderr: '', exitCode: 0 };
      }
      if (argv[1] === 'image' && argv[2] === 'pull') return { stdout: '', stderr: '', exitCode: 0 };
      if (argv[1] === 'image' && argv[2] === 'inspect') {
        if (stage === 'image-inspect-command') return { stdout: '', stderr: 'secret=image', exitCode: 1 };
        if (stage === 'image-inspect-json') return { stdout: '{bad-json', stderr: '', exitCode: 0 };
        if (stage === 'image-reference') return { stdout: imageInspect({ repoDigest: `ollama/ollama@sha256:${'b'.repeat(64)}` }), stderr: '', exitCode: 0 };
        return { stdout: imageInspect(), stderr: '', exitCode: 0 };
      }
      if (command.includes(' up -d ')) {
        assert(stdin);
        if (stage === 'up') return { stdout: '', stderr: 'secret=up', exitCode: 1 };
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      if (command.endsWith('ps --all -q ollama')) {
        if (stage === 'ps') return { stdout: '', stderr: 'secret=ps', exitCode: 1 };
        return { stdout: 'new-container-id\n', stderr: '', exitCode: 0 };
      }
      if (argv[1] === 'inspect') {
        if (stage === 'container-inspect-command') return { stdout: '', stderr: 'secret=inspect', exitCode: 1 };
        if (stage === 'container-inspect-json') return { stdout: 'not-json', stderr: '', exitCode: 0 };
        return { stdout: replacementInspect(), stderr: '', exitCode: 0 };
      }
      throw new Error(`unexpected command: ${command}`);
    },
  };
}

test('Compose replacement classifies each remote command/verification failure without stderr leakage', async () => {
  const cases = [
    ['context', 'COMPOSE_CONTEXT_CHANGED'],
    ['image-inspect-command', 'IMAGE_INSPECT_INVALID'],
    ['image-inspect-json', 'IMAGE_INSPECT_INVALID'],
    ['image-reference', 'IMAGE_REFERENCE_MISMATCH'],
    ['up', 'COMPOSE_RECREATE_FAILED'],
    ['ps', 'COMPOSE_SERVICE_LOOKUP_FAILED'],
    ['container-inspect-command', 'REPLACEMENT_INSPECT_FAILED'],
    ['container-inspect-json', 'REPLACEMENT_INSPECT_INVALID'],
  ];
  for (const [stage, code] of cases) {
    await assert.rejects(
      () => replaceComposeServiceImage(executorForFailure(stage), context, REF, 'old-container-id', 'pull-exact'),
      (error) => {
        assert(error instanceof ComposeReplacementError);
        assert.equal(error.code, code);
        assert.equal(error.message.includes('secret='), false);
        return true;
      },
      stage,
    );
  }
});
