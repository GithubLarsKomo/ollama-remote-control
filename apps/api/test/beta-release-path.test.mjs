import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { registerAuditFeature } from '../dist/audit-feature.js';
import { registerModelCreateFeature } from '../dist/model-create-feature.js';
import { buildServer } from '../dist/server.js';

const SSH_HOST = process.env.SSH_HOST;
const SSH_PORT = Number(process.env.SSH_PORT ?? '2222');
const SSH_USER = process.env.SSH_USER;
const SSH_PRIVATE_KEY_PATH = process.env.SSH_PRIVATE_KEY_PATH;
const CONTAINER_STATE = process.env.ORC_CONTAINER_STATE;
const HAS_FIXTURE = Boolean(SSH_HOST && SSH_USER && SSH_PRIVATE_KEY_PATH && CONTAINER_STATE);
const MASTER_KEY = Buffer.alloc(32, 0x71);
const PASSWORD = 'beta-release-candidate-password!';
const BASE_MODEL = 'rc-base:latest';
const OUTPUT_MODEL = 'rc-custom:latest';
const BASE_DIGEST = 'a'.repeat(64);
const OUTPUT_DIGEST = 'c'.repeat(64);
const RAW = 'FROM rc-base:latest\nPARAMETER temperature 0.7\n';

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
    name,
    model: name,
    modified_at: '2026-08-12T06:00:00Z',
    size: 4096,
    digest,
    details: {
      format: 'gguf', family: 'fixture', families: ['fixture'], parameter_size: '1B', quantization_level: 'Q4',
    },
  };
}
function tagsPayload(state) {
  return {
    models: [
      ...(state.baseInstalled ? [modelEntry(BASE_MODEL, BASE_DIGEST)] : []),
      ...(state.outputInstalled ? [modelEntry(OUTPUT_MODEL, OUTPUT_DIGEST)] : []),
    ],
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
      response.end(JSON.stringify(tagsPayload(state)));
      return;
    }
    if (request.method === 'GET' && request.url === '/api/ps') {
      response.end(JSON.stringify({ models: [] }));
      return;
    }
    if (request.method === 'POST' && request.url === '/api/pull') {
      state.pullCalls += 1;
      response.setHeader('content-type', 'application/x-ndjson');
      response.write(`${JSON.stringify({ status: 'pulling manifest' })}\n`);
      response.write(`${JSON.stringify({ status: 'pulling layer', digest: `sha256:${BASE_DIGEST}`, total: 100, completed: 20 })}\n`);
      return;
    }
    if (request.method === 'POST' && request.url === '/api/create') {
      state.createCalls += 1;
      const body = await readJsonRequest(request);
      assert.equal(body.model, OUTPUT_MODEL);
      assert.equal(body.from, BASE_MODEL);
      response.setHeader('content-type', 'application/x-ndjson');
      response.write(`${JSON.stringify({ status: 'creating model layer' })}\n`);
      state.outputInstalled = true;
      response.end(`${JSON.stringify({ status: 'success' })}\n`);
      return;
    }
    if (request.method === 'POST' && request.url === '/api/show') {
      const body = await readJsonRequest(request);
      assert.deepEqual(body, { model: OUTPUT_MODEL, verbose: false });
      response.end(JSON.stringify({
        modelfile: 'FROM /root/.ollama/models/blobs/sha256:deadbeef\nPARAMETER temperature 0.7\n',
        parameters: 'temperature 0.7',
        template: '',
        system: '',
        license: '',
        details: { parent_model: BASE_MODEL },
        capabilities: ['completion'],
        model_info: { 'general.architecture': 'fixture' },
      }));
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
      displayName: 'Beta RC fixture', hostname: SSH_HOST, port: SSH_PORT, username: SSH_USER,
      confirmedFingerprint: probe.json().fingerprint,
      privateKey: fs.readFileSync(SSH_PRIVATE_KEY_PATH, 'utf8'),
    },
  });
  assert.equal(created.statusCode, 201);
  const hostId = created.json().host.id;
  const target = await app.inject({
    method: 'POST', url: `/api/v1/hosts/${hostId}/targets`, headers: mutationHeaders(cookies),
    payload: { containerId: 'ollama-container-id', displayName: 'Beta RC Ollama' },
  });
  assert.equal(target.statusCode, 201);
  return target.json().target.id;
}
async function waitForCoreJob(app, cookies, jobId, predicate, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await app.inject({ method: 'GET', url: `/api/v1/jobs/${jobId}`, headers: { cookie: cookieHeader(cookies) } });
    assert.equal(response.statusCode, 200);
    const job = response.json().job;
    if (predicate(job)) return job;
    await delay(50);
  }
  assert.fail(`Timed out waiting for core job ${jobId}.`);
}
async function waitForPullRequest(state, expectedCount, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (state.pullCalls >= expectedCount) return;
    await delay(25);
  }
  assert.fail(`Timed out waiting for ${expectedCount} Ollama pull request(s).`);
}
async function waitForCreateJob(app, cookies, jobId, predicate, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await app.inject({ method: 'GET', url: `/api/v1/model-create-jobs/${jobId}`, headers: { cookie: cookieHeader(cookies) } });
    assert.equal(response.statusCode, 200);
    const job = response.json().job;
    if (predicate(job)) return job;
    await delay(50);
  }
  assert.fail(`Timed out waiting for create job ${jobId}.`);
}
function buildRcApp(databasePath, environment) {
  const app = buildServer({ databasePath, environment });
  registerModelCreateFeature(app, { databasePath, environment });
  registerAuditFeature(app, { databasePath });
  return app;
}

test('0.1 beta joined release path survives browser/app reconnect and preserves verified state', { skip: !HAS_FIXTURE }, async () => {
  fs.writeFileSync('/tmp/orc-docker-fixture-mode', 'single');
  fs.writeFileSync('/tmp/orc-status-fixture-mode', 'normal');
  fs.writeFileSync(CONTAINER_STATE, 'running');
  const state = { baseInstalled: false, outputInstalled: false, pullCalls: 0, createCalls: 0 };
  const ollama = await listenOllama(state);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orc-beta-release-path-'));
  const databasePath = path.join(directory, 'app.sqlite');
  const environment = { ORC_MASTER_KEY: MASTER_KEY.toString('base64') };
  let app = buildRcApp(databasePath, environment);

  try {
    const setup = await app.inject({ method: 'POST', url: '/api/v1/setup/admin', payload: { username: 'admin', password: PASSWORD } });
    assert.equal(setup.statusCode, 201);
    let cookies = await login(app);
    const targetId = await onboard(app, cookies);

    const initialInventory = await app.inject({
      method: 'GET', url: `/api/v1/targets/${targetId}/models`, headers: { cookie: cookieHeader(cookies) },
    });
    assert.equal(initialInventory.statusCode, 200);
    assert.equal(initialInventory.json().installed.length, 0);

    const pull = await app.inject({
      method: 'POST', url: `/api/v1/targets/${targetId}/models/pull`, headers: mutationHeaders(cookies),
      payload: { model: BASE_MODEL },
    });
    assert.equal(pull.statusCode, 202);
    const pullJobId = pull.json().job.id;
    await waitForCoreJob(app, cookies, pullJobId, (job) => job.state === 'running');
    await waitForPullRequest(state, 1);
    assert.equal(state.pullCalls, 1);

    const reconnected = await app.inject({
      method: 'GET', url: `/api/v1/targets/${targetId}/models/pull/active`, headers: { cookie: cookieHeader(cookies) },
    });
    assert.equal(reconnected.statusCode, 200);
    assert.equal(reconnected.json().job.id, pullJobId);

    await app.close();
    state.baseInstalled = true;

    app = buildRcApp(databasePath, environment);
    cookies = await login(app);
    const reconciled = await waitForCoreJob(app, cookies, pullJobId, (job) => job.state === 'succeeded');
    assert.equal(reconciled.errorClass, null);
    assert.equal(state.pullCalls, 1, 'restart reconciliation must not replay POST /api/pull');

    const inventory = await app.inject({
      method: 'GET', url: `/api/v1/targets/${targetId}/models`, headers: { cookie: cookieHeader(cookies) },
    });
    assert.equal(inventory.statusCode, 200);
    assert.deepEqual(inventory.json().installed.map((model) => model.name), [BASE_MODEL]);

    const source = await app.inject({
      method: 'POST', url: '/api/v1/modelfiles', headers: mutationHeaders(cookies),
      payload: { displayName: 'Beta RC custom model', rawText: RAW },
    });
    assert.equal(source.statusCode, 201);
    const modelfile = source.json().modelfile;
    const deployRoute = `/api/v1/targets/${targetId}/modelfiles/${modelfile.id}/revisions/${modelfile.currentRevisionId}`;
    const planned = await app.inject({
      method: 'POST', url: `${deployRoute}/deploy-plan`, headers: mutationHeaders(cookies),
      payload: { outputModel: OUTPUT_MODEL },
    });
    assert.equal(planned.statusCode, 201);
    const plan = planned.json().plan;
    assert.equal(plan.outputModel, OUTPUT_MODEL);
    assert.equal(plan.baseModel, BASE_MODEL);

    const deploy = await app.inject({
      method: 'POST', url: `${deployRoute}/deploy`, headers: mutationHeaders(cookies),
      payload: { planId: plan.planId, confirmationToken: plan.confirmationToken },
    });
    assert.equal(deploy.statusCode, 202);
    const createJob = await waitForCreateJob(app, cookies, deploy.json().job.id, (job) => job.state === 'succeeded');
    assert.equal(createJob.errorClass, null);
    assert.equal(state.createCalls, 1);

    const finalInventory = await app.inject({
      method: 'GET', url: `/api/v1/targets/${targetId}/models`, headers: { cookie: cookieHeader(cookies) },
    });
    assert.equal(finalInventory.statusCode, 200);
    assert.deepEqual(new Set(finalInventory.json().installed.map((model) => model.name)), new Set([BASE_MODEL, OUTPUT_MODEL]));

    const audit = await app.inject({ method: 'GET', url: '/api/v1/audit?limit=100', headers: { cookie: cookieHeader(cookies) } });
    assert.equal(audit.statusCode, 200);
    const actions = new Set(audit.json().events.map((event) => event.action));
    for (const action of ['host.create', 'model.pull.requested', 'modelfile.create', 'modelfile.deploy_plan.created', 'model.create.requested']) {
      assert.equal(actions.has(action), true, `missing joined-path audit action ${action}`);
    }

    await app.close();
    app = buildRcApp(databasePath, environment);
    cookies = await login(app);
    const persisted = await app.inject({
      method: 'GET', url: `/api/v1/targets/${targetId}/models`, headers: { cookie: cookieHeader(cookies) },
    });
    assert.equal(persisted.statusCode, 200);
    assert.deepEqual(new Set(persisted.json().installed.map((model) => model.name)), new Set([BASE_MODEL, OUTPUT_MODEL]));
  } finally {
    await app.close();
    await closeServer(ollama);
  }
});