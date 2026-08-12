import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

const root = new URL('../../../', import.meta.url);

function text(path) {
  return readFileSync(new URL(path, root), 'utf8');
}

function has(path) {
  return existsSync(new URL(path, root));
}

test('operator documentation reflects the current beta-candidate deployment boundary', () => {
  const readme = text('README.md');
  const deployment = text('docs/DEPLOYMENT.md');

  assert.match(readme, /0\.1 Beta Candidate/i);
  assert.match(deployment, /0\.1-beta-candidate operator contract/i);
  assert.doesNotMatch(readme, /Current vertical slice|Wave 2p1/i);
  assert.doesNotMatch(deployment, /Wave 2p1/i);

  for (const required of [
    '/data',
    'external master key',
    'HTTPS',
    'no local Docker-socket mount',
    'no Ollama port publication',
    'Docker Compose',
    'Standalone Ollama containers',
    'pre-upgrade `/data` backup',
    'same original external master key',
    'Expert Mode',
    'model deletion',
    'foundation-spike',
    'production-container',
    'beta-acceptance',
    'beta-release-candidate',
  ]) {
    assert.ok(deployment.includes(required), `deployment docs missing ${required}`);
  }

  assert.match(deployment, /Do \*\*not\*\* assume that running an older ORC image against a database already migrated by a newer image is a supported rollback/);
  assert.doesNotMatch(deployment, /-v\s+\/var\/run\/docker\.sock|\/var\/run\/docker\.sock:\/var\/run\/docker\.sock/);
});

test('operator docs link the bounded recovery and release evidence', () => {
  const readme = text('README.md');
  const deployment = text('docs/DEPLOYMENT.md');
  const linkedDocs = [
    'docs/SPEC-0.1-BETA-AMENDMENT.md',
    'docs/BACKUP-RESTORE.md',
    'docs/BETA-ACCEPTANCE.md',
    'docs/BETA-RC-SCENARIOS.md',
    'docs/BETA-FAILURE-RECOVERY-MATRIX.md',
    'docs/BETA-ACCESSIBILITY-RESPONSIVE.md',
  ];

  for (const path of linkedDocs) {
    assert.equal(has(path), true, `missing linked operator evidence ${path}`);
    const basename = path.split('/').at(-1);
    assert.ok(readme.includes(basename), `README does not link ${basename}`);
    assert.ok(deployment.includes(basename), `deployment docs do not link ${basename}`);
  }

  const backup = text('docs/BACKUP-RESTORE.md');
  assert.match(backup, /The app must be stopped before backup/i);
  assert.match(backup, /must be backed up and escrowed separately/i);
});
