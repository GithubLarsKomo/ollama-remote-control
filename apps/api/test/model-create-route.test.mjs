import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { openDatabase } from '@orc/db';
import { registerModelCreateFeature } from '../dist/model-create-feature.js';
import { buildServer } from '../dist/server.js';

const SSH_HOST = process.env.SSH_HOST;
const SSH_PORT = Number(process.env.SSH_PORT ?? '2222');
const SSH_USER = process.env.SSH_USER;
const SSH_PRIVATE_KEY_PATH = process.env.SSH_PRIVATE_KEY_PATH;
const DOCKER_FIXTURE_LOG = process.env.ORC_DOCKER_FIXTURE_LOG;
const CONTAINER_STATE = process.env.ORC_CONTAINER_STATE;
const HAS_FIXTURE = Boolean(SSH_HOST && SSH_USER && SSH_PRIVATE_KEY_PATH && DOCKER_FIXTURE_LOG && CONTAINER_STATE);
const MASTER_KEY = Buffer.alloc(32, 0x57);
const PASSWORD = 'model-create-admin-password!';
const BASE_MODEL = 'base:latest';
const OUTPUT_MODEL = 'custom:latest';
const BASE_DIGEST = 'b'.repeat(64);
const OUTPUT_DIGEST = 'c'.repeat(64);
const RAW = [
  'FROM base:latest',
  'TEMPLATE """{{ .Prompt }}"""',
  'SYSTEM """secret system text"""',
  'PARAMETER temperature 0.7',
  'MESSAGE user """hello',
  'there"""',
  'LICENSE """secret license text"""',
  'RENDERER qwen3.5',
  'PARSER qwen3.5',
  'REQUIRES 0.12.0',
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
function modelEntry(name, digest) {
  return {
    name,
    model: name,
    modified_at: '2026-08-10T00:00:00Z',
    size: 4096,
    digest,
    details: {
      format: 'gguf', family: 'fixture', families: ['fixture'],
      parameter_size: '1B', quantization_level: 'Q4',
    },
  };
}
function tagsPayload(outputInstalled) {
  return {
    models: [
      modelEntry(BASE_MODEL, BASE_DIGEST),
      ...(outputInstalled ? [modelEntry(OUTPUT_MODEL, OUTPUT_DIGEST)] : []),
    ],
  };
}
function showPayload() {
  return {
    modelfile: [
      '# generated',
      'FROM /root/.ollama/models/blobs/sha256:deadbeef',
      'MESSAGE user """hello',
      'there"""',
      'RENDERER qwen3.5',
      'PARSER qwen3.5',
      'PARAMETER temperature 0.7',
    ].join('\n'),
    parameters: 'temperature 0.7',
    template: '{{ .Prompt }}',
    system: 'secret system text',
    license: 'secret license text',
    requires: '0.12.0',
    details: { parent_model: BASE_MODEL },
    capabilities: ['completion'],
    model_info: { 'general.architecture': 'fixture' },
  };
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
      displayName: 'Create fixture', hostname: SSH_HOST, port: SSH_PORT, username: SSH_USER,
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
async function createSource(app, cookies) {
  const response = await app.inject({
    method: 'POST', url: '/api/v1/modelfiles', headers: mutationHeaders(cookies),
    payload: { displayName: 'Deploy source', rawText: RAW },
  });
  assert.equal(response.statusCode, 201);
  return response.json().modelfile;
}
async function waitForCreateJob(app, cookies, jobId, predicate, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await app.inject({
      method: 'GET', url: `/api/v1/model-create-jobs/${jobId}`,
      headers: { cookie: cookieHeader(cookies) },
    });
    assert.equal(response.statusCode, 200);
    const job = response.json().job;
    if (predicate(job)) return job;
    await delay(50);
  }
  assert.fail('Timed out waiting for model-create job state.');
}

test('confirmed deploy ignores forged browser semantics, creates through pinned SSH and succeeds only after show verification', { skip: !HAS_FIXTURE }, async () => {
  fs.writeFileSync('/tmp/orc-docker-fixture-mode', 'single');
  fs.writeFileSync('/tmp/orc-status-fixture-mode', 'normal');
  fs.writeFileSync(CONTAINER_STATE, 'running');
  fs.writeFileSync(DOCKER_FIXTURE_LOG, '');
  let outputInstalled = false;
  let createCalls = 0;
  let createBody = null;
  let showCalls = 0;
  const ollama = await listenOllama(async (request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.method === 'GET' && request.url === '/api/version') {
      response.end(JSON.stringify({ version: '0.32.5' }));
      return;
    }
    if (request.method === 'GET' && request.url === '/api/tags') {
      response.end(JSON.stringify(tagsPayload(outputInstalled)));
      return;
    }
    if (request.method === 'GET' && request.url === '/api/ps') {
      response.end(JSON.stringify({ models: [] }));
      return;
    }
    if (request.method === 'POST' && request.url === '/api/create') {
      createCalls += 1;
      createBody = await readJsonRequest(request);
      response.setHeader('content-type', 'application/x-ndjson');
      response.write(`${JSON.stringify({ status: 'creating model layer' })}\n`);
      await delay(200);
      outputInstalled = true;
      response.end(`${JSON.stringify({ status: 'success' })}\n`);
      return;
    }
    if (request.method === 'POST' && request.url === '/api/show') {
      const body = await readJsonRequest(request);
      assert.deepEqual(body, { model: OUTPUT_MODEL, verbose: false });
      showCalls += 1;
      response.end(JSON.stringify(showPayload()));
      return;
    }
    response.statusCode = 404;
    response.end('{}');
  });

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orc-model-create-route-'));
  const databasePath = path.join(directory, 'app.sqlite');
  const environment = { ORC_MASTER_KEY: MASTER_KEY.toString('base64') };
  const app = buildServer({ databasePath, environment });
  registerModelCreateFeature(app, { databasePath, environment });
  try {
    const cookies = await authenticate(app);
    const targetId = await onboard(app, cookies);
    const source = await createSource(app, cookies);
    const route = `/api/v1/targets/${targetId}/modelfiles/${source.id}/revisions/${source.currentRevisionId}`;
    fs.writeFileSync(DOCKER_FIXTURE_LOG, '');

    const noCsrf = await app.inject({
      method: 'POST', url: `${route}/deploy-plan`,
      headers: { cookie: cookieHeader(cookies) },
      payload: { outputModel: OUTPUT_MODEL },
    });
    assert.equal(noCsrf.statusCode, 403);
    assert.equal(createCalls, 0);

    const planned = await app.inject({
      method: 'POST', url: `${route}/deploy-plan`, headers: mutationHeaders(cookies),
      payload: {
        outputModel: 'custom',
        rawText: 'FROM forged:latest',
        system: 'FORGED SYSTEM',
        parameters: { temperature: 99 },
      },
    });
    assert.equal(planned.statusCode, 201);
    const plan = planned.json().plan;
    assert.equal(plan.outputModel, OUTPUT_MODEL);
    assert.equal(plan.baseModel, BASE_MODEL);
    assert.equal(plan.revisionId, source.currentRevisionId);
    const planText = JSON.stringify(plan);
    for (const secret of ['secret system text', 'secret license text', 'hello', 'FORGED SYSTEM', 'forged:latest']) {
      assert.equal(planText.includes(secret), false);
    }
    assert.equal(createCalls, 0);

    const started = await app.inject({
      method: 'POST', url: `${route}/deploy`, headers: mutationHeaders(cookies),
      payload: {
        planId: plan.planId,
        confirmationToken: plan.confirmationToken,
        system: 'FORGED SYSTEM',
        rawText: 'FROM forged:latest',
      },
    });
    assert.equal(started.statusCode, 202);
    const jobId = started.json().job.id;

    const active = await app.inject({
      method: 'GET', url: `/api/v1/targets/${targetId}/model-create/active`,
      headers: { cookie: cookieHeader(cookies) },
    });
    assert.equal(active.statusCode, 200);
    assert.equal(active.json().job.id, jobId);
    assert.equal(['queued', 'running', 'cancelling'].includes(active.json().job.state), true);

    const terminal = await waitForCreateJob(app, cookies, jobId, (job) => ['succeeded', 'failed'].includes(job.state));
    assert.equal(terminal.state, 'succeeded');
    assert.equal(terminal.errorClass, null);
    assert.equal(createCalls, 1);
    assert.equal(showCalls, 1);
    assert.deepEqual(createBody, {
      model: OUTPUT_MODEL,
      stream: true,
      from: BASE_MODEL,
      template: '{{ .Prompt }}',
      system: 'secret system text',
      license: 'secret license text',
      parameters: { temperature: 0.7 },
      messages: [{ role: 'user', content: 'hello\nthere' }],
      renderer: 'qwen3.5',
      parser: 'qwen3.5',
      requires: '0.12.0',
    });
    assert.equal(JSON.stringify(createBody).includes('FORGED SYSTEM'), false);
    assert.equal(JSON.stringify(createBody).includes('forged:latest'), false);

    const noLongerActive = await app.inject({
      method: 'GET', url: `/api/v1/targets/${targetId}/model-create/active`,
      headers: { cookie: cookieHeader(cookies) },
    });
    assert.equal(noLongerActive.statusCode, 200);
    assert.equal(noLongerActive.json().job, null);

    const replay = await app.inject({
      method: 'POST', url: `${route}/deploy`, headers: mutationHeaders(cookies),
      payload: { planId: plan.planId, confirmationToken: plan.confirmationToken },
    });
    assert.equal(replay.statusCode, 409);
    assert.equal(replay.json().error.code, 'DEPLOY_PLAN_ALREADY_USED');
    assert.equal(createCalls, 1);

    const database = openDatabase(databasePath);
    try {
      const auditRows = database.prepare(`
        SELECT parameters_redacted_json FROM audit_events
        WHERE action IN ('modelfile.deploy_plan.created', 'model.create.requested', 'model.create.terminal')
        ORDER BY timestamp, id
      `).all();
      const auditText = JSON.stringify(auditRows);
      for (const secret of ['secret system text', 'secret license text', 'hello', 'FORGED SYSTEM', 'forged:latest']) {
        assert.equal(auditText.includes(secret), false);
      }
      assert.equal(auditText.includes(OUTPUT_MODEL), true);
    } finally {
      database.close();
    }

    const calls = fs.readFileSync(DOCKER_FIXTURE_LOG, 'utf8').trim().split(/\r?\n/u).filter(Boolean);
    assert(calls.length > 0);
    assert(calls.every((line) => line === 'inspect ollama-container-id' || line === 'exec ollama-container-id ollama --version'));
    assert.equal(calls.some((line) => /\b(create|rm|run|stop)\b/u.test(line)), false);
  } finally {
    await app.close();
    await closeServer(ollama);
  }
});
