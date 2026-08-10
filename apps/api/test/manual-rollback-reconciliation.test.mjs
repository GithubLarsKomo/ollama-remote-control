import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyMigrations,
  openDatabase,
  SqliteHostOnboardingRepository,
  SqliteJobRepository,
  SqliteOllamaTargetRepository,
  SqliteSshCredentialRepository,
  SqliteUpdateSnapshotRepository,
} from '@orc/db';
import { SqliteTargetContainerBindingRepository } from '@orc/db/target-binding';
import { ComposeReplacementError } from '@orc/docker/compose-replacement';
import { SecretCipher, UpdateSnapshotCipher } from '@orc/security';
import { JobService } from '../dist/jobs.js';
import {
  ManualRollbackReconciliationError,
  ManualRollbackReconciliationService,
} from '../dist/manual-rollback-reconciliation.js';

const MASTER_KEY = Buffer.alloc(32, 0x52);
const NOW = new Date('2026-08-10T13:00:00.000Z');
const OLD_DIGEST = `sha256:${'1'.repeat(64)}`;
const NEW_DIGEST = `sha256:${'2'.repeat(64)}`;
const OLD_REF = `ollama/ollama@${OLD_DIGEST}`;
const NEW_REF = `ollama/ollama@${NEW_DIGEST}`;

function healthy(containerId) {
  return {
    targetId: 'target-1',
    status: 'healthy',
    container: { running: true },
    ollama: { cliVersion: '0.33.0', apiReachable: true, apiVersion: '0.33.0', versionMatch: true },
    transport: { mode: 'published-binding' },
    containerId,
  };
}

function fixture({ stage = 'before', remoteContainerId = 'candidate-container-id', failRestore = false } = {}) {
  const database = openDatabase(':memory:');
  applyMigrations(database);
  database.prepare(`INSERT INTO users(id, username, password_hash, role, created_at) VALUES (?, ?, ?, 'admin', ?)`)
    .run('user-1', 'admin', 'hash', NOW.toISOString());

  const hosts = new SqliteHostOnboardingRepository(database);
  const credentials = new SqliteSshCredentialRepository(database);
  const targets = new SqliteOllamaTargetRepository(database);
  const bindings = new SqliteTargetContainerBindingRepository(database);
  const snapshots = new SqliteUpdateSnapshotRepository(database);
  const jobs = new JobService(new SqliteJobRepository(database), () => NOW);
  const auditEvents = [];
  const audit = { record: (event) => auditEvents.push(event) };

  const hostId = 'host-1';
  const credentialId = 'cred-1';
  hosts.createHostWithCredential(
    {
      id: hostId,
      displayName: 'Rollback host',
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
        '-----BEGIN PRIVATE KEY-----\nRECOVERY-SECRET\n-----END PRIVATE KEY-----',
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
  snapshots.save({
    id: snapshotId,
    targetId: 'target-1',
    actorUserId: 'user-1',
    createdAt: NOW.toISOString(),
    publicMetadataJson: '{}',
    encryptedPayload: new UpdateSnapshotCipher(MASTER_KEY).encrypt(
      { snapshotId, targetId: 'target-1' },
      JSON.stringify({
        schemaVersion: 1,
        containerInspect: {
          Id: 'old-container-id',
          Config: {
            Image: 'ollama/ollama:latest',
            Env: ['OLLAMA_TOKEN=RECOVERY-SNAPSHOT-SECRET'],
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
      }),
    ),
  });

  const intentJob = jobs.create({
    targetId: 'target-1', actorUserId: 'user-1', kind: 'container.update_execution_intent', mutating: false,
  });
  jobs.transition(intentJob.id, 'running');
  jobs.transition(intentJob.id, 'succeeded', {
    result: {
      intentVersion: 1,
      intentId: intentJob.id,
      targetId: 'target-1',
      snapshotId,
      imageReference: 'ollama/ollama:latest',
      currentDigest: OLD_DIGEST,
      candidateDigest: NEW_DIGEST,
      candidateIndexDigest: null,
      exactCandidateReference: NEW_REF,
      candidateImageVersion: '0.33.0',
      strategy: 'compose',
      composeService: 'ollama',
      createdAt: intentJob.createdAt,
    },
  });
  const updateJob = jobs.create({
    targetId: 'target-1', actorUserId: 'user-1', kind: 'container.update', mutating: true,
  });
  jobs.transition(updateJob.id, 'running');
  assert.equal(bindings.rebindContainer('target-1', 'old-container-id', 'candidate-container-id', NOW.toISOString()), true);
  jobs.transition(updateJob.id, 'succeeded', {
    result: {
      jobId: updateJob.id,
      outcome: 'updated',
      intentId: intentJob.id,
      snapshotId,
      previousContainerId: 'old-container-id',
      containerId: 'candidate-container-id',
      candidateDigest: NEW_DIGEST,
    },
  });

  const rollbackJob = jobs.create({
    targetId: 'target-1', actorUserId: 'user-1', kind: 'container.rollback', mutating: true,
  });
  jobs.transition(rollbackJob.id, 'running');
  if (stage !== 'before') {
    jobs.appendEvent(rollbackJob.id, 'stage', {
      stage: 'lock_acquired',
      sourceUpdateJobId: updateJob.id,
      snapshotId,
      currentContainerId: 'candidate-container-id',
      rollbackDigest: OLD_DIGEST,
      currentDigest: NEW_DIGEST,
    });
    jobs.appendEvent(rollbackJob.id, 'stage', {
      stage: 'rollback_started',
      fromContainerId: 'candidate-container-id',
      rollbackDigest: OLD_DIGEST,
    });
  }
  if (stage === 'rollback-created') {
    jobs.appendEvent(rollbackJob.id, 'stage', {
      stage: 'rollback_replacement_created',
      containerId: 'rollback-container-id',
      imageId: `sha256:${'4'.repeat(64)}`,
    });
  }

  let currentRemote = remoteContainerId;
  const remoteCalls = [];
  const remote = {
    async validateCompose() { throw new Error('not used during reconciliation'); },
    async resolveComposeContainer(context) {
      remoteCalls.push(['resolve', context.service, currentRemote]);
      return currentRemote;
    },
    async replace(context, exactImageReference, expectedPreviousContainerId, source) {
      remoteCalls.push(['replace', context.service, exactImageReference, expectedPreviousContainerId, source]);
      if (failRestore) throw new ComposeReplacementError('REPLACEMENT_FAILED', 'restore blocked');
      assert.equal(exactImageReference, NEW_REF);
      assert.equal(expectedPreviousContainerId, currentRemote);
      assert.equal(source, 'local-only');
      currentRemote = 'restored-candidate-id';
      return {
        source,
        exactImageReference,
        imageId: `sha256:${'5'.repeat(64)}`,
        previousContainerId: expectedPreviousContainerId,
        containerId: currentRemote,
      };
    },
    async health(targetId, containerId) {
      remoteCalls.push(['health', targetId, containerId]);
      return healthy(containerId);
    },
  };

  const reconciliation = new ManualRollbackReconciliationService(
    hosts,
    credentials,
    targets,
    bindings,
    snapshots,
    MASTER_KEY,
    jobs,
    audit,
    () => remote,
    () => NOW,
  );
  return {
    database,
    targets,
    jobs,
    auditEvents,
    rollbackJob,
    reconciliation,
    remoteCalls,
  };
}

test('interrupted rollback before remote mutation is terminally failed without remote access', async () => {
  const f = fixture({ stage: 'before' });
  try {
    assert.deepEqual(await f.reconciliation.reconcile(), { examined: 1, reconciled: 1 });
    const job = f.jobs.get(f.rollbackJob.id);
    assert.equal(job.state, 'failed');
    assert.equal(job.errorClass, 'MANUAL_ROLLBACK_RECOVERY_INTERRUPTED_BEFORE_MUTATION');
    assert.deepEqual(f.remoteCalls, []);
  } finally {
    f.database.close();
  }
});

test('journal-proven rollback replacement is freshly health-verified and never silently marked succeeded', async () => {
  const f = fixture({ stage: 'rollback-created', remoteContainerId: 'rollback-container-id' });
  try {
    assert.deepEqual(await f.reconciliation.reconcile(), { examined: 1, reconciled: 1 });
    assert.equal(f.targets.findById('target-1').selectedContainerId, 'rollback-container-id');
    const job = f.jobs.get(f.rollbackJob.id);
    assert.equal(job.state, 'failed');
    assert.equal(job.errorClass, 'MANUAL_ROLLBACK_RECOVERY_ROLLBACK_VERIFIED');
    assert.deepEqual(f.remoteCalls, [
      ['resolve', 'ollama', 'rollback-container-id'],
      ['health', 'target-1', 'rollback-container-id'],
    ]);
  } finally {
    f.database.close();
  }
});

test('ambiguous changed Compose state is restored to exact previously healthy update digest', async () => {
  const f = fixture({ stage: 'started', remoteContainerId: 'unknown-replacement-id' });
  try {
    assert.deepEqual(await f.reconciliation.reconcile(), { examined: 1, reconciled: 1 });
    assert.equal(f.targets.findById('target-1').selectedContainerId, 'restored-candidate-id');
    const job = f.jobs.get(f.rollbackJob.id);
    assert.equal(job.state, 'failed');
    assert.equal(job.errorClass, 'MANUAL_ROLLBACK_RECOVERY_CURRENT_RESTORED');
    assert.deepEqual(f.remoteCalls, [
      ['resolve', 'ollama', 'unknown-replacement-id'],
      ['replace', 'ollama', NEW_REF, 'unknown-replacement-id', 'local-only'],
      ['health', 'target-1', 'restored-candidate-id'],
    ]);
    assert.equal(JSON.stringify(f.auditEvents).includes('RECOVERY-SNAPSHOT-SECRET'), false);
    assert.equal(JSON.stringify(f.jobs.events(f.rollbackJob.id)).includes('RECOVERY-SNAPSHOT-SECRET'), false);
  } finally {
    f.database.close();
  }
});

test('unrecoverable ambiguous rollback state blocks reconciliation and remains non-terminal', async () => {
  const f = fixture({ stage: 'started', remoteContainerId: 'unknown-replacement-id', failRestore: true });
  try {
    await assert.rejects(
      f.reconciliation.reconcile(),
      (error) => error instanceof ManualRollbackReconciliationError && error.code === 'MANUAL_ROLLBACK_RECOVERY_UNRESOLVED',
    );
    assert.equal(f.jobs.get(f.rollbackJob.id).state, 'running');
  } finally {
    f.database.close();
  }
});
