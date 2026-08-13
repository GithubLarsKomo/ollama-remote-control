import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import process from 'node:process';
import { buildThirdPartyLicenseInventory } from './third-party-license-inventory.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const SHA256 = /^[a-f0-9]{40}$/u;
const IMAGE_ID = /^sha256:[a-f0-9]{64}$/u;
const RELEASE_VERSION = /^0\.1\.0-beta\.[1-9][0-9]*$/u;
const PROJECT_LICENSE = 'Apache-2.0';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function sha256File(path) {
  return sha256(readFileSync(path));
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function fail(message) {
  throw new Error(message);
}

function parseArgs(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!key?.startsWith('--') || value === undefined) fail('Release packaging arguments must be --key value pairs.');
    result[key.slice(2)] = value;
  }
  return result;
}

function actualNpmVersion() {
  return execFileSync('npm', ['--version'], { cwd: ROOT, encoding: 'utf8' }).trim();
}

function assertCleanRepository() {
  const status = execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'], {
    cwd: ROOT,
    encoding: 'utf8',
  }).trim();
  if (status) fail('Release packaging requires a clean Git worktree.');
}

function workspaceRecords(lock) {
  const records = [];
  for (const [workspacePath, lockEntry] of Object.entries(lock.packages ?? {})) {
    if (!/^(apps|packages)\/[^/]+$/u.test(workspacePath)) continue;
    const manifestPath = join(ROOT, workspacePath, 'package.json');
    const manifest = readJson(manifestPath);
    if (manifest.private !== true) fail(`${workspacePath} must remain private for the beta package.`);
    if (manifest.name !== lockEntry.name || manifest.version !== lockEntry.version) {
      fail(`${workspacePath} package metadata does not match package-lock.json.`);
    }
    records.push({
      path: workspacePath,
      name: manifest.name,
      internalPackageVersion: manifest.version,
    });
  }
  records.sort((left, right) => left.path.localeCompare(right.path));
  if (records.length !== 8) fail(`Expected 8 private workspaces, found ${records.length}.`);
  return records;
}

function assertInternalDependencyLock(manifests) {
  const versionByName = new Map(manifests.map((entry) => [entry.name, entry.internalPackageVersion]));
  for (const entry of manifests) {
    const manifest = readJson(join(ROOT, entry.path, 'package.json'));
    for (const [name, spec] of Object.entries(manifest.dependencies ?? {})) {
      if (!name.startsWith('@orc/')) continue;
      const expected = versionByName.get(name);
      if (!expected || spec !== expected) fail(`${entry.path} has unsynchronised internal dependency ${name}.`);
    }
  }
}

export function buildReleaseManifest(input) {
  const release = readJson(join(ROOT, 'release', 'version.json'));
  if (!RELEASE_VERSION.test(release.version)) fail('release/version.json contains an invalid 0.1 beta version.');
  if (!/^24\.[0-9]+\.[0-9]+$/u.test(release.nodeVersion)) fail('release nodeVersion must pin Node 24 exactly.');
  if (!/^[0-9]+\.[0-9]+\.[0-9]+$/u.test(release.npmVersion)) fail('release npmVersion must be exact.');
  if (release.license !== PROJECT_LICENSE) fail(`release license must be ${PROJECT_LICENSE}.`);
  if (!SHA256.test(input.commitSha)) fail('Release commit SHA must be an exact lowercase 40-character Git SHA.');
  if (!IMAGE_ID.test(input.imageId) || !IMAGE_ID.test(input.baseImageId)) fail('Docker image identities must be sha256 IDs.');

  const rootPackage = readJson(join(ROOT, 'package.json'));
  const lock = readJson(join(ROOT, 'package-lock.json'));
  if (rootPackage.private !== true || lock.packages?.['']?.name !== rootPackage.name || lock.packages?.['']?.version !== rootPackage.version) {
    fail('Root package metadata does not match package-lock.json.');
  }
  if (rootPackage.packageManager !== `npm@${release.npmVersion}`) fail('Root packageManager does not match release npmVersion.');
  if (rootPackage.license !== release.license) fail('Root package license does not match authoritative release license.');
  const projectLicensePath = join(ROOT, 'LICENSE');
  const projectLicenseSha256 = sha256File(projectLicensePath);
  const workspaces = workspaceRecords(lock);
  assertInternalDependencyLock(workspaces);

  if (process.version !== `v${release.nodeVersion}`) fail(`Expected Node ${release.nodeVersion}, got ${process.version}.`);
  const npmVersion = actualNpmVersion();
  if (npmVersion !== release.npmVersion) fail(`Expected npm ${release.npmVersion}, got ${npmVersion}.`);

  return {
    schemaVersion: 1,
    product: 'ollama-remote-control',
    releaseVersion: release.version,
    commitSha: input.commitSha,
    projectLicense: {
      spdx: release.license,
      licenseSha256: projectLicenseSha256,
    },
    toolchain: {
      node: release.nodeVersion,
      npm: release.npmVersion,
      nodeEngine: rootPackage.engines?.node ?? null,
    },
    inputs: {
      packageLockSha256: sha256File(join(ROOT, 'package-lock.json')),
      dockerfileSha256: sha256File(join(ROOT, 'Dockerfile')),
      composeSha256: sha256File(join(ROOT, 'compose.yaml')),
      baseImageReference: input.baseImageReference,
      baseImageId: input.baseImageId,
    },
    image: {
      reference: input.imageReference,
      id: input.imageId,
      labels: {
        version: release.version,
        revision: input.commitSha,
        licenses: release.license,
      },
    },
    workspaces: workspaces.map((workspace) => ({
      ...workspace,
      releaseVersion: release.version,
    })),
  };
}

export function writeReleaseBundle(input) {
  assertCleanRepository();
  const lockText = readFileSync(join(ROOT, 'package-lock.json'), 'utf8');
  const evidenceText = readFileSync(join(ROOT, 'release', 'third-party-license-evidence.json'), 'utf8');
  const licenseInventory = buildThirdPartyLicenseInventory(lockText, evidenceText);
  const licenseContent = `${JSON.stringify(licenseInventory, null, 2)}\n`;
  const manifest = {
    ...buildReleaseManifest(input),
    thirdPartyLicenses: {
      packageCount: licenseInventory.packageCount,
      licenseExpressionCounts: licenseInventory.licenseExpressionCounts,
      reviewedEvidenceCount: licenseInventory.reviewedEvidenceCount,
      reviewedEvidenceSha256: licenseInventory.reviewedEvidenceSha256,
      inventorySha256: sha256(licenseContent),
    },
  };
  if (manifest.inputs.packageLockSha256 !== licenseInventory.packageLockSha256) {
    fail('Third-party license inventory is not bound to the release package-lock hash.');
  }
  if (manifest.thirdPartyLicenses.reviewedEvidenceSha256 !== sha256(evidenceText)) {
    fail('Third-party license inventory is not bound to the reviewed evidence file.');
  }

  const outDir = resolve(input.outDir);
  mkdirSync(outDir, { recursive: true });

  const manifestPath = join(outDir, 'release-manifest.json');
  const thirdPartyLicensePath = join(outDir, 'third-party-licenses.json');
  const evidencePath = join(outDir, 'third-party-license-evidence.json');
  const projectLicensePath = join(outDir, 'LICENSE');
  const dockerfilePath = join(outDir, 'Dockerfile');
  const composePath = join(outDir, 'compose.yaml');
  const versionPath = join(outDir, 'version.json');
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 });
  writeFileSync(thirdPartyLicensePath, licenseContent, { mode: 0o644 });
  writeFileSync(evidencePath, evidenceText, { mode: 0o644 });
  cpSync(join(ROOT, 'LICENSE'), projectLicensePath);
  cpSync(join(ROOT, 'Dockerfile'), dockerfilePath);
  cpSync(join(ROOT, 'compose.yaml'), composePath);
  cpSync(join(ROOT, 'release', 'version.json'), versionPath);

  if (sha256File(projectLicensePath) !== manifest.projectLicense.licenseSha256) {
    fail('Release bundle project LICENSE hash does not match release manifest authority.');
  }

  const checksumTargets = [manifestPath, thirdPartyLicensePath, evidencePath, projectLicensePath, dockerfilePath, composePath, versionPath];
  const sums = checksumTargets
    .map((path) => `${sha256File(path)}  ${basename(path)}`)
    .sort()
    .join('\n');
  writeFileSync(join(outDir, 'SHA256SUMS'), `${sums}\n`, { mode: 0o644 });
  return manifest;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  for (const required of ['out', 'commit', 'image-reference', 'image-id', 'base-image-reference', 'base-image-id']) {
    if (!args[required]) fail(`Missing --${required}.`);
  }
  const manifest = writeReleaseBundle({
    outDir: args.out,
    commitSha: args.commit,
    imageReference: args['image-reference'],
    imageId: args['image-id'],
    baseImageReference: args['base-image-reference'],
    baseImageId: args['base-image-id'],
  });
  process.stdout.write(`${JSON.stringify({ releaseVersion: manifest.releaseVersion, commitSha: manifest.commitSha, imageId: manifest.image.id, projectLicense: manifest.projectLicense.spdx, thirdPartyPackageCount: manifest.thirdPartyLicenses.packageCount, reviewedEvidenceCount: manifest.thirdPartyLicenses.reviewedEvidenceCount })}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) main();