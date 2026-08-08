import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildServer } from '../dist/server.js';

test('five failed logins rate-limit the client until the window expires', async () => {
  let current = new Date('2026-08-08T06:00:00.000Z');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orc-rate-limit-'));
  const app = buildServer({
    databasePath: path.join(directory, 'auth.sqlite'),
    now: () => current,
  });
  const password = 'rate-limit-correct-password!';

  try {
    await app.inject({
      method: 'POST',
      url: '/api/v1/setup/admin',
      payload: { username: 'admin', password },
    });

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const failed = await app.inject({
        method: 'POST',
        url: '/api/v1/session',
        payload: { username: 'admin', password: 'rate-limit-wrong-password!' },
      });
      assert.equal(failed.statusCode, 401);
    }

    const blocked = await app.inject({
      method: 'POST',
      url: '/api/v1/session',
      payload: { username: 'admin', password },
    });
    assert.equal(blocked.statusCode, 429);
    assert.equal(blocked.json().error.code, 'LOGIN_RATE_LIMITED');

    current = new Date('2026-08-08T06:01:01.000Z');
    const recovered = await app.inject({
      method: 'POST',
      url: '/api/v1/session',
      payload: { username: 'admin', password },
    });
    assert.equal(recovered.statusCode, 200);
  } finally {
    await app.close();
  }
});

test('oversized login credentials are rejected before expensive verification', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orc-login-bound-'));
  const app = buildServer({ databasePath: path.join(directory, 'auth.sqlite') });
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/session',
      payload: { username: 'admin', password: 'x'.repeat(1025) },
    });
    assert.equal(response.statusCode, 401);
    assert.equal(response.json().error.code, 'INVALID_CREDENTIALS');
  } finally {
    await app.close();
  }
});
