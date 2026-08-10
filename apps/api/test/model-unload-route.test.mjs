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
const DOCKER_FIXTURE_LOG = process.env.ORC_DOCKER_FIXTURE_LOG;
const CONTAINER_STATE = process.env.ORC_CONTAINER_STATE;
const HAS_FIXTURE = Boolean(SSH_HOST && SSH_USER && SSH_PRIVATE_KEY_PATH && DOCKER_FIXTURE_LOG && CONTAINER_STATE);
const MASTER_KEY = Buffer.alloc(32, 0x59);
const PASSWORD = 'model-unload-admin-password!';
const MODEL = 'hf.co/example/model:Q4_K_M';
const DIGEST = 'd'.repeat(64);
const OTHER_DIGEST = 'e'.repeat(64);

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
      displayName: 'Unload fixture', hostname: SSH_HOST, port: SSH_PORT, username: SSH_USER,
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

async function readJsonRequest(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
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

function runningPayload(loaded, digest = DIGEST) {
  return {
    models: loaded ? [{
      name: MODEL,
      model: MODEL,
      size: 4096,
      digest,
      details: {
        format: 'gguf', family: 'fixture', families: ['fixture'],
        parameter_size: '1B', quantization_level: 'Q4',
      },
      expires_at: '2026-08-10T03:00:00Z',
      size_vram: 2048,
      context_length: 4096,
    }] : [],
  };
}

function unloadPayload(targetId, digest = DIGEST) {
  return {
    model: MODEL,
    digest,
    confirmation: { action: 'unload', targetId, model: MODEL, digest },
  };
}

test('verified unload sends one fixed generate body and only succeeds after fresh /api/ps absence', { skip: !HAS_FIXTURE }, async () => {
  fs.writeFileSync('/tmp/orc-docker-fixture-mode', 'single');
  fs.writeFileSync('/tmp/orc-status-fixture-mode', 'normal');
  fs.writeFileSync(CONTAINER_STATE, 'running');
  fs.writeFileSync(DOCKER_FIXTURE_LOG, '');
  let loaded = true;
  let generateCalls = 0;
  let generateBody = null;
  const requests = [];
  const ollama = await listenOllama(async (request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.method === 'GET' && request.url === '/api/ps') {
      requests.push({ method: 'GET', url: '/api/ps' });
      response.end(JSON.stringify(runningPayload(loaded)));
      return;
    }
    if (request.method === 'POST' && request.url === '/api/generate') {
      generateCalls += 1;
      generateBody = await readJsonRequest(request);
      requests.push({ method: 'POST', url: '/api/generate' });
      loaded = false;
      response.end(JSON.stringify({ done: true, response: '', secret: 'REMOTE-SECRET-MUST-NOT-PERSIST' }));
      return;
    }
    response.statusCode = 404;
    response.end('{}');
  });

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orc-model-unload-route-'));
  const databasePath = path.join(directory, 'app.sqlite');
  const environment = { ORC_MASTER_KEY: MASTER_KEY.toString('base64') };
  const app = buildServer({ databasePath, environment });
  registerModelUnloadFeature(app, { databasePath, environment });
  try {
    const cookies = await authenticate(app);
    const targetId = await onboard(app, cookies);
    fs.writeFileSync(DOCKER_FIXTURE_LOG, '');
    requests.length = 0;

    const noCsrf = await app.inject({
      method: 'POST', url: `/api/v1/targets/${targetId}/models/unload`,
      headers: { cookie: cookieHeader(cookies) }, payload: unloadPayload(targetId),
    });
    assert.equal(noCsrf.statusCode, 403);
    assert.equal(generateCalls, 0);
    assert.deepEqual(requests, []);

    const response = await app.inject({
      method: 'POST', url: `/api/v1/targets/${targetId}/models/unload`,
      headers: mutationHeaders(cookies), payload: unloadPayload(targetId),
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(generateBody, { model: MODEL, keep_alive: 0, stream: false });
    assert.equal(generateCalls, 1);
    assert.deepEqual(requests, [
      { method: 'GET', url: '/api/ps' },
      { method: 'POST', url: '/api/generate' },
      { method: 'GET', url: '/api/ps' },
    ]);
    const result = response.json().unload;
    assert.equal(result.verified, true);
    assert.equal(result.model, MODEL);
    assert.equal(result.digest, DIGEST);
    assert.equal(result.job.kind, 'model-unload');
    assert.equal(result.job.state, 'succeeded');

    const calls = fs.readFileSync(DOCKER_FIXTURE_LOG, 'utf8').trim().split(/\r?\n/u).filter(Boolean);
    assert.deepEqual(calls, [
      'inspect ollama-container-id',
      'inspect ollama-container-id',
      'inspect ollama-container-id',
    ]);

    const database = openDatabase(databasePath);
    try {
      const jobs = database.prepare(`SELECT kind, state, result_json AS resultJson, error_class AS errorClass FROM jobs WHERE kind = 'model-unload'`).all();
      assert.equal(jobs.length, 1);
      assert.equal(jobs[0].state, 'succeeded');
      assert.equal(jobs[0].errorClass, null);
      const persisted = JSON.stringify({
        jobs,
        audit: database.prepare(`SELECT action, parameters_redacted_json AS parameters FROM audit_events WHERE action LIKE 'model.unload.%' ORDER BY timestamp, id`).all(),
      });
      assert.equal(persisted.includes('REMOTE-SECRET-MUST-NOT-PERSIST'), false);
      assert.equal(persisted.includes(DIGEST), true);
      assert.equal(persisted.includes(MODEL), true);
    } finally {
      database.close();
    }
  } finally {
    await app.close();
    await closeServer(ollama);
  }
});

test('stale digest or already-unloaded confirmation stops before POST /api/generate', { skip: !HAS_FIXTURE }, async () => {
  fs.writeFileSync('/tmp/orc-docker-fixture-mode', 'single');
  fs.writeFileSync('/tmp/orc-status-fixture-mode', 'normal');
  fs.writeFileSync(CONTAINER_STATE, 'running');
  let loaded = true;
  let currentDigest = DIGEST;
  let generateCalls = 0;
  const ollama = await listenOllama(async (request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.method === 'GET' && request.url === '/api/ps') {
      response.end(JSON.stringify(runningPayload(loaded, currentDigest)));
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
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orc-model-unload-stale-'));
  const databasePath = path.join(directory, 'app.sqlite');
  const environment = { ORC_MASTER_KEY: MASTER_KEY.toString('base64') };
  const app = buildServer({ databasePath, environment });
  registerModelUnloadFeature(app, { databasePath, environment });
  try {
    const cookies = await authenticate(app);
    const targetId = await onboard(app, cookies);

    currentDigest = OTHER_DIGEST;
    const stale = await app.inject({
      method: 'POST', url: `/api/v1/targets/${targetId}/models/unload`,
      headers: mutationHeaders(cookies), payload: unloadPayload(targetId, DIGEST),
    });
    assert.equal(stale.statusCode, 409);
    assert.equal(stale.json().error.code, 'MODEL_NOT_LOADED');
    assert.equal(generateCalls, 0);

    loaded = false;
    const absent = await app.inject({
      method: 'POST', url: `/api/v1/targets/${targetId}/models/unload`,
      headers: mutationHeaders(cookies), payload: unloadPayload(targetId, OTHER_DIGEST),
    });
    assert.equal(absent.statusCode, 409);
    assert.equal(absent.json().error.code, 'MODEL_NOT_LOADED');
    assert.equal(generateCalls, 0);
  } finally {
    await app.close();
    await closeServer(ollama);
  }
});

test('2xx unload response is provisional and verification failure terminalizes job as failed', { skip: !HAS_FIXTURE }, async () => {
  fs.writeFileSync('/tmp/orc-docker-fixture-mode', 'single');
  fs.writeFileSync('/tmp/orc-status-fixture-mode', 'normal');
  fs.writeFileSync(CONTAINER_STATE, 'running');
  let generateCalls = 0;
  const ollama = await listenOllama(async (request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.method === 'GET' && request.url === '/api/ps') {
      response.end(JSON.stringify(runningPayload(true)));
      return;
    }
    if (request.method === 'POST' && request.url === '/api/generate') {
      generateCalls += 1;
      assert.deepEqual(await readJsonRequest(request), { model: MODEL, keep_alive: 0, stream: false });
      response.end(JSON.stringify({ done: true }));
      return;
    }
    response.statusCode = 404;
    response.end('{}');
  });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orc-model-unload-verify-fail-'));
  const databasePath = path.join(directory, 'app.sqlite');
  const environment = { ORC_MASTER_KEY: MASTER_KEY.toString('base64') };
  const app = buildServer({ databasePath, environment });
  registerModelUnloadFeature(app, { databasePath, environment });
  try {
    const cookies = await authenticate(app);
    const targetId = await onboard(app, cookies);
    const response = await app.inject({
      method: 'POST', url: `/api/v1/targets/${targetId}/models/unload`,
      headers: mutationHeaders(cookies), payload: unloadPayload(targetId),
    });
    assert.equal(response.statusCode, 502);
    assert.equal(response.json().error.code, 'MODEL_UNLOAD_VERIFICATION_FAILED');
    assert.equal(generateCalls, 1);

    const database = openDatabase(databasePath);
    try {
      const job = database.prepare(`SELECT state, error_class AS errorClass, result_json AS resultJson FROM jobs WHERE kind = 'model-unload'`).get();
      assert.equal(job.state, 'failed');
      assert.equal(job.errorClass, 'MODEL_UNLOAD_VERIFICATION_FAILED');
      assert.equal(JSON.parse(job.resultJson).verified, false);
    } finally {
      database.close();
    }
  } finally {
    await app.close();
    await closeServer(ollama);
  }
});
