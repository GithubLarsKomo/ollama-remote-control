import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { MasterKeyError } from '@orc/security';
import { buildServer } from '../dist/server.js';

function databasePath() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orc-api-master-key-'));
  return path.join(directory, 'app.sqlite');
}

test('API accepts a valid externally configured master key', async () => {
  const app = buildServer({
    databasePath: databasePath(),
    environment: { ORC_MASTER_KEY: Buffer.alloc(32, 0x55).toString('base64') },
  });
  await app.close();
});

test('API startup fails closed for an explicitly malformed master key', () => {
  assert.throws(
    () => buildServer({
      databasePath: databasePath(),
      environment: { ORC_MASTER_KEY: 'malformed-key' },
    }),
    MasterKeyError,
  );
});
