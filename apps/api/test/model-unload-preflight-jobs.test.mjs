import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openDatabase } from '@orc/db';
import { registerModelUnloadFeature } from '../dist/model-unload-feature.js';
import { buildServer } from '../dist/server.js';

const SSH_HOST = process.env.SSH_HOST;
const SSH_PORT = Number(process.env.SSH_PORT ?? '2222');
const SSH_USER = process.env.SSH_USER;
const SSH_PRIVATE_KEY_PATH = process.env.SSH_PRIVATE_KEY_PATH;
const HAS_FIXTURE = Boolean(SSH_HOST && SSH_USER && SSH_PRIVATE_KEY_PATH);
const MASTER_KEY = Buffer.alloc(32, 0x5c);
const PASSWORD = 'model-unload-preflight-password!';
const MODEL = 'model-preflight:latest';
const CONFIRMED_DIGEST = 'a'.repeat(64);
const REPLACED_DIGEST = 'b'.repeat(64);

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

async function onboard(app, cookies) {
  const probe = await app.inject({
    method: 'POST', url: '/api/v1/hosts/probe', headers: mutationHeaders(cookies),
    payload: { hostname: SSH_HOST, port: SSH_PORT },
  });
  assert.equal(probe.statusCode, 200);
  const created = await app.inject({
    method: 'POST', url: '/api/v1/hosts', headers: mutationHeaders(cookies),
    payload: {
      displayName: 'Unload preflight fixture', hostname: SSH_HOST, port: SSH_PORT, username: SSH_USER,
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

function runningModel(digest) {
  return {
    name: MODEL,
    model: MODEL,
    size: 4096,
    digest,
    details: {
      format: 'gguf', family: 'fixture', families: ['fixture'],
      parameter_size: '1B', quantization_level: 'Q4',
    },
    expires_at: '2026-08-10T04:00:00Z',
    size_vram: 2048,
    context_length: 4096,
  };
}

function requestBody(targetId, digest) {
  return {
    model: MODEL,
    digest,
    confirmation: { action: 'unload', targetId, model: MODEL, digest },
  };
}

test('stale and not-loaded preflight failures are persisted as explicit terminal model-unload jobs', { skip: !HAS_FIXTURE }, async () => {
  fs.writeFileSync('/tmp/orc-docker-fixture-mode', 'single');
  fs.writeFileSync('/tmp/orc-status-fixture-mode', 'normal');
  fs.writeFileSync('/tmp/orc-container-state', 'running');

  let mode = 'stale';
  let generateCalls = 0;
  const ollama = await listenOllama((request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.method === 'GET' && request.url === '/api/ps') {
      response.end(JSON.stringify({ models: mode === 'stale' ? [runningModel(REPLACED_DIGEST)] : [] }));
      return;
    }
    if (request.method === 'POST' && request.url === '/api/generate') {
      generateCalls += 1;
      response.end(JSON.stringify({ done: true }));
      return;
    }
    response.statusCode = 404;
    response.end('{}');
  });

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orc-model-unload-preflight-'));
  const databasePath = path.join(directory, 'app.sqlite');
  const environment = { ORC_MASTER_KEY: MASTER_KEY.toString('base64') };
  const app = buildServer({ databasePath, environment });
  registerModelUnloadFeature(app, { databasePath, environment });
  try {
    const cookies = await authenticate(app);
    const targetId = await onboard(app, cookies);

    const stale = await app.inject({
      method: 'POST',
      url: `/api/v1/targets/${targetId}/models/unload`,
      headers: mutationHeaders(cookies),
      payload: requestBody(targetId, CONFIRMED_DIGEST),
    });
    assert.equal(stale.statusCode, 409);
    assert.equal(stale.json().error.code, 'MODEL_UNLOAD_STALE');

    mode = 'absent';
    const absent = await app.inject({
      method: 'POST',
      url: `/api/v1/targets/${targetId}/models/unload`,
      headers: mutationHeaders(cookies),
      payload: requestBody(targetId, CONFIRMED_DIGEST),
    });
    assert.equal(absent.statusCode, 409);
    assert.equal(absent.json().error.code, 'MODEL_NOT_LOADED');
    assert.equal(generateCalls, 0);

    const database = openDatabase(databasePath);
    try {
      const jobs = database.prepare(`
        SELECT state, error_class AS errorClass, result_json AS resultJson
        FROM jobs
        WHERE kind = 'model-unload'
        ORDER BY created_at, id
      `).all();
      assert.equal(jobs.length, 2);
      assert.deepEqual(jobs.map((job) => [job.state, job.errorClass]), [
        ['failed', 'MODEL_UNLOAD_STALE'],
        ['failed', 'MODEL_NOT_LOADED'],
      ]);
      for (const job of jobs) {
        const result = JSON.parse(job.resultJson);
        assert.equal(result.model, MODEL);
        assert.equal(result.digest, CONFIRMED_DIGEST);
        assert.equal(result.verified, false);
      }
    } finally {
      database.close();
    }
  } finally {
    await app.close();
    await closeServer(ollama);
  }
});
