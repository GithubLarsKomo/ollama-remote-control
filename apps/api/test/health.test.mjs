import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildServer } from '../dist/server.js';

test('GET /api/v1/health reports migrated SQLite state and configured release version', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orc-api-'));
  const databasePath = path.join(directory, 'health.sqlite');
  const app = buildServer({ databasePath, releaseVersion: '0.1.0-beta.1' });
  try {
    const response = await app.inject({ method: 'GET', url: '/api/v1/health' });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), {
      status: 'ok',
      service: 'ollama-remote-control-api',
      version: '0.1.0-beta.1',
      database: { status: 'ok', schemaVersion: 11 },
    });
    assert.equal(fs.existsSync(databasePath), true);
  } finally {
    await app.close();
  }
});
