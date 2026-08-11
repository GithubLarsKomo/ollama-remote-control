import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { applyMigrations, openDatabase } from '@orc/db';
import { registerModelSourceFeature } from '../dist/model-source-feature.js';
import { buildServer } from '../dist/server.js';

const PASSWORD = 'provenance-lineage-admin-password!';
const MASTER_KEY = Buffer.alloc(32, 0x62);
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
    ) VALUES ('node-installed', ?, 'installed-model', 'target-1', 'derived:model', ?, NULL, ?)`)
      .run(`installed:target-1:derived:model:${DIGEST}`, DIGEST, '2026-08-11T12:00:00.000Z');
    database.prepare(`INSERT INTO provenance_nodes(
      id, identity_key, kind, target_id, model_name, model_digest, revision_id, created_at
    ) VALUES ('node-reference', 'model-reference:base', 'model-reference', NULL, 'base', NULL, NULL, ?)`)
      .run('2026-08-11T12:00:00.000Z');
    return String(user.id);
  } finally {
    database.close();
  }
}

test('operator lineage is CSRF protected, node-bound, allowlisted, multi-parent and audited', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orc-provenance-lineage-'));
  const databasePath = path.join(directory, 'app.sqlite');
  const environment = { ORC_MASTER_KEY: MASTER_KEY.toString('base64') };
  const app = buildServer({ databasePath, environment });
  registerModelSourceFeature(app, { databasePath, environment, now: () => new Date('2026-08-11T13:00:00.000Z') });
  try {
    const cookies = await authenticate(app);
    const actorUserId = seedNode(databasePath);
    const url = '/api/v1/provenance/nodes/node-installed/lineage';

    const unauthenticated = await app.inject({
      method: 'POST', url,
      payload: { relation: 'quantized-from', parentModel: 'base:model', confidence: 'high' },
    });
    assert.equal(unauthenticated.statusCode, 401);

    const noCsrf = await app.inject({
      method: 'POST', url,
      payload: { relation: 'quantized-from', parentModel: 'base:model', confidence: 'high' },
      headers: { cookie: cookieHeader(cookies) },
    });
    assert.equal(noCsrf.statusCode, 403);

    const hostile = await app.inject({
      method: 'POST', url,
      payload: {
        relation: 'base-model', parentModel: '/root/.ollama/models/blobs/sha256:secret', confidence: 'high',
        targetId: 'attacker-target', modelDigest: 'f'.repeat(64),
      },
      headers: { cookie: cookieHeader(cookies), 'x-csrf-token': cookies.orc_csrf },
    });
    assert.equal(hostile.statusCode, 400);
    assert.equal(hostile.json().error.code, 'PROVENANCE_LINEAGE_INVALID');

    const quantized = await app.inject({
      method: 'POST', url,
      payload: {
        relation: 'quantized-from', parentModel: 'hf.co/example/base-model:FP16', confidence: 'high',
        targetId: 'attacker-target', modelDigest: 'f'.repeat(64),
      },
      headers: { cookie: cookieHeader(cookies), 'x-csrf-token': cookies.orc_csrf },
    });
    assert.equal(quantized.statusCode, 201);
    assert.equal(quantized.json().edge.toNodeId, 'node-installed');
    assert.equal(quantized.json().edge.relation, 'quantized-from');
    assert.equal(quantized.json().edge.origin, 'operator');
    assert.equal(quantized.json().parentNode.modelName, 'hf.co/example/base-model:FP16');

    const adapter = await app.inject({
      method: 'POST', url,
      payload: { relation: 'adapter', parentModel: 'hf.co/example/adapter:Q4_K_M', confidence: 'medium' },
      headers: { cookie: cookieHeader(cookies), 'x-csrf-token': cookies.orc_csrf },
    });
    assert.equal(adapter.statusCode, 201);
    assert.equal(adapter.json().edge.relation, 'adapter');

    const duplicate = await app.inject({
      method: 'POST', url,
      payload: { relation: 'adapter', parentModel: 'hf.co/example/adapter:Q4_K_M', confidence: 'low' },
      headers: { cookie: cookieHeader(cookies), 'x-csrf-token': cookies.orc_csrf },
    });
    assert.equal(duplicate.statusCode, 409);
    assert.equal(duplicate.json().error.code, 'PROVENANCE_LINEAGE_EXISTS');

    const wrongNode = await app.inject({
      method: 'POST', url: '/api/v1/provenance/nodes/node-reference/lineage',
      payload: { relation: 'adapter', parentModel: 'hf.co/example/adapter2:Q4', confidence: 'low' },
      headers: { cookie: cookieHeader(cookies), 'x-csrf-token': cookies.orc_csrf },
    });
    assert.equal(wrongNode.statusCode, 409);
    assert.equal(wrongNode.json().error.code, 'PROVENANCE_NODE_NOT_CORRECTABLE');

    const database = openDatabase(databasePath);
    try {
      const edges = database.prepare(`SELECT relation, origin, confidence, to_node_id FROM provenance_edges ORDER BY relation`).all();
      assert.equal(edges.length, 2);
      assert.deepEqual(edges.map((edge) => edge.relation), ['adapter', 'quantized-from']);
      assert.equal(edges.every((edge) => edge.origin === 'operator' && edge.to_node_id === 'node-installed'), true);

      const audit = database.prepare(`SELECT actor_user_id, target_id, parameters_redacted_json FROM audit_events WHERE action = 'provenance.lineage.record' ORDER BY id`).all();
      assert.equal(audit.length, 2);
      assert.equal(audit.every((row) => row.actor_user_id === actorUserId && row.target_id === 'target-1'), true);
      const auditText = audit.map((row) => row.parameters_redacted_json).join('\n');
      assert.equal(auditText.includes('attacker-target'), false);
      assert.equal(auditText.includes(`"modelDigest"`), false);
      assert.equal(auditText.includes('quantized-from'), true);
      assert.equal(auditText.includes('adapter'), true);
    } finally {
      database.close();
    }
  } finally {
    await app.close();
  }
});
