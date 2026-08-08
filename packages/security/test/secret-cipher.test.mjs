import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  loadConfiguredMasterKey,
  MasterKeyError,
  SecretCipher,
} from '../dist/index.js';

const KEY = Buffer.alloc(32, 0x2a);
const OTHER_KEY = Buffer.alloc(32, 0x11);
const PRIVATE_KEY = '-----BEGIN OPENSSH PRIVATE KEY-----\ntest-secret-material\n-----END OPENSSH PRIVATE KEY-----';

test('AES-GCM secret encryption round-trips with a fresh nonce', () => {
  const cipher = new SecretCipher(KEY);
  const first = cipher.encrypt('credential-1', PRIVATE_KEY);
  const second = cipher.encrypt('credential-1', PRIVATE_KEY);

  assert.equal(cipher.decrypt('credential-1', first), PRIVATE_KEY);
  assert.equal(cipher.decrypt('credential-1', second), PRIVATE_KEY);
  assert.notEqual(first.nonce, second.nonce);
  assert.notEqual(first.ciphertext, second.ciphertext);
  assert.equal(first.algorithm, 'aes-256-gcm');
  assert.equal(first.keyVersion, 1);
});

test('tampering, wrong credential AAD and wrong key all fail closed', () => {
  const cipher = new SecretCipher(KEY);
  const encrypted = cipher.encrypt('credential-1', PRIVATE_KEY);

  assert.throws(() => cipher.decrypt('credential-2', encrypted));
  assert.throws(() => new SecretCipher(OTHER_KEY).decrypt('credential-1', encrypted));

  const tag = Buffer.from(encrypted.authTag, 'base64');
  tag[0] ^= 0xff;
  assert.throws(() => cipher.decrypt('credential-1', {
    ...encrypted,
    authTag: tag.toString('base64'),
  }));
});

test('master key loader prefers file and requires canonical 32-byte Base64', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orc-master-key-'));
  const keyFile = path.join(directory, 'master-key');
  fs.writeFileSync(keyFile, `${KEY.toString('base64')}\n`, { mode: 0o600 });

  const loaded = loadConfiguredMasterKey({
    ORC_MASTER_KEY_FILE: keyFile,
    ORC_MASTER_KEY: OTHER_KEY.toString('base64'),
  });
  assert.deepEqual(loaded, KEY);
  assert.deepEqual(loadConfiguredMasterKey({ ORC_MASTER_KEY: KEY.toString('base64') }), KEY);
  assert.equal(loadConfiguredMasterKey({}), null);

  assert.throws(
    () => loadConfiguredMasterKey({ ORC_MASTER_KEY: Buffer.alloc(31).toString('base64') }),
    MasterKeyError,
  );
  assert.throws(
    () => loadConfiguredMasterKey({ ORC_MASTER_KEY: 'not-base64' }),
    MasterKeyError,
  );
});
