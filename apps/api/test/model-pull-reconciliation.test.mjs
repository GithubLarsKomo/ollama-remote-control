import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { buildServer } from '../dist/server.js';

const SSH_HOST = process.env.SSH_HOST;
const SSH_PORT = Number(process.env.SSH_PORT ?? '2222');
const SSH_USER = process.env.SSH_USER;
const SSH_PRIVATE_KEY_PATH = process.env.SSH_PRIVATE_KEY_PATH;
const CONTAINER_STATE = process.env.ORC_CONTAINER_STATE;
const HAS_FIXTURE = Boolean(SSH_HOST && SSH_USER && SSH_PRIVATE_KEY_PATH && CONTAINER_STATE);
const MASTER_KEY = Buffer.alloc(32, 0x62);
const PASSWORD = 'model-pull-reconcile-password!';
const MODEL = 'model-pull-reconcile:latest';
const DIGEST = 'd'.repeat(64);

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
async function login(app) {
  const response = await app.inject({
    method: 'POST', url: '/api/v1/session', payload: { username: 'admin', password: PASSWORD },
  });
  assert.equal(response.statusCode, 200);
  return cookiesFrom(response);
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
      displayName: 'Reconcile fixture', hostname: SSH_HOST, port: SSH_PORT, username: SSH_USER,
      confirmedFingerprint: probe.json().fingerprint,
      privateKey: fs.readFileSync(SSH_PRIVATE_KEY_PATH, 'utf8'),
    },
  });
  assert.equal(created.statusCode, 201);
  const hostId = created.json().host.id;
  const selected = await app.inject({
    method: 'POST', url: `/api/v1/hosts/${hostId}/targets`, headers: mutationHeaders(cookies),
    payload: { containerId: 'ollama-container-id', displayName: 'Primary Ollama' },
  });
  assert.equal(selected.statusCode, 201);
  return selected.json().target.id;
}
async function waitForJob(app, cookies, jobId, predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await app.inject({
      method: 'GET', url: `/api/v1/jobs/${jobId}`,
      headers: { cookie: cookieHeader(cookies) },
    });
    assert.equal(response.statusCode, 200);
    const job = response.json().job;
    if (predicate(job)) return job;
    await delay(50);
  }
  assert.fail('Timed out waiting for model pull job state.');
}

function installedResponse(installed) {
  return { models: installed ? [{
    name: MODEL,
    model: MODEL,
    modified_at: '2026-08-09T06:00:00Z',
    size: 8192,
    digest: DIGEST,
    details: { format: 'gguf', family: 'fixture', families: ['fixture'], parameter_size: '1B', quantization_level: 'Q4' },
  }] : [] };
}

async function listenOllama(state) {
  const server = http.createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.method === 'GET' && request.url === '/api/tags') {
      response.end(JSON.stringify(installedResponse(state.installed)));
      return;
    }
    if (request.method === 'GET' && request.url === '/api/ps') {
      response.end(JSON.stringify({ models: [] }));
      return;
    }
    if (request.method === 'POST' && request.url === '/api/pull') {
      state.pullRequests += 1;
      response.setHeader('content-type', 'application/x-ndjson');
      response.write(`${JSON.stringify({ status: 'pulling manifest' })}\n`);
      response.write(`${JSON.stringify({ status: 'pulling layer', digest: `sha256:${DIGEST}`, total: 1000, completed: 100 })}\n`);
      return;
    }
    response.statusCode = 404;
    response.end('{}');
  });
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

test('restart reconciliation verifies completed pull without replaying POST and releases persistent target lock', { skip: !HAS_FIXTURE }, async () => {
  fs.writeFileSync('/tmp/orc-docker-fixture-mode', 'single');
  fs.writeFileSync('/tmp/orc-status-fixture-mode', 'normal');
  fs.writeFileSync(CONTAINER_STATE, 'running');
  const state = { installed: false, pullRequests: 0 };
  const ollama = await listenOllama(state);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orc-model-pull-reconcile-'));
  const databasePath = path.join(directory, 'app.sqlite');
  let app = buildServer({
    databasePath,
    environment: { ORC_MASTER_KEY: MASTER_KEY.toString('base64') },
  });

  try {
    await app.inject({ method: 'POST', url: '/api/v1/setup/admin', payload: { username: 'admin', password: PASSWORD } });
    let cookies = await login(app);
    const targetId = await onboard(app, cookies);
    const started = await app.inject({
      method: 'POST', url: `/api/v1/targets/${targetId}/models/pull`, headers: mutationHeaders(cookies),
      payload: { model: MODEL },
    });
    assert.equal(started.statusCode, 202);
    const jobId = started.json().job.id;
    await waitForJob(app, cookies, jobId, (job) => job.state === 'running');
    assert.equal(state.pullRequests, 1);

    await app.close();
    state.installed = true;

    app = buildServer({
      databasePath,
      environment: { ORC_MASTER_KEY: MASTER_KEY.toString('base64') },
    });
    cookies = await login(app);

    const reconciled = await app.inject({
      method: 'GET', url: `/api/v1/jobs/${jobId}`,
      headers: { cookie: cookieHeader(cookies) },
    });
    assert.equal(reconciled.statusCode, 200);
    assert.equal(reconciled.json().job.state, 'succeeded');
    assert.equal(reconciled.json().job.errorClass, null);
    assert.equal(state.pullRequests, 1, 'startup reconciliation must never replay POST /api/pull');

    const active = await app.inject({
      method: 'GET', url: `/api/v1/targets/${targetId}/models/pull/active`,
      headers: { cookie: cookieHeader(cookies) },
    });
    assert.equal(active.statusCode, 200);
    assert.equal(active.json().job, null);

    const next = await app.inject({
      method: 'POST', url: `/api/v1/targets/${targetId}/models/pull`, headers: mutationHeaders(cookies),
      payload: { model: MODEL },
    });
    assert.equal(next.statusCode, 202, 'reconciliation must release the persisted target mutation lock');
    const nextId = next.json().job.id;
    const cancel = await app.inject({
      method: 'POST', url: `/api/v1/jobs/${nextId}/cancel`, headers: mutationHeaders(cookies), payload: {},
    });
    assert.equal(cancel.statusCode, 200);
    await waitForJob(app, cookies, nextId, (job) => ['cancelled', 'failed'].includes(job.state));
  } finally {
    await app.close();
    await closeServer(ollama);
  }
});
