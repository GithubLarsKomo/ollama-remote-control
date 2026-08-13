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

test('release version, toolchain and project license have one explicit authoritative source', () => {
  const release = json('release/version.json');
  const rootPackage = json('package.json');

  assert.match(release.version, /^0\.1\.0-beta\.[1-9][0-9]*$/u);
  assert.match(release.nodeVersion, /^24\.[0-9]+\.[0-9]+$/u);
  assert.match(release.npmVersion, /^[0-9]+\.[0-9]+\.[0-9]+$/u);
  assert.equal(release.license, 'Apache-2.0');
  assert.equal(rootPackage.license, release.license);
  assert.equal(rootPackage.packageManager, `npm@${release.npmVersion}`);
  assert.equal(rootPackage.scripts['release:package'], 'node scripts/release-package.mjs');

  const projectLicense = text('LICENSE');
  assert.match(projectLicense, /Apache License\s+Version 2\.0, January 2004/u);
  assert.match(projectLicense, /END OF TERMS AND CONDITIONS/u);
});

test('release packaging binds exact source, lock, project license, workspaces, Docker and third-party license identities', () => {
  const source = text('scripts/release-package.mjs');
  for (const marker of [
    'PROJECT_LICENSE',
    'projectLicense',
    'licenseSha256',
    "cpSync(join(ROOT, 'LICENSE'), projectLicensePath)",
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
    'buildThirdPartyLicenseInventory',
    'third-party-licenses.json',
    'third-party-license-evidence.json',
    'reviewedEvidenceSha256',
    'inventorySha256',
    'SHA256SUMS',
  ]) {
    assert.ok(source.includes(marker), `release packaging source missing ${marker}`);
  }
});

test('reviewed missing-lock license evidence is exact-version and immutable-source bound', () => {
  const evidence = json('release/third-party-license-evidence.json');
  assert.equal(evidence.schemaVersion, 1);
  assert.deepEqual(Object.keys(evidence.overrides), ['buildcheck@0.0.7', 'cpu-features@0.0.10', 'ssh2@1.17.0']);
  assert.deepEqual(evidence.overrides['buildcheck@0.0.7'], {
    license: 'MIT',
    repository: 'mscdex/buildcheck',
    commitSha: '98d046cecfa784ac5522f8491d9f46a907da6743',
    packageJsonPath: 'package.json',
    packageJsonBlobSha: 'bbb9c75f7dc481f566da726ce7ed9d2a0f120ea3',
    licensePath: 'LICENSE',
    licenseBlobSha: '290762e94f4e2f2b52cc13ae4f2b63ac0269bfd1',
    reviewNote: 'Exact upstream 0.0.7 release commit declares MIT in package.json and contains the matching MIT LICENSE text. Used only because npm lock metadata omits the license field.',
  });
  assert.deepEqual(evidence.overrides['cpu-features@0.0.10'], {
    license: 'MIT',
    repository: 'mscdex/cpu-features',
    commitSha: '3fc76509be992e460878aad775ffbde5cfe1da36',
    packageJsonPath: 'package.json',
    packageJsonBlobSha: '6cc12c3c7703ea17995be61c5accc331e7e35014',
    licensePath: 'LICENSE',
    licenseBlobSha: '9ea90e03922d5e31b32e5ff84f4e51a6ca0760b5',
    reviewNote: 'Exact upstream 0.0.10 release commit declares MIT in package.json and contains the matching MIT LICENSE text. Used only because npm lock metadata omits the license field.',
  });
  assert.deepEqual(evidence.overrides['ssh2@1.17.0'], {
    license: 'MIT',
    repository: 'mscdex/ssh2',
    commitSha: '844f1edfc41589737671f96a4f4e76afdf46abd4',
    packageJsonPath: 'package.json',
    packageJsonBlobSha: '2e170c3e1be3353c642044f7d0e635b8dc10a6a9',
    licensePath: 'LICENSE',
    licenseBlobSha: '290762e94f4e2f2b52cc13ae4f2b63ac0269bfd1',
    reviewNote: 'Exact upstream 1.17.0 release commit declares MIT in package.json licenses metadata and contains the matching MIT LICENSE text. Used only because npm lock metadata omits the license field.',
  });
});

test('production image accepts immutable base and exposes non-sensitive release and license labels', () => {
  const dockerfile = text('Dockerfile');
  assert.ok(dockerfile.includes('ARG NODE_IMAGE=node:24-bookworm-slim'));
  assert.equal((dockerfile.match(/FROM \$\{NODE_IMAGE\}/gu) ?? []).length, 2);
  assert.ok(dockerfile.includes('org.opencontainers.image.version="${ORC_VERSION}"'));
  assert.ok(dockerfile.includes('org.opencontainers.image.revision="${ORC_COMMIT_SHA}"'));
  assert.ok(dockerfile.includes('org.opencontainers.image.licenses="Apache-2.0"'));
  assert.ok(dockerfile.includes('/app/LICENSE'));
  assert.ok(dockerfile.includes('ORC_RELEASE_VERSION=${ORC_VERSION}'));
  assert.ok(dockerfile.includes('ORC_COMMIT_SHA=${ORC_COMMIT_SHA}'));
  assert.ok(dockerfile.includes('/app/release/version.json'));
});

test('beta release candidate fails closed through locked exact-SHA packaging', () => {
  const workflow = text('.github/workflows/beta-release-candidate.yml');
  for (const marker of [
    'Resolve authoritative release metadata',
    'Set up exact release Node',
    'npm ci --ignore-scripts=false',
    "base_tag='node:24-bookworm-slim'",
    '--build-arg "NODE_IMAGE=${base_ref}"',
    '--build-arg "ORC_VERSION=${RELEASE_VERSION}"',
    '--build-arg "ORC_COMMIT_SHA=${TESTED_SHA}"',
    'npm run release:package --',
    'sha256sum -c SHA256SUMS',
    'release-packaging=passed',
    'Upload exact-SHA release package evidence',
  ]) {
    assert.ok(workflow.includes(marker), `beta RC workflow missing ${marker}`);
  }
  assert.ok(workflow.includes('beta-release-candidate'));
  assert.ok(workflow.includes('foundation-spike'));
  assert.ok(workflow.includes('production-container'));
});

test('release documentation keeps project grant and third-party license evidence explicit and separate', () => {
  const docs = text('docs/RELEASE-PACKAGING.md');
  assert.match(docs, /exact tested Git SHA/i);
  assert.match(docs, /package-lock SHA-256/i);
  assert.match(docs, /immutable base-image reference/i);
  assert.match(docs, /Apache-2\.0/i);
  assert.match(docs, /project `LICENSE`/i);
  assert.match(docs, /third-party-licenses\.json/i);
  assert.match(docs, /third-party-license-evidence\.json/i);
  assert.match(docs, /exact reviewed evidence/i);
  assert.match(docs, /factual dependency metadata only/i);
  assert.match(docs, /not legal advice/i);
  assert.match(docs, /contains no `\/data`, master key, SSH credential/i);
  assert.match(docs, /publishing a registry image or public release is a separate release action/i);
});