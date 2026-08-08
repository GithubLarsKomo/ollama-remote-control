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
const HAS_FIXTURE = Boolean(
  SSH_HOST && SSH_USER && SSH_PRIVATE_KEY_PATH && DOCKER_FIXTURE_LOG && CONTAINER_STATE && LIFECYCLE_MODE && REGISTRY_MODE,
);
const MASTER_KEY = Buffer.alloc(32, 0x63);
const PASSWORD = 'update-plan-admin-password!';

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
      displayName: 'Registry fixture host', hostname: SSH_HOST, port: SSH_PORT, username: SSH_USER,
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

async function createSnapshot(app, cookies, targetId) {
  const response = await app.inject({
    method: 'POST',
    url: `/api/v1/targets/${targetId}/container/update-preflight`,
    headers: mutationHeaders(cookies),
  });
  assert.equal(response.statusCode, 201);
  return response.json().snapshot.id;
}

function resetFixture() {
  fs.writeFileSync(CONTAINER_STATE, 'running');
  fs.writeFileSync(LIFECYCLE_MODE, 'normal');
  fs.writeFileSync(REGISTRY_MODE, 'changed');
  fs.writeFileSync(DOCKER_FIXTURE_LOG, '');
  fs.writeFileSync('/tmp/orc-docker-fixture-mode', 'single');
  fs.writeFileSync('/tmp/orc-status-fixture-mode', 'normal');
}
function dockerCalls() {
  return fs.readFileSync(DOCKER_FIXTURE_LOG, 'utf8').trim().split(/\r?\n/u).filter(Boolean);
}
function planUrl(targetId, snapshotId) {
  return `/api/v1/targets/${targetId}/container/update-plan?snapshotId=${encodeURIComponent(snapshotId)}`;
}

test('update plan compares the matching multi-arch platform digest and preserves configured tag', { skip: !HAS_FIXTURE }, async () => {
  resetFixture();
  const databasePath = newDatabasePath('orc-update-plan-');
  const app = newApp(databasePath);
  try {
    const { cookies, targetId } = await bootstrapTarget(app);
    const snapshotId = await createSnapshot(app, cookies, targetId);
    fs.writeFileSync(DOCKER_FIXTURE_LOG, '');

    const changed = await app.inject({
      method: 'GET', url: planUrl(targetId, snapshotId), headers: { cookie: cookieHeader(cookies) },
    });
    assert.equal(changed.statusCode, 200);
    const plan = changed.json().plan;
    assert.equal(plan.snapshotId, snapshotId);
    assert.equal(plan.imageReference, 'ollama/ollama:latest');
    assert.equal(plan.currentDigest, 'sha256:current-digest');
    assert.equal(plan.candidateDigest, 'sha256:candidate-digest');
    assert.equal(plan.candidateIndexDigest, 'sha256:index-digest');
    assert.deepEqual(plan.platform, { os: 'linux', architecture: 'amd64', variant: null });
    assert.equal(plan.updateAvailable, true);
    assert.equal(plan.pinned, false);
    assert.equal(plan.currentOllamaVersion, 'ollama version is 0.32.5');
    assert.equal(plan.candidateImageVersion, '0.33.0');
    assert.equal('candidateOllamaVersion' in plan, false);
    assert.equal(plan.composeManaged, true);
    assert.equal(plan.modelVolumeBackup.included, false);
    assert.match(plan.modelVolumeBackup.warning, /not backed up/i);
    assert.deepEqual(dockerCalls(), [
      'buildx version',
      'buildx imagetools inspect ollama/ollama:latest --format {{json .Manifest}}',
      'buildx imagetools inspect ollama/ollama@sha256:candidate-digest --format {{json .Image}}',
    ]);

    fs.writeFileSync(REGISTRY_MODE, 'same');
    fs.writeFileSync(DOCKER_FIXTURE_LOG, '');
    const same = await app.inject({
      method: 'GET', url: planUrl(targetId, snapshotId), headers: { cookie: cookieHeader(cookies) },
    });
    assert.equal(same.statusCode, 200);
    assert.equal(same.json().plan.currentDigest, 'sha256:current-digest');
    assert.equal(same.json().plan.candidateDigest, 'sha256:current-digest');
    assert.equal(same.json().plan.updateAvailable, false);

    const database = openDatabase(databasePath);
    try {
      assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM jobs`).get().count, 0);
      assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM update_snapshots`).get().count, 1);
      const audit = database.prepare(`SELECT action, parameters_redacted_json, result FROM audit_events ORDER BY timestamp, id`).all();
      assert(audit.some((row) => row.action === 'container.update_plan.created'));
      assert.equal(JSON.stringify(audit).includes('top-secret'), false);
      assert.equal(JSON.stringify(audit).includes('REGISTRY-SECRET'), false);
    } finally {
      database.close();
    }
  } finally {
    resetFixture();
    await app.close();
  }
});

test('update plan surfaces Buildx, registry and platform failures without remote secret leakage', { skip: !HAS_FIXTURE }, async () => {
  resetFixture();
  const databasePath = newDatabasePath('orc-update-plan-errors-');
  const app = newApp(databasePath);
  try {
    const { cookies, targetId } = await bootstrapTarget(app);
    const snapshotId = await createSnapshot(app, cookies, targetId);
    const cases = [
      ['buildx-missing', 422, 'REGISTRY_LOOKUP_UNAVAILABLE'],
      ['registry-fail', 502, 'IMAGE_REGISTRY_LOOKUP_FAILED'],
      ['platform-missing', 409, 'IMAGE_PLATFORM_NOT_FOUND'],
    ];
    for (const [mode, status, code] of cases) {
      fs.writeFileSync(REGISTRY_MODE, mode);
      fs.writeFileSync(DOCKER_FIXTURE_LOG, '');
      const response = await app.inject({
        method: 'GET', url: planUrl(targetId, snapshotId), headers: { cookie: cookieHeader(cookies) },
      });
      assert.equal(response.statusCode, status);
      assert.equal(response.json().error.code, code);
      assert.equal(response.body.includes('REGISTRY-SECRET'), false);
    }

    const unauthenticated = await app.inject({ method: 'GET', url: planUrl(targetId, snapshotId) });
    assert.equal(unauthenticated.statusCode, 401);
    const database = openDatabase(databasePath);
    try {
      assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM jobs`).get().count, 0);
      assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM update_snapshots`).get().count, 1);
    } finally {
      database.close();
    }
  } finally {
    resetFixture();
    await app.close();
  }
});

test('digest-pinned snapshot remains pinned and creates a plan without any registry command', { skip: !HAS_FIXTURE }, async () => {
  resetFixture();
  const databasePath = newDatabasePath('orc-update-plan-pinned-');
  const app = newApp(databasePath);
  try {
    const { cookies, userId, targetId } = await bootstrapTarget(app);
    const snapshotId = '11111111-2222-4333-8444-555555555555';
    const rawPayload = JSON.stringify({
      schemaVersion: 1,
      containerInspect: {
        Id: 'ollama-container-id',
        Config: {
          Image: 'ollama/ollama@sha256:pinned-digest',
          Labels: { 'com.docker.compose.project': 'orc-stack', 'com.docker.compose.service': 'ollama' },
        },
      },
      imageInspect: {
        RepoDigests: ['ollama/ollama@sha256:pinned-digest'],
        Architecture: 'amd64',
        Os: 'linux',
        Variant: '',
      },
      ollamaVersion: 'ollama version is 0.32.5',
    });
    const database = openDatabase(databasePath);
    try {
      new SqliteUpdateSnapshotRepository(database).save({
        id: snapshotId,
        targetId,
        actorUserId: userId,
        createdAt: '2026-08-08T09:40:00.000Z',
        publicMetadataJson: '{}',
        encryptedPayload: new UpdateSnapshotCipher(MASTER_KEY).encrypt({ snapshotId, targetId }, rawPayload),
      });
    } finally {
      database.close();
    }
    fs.writeFileSync(DOCKER_FIXTURE_LOG, '');
    fs.writeFileSync(REGISTRY_MODE, 'buildx-missing');

    const response = await app.inject({
      method: 'GET', url: planUrl(targetId, snapshotId), headers: { cookie: cookieHeader(cookies) },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().plan.pinned, true);
    assert.equal(response.json().plan.currentDigest, 'sha256:pinned-digest');
    assert.equal(response.json().plan.candidateDigest, 'sha256:pinned-digest');
    assert.equal(response.json().plan.candidateImageVersion, null);
    assert.equal(response.json().plan.updateAvailable, false);
    assert.deepEqual(dockerCalls(), []);
  } finally {
    resetFixture();
    await app.close();
  }
});

test('stale snapshot is rejected before registry lookup', { skip: !HAS_FIXTURE }, async () => {
  resetFixture();
  const databasePath = newDatabasePath('orc-update-plan-stale-');
  const app = newApp(databasePath);
  try {
    const { cookies, targetId } = await bootstrapTarget(app);
    const snapshotId = await createSnapshot(app, cookies, targetId);
    const database = openDatabase(databasePath);
    database.prepare(`UPDATE ollama_targets SET selected_container_id = 'replacement-container-id' WHERE id = ?`).run(targetId);
    database.close();
    fs.writeFileSync(DOCKER_FIXTURE_LOG, '');

    const response = await app.inject({
      method: 'GET', url: planUrl(targetId, snapshotId), headers: { cookie: cookieHeader(cookies) },
    });
    assert.equal(response.statusCode, 409);
    assert.equal(response.json().error.code, 'UPDATE_SNAPSHOT_STALE');
    assert.deepEqual(dockerCalls(), []);
  } finally {
    resetFixture();
    await app.close();
  }
});
