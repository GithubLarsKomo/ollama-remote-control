import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  openDatabase,
  SqliteUpdateSnapshotRepository,
} from '@orc/db';
import { UpdateSnapshotCipher } from '@orc/security';
import { buildServer } from '../dist/server.js';

const SSH_HOST = process.env.SSH_HOST;
const SSH_PORT = Number(process.env.SSH_PORT ?? '2222');
const SSH_USER = process.env.SSH_USER;
const SSH_PRIVATE_KEY_PATH = process.env.SSH_PRIVATE_KEY_PATH;
const DOCKER_FIXTURE_LOG = process.env.ORC_DOCKER_FIXTURE_LOG;
const CONTAINER_STATE = process.env.ORC_CONTAINER_STATE;
const LIFECYCLE_MODE = process.env.ORC_LIFECYCLE_MODE;
const REGISTRY_MODE = process.env.ORC_REGISTRY_MODE;
const COMPOSE_MODE = process.env.ORC_COMPOSE_MODE;
const HAS_FIXTURE = Boolean(
  SSH_HOST && SSH_USER && SSH_PRIVATE_KEY_PATH && DOCKER_FIXTURE_LOG
  && CONTAINER_STATE && LIFECYCLE_MODE && REGISTRY_MODE && COMPOSE_MODE,
);
const MASTER_KEY = Buffer.alloc(32, 0x71);
const PASSWORD = 'update-strategy-admin-password!';

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
function newDatabasePath(prefix) {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), prefix)), 'app.sqlite');
}
function newApp(databasePath) {
  return buildServer({ databasePath, environment: { ORC_MASTER_KEY: MASTER_KEY.toString('base64') } });
}

async function bootstrapTarget(app) {
  const setup = await app.inject({
    method: 'POST', url: '/api/v1/setup/admin', payload: { username: 'admin', password: PASSWORD },
  });
  assert.equal(setup.statusCode, 201);
  const login = await app.inject({
    method: 'POST', url: '/api/v1/session', payload: { username: 'admin', password: PASSWORD },
  });
  assert.equal(login.statusCode, 200);
  const cookies = cookiesFrom(login);
  const probe = await app.inject({
    method: 'POST', url: '/api/v1/hosts/probe', headers: mutationHeaders(cookies), payload: { hostname: SSH_HOST, port: SSH_PORT },
  });
  assert.equal(probe.statusCode, 200);
  const host = await app.inject({
    method: 'POST',
    url: '/api/v1/hosts',
    headers: mutationHeaders(cookies),
    payload: {
      displayName: 'Strategy fixture host', hostname: SSH_HOST, port: SSH_PORT, username: SSH_USER,
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
  return { cookies, userId: login.json().user.id, targetId: target.json().target.id };
}

async function createComposeSnapshot(app, cookies, targetId) {
  const response = await app.inject({
    method: 'POST',
    url: `/api/v1/targets/${targetId}/container/update-preflight`,
    headers: mutationHeaders(cookies),
  });
  assert.equal(response.statusCode, 201);
  return response.json().snapshot.id;
}

function storeSnapshot(databasePath, userId, targetId, snapshotId, containerInspect) {
  const payload = JSON.stringify({
    schemaVersion: 1,
    containerInspect,
    imageInspect: { RepoDigests: ['ollama/ollama@sha256:current'], Architecture: 'amd64', Os: 'linux', Variant: '' },
    ollamaVersion: 'ollama version is 0.32.5',
  });
  const database = openDatabase(databasePath);
  try {
    new SqliteUpdateSnapshotRepository(database).save({
      id: snapshotId,
      targetId,
      actorUserId: userId,
      createdAt: '2026-08-08T10:10:00.000Z',
      publicMetadataJson: '{}',
      encryptedPayload: new UpdateSnapshotCipher(MASTER_KEY).encrypt({ snapshotId, targetId }, payload),
    });
  } finally {
    database.close();
  }
}

function resetFixture() {
  fs.writeFileSync(CONTAINER_STATE, 'running');
  fs.writeFileSync(LIFECYCLE_MODE, 'normal');
  fs.writeFileSync(REGISTRY_MODE, 'changed');
  fs.writeFileSync(COMPOSE_MODE, 'normal');
  fs.writeFileSync(DOCKER_FIXTURE_LOG, '');
  fs.writeFileSync('/tmp/orc-docker-fixture-mode', 'single');
  fs.writeFileSync('/tmp/orc-status-fixture-mode', 'normal');
}
function dockerCalls() {
  return fs.readFileSync(DOCKER_FIXTURE_LOG, 'utf8').trim().split(/\r?\n/u).filter(Boolean);
}
function strategyUrl(targetId, snapshotId) {
  return `/api/v1/targets/${targetId}/container/update-strategy?snapshotId=${encodeURIComponent(snapshotId)}`;
}

test('Compose strategy validates captured context and exact current container over real SSH', { skip: !HAS_FIXTURE }, async () => {
  resetFixture();
  const databasePath = newDatabasePath('orc-update-strategy-compose-');
  const app = newApp(databasePath);
  try {
    const { cookies, targetId } = await bootstrapTarget(app);
    const snapshotId = await createComposeSnapshot(app, cookies, targetId);
    fs.writeFileSync(DOCKER_FIXTURE_LOG, '');

    const response = await app.inject({
      method: 'GET',
      url: strategyUrl(targetId, snapshotId),
      headers: { cookie: cookieHeader(cookies) },
    });
    assert.equal(response.statusCode, 200);
    const strategy = response.json().strategy;
    assert.equal(strategy.type, 'compose');
    assert.equal(strategy.executable, true);
    assert.equal(strategy.projectName, 'orc-stack');
    assert.equal(strategy.service, 'ollama');
    assert.equal(strategy.workingDirectory, '/srv/orc');
    assert.deepEqual(strategy.configFiles, ['/srv/orc/compose.yml']);
    assert.deepEqual(strategy.environmentFiles, []);
    assert.equal(strategy.composeVersion, '2.40.3');
    assert.equal(strategy.containerId, 'ollama-container-id');
    assert.equal(response.body.includes('top-secret'), false);
    assert.equal(response.body.includes('OLLAMA_API_KEY'), false);
    assert.deepEqual(dockerCalls(), [
      'compose version --short',
      'compose -p orc-stack --project-directory /srv/orc -f /srv/orc/compose.yml config --services',
      'compose -p orc-stack --project-directory /srv/orc -f /srv/orc/compose.yml ps --all -q ollama',
    ]);

    const database = openDatabase(databasePath);
    try {
      assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM jobs`).get().count, 0);
      assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM update_snapshots`).get().count, 1);
      const audit = database.prepare(`SELECT action, parameters_redacted_json, error_class FROM audit_events ORDER BY timestamp, id`).all();
      assert(audit.some((row) => row.action === 'container.update_strategy.created'));
      assert.equal(JSON.stringify(audit).includes('top-secret'), false);
    } finally {
      database.close();
    }
  } finally {
    resetFixture();
    await app.close();
  }
});

test('Compose strategy surfaces unavailable/config/service/container errors without stderr leakage', { skip: !HAS_FIXTURE }, async () => {
  resetFixture();
  const databasePath = newDatabasePath('orc-update-strategy-errors-');
  const app = newApp(databasePath);
  try {
    const { cookies, targetId } = await bootstrapTarget(app);
    const snapshotId = await createComposeSnapshot(app, cookies, targetId);
    const cases = [
      ['unavailable', 422, 'COMPOSE_UNAVAILABLE'],
      ['config-fail', 409, 'COMPOSE_CONFIG_INVALID'],
      ['service-missing', 409, 'COMPOSE_SERVICE_NOT_FOUND'],
      ['mismatch', 409, 'COMPOSE_CONTEXT_MISMATCH'],
    ];
    for (const [mode, status, code] of cases) {
      fs.writeFileSync(COMPOSE_MODE, mode);
      fs.writeFileSync(DOCKER_FIXTURE_LOG, '');
      const response = await app.inject({
        method: 'GET',
        url: strategyUrl(targetId, snapshotId),
        headers: { cookie: cookieHeader(cookies) },
      });
      assert.equal(response.statusCode, status);
      assert.equal(response.json().error.code, code);
      assert.equal(response.body.includes('COMPOSE-SECRET'), false);
    }
  } finally {
    resetFixture();
    await app.close();
  }
});

test('standalone strategy is local-only and blocks unsupported high-impact runtime features explicitly', { skip: !HAS_FIXTURE }, async () => {
  resetFixture();
  const databasePath = newDatabasePath('orc-update-strategy-standalone-');
  const app = newApp(databasePath);
  try {
    const { cookies, userId, targetId } = await bootstrapTarget(app);
    const simpleId = '22222222-2222-4222-8222-222222222222';
    storeSnapshot(databasePath, userId, targetId, simpleId, {
      Id: 'ollama-container-id',
      Config: {
        Image: 'ollama/ollama:latest',
        Env: ['OLLAMA_API_KEY=standalone-secret'],
        Labels: { purpose: 'ollama' },
        Cmd: ['serve'],
      },
      HostConfig: {
        PortBindings: { '11434/tcp': [{ HostIp: '127.0.0.1', HostPort: '11434' }] },
        RestartPolicy: { Name: 'unless-stopped' },
        NetworkMode: 'bridge',
      },
      Mounts: [{ Type: 'bind', Source: '/srv/ollama', Destination: '/root/.ollama' }],
      NetworkSettings: { Networks: { bridge: {} } },
    });
    fs.writeFileSync(DOCKER_FIXTURE_LOG, '');
    const simple = await app.inject({
      method: 'GET', url: strategyUrl(targetId, simpleId), headers: { cookie: cookieHeader(cookies) },
    });
    assert.equal(simple.statusCode, 200);
    assert.equal(simple.json().strategy.type, 'standalone');
    assert.equal(simple.json().strategy.executable, true);
    assert.deepEqual(simple.json().strategy.unsupportedFields, []);
    assert.equal(simple.body.includes('standalone-secret'), false);
    assert.deepEqual(dockerCalls(), []);

    const blockedId = '33333333-3333-4333-8333-333333333333';
    storeSnapshot(databasePath, userId, targetId, blockedId, {
      Id: 'ollama-container-id',
      Config: { Image: 'ollama/ollama:latest', Env: ['OLLAMA_API_KEY=blocked-secret'] },
      HostConfig: {
        Privileged: true,
        DeviceRequests: [{ Driver: 'nvidia', Count: -1 }],
      },
      Mounts: [],
      NetworkSettings: { Networks: { bridge: {} } },
    });
    const blocked = await app.inject({
      method: 'GET', url: strategyUrl(targetId, blockedId), headers: { cookie: cookieHeader(cookies) },
    });
    assert.equal(blocked.statusCode, 200);
    assert.equal(blocked.json().strategy.executable, false);
    assert.deepEqual(blocked.json().strategy.unsupportedFields, ['HostConfig.DeviceRequests', 'HostConfig.Privileged']);
    assert.equal(blocked.body.includes('blocked-secret'), false);
    assert.deepEqual(dockerCalls(), []);
  } finally {
    resetFixture();
    await app.close();
  }
});
