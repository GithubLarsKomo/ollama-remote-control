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
const MASTER_KEY = Buffer.alloc(32, 0x72);
const PASSWORD = 'model-route-admin-password!';
const DIGEST = 'b'.repeat(64);

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
      displayName: 'Model route host', hostname: SSH_HOST, port: SSH_PORT, username: SSH_USER,
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

async function listenServer() {
  const server = http.createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url === '/api/tags') {
      response.end(JSON.stringify({
        models: [{
          name: 'model-a:latest', model: 'model-a:latest', modified_at: '2026-08-08T19:00:00Z',
          size: 123456, digest: DIGEST,
          details: { format: 'gguf', family: 'test', families: ['test'], parameter_size: '1B', quantization_level: 'Q4' },
          secret: 'UPSTREAM-SECRET',
        }],
        secret: 'UPSTREAM-SECRET',
      }));
      return;
    }
    if (request.url === '/api/ps') {
      response.end(JSON.stringify({
        models: [{
          name: 'model-a:latest', model: 'model-a:latest', size: 123456, digest: DIGEST,
          details: { format: 'gguf', family: 'test', families: ['test'], parameter_size: '1B', quantization_level: 'Q4' },
          expires_at: '2026-08-08T22:00:00Z', size_vram: 100000, context_length: 8192,
          secret: 'UPSTREAM-SECRET',
        }],
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

test('model inventory route requires auth before SSH and returns only normalized fields', { skip: !HAS_FIXTURE }, async () => {
  fs.writeFileSync(DOCKER_FIXTURE_LOG, '');
  fs.writeFileSync(CONTAINER_STATE, 'running');
  fs.writeFileSync('/tmp/orc-status-fixture-mode', 'normal');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orc-model-route-'));
  const app = buildServer({
    databasePath: path.join(directory, 'app.sqlite'),
    environment: { ORC_MASTER_KEY: MASTER_KEY.toString('base64') },
  });
  const modelServer = await listenServer();
  try {
    const unauthenticated = await app.inject({ method: 'GET', url: '/api/v1/targets/not-yet/models' });
    assert.equal(unauthenticated.statusCode, 401);
    assert.equal(fs.readFileSync(DOCKER_FIXTURE_LOG, 'utf8'), '');

    await app.inject({ method: 'POST', url: '/api/v1/setup/admin', payload: { username: 'admin', password: PASSWORD } });
    const login = await app.inject({ method: 'POST', url: '/api/v1/session', payload: { username: 'admin', password: PASSWORD } });
    const cookies = cookiesFrom(login);
    const targetId = await onboard(app, cookies);
    fs.writeFileSync(DOCKER_FIXTURE_LOG, '');

    const response = await app.inject({
      method: 'GET', url: `/api/v1/targets/${targetId}/models`, headers: { cookie: cookieHeader(cookies) },
    });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.targetId, targetId);
    assert.deepEqual(body.transport, { mode: 'published-binding' });
    assert.equal(body.installed[0].name, 'model-a:latest');
    assert.equal(body.running[0].sizeVramBytes, 100000);
    assert.equal(JSON.stringify(body).includes('UPSTREAM-SECRET'), false);
    assert.deepEqual(fs.readFileSync(DOCKER_FIXTURE_LOG, 'utf8').trim().split(/\r?\n/u).filter(Boolean), [
      'inspect ollama-container-id',
    ]);
  } finally {
    await app.close();
    await closeServer(modelServer);
  }
});
