import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildServer } from '../dist/server.js';

const SSH_HOST = process.env.SSH_HOST;
const SSH_PORT = Number(process.env.SSH_PORT ?? '2222');
const SSH_USER = process.env.SSH_USER;
const SSH_PRIVATE_KEY_PATH = process.env.SSH_PRIVATE_KEY_PATH;
const DOCKER_FIXTURE_LOG = process.env.ORC_DOCKER_FIXTURE_LOG;
const CONTAINER_STATE = process.env.ORC_CONTAINER_STATE;
const HAS_FIXTURE = Boolean(SSH_HOST && SSH_USER && SSH_PRIVATE_KEY_PATH && DOCKER_FIXTURE_LOG && CONTAINER_STATE);
const MASTER_KEY = Buffer.alloc(32, 0x75);
const PASSWORD = 'model-detail-route-admin-password!';
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

async function onboard(app, cookies) {
  const probe = await app.inject({
    method: 'POST', url: '/api/v1/hosts/probe', headers: mutationHeaders(cookies),
    payload: { hostname: SSH_HOST, port: SSH_PORT },
  });
  assert.equal(probe.statusCode, 200);
  const create = await app.inject({
    method: 'POST', url: '/api/v1/hosts', headers: mutationHeaders(cookies),
    payload: {
      displayName: 'Model detail route host', hostname: SSH_HOST, port: SSH_PORT, username: SSH_USER,
      confirmedFingerprint: probe.json().fingerprint,
      privateKey: fs.readFileSync(SSH_PRIVATE_KEY_PATH, 'utf8'),
    },
  });
  assert.equal(create.statusCode, 201);
  const hostId = create.json().host.id;
  const selected = await app.inject({
    method: 'POST', url: `/api/v1/hosts/${hostId}/targets`, headers: mutationHeaders(cookies),
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

async function listenServer(requests) {
  const server = http.createServer(async (request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.method === 'GET' && request.url === '/api/tags') {
      requests.push({ method: request.method, url: request.url, body: null });
      response.end(JSON.stringify({
        models: [{
          name: 'hf.co/example/model:Q4_K_M', model: 'hf.co/example/model:Q4_K_M',
          modified_at: '2026-08-09T05:00:00Z', size: 123456, digest: DIGEST,
          details: { format: 'gguf', family: 'qwen3', families: ['qwen3'], parameter_size: '9B', quantization_level: 'Q4_K_M' },
          secret: 'UPSTREAM-SECRET',
        }],
      }));
      return;
    }
    if (request.method === 'POST' && request.url === '/api/show') {
      const body = await readJsonRequest(request);
      requests.push({ method: request.method, url: request.url, body });
      response.end(JSON.stringify({
        modelfile: '# generated\nFROM /root/.ollama/models/blobs/sha256:abc\nPARAMETER num_ctx 32768',
        parameters: 'num_ctx 32768',
        template: '{{ .Prompt }}',
        system: 'Safe system prompt',
        license: 'Safe license',
        details: { parent_model: '', secret: 'UPSTREAM-SECRET' },
        capabilities: ['completion', 'tools'],
        model_info: {
          'general.architecture': 'qwen3',
          'general.parameter_count': 9000000000,
          'qwen3.context_length': 32768,
          'tokenizer.ggml.tokens': ['UPSTREAM-SECRET'],
        },
        tensors: [{ secret: 'UPSTREAM-SECRET' }],
        remote_host: 'UPSTREAM-SECRET',
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
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

test('model detail route requires auth and returns only normalized read-only detail fields', { skip: !HAS_FIXTURE }, async () => {
  fs.writeFileSync(DOCKER_FIXTURE_LOG, '');
  fs.writeFileSync(CONTAINER_STATE, 'running');
  fs.writeFileSync('/tmp/orc-status-fixture-mode', 'normal');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orc-model-detail-route-'));
  const app = buildServer({
    databasePath: path.join(directory, 'app.sqlite'),
    environment: { ORC_MASTER_KEY: MASTER_KEY.toString('base64') },
  });
  const requests = [];
  const modelServer = await listenServer(requests);
  try {
    const unauthenticated = await app.inject({
      method: 'GET',
      url: '/api/v1/targets/not-yet/model-details?model=model-a%3Alatest',
    });
    assert.equal(unauthenticated.statusCode, 401);
    assert.equal(fs.readFileSync(DOCKER_FIXTURE_LOG, 'utf8'), '');
    assert.deepEqual(requests, []);

    await app.inject({ method: 'POST', url: '/api/v1/setup/admin', payload: { username: 'admin', password: PASSWORD } });
    const login = await app.inject({ method: 'POST', url: '/api/v1/session', payload: { username: 'admin', password: PASSWORD } });
    const cookies = cookiesFrom(login);
    const targetId = await onboard(app, cookies);
    fs.writeFileSync(DOCKER_FIXTURE_LOG, '');
    requests.length = 0;

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/targets/${targetId}/model-details?model=${encodeURIComponent('hf.co/example/model:Q4_K_M')}`,
      headers: { cookie: cookieHeader(cookies) },
    });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.targetId, targetId);
    assert.equal(body.identity.model, 'hf.co/example/model:Q4_K_M');
    assert.equal(body.identity.digest, DIGEST);
    assert.equal(body.architecture.contextLength, 32768);
    assert.deepEqual(body.capabilities, ['completion', 'tools']);
    assert.deepEqual(body.provenancePreview.from, {
      reference: '/root/.ollama/models/blobs/sha256:abc', kind: 'local-artifact',
    });
    assert.equal(JSON.stringify(body).includes('UPSTREAM-SECRET'), false);
    assert.deepEqual(requests, [
      { method: 'GET', url: '/api/tags', body: null },
      { method: 'POST', url: '/api/show', body: { model: 'hf.co/example/model:Q4_K_M', verbose: false } },
    ]);
    assert.deepEqual(fs.readFileSync(DOCKER_FIXTURE_LOG, 'utf8').trim().split(/\r?\n/u).filter(Boolean), [
      'inspect ollama-container-id',
    ]);
  } finally {
    await app.close();
    await closeServer(modelServer);
  }
});

test('invalid model query is rejected before SSH', { skip: !HAS_FIXTURE }, async () => {
  fs.writeFileSync(DOCKER_FIXTURE_LOG, '');
  fs.writeFileSync(CONTAINER_STATE, 'running');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orc-model-detail-invalid-route-'));
  const app = buildServer({
    databasePath: path.join(directory, 'app.sqlite'),
    environment: { ORC_MASTER_KEY: MASTER_KEY.toString('base64') },
  });
  try {
    await app.inject({ method: 'POST', url: '/api/v1/setup/admin', payload: { username: 'admin', password: PASSWORD } });
    const login = await app.inject({ method: 'POST', url: '/api/v1/session', payload: { username: 'admin', password: PASSWORD } });
    const cookies = cookiesFrom(login);
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/targets/not-needed/model-details?model=bad%20model',
      headers: { cookie: cookieHeader(cookies) },
    });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error.code, 'INVALID_MODEL_NAME');
    assert.equal(fs.readFileSync(DOCKER_FIXTURE_LOG, 'utf8'), '');
  } finally {
    await app.close();
  }
});
