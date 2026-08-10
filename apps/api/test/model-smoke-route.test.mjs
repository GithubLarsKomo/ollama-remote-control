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
const MASTER_KEY = Buffer.alloc(32, 0x5e);
const PASSWORD = 'model-smoke-admin-password!';
const MODEL = 'hf.co/example/smoke-model:Q4_K_M';
const DIGEST = 'a'.repeat(64);
const OTHER_DIGEST = 'b'.repeat(64);
const GENERATED_SECRET = 'SECRET-GENERATED-TEXT-MUST-NOT-PERSIST';

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
      displayName: 'Smoke fixture', hostname: SSH_HOST, port: SSH_PORT, username: SSH_USER,
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

function installedPayload(digest = DIGEST) {
  return {
    models: [{
      name: MODEL,
      model: MODEL,
      modified_at: '2026-08-10T03:00:00Z',
      size: 4096,
      digest,
      details: {
        format: 'gguf', family: 'fixture', families: ['fixture'],
        parameter_size: '1B', quantization_level: 'Q4',
      },
    }],
  };
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
      expires_at: '2026-08-10T04:00:00Z',
      size_vram: 2048,
      context_length: 4096,
    }] : [],
  };
}
function requestBody(targetId, digest = DIGEST) {
  return {
    model: MODEL,
    digest,
    confirmation: { action: 'smoke-test', targetId, model: MODEL, digest },
  };
}

async function createApp(prefix) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const databasePath = path.join(directory, 'app.sqlite');
  const environment = { ORC_MASTER_KEY: MASTER_KEY.toString('base64') };
  const app = buildServer({ databasePath, environment });
  registerModelSmokeFeature(app, { databasePath, environment });
  const cookies = await authenticate(app);
  const targetId = await onboard(app, cookies);
  return { app, cookies, targetId, databasePath };
}

test('smoke test sends the exact fixed body and persists only safe diagnostics after clean postcondition', { skip: !HAS_FIXTURE }, async () => {
  fs.writeFileSync('/tmp/orc-docker-fixture-mode', 'single');
  fs.writeFileSync('/tmp/orc-status-fixture-mode', 'normal');
  fs.writeFileSync(CONTAINER_STATE, 'running');
  let generateCalls = 0;
  let generateBody = null;
  const requests = [];
  const ollama = await listenOllama(async (request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.method === 'GET' && request.url === '/api/tags') {
      requests.push('tags');
      response.end(JSON.stringify(installedPayload()));
      return;
    }
    if (request.method === 'GET' && request.url === '/api/ps') {
      requests.push('ps');
      response.end(JSON.stringify(runningPayload(false)));
      return;
    }
    if (request.method === 'POST' && request.url === '/api/generate') {
      generateCalls += 1;
      generateBody = await readJsonRequest(request);
      requests.push('generate');
      response.end(JSON.stringify({ response: GENERATED_SECRET, done: true, done_reason: 'stop' }));
      return;
    }
    response.statusCode = 404;
    response.end('{}');
  });
  const { app, cookies, targetId, databasePath } = await createApp('orc-model-smoke-success-');
  try {
    const noCsrf = await app.inject({
      method: 'POST', url: `/api/v1/targets/${targetId}/models/smoke-test`,
      headers: { cookie: cookieHeader(cookies) }, payload: requestBody(targetId),
    });
    assert.equal(noCsrf.statusCode, 403);
    assert.equal(generateCalls, 0);

    requests.length = 0;
    const response = await app.inject({
      method: 'POST', url: `/api/v1/targets/${targetId}/models/smoke-test`,
      headers: mutationHeaders(cookies), payload: requestBody(targetId),
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(generateBody, {
      model: MODEL,
      prompt: 'Reply with the single word OK.',
      stream: false,
      keep_alive: 0,
      options: { temperature: 0, num_predict: 8 },
    });
    assert.equal(generateCalls, 1);
    assert.deepEqual(requests, ['tags', 'ps', 'generate', 'tags', 'ps']);
    const result = response.json().smokeTest;
    assert.equal(result.verified, true);
    assert.equal(result.model, MODEL);
    assert.equal(result.digest, DIGEST);
    assert.equal(result.responseChars, GENERATED_SECRET.length);
    assert.equal(result.doneReason, 'stop');
    assert.equal(result.job.kind, 'model-smoke-test');
    assert.equal(result.job.state, 'succeeded');
    assert(Number.isSafeInteger(result.elapsedMs));

    const database = openDatabase(databasePath);
    try {
      const serialized = JSON.stringify({
        jobs: database.prepare(`SELECT result_json AS resultJson, error_class AS errorClass FROM jobs WHERE kind = 'model-smoke-test'`).all(),
        audit: database.prepare(`SELECT action, parameters_redacted_json AS parameters FROM audit_events WHERE action LIKE 'model.smoke.%'`).all(),
      });
      assert.equal(serialized.includes(GENERATED_SECRET), false);
      assert.equal(serialized.includes('Reply with the single word OK.'), false);
      assert.equal(serialized.includes(MODEL), true);
      assert.equal(serialized.includes(DIGEST), true);
    } finally {
      database.close();
    }
  } finally {
    await app.close();
    await closeServer(ollama);
  }
});

test('stale digest and already-loaded model fail before generation POST', { skip: !HAS_FIXTURE }, async () => {
  fs.writeFileSync('/tmp/orc-docker-fixture-mode', 'single');
  fs.writeFileSync('/tmp/orc-status-fixture-mode', 'normal');
  fs.writeFileSync(CONTAINER_STATE, 'running');
  let mode = 'stale';
  let generateCalls = 0;
  const ollama = await listenOllama((request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.method === 'GET' && request.url === '/api/tags') {
      response.end(JSON.stringify(installedPayload(mode === 'stale' ? OTHER_DIGEST : DIGEST)));
      return;
    }
    if (request.method === 'GET' && request.url === '/api/ps') {
      response.end(JSON.stringify(runningPayload(mode === 'loaded')));
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
  const { app, cookies, targetId } = await createApp('orc-model-smoke-preflight-');
  try {
    const stale = await app.inject({
      method: 'POST', url: `/api/v1/targets/${targetId}/models/smoke-test`,
      headers: mutationHeaders(cookies), payload: requestBody(targetId),
    });
    assert.equal(stale.statusCode, 409);
    assert.equal(stale.json().error.code, 'MODEL_SMOKE_STALE');
    assert.equal(generateCalls, 0);

    mode = 'loaded';
    const loaded = await app.inject({
      method: 'POST', url: `/api/v1/targets/${targetId}/models/smoke-test`,
      headers: mutationHeaders(cookies), payload: requestBody(targetId),
    });
    assert.equal(loaded.statusCode, 409);
    assert.equal(loaded.json().error.code, 'MODEL_SMOKE_ALREADY_LOADED');
    assert.equal(generateCalls, 0);
  } finally {
    await app.close();
    await closeServer(ollama);
  }
});

test('invalid 2xx generation response and cleanup failure terminalize smoke jobs as failed', { skip: !HAS_FIXTURE }, async () => {
  fs.writeFileSync('/tmp/orc-docker-fixture-mode', 'single');
  fs.writeFileSync('/tmp/orc-status-fixture-mode', 'normal');
  fs.writeFileSync(CONTAINER_STATE, 'running');
  let mode = 'invalid-response';
  let afterGenerate = false;
  const ollama = await listenOllama((request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.method === 'GET' && request.url === '/api/tags') {
      response.end(JSON.stringify(installedPayload()));
      return;
    }
    if (request.method === 'GET' && request.url === '/api/ps') {
      response.end(JSON.stringify(runningPayload(mode === 'cleanup-fail' && afterGenerate)));
      return;
    }
    if (request.method === 'POST' && request.url === '/api/generate') {
      afterGenerate = true;
      if (mode === 'invalid-response') response.end(JSON.stringify({ response: '', done: true }));
      else response.end(JSON.stringify({ response: 'OK', done: true }));
      return;
    }
    response.statusCode = 404;
    response.end('{}');
  });
  const { app, cookies, targetId, databasePath } = await createApp('orc-model-smoke-failures-');
  try {
    const invalid = await app.inject({
      method: 'POST', url: `/api/v1/targets/${targetId}/models/smoke-test`,
      headers: mutationHeaders(cookies), payload: requestBody(targetId),
    });
    assert.equal(invalid.statusCode, 502);
    assert.equal(invalid.json().error.code, 'MODEL_SMOKE_RESPONSE_INVALID');

    mode = 'cleanup-fail';
    afterGenerate = false;
    const cleanup = await app.inject({
      method: 'POST', url: `/api/v1/targets/${targetId}/models/smoke-test`,
      headers: mutationHeaders(cookies), payload: requestBody(targetId),
    });
    assert.equal(cleanup.statusCode, 502);
    assert.equal(cleanup.json().error.code, 'MODEL_SMOKE_CLEANUP_FAILED');

    const database = openDatabase(databasePath);
    try {
      const jobs = database.prepare(`SELECT state, error_class AS errorClass FROM jobs WHERE kind = 'model-smoke-test' ORDER BY created_at, id`).all();
      assert.equal(jobs.length, 2);
      assert.deepEqual(jobs.map((job) => [job.state, job.errorClass]), [
        ['failed', 'MODEL_SMOKE_RESPONSE_INVALID'],
        ['failed', 'MODEL_SMOKE_CLEANUP_FAILED'],
      ]);
    } finally {
      database.close();
    }
  } finally {
    await app.close();
    await closeServer(ollama);
  }
});
