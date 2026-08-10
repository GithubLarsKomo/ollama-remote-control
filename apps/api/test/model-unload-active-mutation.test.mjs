import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openDatabase } from '@orc/db';
import { registerModelUnloadFeature } from '../dist/model-unload-feature.js';
import { buildServer } from '../dist/server.js';

const MASTER_KEY = Buffer.alloc(32, 0x5b);
const PASSWORD = 'active-mutation-admin-password!';
const NOW = '2026-08-10T03:40:00.000Z';

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

test('active mutation endpoint exposes only safe kind/state and clears after terminalization', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orc-active-mutation-'));
  const databasePath = path.join(directory, 'app.sqlite');
  const environment = { ORC_MASTER_KEY: MASTER_KEY.toString('base64') };
  const app = buildServer({ databasePath, environment });
  registerModelUnloadFeature(app, { databasePath, environment });
  try {
    const setup = await app.inject({
      method: 'POST', url: '/api/v1/setup/admin', payload: { username: 'admin', password: PASSWORD },
    });
    assert.equal(setup.statusCode, 201);
    const login = await app.inject({
      method: 'POST', url: '/api/v1/session', payload: { username: 'admin', password: PASSWORD },
    });
    assert.equal(login.statusCode, 200);
    const cookies = cookiesFrom(login);

    const database = openDatabase(databasePath);
    try {
      const user = database.prepare(`SELECT id FROM users WHERE username = ?`).get('admin');
      assert(user?.id);
      database.prepare(`
        INSERT INTO hosts(id, display_name, hostname, port, username, host_key_fingerprint, enabled, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
      `).run('host-active', 'Host', 'host.internal', 22, 'tester', 'SHA256:test', NOW, NOW);
      database.prepare(`
        INSERT INTO ollama_targets(id, host_id, display_name, selected_container_id, enabled, created_at, updated_at)
        VALUES (?, ?, ?, ?, 1, ?, ?)
      `).run('target-active', 'host-active', 'Target', 'container-active', NOW, NOW);
      database.prepare(`
        INSERT INTO jobs(
          id, target_id, actor_user_id, kind, mutating, state, created_at, started_at, finished_at,
          result_json, error_class, exit_code
        ) VALUES (?, ?, ?, ?, 1, 'running', ?, ?, NULL, ?, NULL, NULL)
      `).run(
        'job-secret-id', 'target-active', String(user.id), 'model-create', NOW, NOW,
        JSON.stringify({ model: 'SECRET-MODEL-NOT-PUBLIC', privateDetail: 'SECRET-RESULT-NOT-PUBLIC' }),
      );
    } finally {
      database.close();
    }

    const unauthenticated = await app.inject({
      method: 'GET', url: '/api/v1/targets/target-active/mutation/active',
    });
    assert.equal(unauthenticated.statusCode, 401);

    const active = await app.inject({
      method: 'GET',
      url: '/api/v1/targets/target-active/mutation/active',
      headers: { cookie: cookieHeader(cookies) },
    });
    assert.equal(active.statusCode, 200);
    assert.deepEqual(active.json(), { mutation: { kind: 'model-create', state: 'running' } });
    const serialized = active.body;
    for (const forbidden of ['job-secret-id', 'SECRET-MODEL-NOT-PUBLIC', 'SECRET-RESULT-NOT-PUBLIC', 'actorUserId', 'resultJson']) {
      assert.equal(serialized.includes(forbidden), false);
    }

    const terminalDatabase = openDatabase(databasePath);
    try {
      // This fixture tests only active-lock visibility. It must not invent a verified model-create
      // success, because successful creates now require immutable deployment evidence.
      terminalDatabase.prepare(`
        UPDATE jobs
        SET state = 'failed', finished_at = ?, error_class = ?
        WHERE id = ?
      `).run(NOW, 'TEST_TERMINAL', 'job-secret-id');
    } finally {
      terminalDatabase.close();
    }

    const cleared = await app.inject({
      method: 'GET',
      url: '/api/v1/targets/target-active/mutation/active',
      headers: { cookie: cookieHeader(cookies) },
    });
    assert.equal(cleared.statusCode, 200);
    assert.deepEqual(cleared.json(), { mutation: null });
  } finally {
    await app.close();
  }
});