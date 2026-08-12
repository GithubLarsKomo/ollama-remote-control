import assert from 'node:assert/strict';
import test from 'node:test';
import {
  checkDestinationAuthority,
  createDeployConfirmationToken,
  parseDeployConfirmationToken,
} from '../dist/deploy-confirmation-authority.js';

const DIGEST = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);
const replace = { replaceExisting: true, existingDestinationDigest: DIGEST, existingDestinationSizeBytes: 42 };
const create = { replaceExisting: false, existingDestinationDigest: null, existingDestinationSizeBytes: null };

test('round-trips server replacement evidence and rejects token tampering', () => {
  const token = createDeployConfirmationToken(replace);
  assert.deepEqual(parseDeployConfirmationToken(token), replace);
  const last = token.at(-1);
  const tampered = `${token.slice(0, -1)}${last === 'A' ? 'B' : 'A'}`;
  const parsed = parseDeployConfirmationToken(tampered);
  assert.notDeepEqual(parsed, replace);
});

test('normal create fails closed when a destination appeared after planning', () => {
  assert.equal(checkDestinationAuthority(create, null), 'ok');
  assert.equal(checkDestinationAuthority(create, { digest: DIGEST, sizeBytes: 42 }), 'destination-exists');
});

test('replacement requires the exact planned destination digest and size', () => {
  assert.equal(checkDestinationAuthority(replace, null), 'replacement-target-missing');
  assert.equal(checkDestinationAuthority(replace, { digest: OTHER, sizeBytes: 42 }), 'replacement-target-stale');
  assert.equal(checkDestinationAuthority(replace, { digest: DIGEST, sizeBytes: 43 }), 'replacement-target-stale');
  assert.equal(checkDestinationAuthority(replace, { digest: DIGEST, sizeBytes: 42 }), 'ok');
});
