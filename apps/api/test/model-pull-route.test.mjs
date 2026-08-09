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
const DOCKER_FIXTURE_LOG = process.env.ORC_DOCKER_FIXTURE_LOG;
const CONTAINER_STATE = process.env.ORC_CONTAINER_STATE;
const HAS_FIXTURE = Boolean(SSH_HOST && SSH_USER && SSH_PRIVATE_KEY_PATH && DOCKER_FIXTURE_LOG && CONTAINER_STATE);
const MASTER_KEY = Buffer.alloc(32, 0x61);
const PASSWORD = 'model-pull-admin-password!';
const MODEL = 'model-pull-fixture:latest';
const DIGEST = 'c'.repeat(64);

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
      displayName: 'Pull fixture host', hostname: SSH_HOST, port: SSH_PORT, username: SSH_USER,
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

async function loginAndTarget(app) {
  await app.inject({ method: 'POST', url: '/api/v1/setup/admin', payload: { username: 'admin', password: PASSWORD } });
  const login = await app.inject({ method: 'POST', url: '/api/v1/session', payload: { username: 'admin', password: PASSWORD } });
  assert.equal(login.statusCode, 200);
  const cookies = cookiesFrom(login);
  const targetId = await onboard(app, cookies);
  return { cookies, targetId };
}

function installedResponse(installed) {
  return {
    models: installed ? [{
      name: MODEL,
      model: MODEL,
      modified_at: '2026-08-09T06:00:00Z',
      size: 4096,
      digest: DIGEST,
      details: { format: 'gguf', family: 'fixture', families: ['fixture'], parameter_size: '1B', quantization_level: 'Q4' },
    }] : [],
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
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function waitForJob(app, cookies, jobId, predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/jobs/${jobId}`,
      headers: { cookie: cookieHeader(cookies) },
    });
    assert.equal(response.statusCode, 200);
    const job = response.json().job;
    if (predicate(job)) return job;
    await delay(50);
  }
  assert.fail('Timed out waiting for model pull job state.');
}

function parseSse(text) {
  return text.split('\n\n').filter((frame) => frame.includes('event: ')).map((frame) => ({
    id: frame.split('\n').find((line) => line.startsWith('id: '))?.slice(4) ?? null,
    event: frame.split('\n').find((line) => line.startsWith('event: '))?.slice(7) ?? '',
    data: JSON.parse(frame.split('\n').find((line) => line.startsWith('data: '))?.slice(6) ?? '{}'),
  }));
}

test('model pull route streams through pinned SSH, persists progress and verifies installed model', { skip: !HAS_FIXTURE }, async () => {
  fs.writeFileSync('/tmp/orc-docker-fixture-mode', 'single');
  fs.writeFileSync('/tmp/orc-status-fixture-mode', 'normal');
  fs.writeFileSync(CONTAINER_STATE, 'running');
  fs.writeFileSync(DOCKER_FIXTURE_LOG, '');
  let installed = false;
  let pullBody = null;
  const ollama = await listenOllama((request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.method === 'GET' && request.url === '/api/tags') {
      response.end(JSON.stringify(installedResponse(installed)));
      return;
    }
    if (request.method === 'GET' && request.url === '/api/ps') {
      response.end(JSON.stringify({ models: [] }));
      return;
    }
    if (request.method === 'POST' && request.url === '/api/pull') {
      let body = '';
      request.setEncoding('utf8');
      request.on('data', (chunk) => { body += chunk; });
      request.on('end', () => {
        pullBody = JSON.parse(body);
        response.setHeader('content-type', 'application/x-ndjson');
        response.write(`${JSON.stringify({ status: 'pulling manifest' })}\n`);
        response.write(`${JSON.stringify({ status: 'pulling layer', digest: `sha256:${DIGEST}`, total: 1000, completed: 500 })}\n`);
        response.write(`${JSON.stringify({ status: 'pulling layer', digest: `sha256:${DIGEST}`, total: 1000, completed: 1000 })}\n`);
        installed = true;
        response.end(`${JSON.stringify({ status: 'success' })}\n`);
      });
      return;
    }
    response.statusCode = 404;
    response.end('{}');
  });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orc-model-pull-'));
  const app = buildServer({
    databasePath: path.join(directory, 'app.sqlite'),
    environment: { ORC_MASTER_KEY: MASTER_KEY.toString('base64') },
  });
  try {
    const { cookies, targetId } = await loginAndTarget(app);
    fs.writeFileSync(DOCKER_FIXTURE_LOG, '');

    const invalid = await app.inject({
      method: 'POST', url: `/api/v1/targets/${targetId}/models/pull`, headers: mutationHeaders(cookies),
      payload: { model: 'bad model;not-allowed' },
    });
    assert.equal(invalid.statusCode, 400);
    assert.equal(invalid.json().error.code, 'INVALID_MODEL_NAME');
    assert.equal(fs.readFileSync(DOCKER_FIXTURE_LOG, 'utf8'), '');

    const started = await app.inject({
      method: 'POST', url: `/api/v1/targets/${targetId}/models/pull`, headers: mutationHeaders(cookies),
      payload: { model: MODEL },
    });
    assert.equal(started.statusCode, 202);
    const jobId = started.json().job.id;
    const terminal = await waitForJob(app, cookies, jobId, (job) => ['succeeded', 'failed'].includes(job.state));
    assert.equal(terminal.state, 'succeeded');
    assert.equal(terminal.errorClass, null);
    assert.deepEqual(pullBody, { model: MODEL, stream: true });

    const calls = fs.readFileSync(DOCKER_FIXTURE_LOG, 'utf8').trim().split(/\r?\n/u).filter(Boolean);
    assert(calls.length >= 3);
    assert(calls.every((line) => line === 'inspect ollama-container-id'));
    assert.equal(calls.some((line) => /\b(pull|run|create|rm|stop)\b/u.test(line)), false);

    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    assert(address && typeof address === 'object');
    const eventsResponse = await fetch(`http://127.0.0.1:${address.port}/api/v1/jobs/${jobId}/events`, {
      headers: { cookie: cookieHeader(cookies) },
    });
    assert.equal(eventsResponse.status, 200);
    const frames = parseSse(await eventsResponse.text());
    assert(frames.some((frame) => frame.event === 'pull-request' && frame.data.model === MODEL));
    assert(frames.some((frame) => frame.event === 'progress' && frame.data.percentage === 50));
    assert(frames.some((frame) => frame.event === 'progress' && frame.data.percentage === 100));
    assert(frames.some((frame) => frame.event === 'state' && frame.data.state === 'succeeded'));
    assert(frames.some((frame) => frame.event === 'end' && frame.data.job.state === 'succeeded'));
    assert(frames.filter((frame) => frame.id !== null).every((frame) => /^\d+$/u.test(frame.id)));
  } finally {
    await app.close();
    await closeServer(ollama);
  }
});

test('running pull cancellation tears down local request and terminalizes as CANCEL_UNVERIFIED', { skip: !HAS_FIXTURE }, async () => {
  fs.writeFileSync('/tmp/orc-docker-fixture-mode', 'single');
  fs.writeFileSync('/tmp/orc-status-fixture-mode', 'normal');
  fs.writeFileSync(CONTAINER_STATE, 'running');
  let remoteClosed = false;
  const ollama = await listenOllama((request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.method === 'GET' && request.url === '/api/tags') {
      response.end(JSON.stringify(installedResponse(false)));
      return;
    }
    if (request.method === 'GET' && request.url === '/api/ps') {
      response.end(JSON.stringify({ models: [] }));
      return;
    }
    if (request.method === 'POST' && request.url === '/api/pull') {
      response.setHeader('content-type', 'application/x-ndjson');
      response.write(`${JSON.stringify({ status: 'pulling manifest' })}\n`);
      response.write(`${JSON.stringify({ status: 'pulling layer', digest: `sha256:${DIGEST}`, total: 1000, completed: 100 })}\n`);
      request.once('close', () => { remoteClosed = true; });
      response.once('close', () => { remoteClosed = true; });
      return;
    }
    response.statusCode = 404;
    response.end('{}');
  });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orc-model-pull-cancel-'));
  const app = buildServer({
    databasePath: path.join(directory, 'app.sqlite'),
    environment: { ORC_MASTER_KEY: MASTER_KEY.toString('base64') },
  });
  try {
    const { cookies, targetId } = await loginAndTarget(app);
    const started = await app.inject({
      method: 'POST', url: `/api/v1/targets/${targetId}/models/pull`, headers: mutationHeaders(cookies),
      payload: { model: MODEL },
    });
    assert.equal(started.statusCode, 202);
    const jobId = started.json().job.id;
    await waitForJob(app, cookies, jobId, (job) => job.state === 'running');

    const cancelled = await app.inject({
      method: 'POST', url: `/api/v1/jobs/${jobId}/cancel`, headers: mutationHeaders(cookies), payload: {},
    });
    assert.equal(cancelled.statusCode, 200);
    assert.equal(cancelled.json().job.state, 'cancelling');

    const terminal = await waitForJob(app, cookies, jobId, (job) => job.state === 'failed');
    assert.equal(terminal.errorClass, 'CANCEL_UNVERIFIED');
    const deadline = Date.now() + 3000;
    while (!remoteClosed && Date.now() < deadline) await delay(50);
    assert.equal(remoteClosed, true);
  } finally {
    await app.close();
    await closeServer(ollama);
  }
});
