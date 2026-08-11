import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { registerModelCreateFeature } from '../dist/model-create-feature.js';
import { buildServer } from '../dist/server.js';

const SSH_HOST = process.env.SSH_HOST;
const SSH_PORT = Number(process.env.SSH_PORT ?? '2222');
const SSH_USER = process.env.SSH_USER;
const SSH_PRIVATE_KEY_PATH = process.env.SSH_PRIVATE_KEY_PATH;
const DOCKER_FIXTURE_LOG = process.env.ORC_DOCKER_FIXTURE_LOG;
const CONTAINER_STATE = process.env.ORC_CONTAINER_STATE;
const HAS_FIXTURE = Boolean(SSH_HOST && SSH_USER && SSH_PRIVATE_KEY_PATH && DOCKER_FIXTURE_LOG && CONTAINER_STATE);
const MASTER_KEY = Buffer.alloc(32, 0x58);
const PASSWORD = 'replace-race-admin-password!';
const BASE_MODEL = 'base:latest';
const OUTPUT_MODEL = 'custom:latest';
const BASE_DIGEST = 'b'.repeat(64);
const OLD_DIGEST = 'c'.repeat(64);
const NEW_DIGEST = 'd'.repeat(64);
const RAW = 'FROM base:latest\nPARAMETER temperature 0.7\n';

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
function modelEntry(name, digest, size = 4096) {
  return {
    name, model: name, modified_at: '2026-08-11T00:00:00Z', size, digest,
    details: { format: 'gguf', family: 'fixture', families: ['fixture'], parameter_size: '1B', quantization_level: 'Q4' },
  };
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
async function authenticate(app) {
  assert.equal((await app.inject({ method: 'POST', url: '/api/v1/setup/admin', payload: { username: 'admin', password: PASSWORD } })).statusCode, 201);
  const login = await app.inject({ method: 'POST', url: '/api/v1/session', payload: { username: 'admin', password: PASSWORD } });
  assert.equal(login.statusCode, 200);
  return cookiesFrom(login);
}
async function onboard(app, cookies) {
  const probe = await app.inject({ method: 'POST', url: '/api/v1/hosts/probe', headers: mutationHeaders(cookies), payload: { hostname: SSH_HOST, port: SSH_PORT } });
  assert.equal(probe.statusCode, 200);
  const created = await app.inject({
    method: 'POST', url: '/api/v1/hosts', headers: mutationHeaders(cookies),
    payload: {
      displayName: 'Replace race fixture', hostname: SSH_HOST, port: SSH_PORT, username: SSH_USER,
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

test('replace plan is invalidated if destination digest changes before confirmation', { skip: !HAS_FIXTURE }, async () => {
  fs.writeFileSync('/tmp/orc-docker-fixture-mode', 'single');
  fs.writeFileSync('/tmp/orc-status-fixture-mode', 'normal');
  fs.writeFileSync(CONTAINER_STATE, 'running');
  fs.writeFileSync(DOCKER_FIXTURE_LOG, '');
  let destinationDigest = OLD_DIGEST;
  let createCalls = 0;
  const ollama = await listenOllama(async (request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.method === 'GET' && request.url === '/api/version') {
      response.end(JSON.stringify({ version: '0.32.5' }));
      return;
    }
    if (request.method === 'GET' && request.url === '/api/tags') {
      response.end(JSON.stringify({ models: [
        modelEntry(BASE_MODEL, BASE_DIGEST, 1024),
        modelEntry(OUTPUT_MODEL, destinationDigest, 8192),
      ] }));
      return;
    }
    if (request.method === 'GET' && request.url === '/api/ps') {
      response.end(JSON.stringify({ models: [] }));
      return;
    }
    if (request.method === 'POST' && request.url === '/api/create') {
      createCalls += 1;
      response.statusCode = 500;
      response.end(JSON.stringify({ error: 'must not be called after stale replacement authority' }));
      return;
    }
    response.statusCode = 404;
    response.end('{}');
  });

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orc-model-replace-race-'));
  const databasePath = path.join(directory, 'app.sqlite');
  const environment = { ORC_MASTER_KEY: MASTER_KEY.toString('base64') };
  const app = buildServer({ databasePath, environment });
  registerModelCreateFeature(app, { databasePath, environment });
  try {
    const cookies = await authenticate(app);
    const targetId = await onboard(app, cookies);
    const sourceResponse = await app.inject({
      method: 'POST', url: '/api/v1/modelfiles', headers: mutationHeaders(cookies),
      payload: { displayName: 'Replace source', rawText: RAW },
    });
    assert.equal(sourceResponse.statusCode, 201);
    const source = sourceResponse.json().modelfile;
    const route = `/api/v1/targets/${targetId}/modelfiles/${source.id}/revisions/${source.currentRevisionId}`;

    const ordinaryCollision = await app.inject({
      method: 'POST', url: `${route}/deploy-plan`, headers: mutationHeaders(cookies),
      payload: { outputModel: OUTPUT_MODEL },
    });
    assert.equal(ordinaryCollision.statusCode, 409);
    assert.equal(ordinaryCollision.json().error.code, 'DEPLOY_DESTINATION_EXISTS');

    const planned = await app.inject({
      method: 'POST', url: `${route}/deploy-plan`, headers: mutationHeaders(cookies),
      payload: { outputModel: OUTPUT_MODEL, replaceExisting: true, existingDigest: 'forged' },
    });
    assert.equal(planned.statusCode, 201);
    const plan = planned.json().plan;
    assert.equal(plan.replacement.existingDigest, OLD_DIGEST);
    assert.equal(plan.replacement.existingSizeBytes, 8192);
    assert.equal(JSON.stringify(plan).includes('forged'), false);

    destinationDigest = NEW_DIGEST;

    const confirm = await app.inject({
      method: 'POST', url: `${route}/deploy`, headers: mutationHeaders(cookies),
      payload: { planId: plan.planId, confirmationToken: plan.confirmationToken },
    });
    assert.equal(confirm.statusCode, 409);
    assert.equal(confirm.json().error.code, 'DEPLOY_DESTINATION_STALE');
    assert.equal(createCalls, 0);
  } finally {
    await app.close();
    await closeServer(ollama);
  }
});