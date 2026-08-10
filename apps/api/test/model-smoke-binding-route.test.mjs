import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openDatabase } from '@orc/db';
import { registerModelSmokeFeature } from '../dist/model-smoke-feature.js';
import { buildServer } from '../dist/server.js';

const SSH_HOST = process.env.SSH_HOST;
const SSH_PORT = Number(process.env.SSH_PORT ?? '2222');
const SSH_USER = process.env.SSH_USER;
const SSH_PRIVATE_KEY_PATH = process.env.SSH_PRIVATE_KEY_PATH;
const CONTAINER_STATE = process.env.ORC_CONTAINER_STATE;
const HAS_FIXTURE = Boolean(SSH_HOST && SSH_USER && SSH_PRIVATE_KEY_PATH && CONTAINER_STATE);
const MASTER_KEY = Buffer.alloc(32, 0x5f);
const PASSWORD = 'model-smoke-binding-password!';
const MODEL = 'model-smoke-binding:latest';
const DIGEST = 'c'.repeat(64);

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
function mutationHeaders(cookies) {
  return { cookie: cookieHeader(cookies), 'x-csrf-token': cookies.orc_csrf };
}
async function authenticate(app) {
  const setup = await app.inject({ method: 'POST', url: '/api/v1/setup/admin', payload: { username: 'admin', password: PASSWORD } });
  assert.equal(setup.statusCode, 201);
  const login = await app.inject({ method: 'POST', url: '/api/v1/session', payload: { username: 'admin', password: PASSWORD } });
  assert.equal(login.statusCode, 200);
  return cookiesFrom(login);
}
async function onboard(app, cookies) {
  const probe = await app.inject({
    method: 'POST', url: '/api/v1/hosts/probe', headers: mutationHeaders(cookies),
    payload: { hostname: SSH_HOST, port: SSH_PORT },
  });
  assert.equal(probe.statusCode, 200);
  const created = await app.inject({
    method: 'POST', url: '/api/v1/hosts', headers: mutationHeaders(cookies),
    payload: {
      displayName: 'Smoke binding fixture', hostname: SSH_HOST, port: SSH_PORT, username: SSH_USER,
      confirmedFingerprint: probe.json().fingerprint,
      privateKey: fs.readFileSync(SSH_PRIVATE_KEY_PATH, 'utf8'),
    },
  });
  assert.equal(created.statusCode, 201);
  const selected = await app.inject({
    method: 'POST', url: `/api/v1/hosts/${created.json().host.id}/targets`, headers: mutationHeaders(cookies),
    payload: { containerId: 'ollama-container-id', displayName: 'Primary Ollama' },
  });
  assert.equal(selected.statusCode, 201);
  return selected.json().target.id;
}
async function listenOllama(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(11434, '127.0.0.1', resolve);
  });
  return server;
}
async function closeServer(server) {
  if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

test('target binding change during fresh inventory prevents smoke-test generation POST', { skip: !HAS_FIXTURE }, async () => {
  fs.writeFileSync('/tmp/orc-docker-fixture-mode', 'single');
  fs.writeFileSync('/tmp/orc-status-fixture-mode', 'normal');
  fs.writeFileSync(CONTAINER_STATE, 'running');

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orc-model-smoke-binding-'));
  const databasePath = path.join(directory, 'app.sqlite');
  const environment = { ORC_MASTER_KEY: MASTER_KEY.toString('base64') };
  const app = buildServer({ databasePath, environment });
  registerModelSmokeFeature(app, { databasePath, environment });
  let ollama = null;
  try {
    const cookies = await authenticate(app);
    const targetId = await onboard(app, cookies);
    let rebound = false;
    let generateCalls = 0;
    ollama = await listenOllama((request, response) => {
      response.setHeader('content-type', 'application/json');
      if (request.method === 'GET' && request.url === '/api/tags') {
        response.end(JSON.stringify({ models: [{
          name: MODEL, model: MODEL, modified_at: '2026-08-10T03:00:00Z', size: 4096, digest: DIGEST,
          details: { format: 'gguf', family: 'fixture', families: ['fixture'], parameter_size: '1B', quantization_level: 'Q4' },
        }] }));
        return;
      }
      if (request.method === 'GET' && request.url === '/api/ps') {
        if (!rebound) {
          const database = openDatabase(databasePath);
          try {
            database.prepare(`UPDATE ollama_targets SET selected_container_id = ?, updated_at = ? WHERE id = ?`)
              .run('rebound-container-id', '2026-08-10T03:45:00.000Z', targetId);
          } finally {
            database.close();
          }
          rebound = true;
        }
        response.end(JSON.stringify({ models: [] }));
        return;
      }
      if (request.method === 'POST' && request.url === '/api/generate') {
        generateCalls += 1;
        response.end(JSON.stringify({ response: 'OK', done: true }));
        return;
      }
      response.statusCode = 404;
      response.end('{}');
    });

    const response = await app.inject({
      method: 'POST', url: `/api/v1/targets/${targetId}/models/smoke-test`, headers: mutationHeaders(cookies),
      payload: {
        model: MODEL,
        digest: DIGEST,
        confirmation: { action: 'smoke-test', targetId, model: MODEL, digest: DIGEST },
      },
    });
    assert.equal(rebound, true);
    assert.equal(response.statusCode, 409);
    assert.equal(response.json().error.code, 'TARGET_BINDING_STALE');
    assert.equal(generateCalls, 0);

    const database = openDatabase(databasePath);
    try {
      const job = database.prepare(`SELECT state, error_class AS errorClass FROM jobs WHERE kind = 'model-smoke-test'`).get();
      assert.equal(job.state, 'failed');
      assert.equal(job.errorClass, 'TARGET_BINDING_STALE');
    } finally {
      database.close();
    }
  } finally {
    await app.close();
    if (ollama) await closeServer(ollama);
  }
});
