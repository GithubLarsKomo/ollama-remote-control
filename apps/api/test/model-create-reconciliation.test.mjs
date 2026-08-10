import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { registerModelCreateFeature } from '../dist/model-create-feature.js';
import { buildServer } from '../dist/server.js';

const SSH_HOST = process.env.SSH_HOST;
const SSH_PORT = Number(process.env.SSH_PORT ?? '2222');
const SSH_USER = process.env.SSH_USER;
const SSH_PRIVATE_KEY_PATH = process.env.SSH_PRIVATE_KEY_PATH;
const CONTAINER_STATE = process.env.ORC_CONTAINER_STATE;
const HAS_FIXTURE = Boolean(SSH_HOST && SSH_USER && SSH_PRIVATE_KEY_PATH && CONTAINER_STATE);
const MASTER_KEY = Buffer.alloc(32, 0x58);
const PASSWORD = 'model-create-reconcile-password!';
const BASE_MODEL = 'base:latest';
const OUTPUT_MODEL = 'recovered:latest';
const BASE_DIGEST = 'b'.repeat(64);
const OUTPUT_DIGEST = 'c'.repeat(64);
const RAW = [
  'FROM base:latest',
  'PARAMETER temperature 0.7',
  'MESSAGE user hello',
  'RENDERER qwen3.5',
  'PARSER qwen3.5',
  '',
].join('\n');

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
async function readJsonRequest(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
function modelEntry(name, digest) {
  return {
    name, model: name, modified_at: '2026-08-10T00:00:00Z', size: 4096, digest,
    details: { format: 'gguf', family: 'fixture', families: ['fixture'], parameter_size: '1B', quantization_level: 'Q4' },
  };
}
function showPayload() {
  return {
    modelfile: [
      'FROM /root/.ollama/models/blobs/sha256:deadbeef',
      'MESSAGE user hello',
      'RENDERER qwen3.5',
      'PARSER qwen3.5',
      'PARAMETER temperature 0.7',
    ].join('\n'),
    parameters: 'temperature 0.7',
    details: { parent_model: BASE_MODEL },
    capabilities: ['completion'],
    model_info: { 'general.architecture': 'fixture' },
  };
}
async function listenOllama(state) {
  const server = http.createServer(async (request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.method === 'GET' && request.url === '/api/version') {
      response.end(JSON.stringify({ version: '0.32.5' }));
      return;
    }
    if (request.method === 'GET' && request.url === '/api/tags') {
      response.end(JSON.stringify({
        models: [
          modelEntry(BASE_MODEL, BASE_DIGEST),
          ...(state.outputInstalled ? [modelEntry(OUTPUT_MODEL, OUTPUT_DIGEST)] : []),
        ],
      }));
      return;
    }
    if (request.method === 'GET' && request.url === '/api/ps') {
      response.end(JSON.stringify({ models: [] }));
      return;
    }
    if (request.method === 'POST' && request.url === '/api/create') {
      state.createCalls += 1;
      state.lastCreateBody = await readJsonRequest(request);
      response.setHeader('content-type', 'application/x-ndjson');
      response.write(`${JSON.stringify({ status: 'creating model layer' })}\n`);
      if (state.completeCreates) {
        response.end(`${JSON.stringify({ status: 'success' })}\n`);
      } else {
        request.once('close', () => {
          if (!response.writableEnded) response.destroy();
        });
      }
      return;
    }
    if (request.method === 'POST' && request.url === '/api/show') {
      const body = await readJsonRequest(request);
      assert.deepEqual(body, { model: OUTPUT_MODEL, verbose: false });
      state.showCalls += 1;
      response.end(JSON.stringify(showPayload()));
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
function buildApp(databasePath, environment) {
  const app = buildServer({ databasePath, environment });
  registerModelCreateFeature(app, { databasePath, environment });
  return app;
}
async function setupAndLogin(app) {
  const setup = await app.inject({ method: 'POST', url: '/api/v1/setup/admin', payload: { username: 'admin', password: PASSWORD } });
  assert.equal(setup.statusCode, 201);
  return login(app);
}
async function login(app) {
  const response = await app.inject({ method: 'POST', url: '/api/v1/session', payload: { username: 'admin', password: PASSWORD } });
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
  const selected = await app.inject({
    method: 'POST', url: `/api/v1/hosts/${created.json().host.id}/targets`, headers: mutationHeaders(cookies),
    payload: { containerId: 'ollama-container-id', displayName: 'Primary Ollama' },
  });
  assert.equal(selected.statusCode, 201);
  return selected.json().target.id;
}
async function createSource(app, cookies) {
  const response = await app.inject({
    method: 'POST', url: '/api/v1/modelfiles', headers: mutationHeaders(cookies),
    payload: { displayName: 'Recovery source', rawText: RAW },
  });
  assert.equal(response.statusCode, 201);
  return response.json().modelfile;
}
async function planAndStart(app, cookies, targetId, source, outputModel) {
  const route = `/api/v1/targets/${targetId}/modelfiles/${source.id}/revisions/${source.currentRevisionId}`;
  const planned = await app.inject({
    method: 'POST', url: `${route}/deploy-plan`, headers: mutationHeaders(cookies), payload: { outputModel },
  });
  assert.equal(planned.statusCode, 201);
  const plan = planned.json().plan;
  const started = await app.inject({
    method: 'POST', url: `${route}/deploy`, headers: mutationHeaders(cookies),
    payload: { planId: plan.planId, confirmationToken: plan.confirmationToken },
  });
  assert.equal(started.statusCode, 202);
  return started.json().job;
}
async function waitForJob(app, cookies, jobId, predicate, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await app.inject({
      method: 'GET', url: `/api/v1/model-create-jobs/${jobId}`, headers: { cookie: cookieHeader(cookies) },
    });
    assert.equal(response.statusCode, 200);
    const job = response.json().job;
    if (predicate(job)) return job;
    await delay(50);
  }
  assert.fail('Timed out waiting for model-create job state.');
}
async function waitForCreateCalls(state, count, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (state.createCalls >= count) return;
    await delay(25);
  }
  assert.fail(`Timed out waiting for ${count} create call(s).`);
}

test('restart reconciliation verifies observed created model and never replays POST /api/create', { skip: !HAS_FIXTURE }, async () => {
  fs.writeFileSync('/tmp/orc-docker-fixture-mode', 'single');
  fs.writeFileSync('/tmp/orc-status-fixture-mode', 'normal');
  fs.writeFileSync(CONTAINER_STATE, 'running');
  const state = { outputInstalled: false, createCalls: 0, showCalls: 0, completeCreates: false, lastCreateBody: null };
  const ollama = await listenOllama(state);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orc-model-create-reconcile-'));
  const databasePath = path.join(directory, 'app.sqlite');
  const environment = { ORC_MASTER_KEY: MASTER_KEY.toString('base64') };
  let app = buildApp(databasePath, environment);

  try {
    let cookies = await setupAndLogin(app);
    const targetId = await onboard(app, cookies);
    const source = await createSource(app, cookies);
    const job = await planAndStart(app, cookies, targetId, source, OUTPUT_MODEL);
    await waitForJob(app, cookies, job.id, (candidate) => candidate.state === 'running');
    await waitForCreateCalls(state, 1);
    assert.equal(state.createCalls, 1);

    await app.close();
    state.outputInstalled = true;
    state.completeCreates = true;

    app = buildApp(databasePath, environment);
    cookies = await login(app);
    const reconciled = await waitForJob(app, cookies, job.id, (candidate) => ['succeeded', 'failed'].includes(candidate.state));
    assert.equal(reconciled.state, 'succeeded');
    assert.equal(reconciled.errorClass, null);
    assert.equal(state.createCalls, 1, 'restart reconciliation must never replay POST /api/create');
    assert.equal(state.showCalls, 1);

    const second = await planAndStart(app, cookies, targetId, source, 'second:latest');
    assert.equal(second.state, 'queued');
    await waitForCreateCalls(state, 2);
    const cancelled = await app.inject({
      method: 'POST', url: `/api/v1/model-create-jobs/${second.id}/cancel`, headers: mutationHeaders(cookies), payload: {},
    });
    assert.equal(cancelled.statusCode, 200);
    await waitForJob(app, cookies, second.id, (candidate) => ['failed', 'cancelled'].includes(candidate.state));
  } finally {
    await app.close();
    await closeServer(ollama);
  }
});
