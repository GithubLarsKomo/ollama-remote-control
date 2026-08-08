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
const REGISTRY_MODE = process.env.ORC_REGISTRY_MODE;
const COMPOSE_MODE = process.env.ORC_COMPOSE_MODE;
const COMPOSE_STDIN = process.env.ORC_COMPOSE_STDIN;
const HAS_FIXTURE = Boolean(
  SSH_HOST && SSH_USER && SSH_PRIVATE_KEY_PATH && DOCKER_FIXTURE_LOG
  && CONTAINER_STATE && LIFECYCLE_MODE && REGISTRY_MODE && COMPOSE_MODE && COMPOSE_STDIN,
);
const MASTER_KEY = Buffer.alloc(32, 0x76);
const PASSWORD = 'update-execution-intent-admin-password!';
const CANDIDATE_DIGEST = `sha256:${'a'.repeat(64)}`;
const CANDIDATE_IMAGE = `ollama/ollama@${CANDIDATE_DIGEST}`;

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

function resetFixture() {
  if (!HAS_FIXTURE) return;
  fs.writeFileSync(CONTAINER_STATE, 'running');
  fs.writeFileSync(LIFECYCLE_MODE, 'normal');
  fs.writeFileSync(REGISTRY_MODE, 'intent-changed');
  fs.writeFileSync(COMPOSE_MODE, 'normal');
  fs.writeFileSync(DOCKER_FIXTURE_LOG, '');
  fs.writeFileSync(COMPOSE_STDIN, '');
  fs.writeFileSync('/tmp/orc-docker-fixture-mode', 'single');
  fs.writeFileSync('/tmp/orc-status-fixture-mode', 'normal');
}

function dockerCalls() {
  return fs.readFileSync(DOCKER_FIXTURE_LOG, 'utf8').trim().split(/\r?\n/u).filter(Boolean);
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
      displayName: 'Intent fixture host', hostname: SSH_HOST, port: SSH_PORT, username: SSH_USER,
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

async function createSnapshot(app, cookies, targetId) {
  const response = await app.inject({
    method: 'POST',
    url: `/api/v1/targets/${targetId}/container/update-preflight`,
    headers: mutationHeaders(cookies),
  });
  assert.equal(response.statusCode, 201);
  return response.json().snapshot.id;
}

function intentUrl(targetId) {
  return `/api/v1/targets/${targetId}/container/update-execution-intent`;
}

test('execution intent requires auth and CSRF before creating jobs or remote commands', { skip: !HAS_FIXTURE }, async () => {
  resetFixture();
  const databasePath = newDatabasePath('orc-update-intent-guard-');
  const app = newApp(databasePath);
  try {
    const { cookies, targetId } = await bootstrapTarget(app);
    const snapshotId = await createSnapshot(app, cookies, targetId);
    fs.writeFileSync(DOCKER_FIXTURE_LOG, '');

    const unauthenticated = await app.inject({
      method: 'POST', url: intentUrl(targetId), payload: { snapshotId },
    });
    assert.equal(unauthenticated.statusCode, 401);

    const noCsrf = await app.inject({
      method: 'POST', url: intentUrl(targetId), headers: { cookie: cookieHeader(cookies) }, payload: { snapshotId },
    });
    assert.equal(noCsrf.statusCode, 403);

    const missingSnapshot = await app.inject({
      method: 'POST', url: intentUrl(targetId), headers: mutationHeaders(cookies), payload: {},
    });
    assert.equal(missingSnapshot.statusCode, 400);
    assert.deepEqual(dockerCalls(), []);

    const database = openDatabase(databasePath);
    try {
      assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM jobs WHERE kind = 'container.update_execution_intent'`).get().count, 0);
    } finally {
      database.close();
    }
  } finally {
    resetFixture();
    await app.close();
  }
});

test('execution intent recomputes candidate, validates digest override over OpenSSH and persists a terminal non-mutating job', { skip: !HAS_FIXTURE }, async () => {
  resetFixture();
  const databasePath = newDatabasePath('orc-update-intent-success-');
  const app = newApp(databasePath);
  try {
    const { cookies, targetId } = await bootstrapTarget(app);
    const snapshotId = await createSnapshot(app, cookies, targetId);
    fs.writeFileSync(DOCKER_FIXTURE_LOG, '');
    fs.writeFileSync(COMPOSE_STDIN, '');

    const response = await app.inject({
      method: 'POST',
      url: intentUrl(targetId),
      headers: mutationHeaders(cookies),
      payload: { snapshotId },
    });
    assert.equal(response.statusCode, 201);
    const intent = response.json().intent;
    assert.equal(intent.intentVersion, 1);
    assert.equal(intent.targetId, targetId);
    assert.equal(intent.snapshotId, snapshotId);
    assert.equal(intent.imageReference, 'ollama/ollama:latest');
    assert.equal(intent.currentDigest, 'sha256:current-digest');
    assert.equal(intent.candidateDigest, CANDIDATE_DIGEST);
    assert.equal(intent.exactCandidateReference, CANDIDATE_IMAGE);
    assert.equal(intent.strategy, 'compose');
    assert.equal(intent.composeService, 'ollama');
    assert.equal(response.body.includes('top-secret'), false);
    assert.equal(response.body.includes('COMPOSE-PIN-SECRET'), false);

    assert.equal(
      fs.readFileSync(COMPOSE_STDIN, 'utf8'),
      JSON.stringify({ services: { ollama: { image: CANDIDATE_IMAGE } } }),
    );

    const calls = dockerCalls();
    assert.deepEqual(calls, [
      'buildx version',
      'buildx imagetools inspect ollama/ollama:latest --format {{json .Manifest}}',
      `buildx imagetools inspect ${CANDIDATE_IMAGE} --format {{json .Image}}`,
      'compose version --short',
      'compose -p orc-stack --project-directory /srv/orc -f /srv/orc/compose.yml config --services',
      'compose -p orc-stack --project-directory /srv/orc -f /srv/orc/compose.yml ps --all -q ollama',
      'compose -p orc-stack --project-directory /srv/orc -f /srv/orc/compose.yml -f - config --images ollama',
    ]);
    assert.equal(calls.some((call) => /(^|\s)(pull|up|down|create|start|stop|restart|rm)(\s|$)/u.test(call)), false);

    const database = openDatabase(databasePath);
    try {
      const job = database.prepare(`
        SELECT id, target_id, kind, mutating, state, result_json, error_class
        FROM jobs WHERE kind = 'container.update_execution_intent'
      `).get();
      assert(job);
      assert.equal(job.id, intent.intentId);
      assert.equal(job.target_id, targetId);
      assert.equal(job.mutating, 0);
      assert.equal(job.state, 'succeeded');
      assert.equal(job.error_class, null);
      assert.deepEqual(JSON.parse(job.result_json), intent);
      assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM update_snapshots`).get().count, 1);
      assert.equal(database.prepare(`SELECT selected_container_id FROM ollama_targets WHERE id = ?`).get(targetId).selected_container_id, 'ollama-container-id');
      const auditRows = database.prepare(`SELECT action, parameters_redacted_json, error_class FROM audit_events ORDER BY timestamp, id`).all();
      assert(auditRows.some((row) => row.action === 'container.update_execution_intent.created'));
      assert.equal(JSON.stringify(auditRows).includes('top-secret'), false);
      assert.equal(JSON.stringify(auditRows).includes('COMPOSE-PIN-SECRET'), false);
    } finally {
      database.close();
    }
  } finally {
    resetFixture();
    await app.close();
  }
});

test('no-update and Compose pin failures produce failed intent jobs without mutation or secret leakage', { skip: !HAS_FIXTURE }, async () => {
  resetFixture();
  const databasePath = newDatabasePath('orc-update-intent-failures-');
  const app = newApp(databasePath);
  try {
    const { cookies, targetId } = await bootstrapTarget(app);
    const snapshotId = await createSnapshot(app, cookies, targetId);

    fs.writeFileSync(REGISTRY_MODE, 'same');
    fs.writeFileSync(DOCKER_FIXTURE_LOG, '');
    let response = await app.inject({
      method: 'POST', url: intentUrl(targetId), headers: mutationHeaders(cookies), payload: { snapshotId },
    });
    assert.equal(response.statusCode, 409);
    assert.equal(response.json().error.code, 'NO_UPDATE_AVAILABLE');
    assert.equal(dockerCalls().some((call) => call.includes('-f - config --images')), false);

    fs.writeFileSync(REGISTRY_MODE, 'intent-changed');
    fs.writeFileSync(COMPOSE_MODE, 'pin-mismatch');
    fs.writeFileSync(DOCKER_FIXTURE_LOG, '');
    response = await app.inject({
      method: 'POST', url: intentUrl(targetId), headers: mutationHeaders(cookies), payload: { snapshotId },
    });
    assert.equal(response.statusCode, 409);
    assert.equal(response.json().error.code, 'COMPOSE_PIN_MISMATCH');
    assert.equal(response.body.includes('COMPOSE-PIN-SECRET'), false);
    assert.equal(dockerCalls().some((call) => /(^|\s)(pull|up|down|create|start|stop|restart|rm)(\s|$)/u.test(call)), false);

    fs.writeFileSync(COMPOSE_MODE, 'pin-fail');
    fs.writeFileSync(DOCKER_FIXTURE_LOG, '');
    response = await app.inject({
      method: 'POST', url: intentUrl(targetId), headers: mutationHeaders(cookies), payload: { snapshotId },
    });
    assert.equal(response.statusCode, 409);
    assert.equal(response.json().error.code, 'COMPOSE_PIN_VALIDATION_FAILED');
    assert.equal(response.body.includes('COMPOSE-PIN-SECRET'), false);

    const database = openDatabase(databasePath);
    try {
      const jobs = database.prepare(`
        SELECT state, mutating, error_class FROM jobs
        WHERE kind = 'container.update_execution_intent' ORDER BY created_at, id
      `).all();
      assert.equal(jobs.length, 3);
      assert.deepEqual(jobs.map((job) => [job.state, job.mutating, job.error_class]), [
        ['failed', 0, 'NO_UPDATE_AVAILABLE'],
        ['failed', 0, 'COMPOSE_PIN_MISMATCH'],
        ['failed', 0, 'COMPOSE_PIN_VALIDATION_FAILED'],
      ]);
    } finally {
      database.close();
    }
  } finally {
    resetFixture();
    await app.close();
  }
});
