import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildServer } from '../dist/server.js';

const SSH_HOST = process.env.SSH_HOST;
const SSH_PORT = Number(process.env.SSH_PORT ?? '2222');
const SSH_USER = process.env.SSH_USER;
const SSH_PRIVATE_KEY_PATH = process.env.SSH_PRIVATE_KEY_PATH;
const DOCKER_FIXTURE_LOG = process.env.ORC_DOCKER_FIXTURE_LOG;
const SYSTEM_FIXTURE_LOG = process.env.ORC_SYSTEM_FIXTURE_LOG;
const HAS_FIXTURE = Boolean(
  SSH_HOST && SSH_USER && SSH_PRIVATE_KEY_PATH && DOCKER_FIXTURE_LOG && SYSTEM_FIXTURE_LOG,
);
const MASTER_KEY = Buffer.alloc(32, 0x45);
const PASSWORD = 'target-status-admin-password!';

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
      displayName: 'Status fixture host',
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

function newApp(prefix) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return buildServer({
    databasePath: path.join(directory, 'app.sqlite'),
    environment: { ORC_MASTER_KEY: MASTER_KEY.toString('base64') },
  });
}

test('target status exposes Docker/Ollama/GPU/disk while masking sensitive Ollama environment', {
  skip: !HAS_FIXTURE,
}, async () => {
  fs.writeFileSync('/tmp/orc-docker-fixture-mode', 'single');
  fs.writeFileSync('/tmp/orc-status-fixture-mode', 'normal');
  const app = newApp('orc-target-status-');
  try {
    const { cookies, targetId } = await bootstrapSelectedTarget(app);
    fs.writeFileSync(DOCKER_FIXTURE_LOG, '');
    fs.writeFileSync(SYSTEM_FIXTURE_LOG, '');

    const unauthenticated = await app.inject({
      method: 'GET',
      url: `/api/v1/targets/${targetId}/status`,
    });
    assert.equal(unauthenticated.statusCode, 401);

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/targets/${targetId}/status`,
      headers: { cookie: cookieHeader(cookies) },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.includes('top-secret'), false);
    const status = response.json();
    assert.equal(status.target.id, targetId);
    assert.equal(status.target.selectedContainerId, 'ollama-container-id');
    assert.equal(status.container.name, 'ollama');
    assert.equal(status.container.running, true);
    assert.equal(status.container.status, 'healthy');
    assert.equal(status.container.restartCount, 2);
    assert.equal('env' in status.container, false);
    assert.equal(status.ollama.available, true);
    assert.equal(status.ollama.version, '0.32.5');

    assert.deepEqual(status.environment, [
      { name: 'OLLAMA_API_KEY', value: null, redacted: true },
      { name: 'OLLAMA_HOST', value: '0.0.0.0:11434', redacted: false },
    ]);

    assert.equal(status.gpu.available, true);
    assert.equal(status.gpu.devices.length, 1);
    assert.equal(status.gpu.devices[0].name, 'NVIDIA RTX A4000');
    assert.equal(status.gpu.devices[0].memoryTotalMiB, 16384);
    assert.equal(status.gpu.devices[0].memoryUsedMiB, 8192);

    assert.equal(status.modelStorage.available, true);
    assert.equal(status.modelStorage.mount.destination, '/root/.ollama');
    assert.equal(status.modelStorage.mount.source, '/srv/ollama');
    assert.equal(status.modelStorage.disk.totalKiB, 1000000);
    assert.equal(status.modelStorage.disk.availableKiB, 600000);
    assert.equal(status.modelStorage.disk.capacityPercent, 40);

    const dockerCalls = fs.readFileSync(DOCKER_FIXTURE_LOG, 'utf8').trim().split(/\r?\n/u).filter(Boolean);
    assert.deepEqual(dockerCalls.map((line) => line.split(' ')[0]), ['inspect', 'exec']);
    assert.equal(dockerCalls.some((line) => /\b(start|stop|restart|rm|pull|run|create)\b/u.test(line)), false);
    const systemCalls = fs.readFileSync(SYSTEM_FIXTURE_LOG, 'utf8').trim().split(/\r?\n/u).filter(Boolean);
    assert.equal(systemCalls.length, 2);
    assert(systemCalls.some((line) => line.startsWith('nvidia-smi ')));
    assert(systemCalls.some((line) => line.startsWith('df ')));
  } finally {
    await app.close();
  }
});

test('optional target capabilities degrade independently', {
  skip: !HAS_FIXTURE,
}, async () => {
  fs.writeFileSync('/tmp/orc-docker-fixture-mode', 'single');
  fs.writeFileSync('/tmp/orc-status-fixture-mode', 'degraded');
  const app = newApp('orc-target-status-degraded-');
  try {
    const { cookies, targetId } = await bootstrapSelectedTarget(app);
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/targets/${targetId}/status`,
      headers: { cookie: cookieHeader(cookies) },
    });
    assert.equal(response.statusCode, 200);
    const status = response.json();
    assert.equal(status.container.running, true);
    assert.deepEqual(status.ollama, {
      available: false,
      version: null,
      errorClass: 'OLLAMA_CLI_ERROR',
    });
    assert.deepEqual(status.gpu, {
      available: false,
      devices: [],
      errorClass: 'GPU_UNAVAILABLE',
    });
    assert.equal(status.modelStorage.available, false);
    assert.equal(status.modelStorage.errorClass, 'MODEL_STORAGE_DISK_UNAVAILABLE');
    assert.equal(status.modelStorage.mount.destination, '/root/.ollama');
  } finally {
    await app.close();
  }
});

test('a persisted target whose container disappeared maps to CONTAINER_NOT_FOUND', {
  skip: !HAS_FIXTURE,
}, async () => {
  fs.writeFileSync('/tmp/orc-docker-fixture-mode', 'single');
  fs.writeFileSync('/tmp/orc-status-fixture-mode', 'normal');
  const app = newApp('orc-target-status-missing-');
  try {
    const { cookies, targetId } = await bootstrapSelectedTarget(app);
    fs.writeFileSync('/tmp/orc-docker-fixture-mode', 'missing-selected');
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/targets/${targetId}/status`,
      headers: { cookie: cookieHeader(cookies) },
    });
    assert.equal(response.statusCode, 404);
    assert.equal(response.json().error.code, 'CONTAINER_NOT_FOUND');
  } finally {
    await app.close();
  }
});
