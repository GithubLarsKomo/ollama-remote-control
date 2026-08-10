import assert from 'node:assert/strict';
import test from 'node:test';
import { applyMigrations, openDatabase } from '../dist/index.js';
import { SqliteModelfileDeploymentRepository } from '../dist/modelfile-deployments.js';
import { sha256Modelfile, SqliteModelfileRepository } from '../dist/modelfiles.js';

const NOW = '2026-08-10T12:00:00.000Z';
const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);

function fixture() {
  const database = openDatabase(':memory:');
  applyMigrations(database);
  database.prepare(`INSERT INTO users(id, username, password_hash, role, created_at) VALUES ('user-1', 'admin', 'hash', 'admin', ?)`).run(NOW);
  database.prepare(`INSERT INTO hosts(id, display_name, hostname, port, username, enabled, created_at, updated_at) VALUES ('host-1', 'Host', 'host', 22, 'orc', 1, ?, ?)`).run(NOW, NOW);
  database.prepare(`INSERT INTO ollama_targets(id, host_id, display_name, selected_container_id, enabled, created_at, updated_at) VALUES ('target-1', 'host-1', 'Target', 'container-1', 1, ?, ?)`).run(NOW, NOW);

  const modelfiles = new SqliteModelfileRepository(database);
  const raw1 = 'FROM llama3.2:latest\nPARAMETER num_ctx 8192\n';
  const revision1 = {
    id: 'rev-1', modelfileId: 'mf-1', revisionNumber: 1, parentRevisionId: null,
    rawText: raw1, contentSha256: sha256Modelfile(raw1), sourceKind: 'manual',
    importedTargetId: null, importedModel: null, importedDigest: null,
    createdByUserId: 'user-1', createdAt: NOW,
  };
  modelfiles.createWithInitialRevision({
    id: 'mf-1', displayName: 'Model file', description: null, currentRevisionId: 'rev-1',
    createdByUserId: 'user-1', updatedByUserId: 'user-1', createdAt: NOW, updatedAt: NOW,
  }, revision1);

  return {
    database,
    modelfiles,
    deployments: new SqliteModelfileDeploymentRepository(database),
    revision1,
  };
}

function insertCreateJob(database, id, state = 'running') {
  database.prepare(`
    INSERT INTO jobs(
      id, target_id, actor_user_id, kind, mutating, state, created_at, started_at,
      finished_at, result_json, error_class, exit_code
    ) VALUES (?, 'target-1', 'user-1', 'model-create', 1, ?, ?, ?, NULL, NULL, NULL, NULL)
  `).run(id, state, NOW, state === 'running' ? NOW : null);
}

function verifiedResult(revision, digest, outputModel = 'custom:model') {
  return JSON.stringify({
    planId: 'plan-1',
    modelfileId: revision.modelfileId,
    revisionId: revision.id,
    revisionSha256: revision.contentSha256,
    payloadSha256: 'c'.repeat(64),
    outputModel,
    baseModel: 'llama3.2:latest',
    selectedContainerId: 'container-1',
    digest,
    sizeBytes: 123456,
    verified: true,
    baseModelObservation: { source: 'from' },
  });
}

test('records immutable deployment evidence only when a model-create job becomes verified succeeded', () => {
  const f = fixture();
  try {
    insertCreateJob(f.database, 'create-1');
    assert.equal(f.deployments.findBySourceCreateJobId('create-1'), null);

    f.database.prepare(`
      UPDATE jobs
      SET state = 'succeeded', finished_at = ?, result_json = ?
      WHERE id = 'create-1'
    `).run(NOW, verifiedResult(f.revision1, DIGEST_A));

    const deployment = f.deployments.findBySourceCreateJobId('create-1');
    assert.deepEqual(deployment, {
      id: 'create-1',
      targetId: 'target-1',
      modelfileId: 'mf-1',
      revisionId: 'rev-1',
      revisionSha256: f.revision1.contentSha256,
      outputModel: 'custom:model',
      modelDigest: DIGEST_A,
      sizeBytes: 123456,
      baseModel: 'llama3.2:latest',
      sourceCreateJobId: 'create-1',
      actorUserId: 'user-1',
      selectedContainerId: 'container-1',
      verifiedAt: NOW,
    });
    assert.deepEqual(f.deployments.listForRevision('rev-1'), [deployment]);
    assert.deepEqual(f.deployments.listForModelfile('mf-1'), [deployment]);
    assert.deepEqual(f.deployments.latestForTargetModel('target-1', 'custom:model'), deployment);

    assert.throws(() => f.database.prepare(`UPDATE modelfile_deployments SET output_model = 'tampered' WHERE id = 'create-1'`).run(), /immutable/u);
    assert.throws(() => f.database.prepare(`DELETE FROM modelfile_deployments WHERE id = 'create-1'`).run(), /append-only/u);
  } finally {
    f.database.close();
  }
});

test('fails closed when a model-create success transition lacks complete verified deployment evidence', () => {
  const f = fixture();
  try {
    insertCreateJob(f.database, 'create-invalid');
    assert.throws(() => {
      f.database.prepare(`
        UPDATE jobs
        SET state = 'succeeded', finished_at = ?, result_json = ?
        WHERE id = 'create-invalid'
      `).run(NOW, JSON.stringify({ verified: false }));
    }, /deployment evidence/u);

    const job = f.database.prepare(`SELECT state, finished_at FROM jobs WHERE id = 'create-invalid'`).get();
    assert.deepEqual(job, { state: 'running', finished_at: null });
    assert.equal(f.deployments.findBySourceCreateJobId('create-invalid'), null);
  } finally {
    f.database.close();
  }
});

test('current producing revision is deterministic while older immutable deployment history remains queryable', () => {
  const f = fixture();
  try {
    insertCreateJob(f.database, 'create-1');
    f.database.prepare(`UPDATE jobs SET state='succeeded', finished_at=?, result_json=? WHERE id='create-1'`)
      .run('2026-08-10T12:00:00.000Z', verifiedResult(f.revision1, DIGEST_A));

    const raw2 = 'FROM llama3.2:latest\nPARAMETER num_ctx 16384\n';
    const revision2 = {
      id: 'rev-2', modelfileId: 'mf-1', revisionNumber: 2, parentRevisionId: 'rev-1',
      rawText: raw2, contentSha256: sha256Modelfile(raw2), sourceKind: 'manual',
      importedTargetId: null, importedModel: null, importedDigest: null,
      createdByUserId: 'user-1', createdAt: '2026-08-10T12:01:00.000Z',
    };
    assert.equal(f.modelfiles.appendRevision('mf-1', 'rev-1', revision2, revision2.createdAt, 'user-1'), true);

    insertCreateJob(f.database, 'create-2');
    f.database.prepare(`UPDATE jobs SET state='succeeded', finished_at=?, result_json=? WHERE id='create-2'`)
      .run('2026-08-10T12:02:00.000Z', verifiedResult(revision2, DIGEST_B));

    const history = f.deployments.listForModelfile('mf-1');
    assert.deepEqual(history.map((entry) => entry.revisionId), ['rev-2', 'rev-1']);
    assert.equal(f.deployments.latestForTargetModel('target-1', 'custom:model')?.revisionId, 'rev-2');
    assert.equal(f.deployments.listForRevision('rev-1')[0]?.modelDigest, DIGEST_A);
  } finally {
    f.database.close();
  }
});

test('repository recording is idempotent for the same source job and rejects conflicting evidence', () => {
  const f = fixture();
  try {
    insertCreateJob(f.database, 'create-1');
    f.database.prepare(`UPDATE jobs SET state='succeeded', finished_at=?, result_json=? WHERE id='create-1'`)
      .run(NOW, verifiedResult(f.revision1, DIGEST_A));
    const deployment = f.deployments.findBySourceCreateJobId('create-1');
    assert.deepEqual(f.deployments.recordVerified(deployment), deployment);
    assert.throws(
      () => f.deployments.recordVerified({ ...deployment, modelDigest: DIGEST_B }),
      /different immutable evidence/u,
    );
  } finally {
    f.database.close();
  }
});
