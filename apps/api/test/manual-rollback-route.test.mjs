import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { registerManualRollbackFeature } from '../dist/manual-rollback-feature.js';
import { buildServer } from '../dist/server.js';

const MASTER_KEY = Buffer.alloc(32, 0x6a);
const PASSWORD = 'manual-rollback-route-password!';

function cookiesFrom(response) {
  const header = response.headers['set-cookie'];
  const values = Array.isArray(header) ? header : header ? [header] : [];
  const cookies = {};
  for (const value of values) {
    const [pair] = value.split(';');
    const separator = pair.indexOf('=');
    cookies[pair.slice(0, separator)] = decodeURIComponent(pair.slice(separator + 1));
  }
  return cookies;
}

function cookieHeader(cookies) {
  return Object.entries(cookies).map(([name, value]) => `${name}=${encodeURIComponent(value)}`).join('; ');
}

async function authenticate(app) {
  assert.equal((await app.inject({
    method: 'POST',
    url: '/api/v1/setup/admin',
    payload: { username: 'admin', password: PASSWORD },
  })).statusCode, 201);
  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/session',
    payload: { username: 'admin', password: PASSWORD },
  });
  assert.equal(login.statusCode, 200);
  return cookiesFrom(login);
}

test('manual rollback route requires authentication, CSRF and a complete bound confirmation before execution', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orc-manual-rollback-route-'));
  const databasePath = path.join(directory, 'app.sqlite');
  const environment = { ORC_MASTER_KEY: MASTER_KEY.toString('base64') };
  const app = buildServer({ databasePath, environment });
  registerManualRollbackFeature(app, {
    databasePath,
    environment,
    remoteFactory: () => ({
      async validateCompose() { throw new Error('must not reach remote'); },
      async replace() { throw new Error('must not reach remote'); },
      async resolveComposeContainer() { throw new Error('must not reach remote'); },
      async health() { throw new Error('must not reach remote'); },
    }),
  });

  try {
    const unauthenticated = await app.inject({
      method: 'POST',
      url: '/api/v1/targets/target-1/container/rollback',
      payload: { confirmation: {} },
    });
    assert.equal(unauthenticated.statusCode, 401);
    assert.equal(unauthenticated.json().error.code, 'UNAUTHENTICATED');

    const cookies = await authenticate(app);
    const noCsrf = await app.inject({
      method: 'POST',
      url: '/api/v1/targets/target-1/container/rollback',
      headers: { cookie: cookieHeader(cookies) },
      payload: { confirmation: {} },
    });
    assert.equal(noCsrf.statusCode, 403);
    assert.equal(noCsrf.json().error.code, 'CSRF_INVALID');

    const invalidConfirmation = await app.inject({
      method: 'POST',
      url: '/api/v1/targets/target-1/container/rollback',
      headers: {
        cookie: cookieHeader(cookies),
        'x-csrf-token': cookies.orc_csrf,
      },
      payload: {
        confirmation: {
          targetId: 'target-1',
          sourceUpdateJobId: 'update-job',
          currentContainerId: 'container-id',
          rollbackDigest: `sha256:${'1'.repeat(64)}`,
          acknowledgeModelVolumeBoundary: false,
        },
      },
    });
    assert.equal(invalidConfirmation.statusCode, 400);
    assert.equal(invalidConfirmation.json().error.code, 'ROLLBACK_CONFIRMATION_INVALID');
  } finally {
    await app.close();
  }
});
