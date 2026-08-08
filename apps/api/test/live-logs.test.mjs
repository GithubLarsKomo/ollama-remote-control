import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { buildServer } from '../dist/server.js';
import { parseLogTail } from '../dist/logs.js';

const SSH_HOST = process.env.SSH_HOST;
const SSH_PORT = Number(process.env.SSH_PORT ?? '2222');
const SSH_USER = process.env.SSH_USER;
const SSH_PRIVATE_KEY_PATH = process.env.SSH_PRIVATE_KEY_PATH;
const DOCKER_FIXTURE_LOG = process.env.ORC_DOCKER_FIXTURE_LOG;
const LOG_PROCESS_STATE = process.env.ORC_LOG_PROCESS_STATE;
const LOG_PROCESS_PID = process.env.ORC_LOG_PROCESS_PID;
const HAS_FIXTURE = Boolean(
  SSH_HOST && SSH_USER && SSH_PRIVATE_KEY_PATH && DOCKER_FIXTURE_LOG && LOG_PROCESS_STATE && LOG_PROCESS_PID,
);
const MASTER_KEY = Buffer.alloc(32, 0x4c);
const PASSWORD = 'live-log-admin-password!';

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
  return Object.entries(cookies)
    .map(([name, value]) => `${name}=${encodeURIComponent(value)}`)
    .join('; ');
}

function mutationHeaders(cookies) {
  return {
    cookie: cookieHeader(cookies),
    'x-csrf-token': cookies.orc_csrf,
  };
}

function newApp(prefix) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return buildServer({
    databasePath: path.join(directory, 'app.sqlite'),
    environment: { ORC_MASTER_KEY: MASTER_KEY.toString('base64') },
  });
}

async function login(app) {
  await app.inject({
    method: 'POST',
    url: '/api/v1/setup/admin',
    payload: { username: 'admin', password: PASSWORD },
  });
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/session',
    payload: { username: 'admin', password: PASSWORD },
  });
  assert.equal(response.statusCode, 200);
  return cookiesFrom(response);
}

async function bootstrapSelectedTarget(app) {
  const cookies = await login(app);
  const probe = await app.inject({
    method: 'POST',
    url: '/api/v1/hosts/probe',
    headers: mutationHeaders(cookies),
    payload: { hostname: SSH_HOST, port: SSH_PORT },
  });
  assert.equal(probe.statusCode, 200);
  const hostCreate = await app.inject({
    method: 'POST',
    url: '/api/v1/hosts',
    headers: mutationHeaders(cookies),
    payload: {
      displayName: 'Live log fixture host',
      hostname: SSH_HOST,
      port: SSH_PORT,
      username: SSH_USER,
      confirmedFingerprint: probe.json().fingerprint,
      privateKey: fs.readFileSync(SSH_PRIVATE_KEY_PATH, 'utf8'),
    },
  });
  assert.equal(hostCreate.statusCode, 201);
  const hostId = hostCreate.json().host.id;
  const targetCreate = await app.inject({
    method: 'POST',
    url: `/api/v1/hosts/${hostId}/targets`,
    headers: mutationHeaders(cookies),
    payload: { containerId: 'ollama-container-id', displayName: 'Primary Ollama' },
  });
  assert.equal(targetCreate.statusCode, 201);
  return { cookies, targetId: targetCreate.json().target.id };
}

function parseCompleteSseFrames(text) {
  return text.split('\n\n').filter((frame) => frame.includes('\ndata: ')).map((frame) => {
    const event = frame.split('\n').find((line) => line.startsWith('event: '))?.slice(7) ?? '';
    const data = frame.split('\n').find((line) => line.startsWith('data: '))?.slice(6) ?? '{}';
    return { event, data: JSON.parse(data) };
  });
}

async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(50);
  }
  assert.fail('Timed out waiting for remote log process cleanup.');
}

test('log tail parser is bounded and rejects shell-like values', () => {
  assert.equal(parseLogTail(undefined), 100);
  assert.equal(parseLogTail('0'), 0);
  assert.equal(parseLogTail('1000'), 1000);
  for (const invalid of ['1001', '-1', '1;id', 'all', ' 10 ', '99999']) {
    assert.throws(() => parseLogTail(invalid), (error) => error?.code === 'INVALID_LOG_TAIL');
  }
});

test('live log endpoint rejects unauthenticated, invalid-tail and unknown-target requests before streaming', async () => {
  const app = newApp('orc-live-log-validation-');
  try {
    const unauthenticated = await app.inject({
      method: 'GET',
      url: '/api/v1/targets/missing/logs/stream?tail=10',
    });
    assert.equal(unauthenticated.statusCode, 401);

    const cookies = await login(app);
    const invalid = await app.inject({
      method: 'GET',
      url: '/api/v1/targets/missing/logs/stream?tail=1%3Bid',
      headers: { cookie: cookieHeader(cookies) },
    });
    assert.equal(invalid.statusCode, 400);
    assert.equal(invalid.json().error.code, 'INVALID_LOG_TAIL');

    const missing = await app.inject({
      method: 'GET',
      url: '/api/v1/targets/missing/logs/stream?tail=10',
      headers: { cookie: cookieHeader(cookies) },
    });
    assert.equal(missing.statusCode, 404);
    assert.equal(missing.json().error.code, 'TARGET_NOT_FOUND');
  } finally {
    await app.close();
  }
});

test('SSE live logs preserve stdout/stderr and client abort terminates the remote follow process', {
  skip: !HAS_FIXTURE,
}, async () => {
  fs.writeFileSync('/tmp/orc-docker-fixture-mode', 'single');
  fs.writeFileSync('/tmp/orc-status-fixture-mode', 'normal');
  fs.writeFileSync(LOG_PROCESS_STATE, '');
  fs.writeFileSync(LOG_PROCESS_PID, '');
  const app = newApp('orc-live-log-stream-');
  let listening = false;
  try {
    const { cookies, targetId } = await bootstrapSelectedTarget(app);
    fs.writeFileSync(DOCKER_FIXTURE_LOG, '');
    await app.listen({ host: '127.0.0.1', port: 0 });
    listening = true;
    const address = app.server.address();
    assert(address && typeof address === 'object');

    const controller = new AbortController();
    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/v1/targets/${targetId}/logs/stream?tail=7`,
      {
        headers: { cookie: cookieHeader(cookies) },
        signal: controller.signal,
      },
    );
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /^text\/event-stream/u);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = '';
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      if (text.includes('stdout-log-line') && text.includes('stderr-log-line')) break;
    }
    const frames = parseCompleteSseFrames(text);
    assert(frames.some((frame) => frame.event === 'ready' && frame.data.tail === 7));
    assert(frames.some((frame) => frame.event === 'log' && frame.data.stream === 'stdout' && frame.data.chunk.includes('stdout-log-line')));
    assert(frames.some((frame) => frame.event === 'log' && frame.data.stream === 'stderr' && frame.data.chunk.includes('stderr-log-line')));

    const calls = fs.readFileSync(DOCKER_FIXTURE_LOG, 'utf8').trim().split(/\r?\n/u).filter(Boolean);
    assert.deepEqual(calls, ['logs --follow --timestamps --tail 7 ollama-container-id']);
    assert.equal(calls.some((line) => /\b(start|stop|restart|rm|pull|run|create)\b/u.test(line)), false);

    controller.abort();
    await reader.cancel().catch(() => {});
    await waitFor(() => fs.readFileSync(LOG_PROCESS_STATE, 'utf8').trim() === 'stopped');
    const pid = Number(fs.readFileSync(LOG_PROCESS_PID, 'utf8').trim());
    assert(Number.isInteger(pid) && pid > 1);
    await waitFor(() => {
      try { process.kill(pid, 0); return false; }
      catch (error) { return error?.code === 'ESRCH'; }
    });
  } finally {
    if (listening) await app.close();
    else await app.close();
  }
});
