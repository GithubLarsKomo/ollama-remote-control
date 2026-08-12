import assert from 'node:assert/strict';
import test from 'node:test';
import { buildThirdPartyLicenseInventory } from '../../../scripts/third-party-license-inventory.mjs';

function lock(packages) {
  return JSON.stringify({ lockfileVersion: 3, packages });
}

function evidence(overrides = {}) {
  return JSON.stringify({ schemaVersion: 1, overrides });
}

function reviewed(license = 'MIT') {
  return {
    license,
    repository: 'example/upstream',
    commitSha: '1'.repeat(40),
    packageJsonPath: 'package.json',
    packageJsonBlobSha: '2'.repeat(40),
    licensePath: 'LICENSE',
    licenseBlobSha: '3'.repeat(40),
    reviewNote: 'Exact upstream release evidence reviewed for the locked package version.',
  };
}

test('third-party license inventory is deterministic and ignores local workspace links', () => {
  const first = buildThirdPartyLicenseInventory(lock({
    '': { name: 'ollama-remote-control', version: '0.0.0' },
    'apps/api': { name: '@orc/api', version: '0.0.0' },
    'node_modules/@orc/api': { resolved: 'apps/api', link: true },
    'node_modules/zeta': { version: '2.0.0', license: 'MIT' },
    'node_modules/@scope/alpha': { version: '1.0.0', license: 'Apache-2.0' },
    'node_modules/parent/node_modules/zeta': { version: '1.0.0', license: 'ISC' },
  }));
  const second = buildThirdPartyLicenseInventory(lock({
    'node_modules/parent/node_modules/zeta': { version: '1.0.0', license: 'ISC' },
    'node_modules/@scope/alpha': { version: '1.0.0', license: 'Apache-2.0' },
    'node_modules/zeta': { version: '2.0.0', license: 'MIT' },
    'node_modules/@orc/api': { resolved: 'apps/api', link: true },
    'apps/api': { name: '@orc/api', version: '0.0.0' },
    '': { name: 'ollama-remote-control', version: '0.0.0' },
  }));

  assert.deepEqual(first.packages, [
    { name: '@scope/alpha', version: '1.0.0', license: 'Apache-2.0', licenseOrigin: 'package-lock' },
    { name: 'zeta', version: '1.0.0', license: 'ISC', licenseOrigin: 'package-lock' },
    { name: 'zeta', version: '2.0.0', license: 'MIT', licenseOrigin: 'package-lock' },
  ]);
  assert.deepEqual(first.licenseExpressionCounts, { 'Apache-2.0': 1, ISC: 1, MIT: 1 });
  assert.equal(first.packageCount, 3);
  assert.equal(first.reviewedEvidenceCount, 0);
  assert.deepEqual(first.packages, second.packages);
  assert.deepEqual(first.licenseExpressionCounts, second.licenseExpressionCounts);
  assert.match(first.disclaimer, /not legal advice/i);
});

test('third-party license inventory fails closed on missing license metadata without exact reviewed evidence', () => {
  assert.throws(
    () => buildThirdPartyLicenseInventory(lock({ 'node_modules/unknown': { version: '1.0.0' } })),
    /no non-empty license metadata and no exact reviewed evidence/,
  );
  assert.throws(
    () => buildThirdPartyLicenseInventory(lock({ 'node_modules/blank': { version: '1.0.0', license: '   ' } })),
    /no non-empty license metadata and no exact reviewed evidence/,
  );
});

test('third-party license inventory accepts exact reviewed evidence and exposes its immutable source identity', () => {
  const inventory = buildThirdPartyLicenseInventory(
    lock({ 'node_modules/example': { version: '1.0.0' } }),
    evidence({ 'example@1.0.0': reviewed('MIT') }),
  );

  assert.equal(inventory.reviewedEvidenceCount, 1);
  assert.match(inventory.reviewedEvidenceSha256, /^[a-f0-9]{64}$/u);
  assert.deepEqual(inventory.licenseExpressionCounts, { MIT: 1 });
  assert.deepEqual(inventory.packages[0], {
    name: 'example',
    version: '1.0.0',
    license: 'MIT',
    licenseOrigin: 'reviewed-evidence',
    evidence: {
      repository: 'example/upstream',
      commitSha: '1'.repeat(40),
      packageJsonPath: 'package.json',
      packageJsonBlobSha: '2'.repeat(40),
      licensePath: 'LICENSE',
      licenseBlobSha: '3'.repeat(40),
      reviewNote: 'Exact upstream release evidence reviewed for the locked package version.',
      packageJsonUrl: `https://github.com/example/upstream/blob/${'1'.repeat(40)}/package.json`,
      licenseUrl: `https://github.com/example/upstream/blob/${'1'.repeat(40)}/LICENSE`,
    },
  });
});

test('reviewed evidence is exact-version only and stale evidence fails closed', () => {
  assert.throws(
    () => buildThirdPartyLicenseInventory(
      lock({ 'node_modules/example': { version: '2.0.0' } }),
      evidence({ 'example@1.0.0': reviewed() }),
    ),
    /example@2\.0\.0 has no non-empty license metadata and no exact reviewed evidence/,
  );

  assert.throws(
    () => buildThirdPartyLicenseInventory(
      lock({ 'node_modules/example': { version: '1.0.0', license: 'MIT' } }),
      evidence({ 'example@1.0.0': reviewed() }),
    ),
    /reviewed third-party license evidence is stale or unused/i,
  );

  assert.throws(
    () => buildThirdPartyLicenseInventory(
      lock({ 'node_modules/other': { version: '1.0.0', license: 'MIT' } }),
      evidence({ 'example@1.0.0': reviewed() }),
    ),
    /reviewed third-party license evidence is stale or unused/i,
  );
});

test('third-party license inventory rejects conflicting metadata for same package version', () => {
  assert.throws(
    () => buildThirdPartyLicenseInventory(lock({
      'node_modules/example': { version: '1.0.0', license: 'MIT' },
      'node_modules/parent/node_modules/example': { version: '1.0.0', license: 'ISC' },
    })),
    /conflicting license metadata/,
  );
});
