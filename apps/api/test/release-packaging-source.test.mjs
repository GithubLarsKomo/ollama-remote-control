import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const root = new URL('../../../', import.meta.url);

function text(path) {
  return readFileSync(new URL(path, root), 'utf8');
}

function json(path) {
  return JSON.parse(text(path));
}

test('release version and toolchain have one explicit authoritative source', () => {
  const release = json('release/version.json');
  const rootPackage = json('package.json');

  assert.match(release.version, /^0\.1\.0-beta\.[1-9][0-9]*$/u);
  assert.match(release.nodeVersion, /^24\.[0-9]+\.[0-9]+$/u);
  assert.match(release.npmVersion, /^[0-9]+\.[0-9]+\.[0-9]+$/u);
  assert.equal(rootPackage.packageManager, `npm@${release.npmVersion}`);
  assert.equal(rootPackage.scripts['release:package'], 'node scripts/release-package.mjs');
});

test('release packaging binds exact source, lock, workspaces and Docker identities', () => {
  const source = text('scripts/release-package.mjs');
  for (const marker of [
    'packageLockSha256',
    'dockerfileSha256',
    'composeSha256',
    'baseImageReference',
    'baseImageId',
    'imageReference',
    'imageId',
    'releaseVersion',
    'Expected 8 private workspaces',
    'Release packaging requires a clean Git worktree',
    'SHA256SUMS',
  ]) {
    assert.ok(source.includes(marker), `release packaging source missing ${marker}`);
  }
});

test('production image accepts immutable base and exposes non-sensitive release labels', () => {
  const dockerfile = text('Dockerfile');
  assert.ok(dockerfile.includes('ARG NODE_IMAGE=node:24-bookworm-slim'));
  assert.equal((dockerfile.match(/FROM \$\{NODE_IMAGE\}/gu) ?? []).length, 2);
  assert.ok(dockerfile.includes('org.opencontainers.image.version="${ORC_VERSION}"'));
  assert.ok(dockerfile.includes('org.opencontainers.image.revision="${ORC_COMMIT_SHA}"'));
  assert.ok(dockerfile.includes('ORC_RELEASE_VERSION=${ORC_VERSION}'));
  assert.ok(dockerfile.includes('ORC_COMMIT_SHA=${ORC_COMMIT_SHA}'));
  assert.ok(dockerfile.includes('/app/release/version.json'));
});

test('release documentation keeps package evidence bounded and separate from public release', () => {
  const docs = text('docs/RELEASE-PACKAGING.md');
  assert.match(docs, /exact tested Git SHA/i);
  assert.match(docs, /package-lock SHA-256/i);
  assert.match(docs, /immutable base-image reference/i);
  assert.match(docs, /contains no `\/data`, master key, SSH credential/i);
  assert.match(docs, /publishing a registry image or public release is a separate release action/i);
  assert.match(docs, /project license decision/i);
});
