import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyMigrations,
  openDatabase,
  SqliteAuditRepository,
  SqliteHostOnboardingRepository,
  SqliteJobRepository,
  SqliteOllamaTargetRepository,
  SqliteUpdateSnapshotRepository,
} from '@orc/db';
import { SqliteTargetContainerBindingRepository } from '@orc/db/target-binding';
import { SqliteUpdateHistoryRepository } from '@orc/db/update-history';
import { ComposeReplacementError } from '@orc/docker/compose-replacement';
import { SecretCipher, UpdateSnapshotCipher } from '@orc/security';
import { AuditService } from '../dist/audit.js';
import { JobService, JobServiceError } from '../dist/jobs.js';
import { ManualRollbackCandidateService } from '../dist/manual-rollback-candidate.js';
import {
  ManualRollbackExecutionError,
  ManualRollbackExecutionService,
} from '../dist/manual-rollback-execution.js';

const MASTER_KEY = Buffer.alloc(32, 0x4d);
const NOW = new Date('2026-08-10T12:30:00.000Z');
const OLD_DIGEST = `sha256:${'1'.repeat(64)}`;
const NEW_DIGEST = `sha256:${'2'.repeat(64)}`;
const OLD_REF = `ollama/ollama@${OLD_DIGEST}`;
const NEW_REF = `ollama/ollama@${NEW_DIGEST}`;

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
    ollama: { cliVersion: '0.31.0', apiReachable: true, apiVersion: '0.30.0', versionMatch: false },
    transport: { mode: 'published-binding' },
  };
}

function createFixture(mode = 'success') {
  const database = openDatabase(':memory:');
  applyMigrations(database);
  database.prepare(`INSERT INTO users(id, username, password_hash, role, created_at) VALUES (?, ?, ?, 'admin', ?)`)
    .run('user-1', 'admin', 'test-hash', NOW.toISOString());

  const hosts = new SqliteHostOnboardingRepository(database);
  const targets = new SqliteOllamaTargetRepository(database);
  const snapshots = new SqliteUpdateSnapshotRepository(database);
  const jobRepository = new SqliteJobRepository(database);
  const jobs = new JobService(jobRepository, () => NOW);
  const auditRepository = new SqliteAuditRepository(database);
  const audit = new AuditService(auditRepository, () => NOW);
  const bindings = new SqliteTargetContainerBindingRepository(database);

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
        '-----BEGIN PRIVATE KEY-----\nROLLBACK-TEST-SECRET\n-----END PRIVATE KEY-----',
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
            Env: ['OLLAMA_API_KEY=SNAPSHOT-SECRET'],
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
        ollamaVersion: '0.32.5',
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

  const calls = [];
  let currentRemote = 'candidate-container-id';
  let sequence = 0;
  const remote = {
    calls,
    async validateCompose(context, expectedContainerId) {
      calls.push(['validate', context.service, expectedContainerId]);
      assert.equal(context.service, 'ollama');
      assert.equal(expectedContainerId, currentRemote);
    },
    async replace(context, exactImageReference, expectedPreviousContainerId, source) {
      calls.push(['replace', source, exactImageReference, expectedPreviousContainerId]);
      assert.equal(context.service, 'ollama');
      assert.equal(source, 'local-only');
      assert.equal(expectedPreviousContainerId, currentRemote);
      sequence += 1;
      if (sequence === 1) {
        if (mode === 'rollback-throws-before-change') {
          throw new ComposeReplacementError('REPLACEMENT_FAILED', 'safe rollback failure');
        }
        currentRemote = 'rollback-container-id';
        return {
          source,
          exactImageReference,
          imageId: `sha256:${'4'.repeat(64)}`,
          previousContainerId: expectedPreviousContainerId,
          containerId: currentRemote,
        };
      }
      if (mode === 'restore-fails') {
        currentRemote = 'restore-partial-id';
        throw new ComposeReplacementError('REPLACEMENT_INSPECT_FAILED', 'safe restore failure');
      }
      currentRemote = 'restored-candidate-id';
      return {
        source,
        exactImageReference,
        imageId: `sha256:${'5'.repeat(64)}`,
        previousContainerId: expectedPreviousContainerId,
        containerId: currentRemote,
      };
    },
    async resolveComposeContainer(context) {
      calls.push(['resolve', context.service, currentRemote]);
      return currentRemote;
    },
    async health(targetId, containerId) {
      calls.push(['health', targetId, containerId]);
      if (containerId === 'rollback-container-id' && mode !== 'success') return degraded();
      return healthy(containerId === 'rollback-container-id' ? '0.31.0' : '0.33.0');
    },
  };

  const candidate = new ManualRollbackCandidateService(
    targets,
    jobRepository,
    snapshots,
    new SqliteUpdateHistoryRepository(database),
    MASTER_KEY,
  );
  const execution = new ManualRollbackExecutionService(
    hosts,
    { findByHostId: (id) => database.prepare(`
      SELECT id, host_id, algorithm, key_version, nonce, ciphertext, auth_tag, created_at, updated_at
      FROM ssh_credentials WHERE host_id = ?
    `).get(id) && new (class {
      findByHostId(host) {
        const row = database.prepare(`SELECT id, host_id, algorithm, key_version, nonce, ciphertext, auth_tag, created_at, updated_at FROM ssh_credentials WHERE host_id = ?`).get(host);
        return row ? {
          id: String(row.id), hostId: String(row.host_id),
          encryptedPrivateKey: {
            algorithm: String(row.algorithm), keyVersion: Number(row.key_version), nonce: String(row.nonce),
            ciphertext: String(row.ciphertext), authTag: String(row.auth_tag),
          },
          createdAt: String(row.created_at), updatedAt: String(row.updated_at),
        } : null;
      }
    })().findByHostId(id) },
    targets,
    bindings,
    snapshots,
    MASTER_KEY,
    candidate,
    jobs,
    audit,
    () => remote,
    () => NOW,
  );

  const confirmation = {
    targetId: 'target-1',
    sourceUpdateJobId: updateJob.id,
    currentContainerId: 'candidate-container-id',
    rollbackDigest: OLD_DIGEST,
    acknowledgeModelVolumeBoundary: true,
  };

  return { database, targets, bindings, jobs, auditRepository, execution, remote, confirmation, updateJob };
}

test('manual rollback uses exact server-derived local image, rebinds and succeeds only after health verification', async () => {
  const f = createFixture('success');
  try {
    const result = await f.execution.execute('target-1', f.confirmation, 'user-1');
    assert.equal(result.outcome, 'rolled_back');
    assert.equal(result.sourceUpdateJobId, f.updateJob.id);
    assert.equal(result.containerId, 'rollback-container-id');
    assert.equal(result.rollbackDigest, OLD_DIGEST);
    assert.equal(f.targets.findById('target-1').selectedContainerId, 'rollback-container-id');
    assert.deepEqual(f.remote.calls, [
      ['validate', 'ollama', 'candidate-container-id'],
      ['replace', 'local-only', OLD_REF, 'candidate-container-id'],
      ['health', 'target-1', 'rollback-container-id'],
    ]);
    const job = f.jobs.get(result.jobId);
    assert.equal(job.kind, 'container.rollback');
    assert.equal(job.state, 'succeeded');
    assert.equal(job.resultJson.includes('SNAPSHOT-SECRET'), false);
    assert.equal(JSON.stringify(f.auditRepository.listByTarget('target-1')).includes('SNAPSHOT-SECRET'), false);
  } finally {
    f.database.close();
  }
});

test('manual rollback rejects stale confirmation before creating a mutating job', async () => {
  const f = createFixture('success');
  try {
    await assert.rejects(
      f.execution.execute('target-1', { ...f.confirmation, rollbackDigest: NEW_DIGEST }, 'user-1'),
      (error) => error instanceof ManualRollbackExecutionError && error.code === 'ROLLBACK_CONFIRMATION_MISMATCH',
    );
    assert.deepEqual(f.remote.calls, []);
    assert.equal(f.jobs.jobsNeedingReconciliation().length, 0);
  } finally {
    f.database.close();
  }
});

test('manual rollback respects the existing persistent per-target mutation lock', async () => {
  const f = createFixture('success');
  try {
    const blocker = f.jobs.create({ targetId: 'target-1', actorUserId: 'user-1', kind: 'test.blocker', mutating: true });
    assert.equal(blocker.state, 'queued');
    await assert.rejects(
      f.execution.execute('target-1', f.confirmation, 'user-1'),
      (error) => error instanceof JobServiceError && error.code === 'JOB_CONFLICT',
    );
    assert.deepEqual(f.remote.calls, []);
  } finally {
    f.database.close();
  }
});

test('degraded rollback health restores and verifies the previously healthy updated image', async () => {
  const f = createFixture('rollback-degraded');
  try {
    await assert.rejects(
      f.execution.execute('target-1', f.confirmation, 'user-1'),
      (error) => error instanceof ManualRollbackExecutionError && error.code === 'MANUAL_ROLLBACK_FAILED_CURRENT_RESTORED',
    );
    assert.equal(f.targets.findById('target-1').selectedContainerId, 'restored-candidate-id');
    assert.deepEqual(f.remote.calls, [
      ['validate', 'ollama', 'candidate-container-id'],
      ['replace', 'local-only', OLD_REF, 'candidate-container-id'],
      ['health', 'target-1', 'rollback-container-id'],
      ['replace', 'local-only', NEW_REF, 'rollback-container-id'],
      ['health', 'target-1', 'restored-candidate-id'],
    ]);
    const rollbackJobs = f.auditRepository.listByTarget('target-1').filter((event) => event.action.startsWith('container.rollback'));
    assert.equal(rollbackJobs.some((event) => event.action === 'container.rollback.current_restored'), true);
  } finally {
    f.database.close();
  }
});

test('failed restoration is classified separately and leaves a terminal failed job', async () => {
  const f = createFixture('restore-fails');
  try {
    await assert.rejects(
      f.execution.execute('target-1', f.confirmation, 'user-1'),
      (error) => error instanceof ManualRollbackExecutionError && error.code === 'MANUAL_ROLLBACK_FAILED_RESTORE_FAILED',
    );
    const nonTerminal = f.jobs.jobsNeedingReconciliation().filter((job) => job.kind === 'container.rollback');
    assert.equal(nonTerminal.length, 0);
    const rollbackEvents = f.auditRepository.listByTarget('target-1').filter((event) => event.action === 'container.rollback.restore_failed');
    assert.equal(rollbackEvents.length, 1);
  } finally {
    f.database.close();
  }
});
