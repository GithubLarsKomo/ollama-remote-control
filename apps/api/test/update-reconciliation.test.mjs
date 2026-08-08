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
import { SecretCipher, UpdateSnapshotCipher } from '@orc/security';
import { AuditService } from '../dist/audit.js';
import { JobService } from '../dist/jobs.js';
import {
  UpdateReconciliationError,
  UpdateReconciliationService,
} from '../dist/update-reconciliation.js';

const MASTER_KEY = Buffer.alloc(32, 0x5a);
const OLD_DIGEST = `sha256:${'1'.repeat(64)}`;
const NEW_DIGEST = `sha256:${'2'.repeat(64)}`;
const OLD_REF = `ollama/ollama@${OLD_DIGEST}`;
const NEW_REF = `ollama/ollama@${NEW_DIGEST}`;
const NOW = new Date('2026-08-08T14:00:00.000Z');

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
    ollama: { cliVersion: '0.32.5', apiReachable: false, apiVersion: null, versionMatch: false },
    transport: { mode: 'published-binding' },
  };
}

function createFixture({ updateState = 'running', stages = [], unrelatedJob = false } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orc-update-recovery-'));
  const database = openDatabase(path.join(directory, 'app.sqlite'));
  applyMigrations(database);
  database.prepare(`
    INSERT INTO users(id, username, password_hash, role, created_at)
    VALUES (?, ?, ?, 'admin', ?)
  `).run('user-1', 'recovery-admin', 'test-hash', NOW.toISOString());

  const hosts = new SqliteHostOnboardingRepository(database);
  const credentials = new SqliteSshCredentialRepository(database);
  const targets = new SqliteOllamaTargetRepository(database);
  const snapshots = new SqliteUpdateSnapshotRepository(database);
  const jobs = new JobService(new SqliteJobRepository(database), () => NOW);
  const audit = new AuditService(new SqliteAuditRepository(database), () => NOW);
  const bindings = new SqliteTargetContainerBindingRepository(database);

  hosts.createHostWithCredential(
    {
      id: 'host-1',
      displayName: 'Recovery host',
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
        '-----BEGIN PRIVATE KEY-----\nRECOVERY-PRIVATE-KEY-SECRET\n-----END PRIVATE KEY-----',
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
        Env: ['OLLAMA_API_KEY=RECOVERY-SNAPSHOT-SECRET'],
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
    actorUserId: 'user-1',
    createdAt: NOW.toISOString(),
    publicMetadataJson: '{}',
    encryptedPayload: new UpdateSnapshotCipher(MASTER_KEY).encrypt(
      { snapshotId: 'snapshot-1', targetId: 'target-1' },
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

  const updateJob = jobs.create({
    targetId: 'target-1', actorUserId: 'user-1', kind: 'container.update', mutating: true,
  });
  if (updateState === 'running') jobs.transition(updateJob.id, 'running');
  for (const [stage, payload = {}] of stages) jobs.appendEvent(updateJob.id, 'stage', { stage, ...payload });

  let unrelated = null;
  if (unrelatedJob) {
    unrelated = jobs.create({ targetId: 'target-1', actorUserId: 'user-1', kind: 'diagnostic.read', mutating: false });
    jobs.transition(unrelated.id, 'running');
  }

  return { database, hosts, credentials, targets, snapshots, jobs, audit, bindings, intent, updateJob, unrelated };
}

function remoteController(mode = 'changed') {
  const calls = [];
  let current = mode === 'old' ? 'old-container-id' : 'candidate-container-id';
  return {
    calls,
    remoteFactory: () => ({
      async validateCompose() { calls.push(['validate']); },
      async replace(context, exactImageReference, expectedPreviousContainerId, source) {
        calls.push(['replace', source, exactImageReference, expectedPreviousContainerId, context.service]);
        if (mode === 'rollback-fail') throw new Error('REMOTE-ROLLBACK-SECRET');
        assert.equal(source, 'local-only');
        assert.equal(exactImageReference, OLD_REF);
        assert.equal(expectedPreviousContainerId, current);
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
        calls.push(['resolve', context.service]);
        if (mode === 'resolve-fail') throw new Error('REMOTE-RESOLVE-SECRET');
        return current;
      },
      async health(targetId, containerId) {
        calls.push(['health', targetId, containerId]);
        if (mode === 'health-fail') throw new Error('REMOTE-HEALTH-SECRET');
        if (mode === 'degraded') return degraded();
        return healthy(containerId === 'candidate-container-id' ? '0.33.0' : '0.32.5');
      },
    }),
  };
}

function recovery(fixture, remoteFactory, masterKey = MASTER_KEY) {
  return new UpdateReconciliationService(
    fixture.hosts,
    fixture.credentials,
    fixture.targets,
    fixture.bindings,
    fixture.snapshots,
    masterKey,
    fixture.jobs,
    fixture.audit,
    remoteFactory,
    () => NOW,
  );
}

function stageSequence(fixture) {
  return fixture.jobs.events(fixture.updateJob.id)
    .filter((event) => event.eventType === 'stage')
    .map((event) => JSON.parse(event.payloadJson).stage);
}

function storedUpdateJob(fixture) {
  return fixture.jobs.get(fixture.updateJob.id);
}

const LOCK = (intentId) => ['lock_acquired', { intentId }];
const FORWARD = ['forward_started', { candidateDigest: NEW_DIGEST }];

test('queued or running interrupted update before forward terminalizes locally without remote access', async () => {
  for (const updateState of ['queued', 'running']) {
    const fixture = createFixture({ updateState });
    let remoteFactoryCalled = false;
    try {
      const summary = await recovery(fixture, () => {
        remoteFactoryCalled = true;
        throw new Error('remote must not be constructed');
      }).reconcile();
      assert.deepEqual(summary, { examined: 1, reconciled: 1 });
      assert.equal(remoteFactoryCalled, false);
      assert.equal(storedUpdateJob(fixture).state, 'failed');
      assert.equal(storedUpdateJob(fixture).errorClass, 'UPDATE_RECOVERY_INTERRUPTED_BEFORE_MUTATION');
      assert.equal(fixture.targets.findById('target-1').selectedContainerId, 'old-container-id');
    } finally { fixture.database.close(); }
  }
});

test('post-forward unchanged original service is health-verified and terminalized without rollback', async () => {
  const fixture = createFixture({ stages: [LOCK('PLACEHOLDER'), FORWARD] });
  const events = fixture.jobs.events(fixture.updateJob.id);
  const lockEvent = events.find((event) => event.eventType === 'stage' && JSON.parse(event.payloadJson).stage === 'lock_acquired');
  fixture.database.prepare('UPDATE job_events SET payload_json = ? WHERE id = ?').run(
    JSON.stringify({ stage: 'lock_acquired', intentId: fixture.intent.intentId }),
    lockEvent.id,
  );
  const remote = remoteController('old');
  try {
    await recovery(fixture, remote.remoteFactory).reconcile();
    const job = storedUpdateJob(fixture);
    assert.equal(job.state, 'failed');
    assert.equal(job.errorClass, 'UPDATE_RECOVERY_INTERRUPTED_NO_REPLACEMENT');
    assert.deepEqual(remote.calls.map((call) => call[0]), ['resolve', 'health']);
    assert.equal(fixture.targets.findById('target-1').selectedContainerId, 'old-container-id');
  } finally { fixture.database.close(); }
});

test('post-forward changed service performs local-only rollback, CAS rebind and healthy verification', async () => {
  const fixture = createFixture({ stages: [] });
  fixture.jobs.appendEvent(fixture.updateJob.id, 'stage', { stage: 'lock_acquired', intentId: fixture.intent.intentId });
  fixture.jobs.appendEvent(fixture.updateJob.id, 'stage', { stage: 'forward_started', candidateDigest: NEW_DIGEST });
  fixture.jobs.appendEvent(fixture.updateJob.id, 'stage', { stage: 'replacement_created', containerId: 'candidate-container-id' });
  assert.equal(fixture.bindings.rebindContainer('target-1', 'old-container-id', 'candidate-container-id', NOW.toISOString()), true);
  const remote = remoteController('changed');
  try {
    await recovery(fixture, remote.remoteFactory).reconcile();
    const job = storedUpdateJob(fixture);
    assert.equal(job.state, 'failed');
    assert.equal(job.errorClass, 'UPDATE_RECOVERY_ROLLBACK_SUCCEEDED');
    assert.equal(JSON.parse(job.resultJson).outcome, 'recovered_rolled_back');
    assert.equal(fixture.targets.findById('target-1').selectedContainerId, 'rollback-container-id');
    assert.deepEqual(remote.calls.map((call) => call[0]), ['resolve', 'replace', 'health']);
    assert.deepEqual(remote.calls.filter((call) => call[0] === 'replace').map((call) => call[1]), ['local-only']);
  } finally { fixture.database.close(); }
});

test('uncommitted candidate health never commits after restart and is rolled back', async () => {
  const fixture = createFixture({ stages: [] });
  fixture.jobs.appendEvent(fixture.updateJob.id, 'stage', { stage: 'lock_acquired', intentId: fixture.intent.intentId });
  fixture.jobs.appendEvent(fixture.updateJob.id, 'stage', { stage: 'forward_started', candidateDigest: NEW_DIGEST });
  fixture.jobs.appendEvent(fixture.updateJob.id, 'stage', { stage: 'replacement_created', containerId: 'candidate-container-id' });
  fixture.jobs.appendEvent(fixture.updateJob.id, 'stage', { stage: 'binding_rebound', fromContainerId: 'old-container-id', containerId: 'candidate-container-id' });
  fixture.jobs.appendEvent(fixture.updateJob.id, 'stage', { stage: 'health_verified', containerId: 'candidate-container-id', version: '0.33.0' });
  assert.equal(fixture.bindings.rebindContainer('target-1', 'old-container-id', 'candidate-container-id', NOW.toISOString()), true);
  const remote = remoteController('changed');
  try {
    await recovery(fixture, remote.remoteFactory).reconcile();
    assert.equal(storedUpdateJob(fixture).errorClass, 'UPDATE_RECOVERY_ROLLBACK_SUCCEEDED');
    assert.equal(fixture.targets.findById('target-1').selectedContainerId, 'rollback-container-id');
    assert.equal(remote.calls.filter((call) => call[0] === 'replace').length, 1);
  } finally { fixture.database.close(); }
});

test('a second restart after recovery replacement resumes by health-checking the proven rollback container without another recreate', async () => {
  const fixture = createFixture({ stages: [] });
  fixture.jobs.appendEvent(fixture.updateJob.id, 'stage', { stage: 'lock_acquired', intentId: fixture.intent.intentId });
  fixture.jobs.appendEvent(fixture.updateJob.id, 'stage', { stage: 'forward_started', candidateDigest: NEW_DIGEST });
  fixture.jobs.appendEvent(fixture.updateJob.id, 'stage', { stage: 'replacement_created', containerId: 'candidate-container-id' });
  fixture.jobs.appendEvent(fixture.updateJob.id, 'stage', { stage: 'recovery_rollback_replacement_created', containerId: 'rollback-container-id', imageId: `sha256:${'3'.repeat(64)}` });
  assert.equal(fixture.bindings.rebindContainer('target-1', 'old-container-id', 'rollback-container-id', NOW.toISOString()), true);
  const remote = remoteController('changed');
  remote.remoteFactory = () => ({
    async validateCompose() {},
    async replace() { remote.calls.push(['replace']); throw new Error('must not recreate proven rollback'); },
    async resolveComposeContainer() { remote.calls.push(['resolve']); return 'rollback-container-id'; },
    async health(targetId, containerId) { remote.calls.push(['health', targetId, containerId]); return healthy(); },
  });
  try {
    await recovery(fixture, remote.remoteFactory).reconcile();
    assert.deepEqual(remote.calls.map((call) => call[0]), ['resolve', 'health']);
    assert.equal(storedUpdateJob(fixture).errorClass, 'UPDATE_RECOVERY_ROLLBACK_SUCCEEDED');
  } finally { fixture.database.close(); }
});

test('unresolved remote, rollback or health failure blocks reconciliation and preserves the mutation lock', async () => {
  for (const mode of ['resolve-fail', 'rollback-fail', 'health-fail', 'degraded']) {
    const fixture = createFixture({ stages: [] });
    fixture.jobs.appendEvent(fixture.updateJob.id, 'stage', { stage: 'lock_acquired', intentId: fixture.intent.intentId });
    fixture.jobs.appendEvent(fixture.updateJob.id, 'stage', { stage: 'forward_started', candidateDigest: NEW_DIGEST });
    const remote = remoteController(mode);
    try {
      await assert.rejects(
        () => recovery(fixture, remote.remoteFactory).reconcile(),
        (error) => error instanceof UpdateReconciliationError,
      );
      assert.equal(storedUpdateJob(fixture).state, 'running');
      assert.equal(fixture.jobs.jobsNeedingReconciliation().some((job) => job.id === fixture.updateJob.id), true);
    } finally { fixture.database.close(); }
  }
});

test('missing recovery authority after forward fails closed before constructing remote operations', async () => {
  const fixture = createFixture({ stages: [FORWARD] });
  let called = false;
  try {
    await assert.rejects(
      () => recovery(fixture, () => { called = true; throw new Error('must not construct remote'); }).reconcile(),
      (error) => error instanceof UpdateReconciliationError && error.code === 'UPDATE_RECOVERY_AUTHORITY_INVALID',
    );
    assert.equal(called, false);
    assert.equal(storedUpdateJob(fixture).state, 'running');
  } finally { fixture.database.close(); }
});

test('unrelated non-terminal jobs are untouched and recovery persistence contains no secret sentinels', async () => {
  const fixture = createFixture({ unrelatedJob: true, stages: [] });
  fixture.jobs.appendEvent(fixture.updateJob.id, 'stage', { stage: 'lock_acquired', intentId: fixture.intent.intentId });
  fixture.jobs.appendEvent(fixture.updateJob.id, 'stage', { stage: 'forward_started', candidateDigest: NEW_DIGEST });
  const remote = remoteController('changed');
  try {
    const summary = await recovery(fixture, remote.remoteFactory).reconcile();
    assert.deepEqual(summary, { examined: 1, reconciled: 1 });
    assert.equal(fixture.jobs.get(fixture.unrelated.id).state, 'running');
    const persisted = JSON.stringify({
      jobs: fixture.database.prepare('SELECT kind, state, result_json, error_class FROM jobs').all(),
      events: fixture.database.prepare('SELECT event_type, payload_json FROM job_events').all(),
      audit: fixture.database.prepare('SELECT action, parameters_redacted_json, error_class FROM audit_events').all(),
    });
    for (const secret of [
      'RECOVERY-PRIVATE-KEY-SECRET',
      'RECOVERY-SNAPSHOT-SECRET',
      'REMOTE-ROLLBACK-SECRET',
      'REMOTE-RESOLVE-SECRET',
      'REMOTE-HEALTH-SECRET',
    ]) assert.equal(persisted.includes(secret), false);
  } finally { fixture.database.close(); }
});
