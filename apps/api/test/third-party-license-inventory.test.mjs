import assert from 'node:assert/strict';
import test from 'node:test';
import { buildThirdPartyLicenseInventory } from '../../../scripts/third-party-license-inventory.mjs';

function lock(packages) {
  return JSON.stringify({ lockfileVersion: 3, packages });
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
    { name: '@scope/alpha', version: '1.0.0', license: 'Apache-2.0' },
    { name: 'zeta', version: '1.0.0', license: 'ISC' },
    { name: 'zeta', version: '2.0.0', license: 'MIT' },
  ]);
  assert.deepEqual(first.licenseExpressionCounts, { 'Apache-2.0': 1, ISC: 1, MIT: 1 });
  assert.equal(first.packageCount, 3);
  assert.deepEqual(first.packages, second.packages);
  assert.deepEqual(first.licenseExpressionCounts, second.licenseExpressionCounts);
  assert.match(first.disclaimer, /not legal advice/i);
});

test('third-party license inventory fails closed on missing license metadata', () => {
  assert.throws(
    () => buildThirdPartyLicenseInventory(lock({ 'node_modules/unknown': { version: '1.0.0' } })),
    /has no non-empty license metadata/,
  );
  assert.throws(
    () => buildThirdPartyLicenseInventory(lock({ 'node_modules/blank': { version: '1.0.0', license: '   ' } })),
    /has no non-empty license metadata/,
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
