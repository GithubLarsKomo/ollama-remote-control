import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openDatabase } from '@orc/db';
import { buildServer } from '../dist/server.js';

function tempDb(prefix = 'orc-auth-') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return path.join(directory, 'auth.sqlite');
}

function cookieValues(response) {
  const header = response.headers['set-cookie'];
  const values = Array.isArray(header) ? header : header ? [header] : [];
  const result = {};
  for (const value of values) {
    const [pair] = value.split(';');
    const separator = pair.indexOf('=');
    result[pair.slice(0, separator)] = decodeURIComponent(pair.slice(separator + 1));
  }
  return { values, cookies: result };
}

function cookieHeader(cookies) {
  return Object.entries(cookies)
    .map(([name, value]) => `${name}=${encodeURIComponent(value)}`)
    .join('; ');
}

test('admin bootstrap, login, CSRF and logout keep raw secrets out of SQLite', async () => {
  const databasePath = tempDb();
  const app = buildServer({ databasePath });
  const password = 'correct-horse-battery-staple';

  try {
    const initial = await app.inject({ method: 'GET', url: '/api/v1/setup/status' });
    assert.deepEqual(initial.json(), { requiresAdminBootstrap: true });

    const bootstrap = await app.inject({
      method: 'POST',
      url: '/api/v1/setup/admin',
      payload: { username: 'admin', password },
    });
    assert.equal(bootstrap.statusCode, 201);
    assert.equal(bootstrap.json().user.role, 'admin');

    const secondBootstrap = await app.inject({
      method: 'POST',
      url: '/api/v1/setup/admin',
      payload: { username: 'other-admin', password },
    });
    assert.equal(secondBootstrap.statusCode, 409);

    const invalidLogin = await app.inject({
      method: 'POST',
      url: '/api/v1/session',
      payload: { username: 'admin', password: 'wrong-password-value' },
    });
    assert.equal(invalidLogin.statusCode, 401);

    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/session',
      payload: { username: 'ADMIN', password },
    });
    assert.equal(login.statusCode, 200);
    const { values: setCookies, cookies } = cookieValues(login);
    assert.equal(setCookies.length, 2);
    assert(setCookies.some((value) => value.startsWith('orc_session=') && value.includes('HttpOnly') && value.includes('Secure') && value.includes('SameSite=Strict')));
    assert(setCookies.some((value) => value.startsWith('orc_csrf=') && !value.includes('HttpOnly') && value.includes('Secure') && value.includes('SameSite=Strict')));
    assert(cookies.orc_session);
    assert(cookies.orc_csrf);

    const inspection = openDatabase(databasePath);
    try {
      const user = inspection.prepare('SELECT password_hash FROM users WHERE username = ?').get('admin');
      assert.notEqual(user.password_hash, password);
      assert.match(user.password_hash, /^\$argon2id\$/u);

      const session = inspection.prepare('SELECT token_hash, csrf_token_hash FROM sessions').get();
      assert.notEqual(session.token_hash, cookies.orc_session);
      assert.notEqual(session.csrf_token_hash, cookies.orc_csrf);
      assert.equal(String(session.token_hash).length, 43);
      assert.equal(String(session.csrf_token_hash).length, 43);
    } finally {
      inspection.close();
    }

    const authenticated = await app.inject({
      method: 'GET',
      url: '/api/v1/session',
      headers: { cookie: cookieHeader(cookies) },
    });
    assert.equal(authenticated.statusCode, 200);
    assert.equal(authenticated.json().user.username, 'admin');

    const missingCsrf = await app.inject({
      method: 'DELETE',
      url: '/api/v1/session',
      headers: { cookie: cookieHeader(cookies) },
    });
    assert.equal(missingCsrf.statusCode, 403);

    const logout = await app.inject({
      method: 'DELETE',
      url: '/api/v1/session',
      headers: {
        cookie: cookieHeader(cookies),
        'x-csrf-token': cookies.orc_csrf,
      },
    });
    assert.equal(logout.statusCode, 204);

    const afterLogout = await app.inject({
      method: 'GET',
      url: '/api/v1/session',
      headers: { cookie: cookieHeader(cookies) },
    });
    assert.equal(afterLogout.statusCode, 401);
  } finally {
    await app.close();
  }
});

test('parallel bootstrap requests can create only one administrator', async () => {
  const app = buildServer({ databasePath: tempDb('orc-auth-race-') });
  try {
    const payloads = [
      { username: 'admin-a', password: 'bootstrap-password-A1!' },
      { username: 'admin-b', password: 'bootstrap-password-B2!' },
    ];
    const responses = await Promise.all(payloads.map((payload) => app.inject({
      method: 'POST',
      url: '/api/v1/setup/admin',
      payload,
    })));
    assert.deepEqual(responses.map((response) => response.statusCode).sort(), [201, 409]);
  } finally {
    await app.close();
  }
});

test('expired sessions are rejected by server-side lookup', async () => {
  let current = new Date('2026-08-08T06:00:00.000Z');
  const app = buildServer({
    databasePath: tempDb('orc-auth-expiry-'),
    now: () => current,
    sessionTtlMs: 1000,
  });

  try {
    await app.inject({
      method: 'POST',
      url: '/api/v1/setup/admin',
      payload: { username: 'admin', password: 'expiry-test-password!' },
    });
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/session',
      payload: { username: 'admin', password: 'expiry-test-password!' },
    });
    const { cookies } = cookieValues(login);
    current = new Date('2026-08-08T06:00:02.000Z');

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/session',
      headers: { cookie: cookieHeader(cookies) },
    });
    assert.equal(response.statusCode, 401);
  } finally {
    await app.close();
  }
});
