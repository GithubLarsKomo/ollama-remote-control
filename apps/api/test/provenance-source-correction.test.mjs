import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { applyMigrations, openDatabase } from '@orc/db';
import { registerModelSourceFeature } from '../dist/model-source-feature.js';
import { buildServer } from '../dist/server.js';

const PASSWORD = 'provenance-correction-admin-password!';
const MASTER_KEY = Buffer.alloc(32, 0x61);
const DIGEST = 'a'.repeat(64);

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
  const setup = await app.inject({
    method: 'POST', url: '/api/v1/setup/admin', payload: { username: 'admin', password: PASSWORD },
  });
  assert.equal(setup.statusCode, 201);
  const login = await app.inject({
    method: 'POST', url: '/api/v1/session', payload: { username: 'admin', password: PASSWORD },
  });
  assert.equal(login.statusCode, 200);
  return cookiesFrom(login);
}

function seedNode(databasePath) {
  const database = openDatabase(databasePath);
  try {
    applyMigrations(database);
    const user = database.prepare(`SELECT id FROM users WHERE username = 'admin'`).get();
    database.prepare(`INSERT INTO hosts(id, display_name, hostname, port, username) VALUES ('host-1', 'Host', 'host.internal', 22, 'orc')`).run();
    database.prepare(`INSERT INTO ollama_targets(id, host_id, display_name, selected_container_id) VALUES ('target-1', 'host-1', 'Target', 'container-1')`).run();
    database.prepare(`INSERT INTO provenance_nodes(
      id, identity_key, kind, target_id, model_name, model_digest, revision_id, created_at
    ) VALUES ('node-installed', ?, 'installed-model', 'target-1', 'example/model:Q4', ?, NULL, ?)`)
      .run(`installed:target-1:example/model:Q4:${DIGEST}`, DIGEST, '2026-08-11T12:00:00.000Z');
    database.prepare(`INSERT INTO provenance_nodes(
      id, identity_key, kind, target_id, model_name, model_digest, revision_id, created_at
    ) VALUES ('node-reference', 'model-reference:base', 'model-reference', NULL, 'base', NULL, NULL, ?)`)
      .run('2026-08-11T12:00:00.000Z');
    return String(user.id);
  } finally {
    database.close();
  }
}

test('manual provenance correction is CSRF protected, node-bound, superseding and audit-redacted', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orc-provenance-correction-'));
  const databasePath = path.join(directory, 'app.sqlite');
  const environment = { ORC_MASTER_KEY: MASTER_KEY.toString('base64') };
  const app = buildServer({ databasePath, environment });
  registerModelSourceFeature(app, { databasePath, environment, now: () => new Date('2026-08-11T13:00:00.000Z') });
  try {
    const cookies = await authenticate(app);
    const actorUserId = seedNode(databasePath);
    const url = '/api/v1/provenance/nodes/node-installed/source-corrections';
    const payload = {
      sourceKind: 'url',
      sourceReference: 'https://example.invalid/private-source',
      confidence: 'medium',
      note: 'operator private note',
      supersedesSourceId: null,
      targetId: 'attacker-target',
      modelName: 'attacker/model',
      modelDigest: 'f'.repeat(64),
    };

    const unauthenticated = await app.inject({ method: 'POST', url, payload });
    assert.equal(unauthenticated.statusCode, 401);

    const noCsrf = await app.inject({
      method: 'POST', url, payload,
      headers: { cookie: cookieHeader(cookies) },
    });
    assert.equal(noCsrf.statusCode, 403);

    const created = await app.inject({
      method: 'POST', url, payload,
      headers: { cookie: cookieHeader(cookies), 'x-csrf-token': cookies.orc_csrf },
    });
    assert.equal(created.statusCode, 201);
    const first = created.json().source;
    assert.equal(first.targetId, 'target-1');
    assert.equal(first.modelName, 'example/model:Q4');
    assert.equal(first.modelDigest, DIGEST);
    assert.equal(first.origin, 'operator');
    assert.equal(first.sourceReference, 'https://example.invalid/private-source');

    const stale = await app.inject({
      method: 'POST', url,
      payload: { sourceKind: 'unknown', confidence: 'unknown', supersedesSourceId: null },
      headers: { cookie: cookieHeader(cookies), 'x-csrf-token': cookies.orc_csrf },
    });
    assert.equal(stale.statusCode, 409);
    assert.equal(stale.json().error.code, 'PROVENANCE_CORRECTION_STALE');

    const corrected = await app.inject({
      method: 'POST', url,
      payload: { sourceKind: 'unknown', confidence: 'unknown', supersedesSourceId: first.id },
      headers: { cookie: cookieHeader(cookies), 'x-csrf-token': cookies.orc_csrf },
    });
    assert.equal(corrected.statusCode, 201);
    assert.equal(corrected.json().source.supersedesSourceId, first.id);
    assert.equal(corrected.json().source.sourceReference, null);

    const wrongKind = await app.inject({
      method: 'POST', url: '/api/v1/provenance/nodes/node-reference/source-corrections',
      payload: { sourceKind: 'unknown', confidence: 'unknown', supersedesSourceId: null },
      headers: { cookie: cookieHeader(cookies), 'x-csrf-token': cookies.orc_csrf },
    });
    assert.equal(wrongKind.statusCode, 409);
    assert.equal(wrongKind.json().error.code, 'PROVENANCE_NODE_NOT_CORRECTABLE');

    const database = openDatabase(databasePath);
    try {
      const sources = database.prepare(`SELECT id, target_id, model_name, model_digest, supersedes_source_id FROM provenance_sources ORDER BY created_at, id`).all();
      assert.equal(sources.length, 2);
      assert.equal(sources[0].target_id, 'target-1');
      assert.equal(sources[1].supersedes_source_id, first.id);

      const audits = database.prepare(`SELECT actor_user_id, target_id, action, parameters_redacted_json FROM audit_events WHERE action = 'provenance.source.correct' ORDER BY timestamp, id`).all();
      assert.equal(audits.length, 2);
      assert.equal(audits[0].actor_user_id, actorUserId);
      assert.equal(audits[0].target_id, 'target-1');
      const auditText = audits.map((row) => row.parameters_redacted_json).join('\n');
      assert.equal(auditText.includes('example.invalid'), false);
      assert.equal(auditText.includes('operator private note'), false);
      assert.equal(auditText.includes('hasReference'), true);
      assert.equal(auditText.includes('hasNote'), true);
    } finally {
      database.close();
    }
  } finally {
    await app.close();
  }
});
