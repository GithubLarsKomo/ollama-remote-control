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
const HAS_FIXTURE = Boolean(SSH_HOST && SSH_USER && SSH_PRIVATE_KEY_PATH && DOCKER_FIXTURE_LOG);
const MASTER_KEY = Buffer.alloc(32, 0x7a);
const PASSWORD = 'docker-discovery-admin-password!';

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
function authHeaders(cookies) {
  return {
    cookie: Object.entries(cookies).map(([name, value]) => `${name}=${encodeURIComponent(value)}`).join('; '),
    'x-csrf-token': cookies.orc_csrf,
  };
}

async function onboard(app, cookies) {
  const probe = await app.inject({
    method: 'POST', url: '/api/v1/hosts/probe', headers: authHeaders(cookies),
    payload: { hostname: SSH_HOST, port: SSH_PORT },
  });
  assert.equal(probe.statusCode, 200);
  const privateKey = fs.readFileSync(SSH_PRIVATE_KEY_PATH, 'utf8');
  const create = await app.inject({
    method: 'POST', url: '/api/v1/hosts', headers: authHeaders(cookies),
    payload: {
      displayName: 'Docker fixture host', hostname: SSH_HOST, port: SSH_PORT, username: SSH_USER,
      confirmedFingerprint: probe.json().fingerprint, privateKey,
    },
  });
  assert.equal(create.statusCode, 201);
  return create.json().host.id;
}

test('Docker discovery reconnects with stored encrypted credential and persists only a current candidate', {
  skip: !HAS_FIXTURE,
}, async () => {
  fs.writeFileSync(DOCKER_FIXTURE_LOG, '');
  fs.writeFileSync('/tmp/orc-docker-fixture-mode', 'single');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orc-docker-api-'));
  const app = buildServer({
    databasePath: path.join(directory, 'app.sqlite'),
    environment: { ORC_MASTER_KEY: MASTER_KEY.toString('base64') },
  });

  try {
    await app.inject({ method: 'POST', url: '/api/v1/setup/admin', payload: { username: 'admin', password: PASSWORD } });
    const login = await app.inject({ method: 'POST', url: '/api/v1/session', payload: { username: 'admin', password: PASSWORD } });
    const cookies = cookiesFrom(login);
    const hostId = await onboard(app, cookies);

    const discovery = await app.inject({
      method: 'POST', url: `/api/v1/hosts/${hostId}/discover-ollama`, headers: authHeaders(cookies), payload: {},
    });
    assert.equal(discovery.statusCode, 200);
    assert.equal(discovery.json().dockerVersion, '27.5.1');
    assert.equal(discovery.json().candidates.length, 1);
    assert.equal(discovery.json().recommendedContainerId, 'ollama-container-id');
    assert.equal(discovery.json().candidates[0].inspect.running, true);

    const arbitrary = await app.inject({
      method: 'POST', url: `/api/v1/hosts/${hostId}/targets`, headers: authHeaders(cookies),
      payload: { containerId: 'browser-supplied-non-candidate' },
    });
    assert.equal(arbitrary.statusCode, 404);
    assert.equal(arbitrary.json().error.code, 'CONTAINER_NOT_FOUND');

    const selected = await app.inject({
      method: 'POST', url: `/api/v1/hosts/${hostId}/targets`, headers: authHeaders(cookies),
      payload: { containerId: 'ollama-container-id', displayName: 'Primary Ollama' },
    });
    assert.equal(selected.statusCode, 201);
    assert.equal(selected.json().target.selectedContainerId, 'ollama-container-id');
    const persistedTargetId = selected.json().target.id;

    const reselected = await app.inject({
      method: 'POST', url: `/api/v1/hosts/${hostId}/targets`, headers: authHeaders(cookies),
      payload: { containerId: 'ollama-container-id', displayName: 'Primary Ollama renamed' },
    });
    assert.equal(reselected.statusCode, 201);
    assert.equal(reselected.json().target.id, persistedTargetId);
    assert.equal(reselected.json().target.displayName, 'Primary Ollama renamed');

    const listed = await app.inject({
      method: 'GET', url: `/api/v1/hosts/${hostId}/targets`,
      headers: { cookie: authHeaders(cookies).cookie },
    });
    assert.equal(listed.statusCode, 200);
    assert.equal(listed.json().targets.length, 1);
    assert.equal(listed.json().targets[0].id, persistedTargetId);
    assert.equal(listed.json().targets[0].displayName, 'Primary Ollama renamed');

    const calls = fs.readFileSync(DOCKER_FIXTURE_LOG, 'utf8').trim().split(/\r?\n/u).filter(Boolean);
    assert(calls.length > 0);
    assert.equal(calls.some((line) => /\b(start|stop|restart|rm|pull|run|create)\b/u.test(line)), false);
    assert.equal(calls.some((line) => line.includes('browser-supplied-non-candidate')), false);
    assert(calls.every((line) => /^(version|ps|inspect)\b/u.test(line)));
  } finally {
    await app.close();
  }
});

test('ambiguous Docker discovery is surfaced instead of silently choosing', {
  skip: !HAS_FIXTURE,
}, async () => {
  fs.writeFileSync('/tmp/orc-docker-fixture-mode', 'ambiguous');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orc-docker-ambiguous-'));
  const app = buildServer({
    databasePath: path.join(directory, 'app.sqlite'),
    environment: { ORC_MASTER_KEY: MASTER_KEY.toString('base64') },
  });
  try {
    await app.inject({ method: 'POST', url: '/api/v1/setup/admin', payload: { username: 'admin', password: PASSWORD } });
    const login = await app.inject({ method: 'POST', url: '/api/v1/session', payload: { username: 'admin', password: PASSWORD } });
    const cookies = cookiesFrom(login);
    const hostId = await onboard(app, cookies);
    const discovery = await app.inject({
      method: 'POST', url: `/api/v1/hosts/${hostId}/discover-ollama`, headers: authHeaders(cookies), payload: {},
    });
    assert.equal(discovery.statusCode, 200);
    assert.equal(discovery.json().candidates.length, 2);
    assert.equal(discovery.json().recommendedContainerId, null);
    assert.equal(discovery.json().ambiguous, true);
  } finally {
    await app.close();
  }
});
