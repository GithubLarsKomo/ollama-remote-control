import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openDatabase } from '@orc/db';
import { buildServer } from '../dist/server.js';

const SSH_HOST = process.env.SSH_HOST;
const SSH_PORT = Number(process.env.SSH_PORT ?? '2222');
const SSH_USER = process.env.SSH_USER;
const SSH_PRIVATE_KEY_PATH = process.env.SSH_PRIVATE_KEY_PATH;
const DOCKER_FIXTURE_LOG = process.env.ORC_DOCKER_FIXTURE_LOG;
const CONTAINER_STATE = process.env.ORC_CONTAINER_STATE;
const HAS_FIXTURE = Boolean(SSH_HOST && SSH_USER && SSH_PRIVATE_KEY_PATH && DOCKER_FIXTURE_LOG && CONTAINER_STATE);
const STATUS_MODE = '/tmp/orc-status-fixture-mode';
const MASTER_KEY = Buffer.alloc(32, 0x75);
const PASSWORD = 'ollama-health-route-admin-password!';

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

function resetFixture() {
  if (!HAS_FIXTURE) return;
  fs.writeFileSync(DOCKER_FIXTURE_LOG, '');
  fs.writeFileSync(CONTAINER_STATE, 'running');
  fs.writeFileSync(STATUS_MODE, 'normal');
}

async function listenVersionServer() {
  const server = http.createServer((request, response) => {
    assert.equal(request.method, 'GET');
    assert.equal(request.url, '/api/version');
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ version: '0.32.5' }));
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

async function bootstrapTarget(app) {
  const setup = await app.inject({
    method: 'POST',
    url: '/api/v1/setup/admin',
    payload: { username: 'admin', password: PASSWORD },
  });
  assert.equal(setup.statusCode, 201);
  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/session',
    payload: { username: 'admin', password: PASSWORD },
  });
  assert.equal(login.statusCode, 200);
  const cookies = cookiesFrom(login);
  const probe = await app.inject({
    method: 'POST',
    url: '/api/v1/hosts/probe',
    headers: mutationHeaders(cookies),
    payload: { hostname: SSH_HOST, port: SSH_PORT },
  });
  assert.equal(probe.statusCode, 200);
  const host = await app.inject({
    method: 'POST',
    url: '/api/v1/hosts',
    headers: mutationHeaders(cookies),
    payload: {
      displayName: 'Health route host',
      hostname: SSH_HOST,
      port: SSH_PORT,
      username: SSH_USER,
      confirmedFingerprint: probe.json().fingerprint,
      privateKey: fs.readFileSync(SSH_PRIVATE_KEY_PATH, 'utf8'),
    },
  });
  assert.equal(host.statusCode, 201);
  const target = await app.inject({
    method: 'POST',
    url: `/api/v1/hosts/${host.json().host.id}/targets`,
    headers: mutationHeaders(cookies),
    payload: { containerId: 'ollama-container-id', displayName: 'Primary Ollama' },
  });
  assert.equal(target.statusCode, 201);
  return { cookies, targetId: target.json().target.id };
}

test('target health route is authenticated, read-only and exposes only safe health data', { skip: !HAS_FIXTURE }, async () => {
  resetFixture();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orc-health-route-'));
  const databasePath = path.join(directory, 'app.sqlite');
  const app = buildServer({ databasePath, environment: { ORC_MASTER_KEY: MASTER_KEY.toString('base64') } });
  const versionServer = await listenVersionServer();
  try {
    const unauthenticated = await app.inject({
      method: 'GET',
      url: '/api/v1/targets/not-a-target/health',
    });
    assert.equal(unauthenticated.statusCode, 401);
    assert.equal(unauthenticated.json().error.code, 'UNAUTHENTICATED');
    assert.equal(fs.readFileSync(DOCKER_FIXTURE_LOG, 'utf8'), '');

    const { cookies, targetId } = await bootstrapTarget(app);
    fs.writeFileSync(DOCKER_FIXTURE_LOG, '');
    const healthy = await app.inject({
      method: 'GET',
      url: `/api/v1/targets/${targetId}/health`,
      headers: { cookie: cookieHeader(cookies) },
    });
    assert.equal(healthy.statusCode, 200);
    assert.equal(healthy.json().status, 'healthy');
    assert.equal(healthy.json().container.running, true);
    assert.equal(healthy.json().ollama.cliVersion, '0.32.5');
    assert.equal(healthy.json().ollama.apiVersion, '0.32.5');
    assert.equal(healthy.json().ollama.versionMatch, true);
    assert.equal(healthy.json().transport.mode, 'published-binding');
    assert.equal(healthy.body.includes('127.0.0.1'), false);
    assert.equal(healthy.body.includes('OLLAMA_API_KEY'), false);
    assert.equal(healthy.body.includes('top-secret'), false);

    const database = openDatabase(databasePath);
    try {
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM jobs').get().count, 0);
      assert.equal(database.prepare('SELECT COUNT(*) AS count FROM update_snapshots').get().count, 0);
    } finally {
      database.close();
    }

    fs.writeFileSync(CONTAINER_STATE, 'stopped');
    fs.writeFileSync(DOCKER_FIXTURE_LOG, '');
    const stopped = await app.inject({
      method: 'GET',
      url: `/api/v1/targets/${targetId}/health`,
      headers: { cookie: cookieHeader(cookies) },
    });
    assert.equal(stopped.statusCode, 409);
    assert.equal(stopped.json().error.code, 'CONTAINER_NOT_RUNNING');
    assert.equal(stopped.body.includes('top-secret'), false);
    assert.deepEqual(
      fs.readFileSync(DOCKER_FIXTURE_LOG, 'utf8').trim().split(/\r?\n/u).filter(Boolean),
      ['inspect ollama-container-id'],
    );
  } finally {
    await app.close();
    await closeServer(versionServer);
    resetFixture();
  }
});
