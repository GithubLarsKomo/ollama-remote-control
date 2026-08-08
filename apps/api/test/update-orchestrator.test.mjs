import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  applyMigrations,
  openDatabase,
  SqliteAuditRepository,
  SqliteHostOnboardingRepository,
  SqliteJobRepository,
  SqliteOllamaTargetRepository,
  SqliteSshCredentialRepository,
  SqliteUpdateSnapshotRepository,
} from '@orc/db';
import { SqliteTargetContainerBindingRepository } from '@orc/db/target-binding';
import { ComposeReplacementError } from '@orc/docker/compose-replacement';
import { SecretCipher, UpdateSnapshotCipher } from '@orc/security';
import { AuditService } from '../dist/audit.js';
import { JobService, JobServiceError } from '../dist/jobs.js';
import {
  UpdateOrchestratorError,
  UpdateOrchestratorService,
} from '../dist/update-orchestrator.js';

const MASTER_KEY = Buffer.alloc(32, 0x78);
const OLD_DIGEST = `sha256:${'1'.repeat(64)}`;
const NEW_DIGEST = `sha256:${'2'.repeat(64)}`;
const OLD_REF = `ollama/ollama@${OLD_DIGEST}`;
const NEW_REF = `ollama/ollama@${NEW_DIGEST}`;
const NOW = new Date('2026-08-08T12:30:00.000Z');

function healthy(version = '0.32.5') {
  return {
    targetId: 'target-1',
    status: 'healthy',
    container: { running: true },
    ollama: { cliVersion: version, apiReachable: true, apiVersion: version, versionMatch: true },
    transport: { mode: 'published-binding' },
  };
}

function degraded() {
  return {
    targetId: 'target-1',
    status: 'degraded',
    container: { running: true },
    ollama: { cliVersion: '0.33.0', apiReachable: true, apiVersion: '0.32.5', versionMatch: false },
    transport: { mode: 'published-binding' },
  };
}

function createFixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orc-update-orchestrator-'));
  const databasePath = path.join(directory, 'app.sqlite');
  const database = openDatabase(databasePath);
  applyMigrations(database);
  database.prepare(`
    INSERT INTO users(id, username, password_hash, role, created_at)
    VALUES (?, ?, ?, 'admin', ?)
  `).run('user-1', 'orchestrator-admin', 'test-only-password-hash', NOW.toISOString());
  const hosts = new SqliteHostOnboardingRepository(database);
  const credentials = new SqliteSshCredentialRepository(database);
  const targets = new SqliteOllamaTargetRepository(database);
  const snapshots = new SqliteUpdateSnapshotRepository(database);
  const jobRepository = new SqliteJobRepository(database);
  const jobs = new JobService(jobRepository, () => NOW);
  const audit = new AuditService(new SqliteAuditRepository(database), () => NOW);
  const bindings = new SqliteTargetContainerBindingRepository(database);

  const hostId = 'host-1';
  const credentialId = 'cred-1';
  hosts.createHostWithCredential(
    {
      id: hostId,
      displayName: 'Update host',
      hostname: 'ollama.internal',
      port: 22,
      username: 'orc',
      hostKeyFingerprint: `SHA256:${'A'.repeat(43)}`,
      enabled: true,
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    },
    {
      id: credentialId,
      hostId,
      encryptedPrivateKey: new SecretCipher(MASTER_KEY).encrypt(
        { credentialId, hostId },
        '-----BEGIN PRIVATE KEY-----\nTEST-SECRET-PRIVATE-KEY\n-----END PRIVATE KEY-----',
      ),
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    },
  );
  targets.saveSelection({
    id: 'target-1',
    hostId,
    displayName: 'Primary Ollama',
    selectedContainerId: 'old-container-id',
    containerNameOverride: null,
    enabled: true,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
  });

  const snapshotId = 'snapshot-1';
  const snapshotPayload = JSON.stringify({
    schemaVersion: 1,
    containerInspect: {
      Id: 'old-container-id',
      Config: {
        Image: 'ollama/ollama:latest',
        Env: ['OLLAMA_API_KEY=SNAPSHOT-TOP-SECRET'],
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
    id: snapshotId,
    targetId: 'target-1',
    actorUserId: 'user-1',
    createdAt: NOW.toISOString(),
    publicMetadataJson: '{}',
    encryptedPayload: new UpdateSnapshotCipher(MASTER_KEY).encrypt(
      { snapshotId, targetId: 'target-1' },
      snapshotPayload,
    ),
  });

  const intentJob = jobs.create({
    targetId: 'target-1', actorUserId: 'user-1', kind: 'container.update_execution_intent', mutating: false,
  });
  jobs.transition(intentJob.id, 'running');
  const intent = {
    intentVersion: 1,
    intentId: intentJob.id,
    targetId: 'target-1',
    snapshotId,
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

  return {
    database,
    databasePath,
    hosts,
    credentials,
    targets,
    snapshots,
    jobs,
    audit,
    bindings,
    intent,
  };
}

function replacement(source, previousContainerId, containerId, exactImageReference) {
  return {
    source,
    exactImageReference,
    imageId: source === 'pull-exact' ? `sha256:${'5'.repeat(64)}` : `sha256:${'3'.repeat(64)}`,
    previousContainerId,
    containerId,
  };
}

function remoteController(mode = 'success') {
  const calls = [];
  let currentRemote = 'old-container-id';
  const remote = {
    calls,
    async validateCompose(context, expectedContainerId) {
      calls.push(['validate', context.service, expectedContainerId]);
      if (mode === 'validate-fail') throw new Error('REMOTE-VALIDATION-SECRET');
      assert.equal(expectedContainerId, 'old-container-id');
    },
    async replace(context, exactImageReference, expectedPreviousContainerId, source) {
      calls.push(['replace', source, exactImageReference, expectedPreviousContainerId]);
      if (source === 'pull-exact') {
        if (mode === 'forward-fail-before') throw new ComposeReplacementError('IMAGE_PULL_FAILED', 'safe forward failure');
        currentRemote = 'candidate-container-id';
        if (mode === 'forward-fail-after') throw new ComposeReplacementError('REPLACEMENT_INSPECT_FAILED', 'safe post-recreate failure');
        return replacement(source, expectedPreviousContainerId, currentRemote, exactImageReference);
      }
      if (mode === 'rollback-fail') {
        currentRemote = 'rollback-partial-id';
        throw new ComposeReplacementError('REPLACEMENT_INSPECT_FAILED', 'safe rollback failure');
      }
      currentRemote = 'rollback-container-id';
      return replacement(source, expectedPreviousContainerId, currentRemote, exactImageReference);
    },
    async resolveComposeContainer(context) {
      calls.push(['resolve', context.service, currentRemote]);
      return currentRemote;
    },
    async health(targetId, containerId) {
      calls.push(['health', targetId, containerId]);
      if (containerId === 'candidate-container-id') {
        if (mode === 'candidate-degraded' || mode === 'rollback-fail' || mode === 'rollback-health-fail') return degraded();
        return healthy('0.33.0');
      }
      if (containerId === 'rollback-container-id' && mode === 'rollback-health-fail') {
        throw new Error('ROLLBACK-HEALTH-SECRET');
      }
      return healthy('0.32.5');
    },
  };
  return remote;
}

function orchestrator(fixture, remote) {
  return new UpdateOrchestratorService(
    fixture.hosts,
    fixture.credentials,
    fixture.targets,
    fixture.bindings,
    fixture.snapshots,
    MASTER_KEY,
    fixture.jobs,
    fixture.audit,
    () => remote,
    () => NOW,
  );
}

function updateJob(database) {
  return database.prepare(`
    SELECT id, state, mutating, result_json, error_class FROM jobs
    WHERE kind = 'container.update' ORDER BY created_at, id DESC LIMIT 1
  `).get();
}

function stages(fixture, jobId) {
  return fixture.jobs.events(jobId)
    .filter((event) => event.eventType === 'stage')
    .map((event) => JSON.parse(event.payloadJson).stage);
}

test('successful update holds mutation job, rebinds candidate and terminalizes healthy success', async () => {
  const fixture = createFixture();
  const remote = remoteController('success');
  try {
    const result = await orchestrator(fixture, remote).execute('target-1', fixture.intent.intentId, 'user-1');
    assert.equal(result.outcome, 'updated');
    assert.equal(result.containerId, 'candidate-container-id');
    assert.equal(fixture.targets.findById('target-1').selectedContainerId, 'candidate-container-id');
    const job = updateJob(fixture.database);
    assert.equal(job.mutating, 1);
    assert.equal(job.state, 'succeeded');
    assert.equal(job.error_class, null);
    assert.equal(JSON.parse(job.result_json).candidateDigest, NEW_DIGEST);
    assert.deepEqual(stages(fixture, job.id), [
      'lock_acquired', 'compose_revalidated', 'forward_started', 'replacement_created', 'binding_rebound', 'health_verified',
    ]);
    assert.deepEqual(remote.calls.map((call) => call[0]), ['validate', 'replace', 'health']);
  } finally { fixture.database.close(); }
});

test('degraded candidate triggers local-only rollback, rollback rebind and healthy verification', async () => {
  const fixture = createFixture();
  const remote = remoteController('candidate-degraded');
  try {
    await assert.rejects(
      () => orchestrator(fixture, remote).execute('target-1', fixture.intent.intentId, 'user-1'),
      (error) => error instanceof UpdateOrchestratorError && error.code === 'UPDATE_FAILED_ROLLBACK_SUCCEEDED',
    );
    assert.equal(fixture.targets.findById('target-1').selectedContainerId, 'rollback-container-id');
    const job = updateJob(fixture.database);
    assert.equal(job.state, 'failed');
    assert.equal(job.error_class, 'UPDATE_FAILED_ROLLBACK_SUCCEEDED');
    assert.equal(JSON.parse(job.result_json).outcome, 'rolled_back');
    assert.deepEqual(remote.calls.filter((call) => call[0] === 'replace').map((call) => call[1]), ['pull-exact', 'local-only']);
    assert.deepEqual(stages(fixture, job.id).slice(-4), [
      'rollback_started', 'rollback_replacement_created', 'rollback_binding_rebound', 'rollback_health_verified',
    ]);
  } finally { fixture.database.close(); }
});

test('forward failure after recreate resolves changed service and still performs rollback', async () => {
  const fixture = createFixture();
  const remote = remoteController('forward-fail-after');
  try {
    await assert.rejects(
      () => orchestrator(fixture, remote).execute('target-1', fixture.intent.intentId, 'user-1'),
      (error) => error instanceof UpdateOrchestratorError && error.code === 'UPDATE_FAILED_ROLLBACK_SUCCEEDED',
    );
    assert.equal(fixture.targets.findById('target-1').selectedContainerId, 'rollback-container-id');
    assert.deepEqual(remote.calls.map((call) => call[0]), ['validate', 'replace', 'resolve', 'replace', 'health']);
  } finally { fixture.database.close(); }
});

test('forward failure before recreate resolves original service and skips rollback', async () => {
  const fixture = createFixture();
  const remote = remoteController('forward-fail-before');
  try {
    await assert.rejects(
      () => orchestrator(fixture, remote).execute('target-1', fixture.intent.intentId, 'user-1'),
      (error) => error instanceof UpdateOrchestratorError && error.code === 'IMAGE_PULL_FAILED',
    );
    assert.equal(fixture.targets.findById('target-1').selectedContainerId, 'old-container-id');
    assert.deepEqual(remote.calls.map((call) => call[0]), ['validate', 'replace', 'resolve']);
    assert.equal(updateJob(fixture.database).error_class, 'IMAGE_PULL_FAILED');
  } finally { fixture.database.close(); }
});

test('rollback replacement or health failure is terminal UPDATE_FAILED_ROLLBACK_FAILED and never success', async () => {
  for (const mode of ['rollback-fail', 'rollback-health-fail']) {
    const fixture = createFixture();
    const remote = remoteController(mode);
    try {
      await assert.rejects(
        () => orchestrator(fixture, remote).execute('target-1', fixture.intent.intentId, 'user-1'),
        (error) => error instanceof UpdateOrchestratorError && error.code === 'UPDATE_FAILED_ROLLBACK_FAILED',
      );
      const job = updateJob(fixture.database);
      assert.equal(job.state, 'failed');
      assert.equal(job.error_class, 'UPDATE_FAILED_ROLLBACK_FAILED');
      assert.notEqual(JSON.parse(job.result_json).outcome, 'updated');
    } finally { fixture.database.close(); }
  }
});

test('concurrent target mutation is rejected before remote operations', async () => {
  const fixture = createFixture();
  const remote = remoteController('success');
  try {
    const blocker = fixture.jobs.create({ targetId: 'target-1', actorUserId: 'user-1', kind: 'blocking.mutation', mutating: true });
    fixture.jobs.transition(blocker.id, 'running');
    await assert.rejects(
      () => orchestrator(fixture, remote).execute('target-1', fixture.intent.intentId, 'user-1'),
      (error) => error instanceof JobServiceError && error.code === 'JOB_CONFLICT',
    );
    assert.deepEqual(remote.calls, []);
    assert.equal(fixture.targets.findById('target-1').selectedContainerId, 'old-container-id');
  } finally { fixture.database.close(); }
});

test('stale binding is rejected before update job creation and remote operations', async () => {
  const fixture = createFixture();
  const remote = remoteController('success');
  try {
    assert.equal(fixture.bindings.rebindContainer('target-1', 'old-container-id', 'externally-changed-id', NOW.toISOString()), true);
    await assert.rejects(
      () => orchestrator(fixture, remote).execute('target-1', fixture.intent.intentId, 'user-1'),
      (error) => error instanceof UpdateOrchestratorError && error.code === 'UPDATE_BINDING_STALE',
    );
    assert.equal(fixture.database.prepare(`SELECT COUNT(*) AS count FROM jobs WHERE kind = 'container.update'`).get().count, 0);
    assert.deepEqual(remote.calls, []);
  } finally { fixture.database.close(); }
});

test('jobs, stages and audits never persist snapshot or credential secret sentinels', async () => {
  const fixture = createFixture();
  const remote = remoteController('candidate-degraded');
  try {
    await assert.rejects(() => orchestrator(fixture, remote).execute('target-1', fixture.intent.intentId, 'user-1'));
    const serialized = JSON.stringify({
      jobs: fixture.database.prepare('SELECT kind, result_json, error_class FROM jobs').all(),
      events: fixture.database.prepare('SELECT event_type, payload_json FROM job_events').all(),
      audit: fixture.database.prepare('SELECT action, parameters_redacted_json, error_class FROM audit_events').all(),
    });
    assert.equal(serialized.includes('SNAPSHOT-TOP-SECRET'), false);
    assert.equal(serialized.includes('TEST-SECRET-PRIVATE-KEY'), false);
    assert.equal(serialized.includes('REMOTE-VALIDATION-SECRET'), false);
    assert.equal(serialized.includes('ROLLBACK-HEALTH-SECRET'), false);
  } finally { fixture.database.close(); }
});