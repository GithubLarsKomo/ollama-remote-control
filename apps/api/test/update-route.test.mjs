import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  openDatabase,
  SqliteHostOnboardingRepository,
  SqliteJobRepository,
  SqliteOllamaTargetRepository,
  SqliteUpdateSnapshotRepository,
} from '@orc/db';
import { SecretCipher, UpdateSnapshotCipher } from '@orc/security';
import { JobService } from '../dist/jobs.js';
import { buildServer } from '../dist/server.js';

const MASTER_KEY = Buffer.alloc(32, 0x6b);
const PASSWORD = 'update-route-admin-password!';
const NOW = new Date('2026-08-08T15:00:00.000Z');
const OLD_DIGEST = `sha256:${'1'.repeat(64)}`;
const NEW_DIGEST = `sha256:${'2'.repeat(64)}`;
const OLD_REF = `ollama/ollama@${OLD_DIGEST}`;
const NEW_REF = `ollama/ollama@${NEW_DIGEST}`;

function databasePath(prefix) {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), prefix)), 'app.sqlite');
}

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

async function bootstrap(app) {
  const setup = await app.inject({
    method: 'POST', url: '/api/v1/setup/admin', payload: { username: 'admin', password: PASSWORD },
  });
  assert.equal(setup.statusCode, 201);
  const login = await app.inject({
    method: 'POST', url: '/api/v1/session', payload: { username: 'admin', password: PASSWORD },
  });
  assert.equal(login.statusCode, 200);
  return { cookies: cookiesFrom(login), userId: login.json().user.id };
}

function seedAuthority(filename, actorUserId) {
  const database = openDatabase(filename);
  try {
    const hosts = new SqliteHostOnboardingRepository(database);
    const targets = new SqliteOllamaTargetRepository(database);
    const snapshots = new SqliteUpdateSnapshotRepository(database);
    const jobs = new JobService(new SqliteJobRepository(database), () => NOW);

    hosts.createHostWithCredential(
      {
        id: 'host-1',
        displayName: 'Update route host',
        hostname: 'ollama.internal',
        port: 22,
        username: 'orc',
        hostKeyFingerprint: `SHA256:${'A'.repeat(43)}`,
        enabled: true,
        createdAt: NOW.toISOString(),
        updatedAt: NOW.toISOString(),
      },
      {
        id: 'cred-1',
        hostId: 'host-1',
        encryptedPrivateKey: new SecretCipher(MASTER_KEY).encrypt(
          { credentialId: 'cred-1', hostId: 'host-1' },
          '-----BEGIN PRIVATE KEY-----\nUPDATE-ROUTE-PRIVATE-KEY-SECRET\n-----END PRIVATE KEY-----',
        ),
        createdAt: NOW.toISOString(),
        updatedAt: NOW.toISOString(),
      },
    );
    targets.saveSelection({
      id: 'target-1',
      hostId: 'host-1',
      displayName: 'Primary Ollama',
      selectedContainerId: 'old-container-id',
      containerNameOverride: null,
      enabled: true,
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    });

    const snapshotPayload = JSON.stringify({
      schemaVersion: 1,
      containerInspect: {
        Id: 'old-container-id',
        Config: {
          Image: 'ollama/ollama:latest',
          Env: ['OLLAMA_API_KEY=UPDATE-ROUTE-SNAPSHOT-SECRET'],
          Labels: {
            'com.docker.compose.project': 'orc-stack',
            'com.docker.compose.service': 'ollama',
            'com.docker.compose.project.config_files': '/srv/orc/compose.yml',
            'com.docker.compose.project.working_dir': '/srv/orc',
          },
        },
        State: { Running: true },
      },
      imageInspect: {
        Id: `sha256:${'3'.repeat(64)}`,
        RepoDigests: [`docker.io/${OLD_REF}`],
        Architecture: 'amd64',
        Os: 'linux',
      },
      ollamaVersion: 'ollama version is 0.32.5',
    });
    snapshots.save({
      id: 'snapshot-1',
      targetId: 'target-1',
      actorUserId,
      createdAt: NOW.toISOString(),
      publicMetadataJson: '{}',
      encryptedPayload: new UpdateSnapshotCipher(MASTER_KEY).encrypt(
        { snapshotId: 'snapshot-1', targetId: 'target-1' },
        snapshotPayload,
      ),
    });

    const intentJob = jobs.create({
      targetId: 'target-1', actorUserId, kind: 'container.update_execution_intent', mutating: false,
    });
    jobs.transition(intentJob.id, 'running');
    const intent = {
      intentVersion: 1,
      intentId: intentJob.id,
      targetId: 'target-1',
      snapshotId: 'snapshot-1',
      imageReference: 'ollama/ollama:latest',
      currentDigest: OLD_DIGEST,
      candidateDigest: NEW_DIGEST,
      candidateIndexDigest: `sha256:${'4'.repeat(64)}`,
      exactCandidateReference: NEW_REF,
      candidateImageVersion: '0.33.0',
      strategy: 'compose',
      composeService: 'ollama',
      createdAt: intentJob.createdAt,
    };
    jobs.transition(intentJob.id, 'succeeded', { result: intent });
    return intent;
  } finally {
    database.close();
  }
}

function confirmation(intent, overrides = {}) {
  return {
    intentId: intent.intentId,
    confirmation: {
      action: 'update',
      targetId: intent.targetId,
      intentId: intent.intentId,
      ...overrides,
    },
  };
}

function remoteController(mode = 'success') {
  const calls = [];
  let current = 'old-container-id';
  return {
    calls,
    factory: () => ({
      async validateCompose(context, expectedContainerId) {
        calls.push(['validate', context.service, expectedContainerId]);
        assert.equal(expectedContainerId, 'old-container-id');
      },
      async replace(context, exactImageReference, expectedPreviousContainerId, source) {
        calls.push(['replace', source, exactImageReference, expectedPreviousContainerId, context.service]);
        if (source === 'pull-exact') {
          assert.equal(exactImageReference, NEW_REF);
          current = 'candidate-container-id';
          return {
            source,
            exactImageReference,
            imageId: `sha256:${'5'.repeat(64)}`,
            previousContainerId: expectedPreviousContainerId,
            containerId: current,
          };
        }
        assert.equal(source, 'local-only');
        assert.equal(exactImageReference, OLD_REF);
        current = 'rollback-container-id';
        return {
          source,
          exactImageReference,
          imageId: `sha256:${'3'.repeat(64)}`,
          previousContainerId: expectedPreviousContainerId,
          containerId: current,
        };
      },
      async resolveComposeContainer(context) {
        calls.push(['resolve', context.service, current]);
        return current;
      },
      async health(targetId, containerId) {
        calls.push(['health', targetId, containerId]);
        if (mode === 'degraded' && containerId === 'candidate-container-id') {
          return {
            targetId,
            status: 'degraded',
            container: { running: true },
            ollama: { cliVersion: '0.33.0', apiReachable: true, apiVersion: '0.32.5', versionMatch: false },
            transport: { mode: 'published-binding' },
          };
        }
        return {
          targetId,
          status: 'healthy',
          container: { running: true },
          ollama: {
            cliVersion: containerId === 'candidate-container-id' ? '0.33.0' : '0.32.5',
            apiReachable: true,
            apiVersion: containerId === 'candidate-container-id' ? '0.33.0' : '0.32.5',
            versionMatch: true,
          },
          transport: { mode: 'published-binding' },
        };
      },
    }),
  };
}

function persistence(filename) {
  const database = openDatabase(filename);
  try {
    return {
      target: database.prepare(`SELECT selected_container_id FROM ollama_targets WHERE id = 'target-1'`).get(),
      updateJobs: database.prepare(`
        SELECT id, state, result_json, error_class FROM jobs
        WHERE kind = 'container.update' ORDER BY created_at, id
      `).all(),
      allJobs: database.prepare(`SELECT kind, state, result_json, error_class FROM jobs ORDER BY created_at, id`).all(),
      events: database.prepare(`SELECT event_type, payload_json FROM job_events ORDER BY job_id, sequence`).all(),
      audit: database.prepare(`SELECT action, parameters_redacted_json, error_class FROM audit_events ORDER BY timestamp, id`).all(),
    };
  } finally {
    database.close();
  }
}

test('update route rejects auth, CSRF, hidden authority, confirmation mismatch and unknown intents before mutation', async () => {
  const filename = databasePath('orc-update-route-guards-');
  const remote = remoteController();
  const app = buildServer({
    databasePath: filename,
    environment: { ORC_MASTER_KEY: MASTER_KEY.toString('base64') },
    updateRemoteFactory: remote.factory,
  });
  try {
    const { cookies, userId } = await bootstrap(app);
    const intent = seedAuthority(filename, userId);
    const url = `/api/v1/targets/${intent.targetId}/container/update`;

    let response = await app.inject({ method: 'POST', url, payload: confirmation(intent) });
    assert.equal(response.statusCode, 401);

    response = await app.inject({
      method: 'POST', url, headers: { cookie: cookieHeader(cookies) }, payload: confirmation(intent),
    });
    assert.equal(response.statusCode, 403);

    response = await app.inject({
      method: 'POST', url, headers: mutationHeaders(cookies),
      payload: { ...confirmation(intent), candidateDigest: NEW_DIGEST },
    });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error.code, 'INVALID_UPDATE_EXECUTION_REQUEST');

    response = await app.inject({
      method: 'POST', url, headers: mutationHeaders(cookies),
      payload: confirmation(intent, { targetId: 'other-target' }),
    });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error.code, 'CONFIRMATION_REQUIRED');

    const unknownIntentId = 'unknown-intent-id';
    response = await app.inject({
      method: 'POST', url, headers: mutationHeaders(cookies),
      payload: {
        intentId: unknownIntentId,
        confirmation: { action: 'update', targetId: intent.targetId, intentId: unknownIntentId },
      },
    });
    assert.equal(response.statusCode, 404);
    assert.equal(response.json().error.code, 'JOB_NOT_FOUND');

    assert.deepEqual(remote.calls, []);
    assert.equal(persistence(filename).updateJobs.length, 0);
  } finally {
    await app.close();
  }
});

test('confirmed update route delegates to locked orchestrator and returns only safe successful result', async () => {
  const filename = databasePath('orc-update-route-success-');
  const remote = remoteController('success');
  const app = buildServer({
    databasePath: filename,
    environment: { ORC_MASTER_KEY: MASTER_KEY.toString('base64') },
    updateRemoteFactory: remote.factory,
  });
  try {
    const { cookies, userId } = await bootstrap(app);
    const intent = seedAuthority(filename, userId);
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/targets/${intent.targetId}/container/update`,
      headers: mutationHeaders(cookies),
      payload: confirmation(intent),
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().update.outcome, 'updated');
    assert.equal(response.json().update.intentId, intent.intentId);
    assert.equal(response.json().update.containerId, 'candidate-container-id');
    assert.equal(response.json().update.candidateDigest, NEW_DIGEST);
    assert.equal(response.body.includes('UPDATE-ROUTE-PRIVATE-KEY-SECRET'), false);
    assert.equal(response.body.includes('UPDATE-ROUTE-SNAPSHOT-SECRET'), false);
    assert.deepEqual(remote.calls.map((call) => call[0]), ['validate', 'replace', 'health']);

    const stored = persistence(filename);
    assert.equal(stored.target.selected_container_id, 'candidate-container-id');
    assert.equal(stored.updateJobs.length, 1);
    assert.equal(stored.updateJobs[0].state, 'succeeded');
    assert.equal(stored.updateJobs[0].error_class, null);
    const serialized = JSON.stringify(stored);
    assert.equal(serialized.includes('UPDATE-ROUTE-PRIVATE-KEY-SECRET'), false);
    assert.equal(serialized.includes('UPDATE-ROUTE-SNAPSHOT-SECRET'), false);
  } finally {
    await app.close();
  }
});

test('degraded candidate through route returns safe rollback failure and restores a healthy old digest container', async () => {
  const filename = databasePath('orc-update-route-rollback-');
  const remote = remoteController('degraded');
  const app = buildServer({
    databasePath: filename,
    environment: { ORC_MASTER_KEY: MASTER_KEY.toString('base64') },
    updateRemoteFactory: remote.factory,
  });
  try {
    const { cookies, userId } = await bootstrap(app);
    const intent = seedAuthority(filename, userId);
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/targets/${intent.targetId}/container/update`,
      headers: mutationHeaders(cookies),
      payload: confirmation(intent),
    });
    assert.equal(response.statusCode, 502);
    assert.equal(response.json().error.code, 'UPDATE_FAILED_ROLLBACK_SUCCEEDED');
    assert.equal(response.body.includes('UPDATE-ROUTE-PRIVATE-KEY-SECRET'), false);
    assert.equal(response.body.includes('UPDATE-ROUTE-SNAPSHOT-SECRET'), false);
    assert.deepEqual(remote.calls.map((call) => call[0]), ['validate', 'replace', 'health', 'replace', 'health']);
    assert.deepEqual(remote.calls.filter((call) => call[0] === 'replace').map((call) => call[1]), ['pull-exact', 'local-only']);

    const stored = persistence(filename);
    assert.equal(stored.target.selected_container_id, 'rollback-container-id');
    assert.equal(stored.updateJobs.length, 1);
    assert.equal(stored.updateJobs[0].state, 'failed');
    assert.equal(stored.updateJobs[0].error_class, 'UPDATE_FAILED_ROLLBACK_SUCCEEDED');
    assert.equal(JSON.parse(stored.updateJobs[0].result_json).outcome, 'rolled_back');
  } finally {
    await app.close();
  }
});

test('update route preserves persistent target mutation conflict without remote operations', async () => {
  const filename = databasePath('orc-update-route-conflict-');
  const remote = remoteController('success');
  const app = buildServer({
    databasePath: filename,
    environment: { ORC_MASTER_KEY: MASTER_KEY.toString('base64') },
    updateRemoteFactory: remote.factory,
  });
  try {
    const { cookies, userId } = await bootstrap(app);
    const intent = seedAuthority(filename, userId);
    const database = openDatabase(filename);
    try {
      const jobs = new JobService(new SqliteJobRepository(database), () => NOW);
      const blocker = jobs.create({ targetId: intent.targetId, actorUserId: userId, kind: 'blocking.mutation', mutating: true });
      jobs.transition(blocker.id, 'running');
    } finally {
      database.close();
    }

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/targets/${intent.targetId}/container/update`,
      headers: mutationHeaders(cookies),
      payload: confirmation(intent),
    });
    assert.equal(response.statusCode, 409);
    assert.equal(response.json().error.code, 'JOB_CONFLICT');
    assert.deepEqual(remote.calls, []);
    assert.equal(persistence(filename).updateJobs.length, 0);
  } finally {
    await app.close();
  }
});
