import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyMigrations,
  openDatabase,
  SqliteHostOnboardingRepository,
  SqliteJobRepository,
  SqliteOllamaTargetRepository,
  SqliteUpdateSnapshotRepository,
} from '@orc/db';
import { SqliteTargetContainerBindingRepository } from '@orc/db/target-binding';
import { SqliteUpdateHistoryRepository } from '@orc/db/update-history';
import { UpdateSnapshotCipher } from '@orc/security';
import { JobService } from '../dist/jobs.js';
import {
  ManualRollbackCandidateError,
  ManualRollbackCandidateService,
} from '../dist/manual-rollback-candidate.js';

const MASTER_KEY = Buffer.alloc(32, 0x42);
const NOW = new Date('2026-08-10T12:00:00.000Z');
const OLD_DIGEST = `sha256:${'1'.repeat(64)}`;
const NEW_DIGEST = `sha256:${'2'.repeat(64)}`;

function fixture() {
  const database = openDatabase(':memory:');
  applyMigrations(database);
  database.prepare(`INSERT INTO users(id, username, password_hash, role, created_at) VALUES (?, ?, ?, 'admin', ?)`)
    .run('user-1', 'admin', 'test-hash', NOW.toISOString());
  const hosts = new SqliteHostOnboardingRepository(database);
  const targets = new SqliteOllamaTargetRepository(database);
  const snapshots = new SqliteUpdateSnapshotRepository(database);
  const jobsRepository = new SqliteJobRepository(database);
  const jobs = new JobService(jobsRepository, () => NOW);
  const bindings = new SqliteTargetContainerBindingRepository(database);

  database.prepare(`
    INSERT INTO hosts(id, display_name, hostname, port, username, host_key_fingerprint, enabled, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
  `).run('host-1', 'Host', 'ollama.internal', 22, 'orc', `SHA256:${'A'.repeat(43)}`, NOW.toISOString(), NOW.toISOString());
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
          RepoDigests: [`docker.io/ollama/ollama@${OLD_DIGEST}`],
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
  const intent = {
    intentVersion: 1,
    intentId: intentJob.id,
    targetId: 'target-1',
    snapshotId,
    imageReference: 'ollama/ollama:latest',
    currentDigest: OLD_DIGEST,
    candidateDigest: NEW_DIGEST,
    candidateIndexDigest: null,
    exactCandidateReference: `ollama/ollama@${NEW_DIGEST}`,
    candidateImageVersion: '0.33.0',
    strategy: 'compose',
    composeService: 'ollama',
    createdAt: intentJob.createdAt,
  };
  jobs.transition(intentJob.id, 'succeeded', { result: intent });

  const updateJob = jobs.create({ targetId: 'target-1', actorUserId: 'user-1', kind: 'container.update', mutating: true });
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

  const service = new ManualRollbackCandidateService(
    targets,
    jobsRepository,
    snapshots,
    new SqliteUpdateHistoryRepository(database),
    MASTER_KEY,
  );
  return { database, targets, bindings, jobsRepository, service, updateJob, intentJob, snapshotId };
}

test('manual rollback candidate is derived only from successful update, intent, authenticated snapshot and current binding', () => {
  const f = fixture();
  try {
    assert.deepEqual(f.service.read('target-1'), {
      candidate: {
        sourceUpdateJobId: f.updateJob.id,
        sourceIntentId: f.intentJob.id,
        snapshotId: f.snapshotId,
        updatedAt: NOW.toISOString(),
        currentContainerId: 'candidate-container-id',
        previousContainerId: 'old-container-id',
        currentImageReference: `ollama/ollama@${NEW_DIGEST}`,
        rollbackImageReference: `ollama/ollama@${OLD_DIGEST}`,
        currentDigest: NEW_DIGEST,
        rollbackDigest: OLD_DIGEST,
        composeService: 'ollama',
        modelVolumeBackup: {
          included: false,
          warning: 'Rollback restores the previous container/runtime configuration; model data volumes are not backed up or restored.',
        },
      },
      reason: null,
    });
  } finally {
    f.database.close();
  }
});

test('manual rollback candidate becomes unavailable when target binding moved after the successful update', () => {
  const f = fixture();
  try {
    assert.equal(f.bindings.rebindContainer('target-1', 'candidate-container-id', 'other-container-id', NOW.toISOString()), true);
    assert.deepEqual(f.service.read('target-1'), { candidate: null, reason: 'TARGET_BINDING_CHANGED' });
  } finally {
    f.database.close();
  }
});

test('manual rollback candidate rejects tampered intent/update/snapshot authority instead of falling back', () => {
  const cases = [
    ['update candidate digest', (f) => f.database.prepare("UPDATE jobs SET result_json = json_set(result_json, '$.candidateDigest', ?) WHERE id = ?").run(`sha256:${'9'.repeat(64)}`, f.updateJob.id)],
    ['intent snapshot id', (f) => f.database.prepare("UPDATE jobs SET result_json = json_set(result_json, '$.snapshotId', ?) WHERE id = ?").run('other-snapshot', f.intentJob.id)],
  ];
  for (const [name, tamper] of cases) {
    const f = fixture();
    try {
      tamper(f);
      assert.throws(
        () => f.service.read('target-1'),
        (error) => error instanceof ManualRollbackCandidateError && error.code === 'ROLLBACK_AUTHORITY_INVALID',
        name,
      );
    } finally {
      f.database.close();
    }
  }
});

test('manual rollback candidate requires external master key once persisted rollback authority exists', () => {
  const f = fixture();
  try {
    const service = new ManualRollbackCandidateService(
      f.targets,
      f.jobsRepository,
      new SqliteUpdateSnapshotRepository(f.database),
      new SqliteUpdateHistoryRepository(f.database),
      null,
    );
    assert.throws(
      () => service.read('target-1'),
      (error) => error instanceof ManualRollbackCandidateError && error.code === 'MASTER_KEY_REQUIRED' && error.statusCode === 503,
    );
  } finally {
    f.database.close();
  }
});
