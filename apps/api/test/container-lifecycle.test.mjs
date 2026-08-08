import assert from 'node:assert/strict';
import fs from 'node:fs';
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
const LIFECYCLE_MODE = process.env.ORC_LIFECYCLE_MODE;
const HAS_FIXTURE = Boolean(
  SSH_HOST && SSH_USER && SSH_PRIVATE_KEY_PATH && DOCKER_FIXTURE_LOG && CONTAINER_STATE && LIFECYCLE_MODE,
);
const MASTER_KEY = Buffer.alloc(32, 0x47);
const PASSWORD = 'container-lifecycle-admin-password!';

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
  const databasePath = path.join(directory, 'app.sqlite');
  return {
    databasePath,
    app: buildServer({
      databasePath,
      environment: { ORC_MASTER_KEY: MASTER_KEY.toString('base64') },
    }),
  };
}

async function bootstrapSelectedTarget(app) {
  await app.inject({
    method: 'POST',
    url: '/api/v1/setup/admin',
    payload: { username: 'admin', password: PASSWORD },
  });
  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/session',
    payload: { username: 'admin', password: PASSWORD },
  });
  const cookies = cookiesFrom(login);
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
      displayName: 'Lifecycle fixture host',
      hostname: SSH_HOST,
      port: SSH_PORT,
      username: SSH_USER,
      confirmedFingerprint: probe.json().fingerprint,
      privateKey: fs.readFileSync(SSH_PRIVATE_KEY_PATH, 'utf8'),
    },
  });
  assert.equal(hostCreate.statusCode, 201);
  const targetCreate = await app.inject({
    method: 'POST',
    url: `/api/v1/hosts/${hostCreate.json().host.id}/targets`,
    headers: mutationHeaders(cookies),
    payload: { containerId: 'ollama-container-id', displayName: 'Primary Ollama' },
  });
  assert.equal(targetCreate.statusCode, 201);
  return {
    cookies,
    targetId: targetCreate.json().target.id,
    containerId: targetCreate.json().target.selectedContainerId,
  };
}

function confirmation(action, targetId, containerId) {
  return { confirmation: { action, targetId, containerId } };
}

function readDockerCalls() {
  return fs.readFileSync(DOCKER_FIXTURE_LOG, 'utf8').trim().split(/\r?\n/u).filter(Boolean);
}

async function waitForDockerCall(prefix, timeoutMs = 2500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (readDockerCalls().some((line) => line.startsWith(prefix))) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for Docker call: ${prefix}`);
}

function readPersistence(databasePath) {
  const database = openDatabase(databasePath);
  try {
    return {
      jobs: database.prepare(`SELECT id, kind, state, result_json, error_class, exit_code FROM jobs ORDER BY created_at, id`).all(),
      events: database.prepare(`SELECT job_id, sequence, payload_json FROM job_events ORDER BY job_id, sequence`).all(),
      audit: database.prepare(`SELECT action, parameters_redacted_json, result, error_class, job_id FROM audit_events ORDER BY timestamp, id`).all(),
    };
  } finally {
    database.close();
  }
}

function resetFixture() {
  fs.writeFileSync(CONTAINER_STATE, 'running');
  fs.writeFileSync(LIFECYCLE_MODE, 'normal');
  fs.writeFileSync(DOCKER_FIXTURE_LOG, '');
  fs.writeFileSync('/tmp/orc-docker-fixture-mode', 'single');
  fs.writeFileSync('/tmp/orc-status-fixture-mode', 'normal');
}

test('container lifecycle rejects auth, CSRF and concrete confirmation failures before jobs or SSH', {
  skip: !HAS_FIXTURE,
}, async () => {
  resetFixture();
  const { app, databasePath } = newApp('orc-container-guards-');
  try {
    const { cookies, targetId, containerId } = await bootstrapSelectedTarget(app);
    fs.writeFileSync(DOCKER_FIXTURE_LOG, '');

    const unauthenticated = await app.inject({
      method: 'POST',
      url: `/api/v1/targets/${targetId}/container/start`,
    });
    assert.equal(unauthenticated.statusCode, 401);

    const missingCsrf = await app.inject({
      method: 'POST',
      url: `/api/v1/targets/${targetId}/container/start`,
      headers: { cookie: cookieHeader(cookies) },
    });
    assert.equal(missingCsrf.statusCode, 403);

    const wrongConfirmation = await app.inject({
      method: 'POST',
      url: `/api/v1/targets/${targetId}/container/restart`,
      headers: mutationHeaders(cookies),
      payload: confirmation('restart', targetId, `${containerId}-wrong`),
    });
    assert.equal(wrongConfirmation.statusCode, 400);
    assert.equal(wrongConfirmation.json().error.code, 'CONFIRMATION_REQUIRED');

    assert.deepEqual(readDockerCalls(), []);
    assert.equal(readPersistence(databasePath).jobs.length, 0);
  } finally {
    resetFixture();
    await app.close();
  }
});

test('start, stop and restart execute typed argv, verify state, and persist terminal jobs plus audit', {
  skip: !HAS_FIXTURE,
}, async () => {
  resetFixture();
  fs.writeFileSync(CONTAINER_STATE, 'stopped');
  const { app, databasePath } = newApp('orc-container-success-');
  try {
    const { cookies, targetId, containerId } = await bootstrapSelectedTarget(app);
    fs.writeFileSync(DOCKER_FIXTURE_LOG, '');

    const start = await app.inject({
      method: 'POST',
      url: `/api/v1/targets/${targetId}/container/start`,
      headers: mutationHeaders(cookies),
    });
    assert.equal(start.statusCode, 200);
    assert.equal(start.json().job.state, 'succeeded');
    assert.equal(start.json().container.running, true);
    assert.equal('env' in start.json().container, false);
    assert.equal(start.body.includes('top-secret'), false);

    const stop = await app.inject({
      method: 'POST',
      url: `/api/v1/targets/${targetId}/container/stop`,
      headers: mutationHeaders(cookies),
      payload: confirmation('stop', targetId, containerId),
    });
    assert.equal(stop.statusCode, 200);
    assert.equal(stop.json().job.state, 'succeeded');
    assert.equal(stop.json().container.running, false);

    const restart = await app.inject({
      method: 'POST',
      url: `/api/v1/targets/${targetId}/container/restart`,
      headers: mutationHeaders(cookies),
      payload: confirmation('restart', targetId, containerId),
    });
    assert.equal(restart.statusCode, 200);
    assert.equal(restart.json().job.state, 'succeeded');
    assert.equal(restart.json().container.running, true);

    assert.deepEqual(readDockerCalls(), [
      'start ollama-container-id',
      'inspect ollama-container-id',
      'stop ollama-container-id',
      'inspect ollama-container-id',
      'restart ollama-container-id',
      'inspect ollama-container-id',
    ]);

    const stored = readPersistence(databasePath);
    assert.equal(stored.jobs.length, 3);
    assert(stored.jobs.every((job) => job.state === 'succeeded'));
    for (const job of stored.jobs) {
      const states = stored.events
        .filter((event) => event.job_id === job.id)
        .map((event) => JSON.parse(event.payload_json).state);
      assert.deepEqual(states, ['queued', 'running', 'succeeded']);
      assert.equal(String(job.result_json).includes('top-secret'), false);
    }
    assert.equal(stored.audit.length, 6);
    assert.equal(stored.audit.filter((row) => row.result === 'queued').length, 3);
    assert.equal(stored.audit.filter((row) => row.result === 'succeeded').length, 3);
    for (const row of stored.audit) {
      assert.equal(row.parameters_redacted_json.includes('top-secret'), false);
      assert.equal(row.parameters_redacted_json.includes('PRIVATE KEY'), false);
    }
  } finally {
    resetFixture();
    await app.close();
  }
});

test('persistent target lock rejects a second lifecycle mutation while the first is running', {
  skip: !HAS_FIXTURE,
}, async () => {
  resetFixture();
  fs.writeFileSync(LIFECYCLE_MODE, 'slow');
  const { app, databasePath } = newApp('orc-container-conflict-');
  try {
    const { cookies, targetId, containerId } = await bootstrapSelectedTarget(app);
    fs.writeFileSync(DOCKER_FIXTURE_LOG, '');
    const request = {
      method: 'POST',
      url: `/api/v1/targets/${targetId}/container/restart`,
      headers: mutationHeaders(cookies),
      payload: confirmation('restart', targetId, containerId),
    };

    const firstPromise = app.inject(request);
    await waitForDockerCall('restart ollama-container-id');
    const second = await app.inject(request);
    assert.equal(second.statusCode, 409);
    assert.equal(second.json().error.code, 'JOB_CONFLICT');

    const first = await firstPromise;
    assert.equal(first.statusCode, 200);
    assert.equal(first.json().job.state, 'succeeded');
    assert.deepEqual(readDockerCalls(), [
      'restart ollama-container-id',
      'inspect ollama-container-id',
    ]);
    assert.equal(readPersistence(databasePath).jobs.length, 1);
  } finally {
    resetFixture();
    await app.close();
  }
});

test('remote command and state-verification failures become failed jobs without stderr or secret leakage', {
  skip: !HAS_FIXTURE,
}, async () => {
  resetFixture();
  const { app, databasePath } = newApp('orc-container-failure-');
  try {
    const { cookies, targetId, containerId } = await bootstrapSelectedTarget(app);
    fs.writeFileSync(DOCKER_FIXTURE_LOG, '');

    fs.writeFileSync(LIFECYCLE_MODE, 'command-fail');
    const commandFailure = await app.inject({
      method: 'POST',
      url: `/api/v1/targets/${targetId}/container/restart`,
      headers: mutationHeaders(cookies),
      payload: confirmation('restart', targetId, containerId),
    });
    assert.equal(commandFailure.statusCode, 502);
    assert.equal(commandFailure.json().error.code, 'DOCKER_UNAVAILABLE');
    assert.equal(commandFailure.body.includes('REMOTE-TOP-SECRET'), false);

    fs.writeFileSync(LIFECYCLE_MODE, 'verification-fail');
    fs.writeFileSync(CONTAINER_STATE, 'running');
    const verificationFailure = await app.inject({
      method: 'POST',
      url: `/api/v1/targets/${targetId}/container/stop`,
      headers: mutationHeaders(cookies),
      payload: confirmation('stop', targetId, containerId),
    });
    assert.equal(verificationFailure.statusCode, 502);
    assert.equal(verificationFailure.json().error.code, 'CONTAINER_STATE_UNVERIFIED');

    const stored = readPersistence(databasePath);
    assert.equal(stored.jobs.length, 2);
    assert(stored.jobs.every((job) => job.state === 'failed'));
    assert.deepEqual(stored.jobs.map((job) => job.error_class).sort(), ['CONTAINER_STATE_UNVERIFIED', 'DOCKER_UNAVAILABLE']);
    assert(stored.audit.some((row) => row.error_class === 'DOCKER_UNAVAILABLE'));
    assert(stored.audit.some((row) => row.error_class === 'CONTAINER_STATE_UNVERIFIED'));
    const persistedText = JSON.stringify(stored);
    assert.equal(persistedText.includes('REMOTE-TOP-SECRET'), false);
    assert.equal(persistedText.includes('top-secret'), false);
  } finally {
    resetFixture();
    await app.close();
  }
});
