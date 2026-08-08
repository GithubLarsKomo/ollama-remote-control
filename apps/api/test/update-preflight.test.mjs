import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openDatabase } from '@orc/db';
import { UpdateSnapshotCipher } from '@orc/security';
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
const MASTER_KEY = Buffer.alloc(32, 0x52);
const PASSWORD = 'update-preflight-admin-password!';

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

function newApp(databasePath, masterKey = MASTER_KEY) {
  return buildServer({
    databasePath,
    environment: masterKey ? { ORC_MASTER_KEY: masterKey.toString('base64') } : {},
  });
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
  assert.equal(login.statusCode, 200);
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
      displayName: 'Preflight fixture host',
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
  return { cookies, targetId: targetCreate.json().target.id };
}

function resetFixture() {
  fs.writeFileSync(CONTAINER_STATE, 'running');
  fs.writeFileSync(LIFECYCLE_MODE, 'normal');
  fs.writeFileSync(DOCKER_FIXTURE_LOG, '');
  fs.writeFileSync('/tmp/orc-docker-fixture-mode', 'single');
  fs.writeFileSync('/tmp/orc-status-fixture-mode', 'normal');
}

function dockerCalls() {
  return fs.readFileSync(DOCKER_FIXTURE_LOG, 'utf8').trim().split(/\r?\n/u).filter(Boolean);
}

test('update preflight captures an encrypted rollback snapshot with only safe public metadata', {
  skip: !HAS_FIXTURE,
}, async () => {
  resetFixture();
  const databasePath = newDatabasePath('orc-update-preflight-');
  const app = newApp(databasePath);
  try {
    const { cookies, targetId } = await bootstrapSelectedTarget(app);
    fs.writeFileSync(DOCKER_FIXTURE_LOG, '');

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/targets/${targetId}/container/update-preflight`,
      headers: mutationHeaders(cookies),
    });
    assert.equal(response.statusCode, 201);
    const body = response.json();
    assert.equal(body.snapshot.targetId, targetId);
    assert.equal(body.snapshot.metadata.imageReference, 'ollama/ollama:latest');
    assert.equal(body.snapshot.metadata.imageId, 'sha256:image-current');
    assert.deepEqual(body.snapshot.metadata.repoDigests, ['ollama/ollama@sha256:current-digest']);
    assert.equal(body.snapshot.metadata.restartPolicy, 'unless-stopped');
    assert.deepEqual(body.snapshot.metadata.networkNames, ['orc_default']);
    assert.equal(body.snapshot.metadata.gpuDeviceRequestCount, 1);
    assert.equal(body.snapshot.metadata.ollamaVersion, 'ollama version is 0.32.5');
    assert.deepEqual(body.snapshot.metadata.compose, {
      managed: true,
      project: 'orc-stack',
      service: 'ollama',
      configFiles: '/srv/orc/compose.yml',
      workingDir: '/srv/orc',
    });
    for (const forbidden of ['top-secret', 'OLLAMA_API_KEY', 'ciphertext', 'authTag', 'nonce']) {
      assert.equal(response.body.includes(forbidden), false);
    }
    assert.deepEqual(dockerCalls(), [
      'inspect ollama-container-id',
      'image inspect ollama/ollama:latest',
      'exec ollama-container-id ollama --version',
    ]);

    const database = openDatabase(databasePath);
    try {
      const rows = database.prepare(`SELECT * FROM update_snapshots`).all();
      assert.equal(rows.length, 1);
      const row = rows[0];
      assert.equal(row.id, body.snapshot.id);
      assert.equal(row.target_id, targetId);
      assert.equal(String(row.public_metadata_json).includes('top-secret'), false);
      assert.equal(String(row.ciphertext).includes('top-secret'), false);
      const payload = new UpdateSnapshotCipher(MASTER_KEY).decrypt(
        { snapshotId: String(row.id), targetId: String(row.target_id) },
        {
          algorithm: row.algorithm,
          keyVersion: row.key_version,
          nonce: row.nonce,
          ciphertext: row.ciphertext,
          authTag: row.auth_tag,
        },
      );
      assert.equal(payload.includes('OLLAMA_API_KEY=top-secret'), true);
      const parsed = JSON.parse(payload);
      assert.equal(parsed.containerInspect.HostConfig.RestartPolicy.Name, 'unless-stopped');
      assert.equal(parsed.containerInspect.HostConfig.DeviceRequests[0].Driver, 'nvidia');
      assert.equal(parsed.containerInspect.NetworkSettings.Networks.orc_default.Aliases[0], 'ollama');
      assert.throws(() => database.prepare(`UPDATE update_snapshots SET public_metadata_json = '{}' WHERE id = ?`).run(row.id));
      assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM jobs`).get().count, 0);
      const audit = database.prepare(`SELECT action, parameters_redacted_json, result FROM audit_events ORDER BY timestamp, id`).all();
      assert(audit.some((entry) => entry.action === 'container.update_preflight.requested'));
      assert(audit.some((entry) => entry.action === 'container.update_preflight.snapshot_created'));
      assert.equal(JSON.stringify(audit).includes('top-secret'), false);
    } finally {
      database.close();
    }
  } finally {
    resetFixture();
    await app.close();
  }
});

test('update preflight guards authentication, CSRF and disabled targets before remote capture', {
  skip: !HAS_FIXTURE,
}, async () => {
  resetFixture();
  const databasePath = newDatabasePath('orc-update-preflight-guards-');
  const app = newApp(databasePath);
  try {
    const { cookies, targetId } = await bootstrapSelectedTarget(app);
    fs.writeFileSync(DOCKER_FIXTURE_LOG, '');

    const unauthenticated = await app.inject({
      method: 'POST', url: `/api/v1/targets/${targetId}/container/update-preflight`,
    });
    assert.equal(unauthenticated.statusCode, 401);

    const noCsrf = await app.inject({
      method: 'POST',
      url: `/api/v1/targets/${targetId}/container/update-preflight`,
      headers: { cookie: cookieHeader(cookies) },
    });
    assert.equal(noCsrf.statusCode, 403);

    const database = openDatabase(databasePath);
    database.prepare(`UPDATE ollama_targets SET enabled = 0 WHERE id = ?`).run(targetId);
    database.close();
    const disabled = await app.inject({
      method: 'POST',
      url: `/api/v1/targets/${targetId}/container/update-preflight`,
      headers: mutationHeaders(cookies),
    });
    assert.equal(disabled.statusCode, 404);
    assert.equal(disabled.json().error.code, 'TARGET_NOT_FOUND');
    assert.deepEqual(dockerCalls(), []);
  } finally {
    resetFixture();
    await app.close();
  }
});

test('missing master key rejects preflight before SSH and snapshot persistence', {
  skip: !HAS_FIXTURE,
}, async () => {
  resetFixture();
  const databasePath = newDatabasePath('orc-update-preflight-key-');
  const setupApp = newApp(databasePath);
  const { cookies, targetId } = await bootstrapSelectedTarget(setupApp);
  await setupApp.close();
  fs.writeFileSync(DOCKER_FIXTURE_LOG, '');

  const app = newApp(databasePath, null);
  try {
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/targets/${targetId}/container/update-preflight`,
      headers: mutationHeaders(cookies),
    });
    assert.equal(response.statusCode, 503);
    assert.equal(response.json().error.code, 'MASTER_KEY_REQUIRED');
    assert.deepEqual(dockerCalls(), []);

    const database = openDatabase(databasePath);
    try {
      assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM update_snapshots`).get().count, 0);
    } finally {
      database.close();
    }
  } finally {
    resetFixture();
    await app.close();
  }
});
