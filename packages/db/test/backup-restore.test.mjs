import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import zlib from 'node:zlib';
import { SecretCipher } from '@orc/security';
import { createDataBackup, restoreDataBackup } from '../../../scripts/orc-data-backup.mjs';
import {
  applyMigrations,
  openDatabase,
  SqliteAuditRepository,
  SqliteSshCredentialRepository,
} from '../dist/index.js';
import { SqliteModelfileDeploymentRepository } from '../dist/modelfile-deployments.js';
import { sha256Modelfile, SqliteModelfileRepository } from '../dist/modelfiles.js';
import { SqliteProvenanceRepository } from '../dist/provenance.js';

const NOW = '2026-08-12T08:00:00.000Z';
const MASTER_KEY = Buffer.alloc(32, 0x41);
const WRONG_MASTER_KEY = Buffer.alloc(32, 0x42);
const PRIVATE_KEY = '-----BEGIN OPENSSH PRIVATE KEY-----\nbackup-restore-secret-private-key\n-----END OPENSSH PRIVATE KEY-----';
const MODEL_DIGEST = 'a'.repeat(64);

function seedDurableState(database) {
  database.prepare(`INSERT INTO users(id, username, password_hash, role, created_at) VALUES (?, ?, ?, 'admin', ?)`)
    .run('user-1', 'admin', 'hash', NOW);
  database.prepare(`INSERT INTO hosts(id, display_name, hostname, port, username, host_key_fingerprint, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`)
    .run('host-1', 'Primary host', 'ollama.internal', 22, 'orc-admin', 'SHA256:pinned', NOW, NOW);
  database.prepare(`INSERT INTO ollama_targets(id, host_id, display_name, selected_container_id, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)`)
    .run('target-1', 'host-1', 'Ollama', 'container-1', NOW, NOW);

  const credentials = new SqliteSshCredentialRepository(database);
  credentials.save({
    id: 'credential-1',
    hostId: 'host-1',
    encryptedPrivateKey: new SecretCipher(MASTER_KEY).encrypt(
      { credentialId: 'credential-1', hostId: 'host-1' },
      PRIVATE_KEY,
    ),
    createdAt: NOW,
    updatedAt: NOW,
  });

  const modelfiles = new SqliteModelfileRepository(database);
  const rawText = 'FROM llama3.2:latest\r\nPARAMETER num_ctx 8192\r\n';
  const revision = {
    id: 'revision-1',
    modelfileId: 'modelfile-1',
    revisionNumber: 1,
    parentRevisionId: null,
    rawText,
    contentSha256: sha256Modelfile(rawText),
    sourceKind: 'manual',
    importedTargetId: null,
    importedModel: null,
    importedDigest: null,
    createdByUserId: 'user-1',
    createdAt: NOW,
  };
  assert.equal(modelfiles.createWithInitialRevision({
    id: 'modelfile-1',
    displayName: 'Backup model',
    description: 'Durable restore evidence',
    currentRevisionId: revision.id,
    createdByUserId: 'user-1',
    updatedByUserId: 'user-1',
    createdAt: NOW,
    updatedAt: NOW,
  }, revision), true);

  database.prepare(`
    INSERT INTO jobs(
      id, target_id, actor_user_id, kind, mutating, state, created_at, started_at,
      finished_at, result_json, error_class, exit_code
    ) VALUES (?, ?, ?, 'model-create', 1, 'running', ?, ?, NULL, NULL, NULL, NULL)
  `).run('create-job-1', 'target-1', 'user-1', NOW, NOW);
  database.prepare(`
    UPDATE jobs
    SET state='succeeded', finished_at=?, result_json=?
    WHERE id='create-job-1'
  `).run(NOW, JSON.stringify({
    planId: 'plan-1',
    modelfileId: revision.modelfileId,
    revisionId: revision.id,
    revisionSha256: revision.contentSha256,
    payloadSha256: 'b'.repeat(64),
    outputModel: 'backup-model:latest',
    baseModel: 'llama3.2:latest',
    selectedContainerId: 'container-1',
    digest: MODEL_DIGEST,
    sizeBytes: 123456,
    verified: true,
    baseModelObservation: { source: 'from' },
  }));

  const provenance = new SqliteProvenanceRepository(database);
  provenance.appendSource({
    id: 'source-1',
    subjectKind: 'installed-model',
    targetId: 'target-1',
    modelName: 'backup-model:latest',
    modelDigest: MODEL_DIGEST,
    revisionId: null,
    sourceKind: 'url',
    sourceReference: 'https://example.com/backup-model',
    origin: 'operator',
    confidence: 'high',
    actorUserId: 'user-1',
    supersedesSourceId: null,
    note: null,
    createdAt: NOW,
  });
  const modelNode = provenance.ensureNode({
    id: 'node-model', identityKey: `installed:target-1:backup-model:latest:${MODEL_DIGEST}`,
    kind: 'installed-model', targetId: 'target-1', modelName: 'backup-model:latest', modelDigest: MODEL_DIGEST,
    revisionId: null, createdAt: NOW,
  });
  const revisionNode = provenance.ensureNode({
    id: 'node-revision', identityKey: 'revision:revision-1', kind: 'modelfile-revision', targetId: null,
    modelName: null, modelDigest: null, revisionId: 'revision-1', createdAt: NOW,
  });
  provenance.appendEdge({
    id: 'edge-1', fromNodeId: revisionNode.id, toNodeId: modelNode.id, relation: 'created-from-revision',
    origin: 'observed', confidence: 'high', sourceJobId: 'create-job-1', actorUserId: 'user-1', createdAt: NOW,
  });

  new SqliteAuditRepository(database).append({
    id: 'audit-1', timestamp: NOW, actorUserId: 'user-1', hostId: 'host-1', targetId: 'target-1',
    action: 'backup.fixture.seeded', parametersRedactedJson: '{"sensitive":false}', result: 'succeeded',
    exitCode: null, errorClass: null, jobId: 'create-job-1',
  });
}

test('quiesced application data backup restores durable state while external master-key authority remains separate', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orc-backup-restore-'));
  const sourceDirectory = path.join(root, 'source-data');
  const restoredDirectory = path.join(root, 'restored-data');
  const backupFile = path.join(root, 'backup', 'orc-data.backup.gz');
  fs.mkdirSync(sourceDirectory, { recursive: true, mode: 0o700 });
  const databasePath = path.join(sourceDirectory, 'ollama-remote-control.sqlite');

  let database = openDatabase(databasePath);
  applyMigrations(database);
  seedDurableState(database);
  database.close();

  const created = createDataBackup(sourceDirectory, backupFile);
  assert.equal(created.fileCount >= 1, true);
  assert.match(created.sha256, /^[a-f0-9]{64}$/u);
  assert.equal(fs.statSync(backupFile).mode & 0o777, 0o600);

  const manifestText = zlib.gunzipSync(fs.readFileSync(backupFile)).toString('utf8');
  assert.equal(manifestText.includes(PRIVATE_KEY), false);
  assert.equal(manifestText.includes(MASTER_KEY.toString('base64')), false);
  assert.equal(JSON.stringify(created).includes(PRIVATE_KEY), false);
  assert.equal(JSON.stringify(created).includes(MASTER_KEY.toString('base64')), false);

  const restored = restoreDataBackup(backupFile, restoredDirectory);
  assert.equal(restored.sha256, created.sha256);
  assert.equal(fs.statSync(restoredDirectory).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(restoredDirectory, 'ollama-remote-control.sqlite')).mode & 0o777, 0o600);

  database = openDatabase(path.join(restoredDirectory, 'ollama-remote-control.sqlite'));
  try {
    applyMigrations(database);
    assert.equal(database.prepare(`SELECT hostname FROM hosts WHERE id='host-1'`).get().hostname, 'ollama.internal');
    assert.equal(database.prepare(`SELECT selected_container_id FROM ollama_targets WHERE id='target-1'`).get().selected_container_id, 'container-1');
    assert.equal(new SqliteModelfileRepository(database).findRevisionById('revision-1').rawText, 'FROM llama3.2:latest\r\nPARAMETER num_ctx 8192\r\n');
    assert.equal(new SqliteModelfileDeploymentRepository(database).findBySourceCreateJobId('create-job-1').modelDigest, MODEL_DIGEST);
    assert.equal(new SqliteProvenanceRepository(database).listSourcesForInstalledModel('target-1', 'backup-model:latest', MODEL_DIGEST)[0].id, 'source-1');
    assert.equal(new SqliteAuditRepository(database).listByTarget('target-1').some((entry) => entry.id === 'audit-1'), true);

    const stored = new SqliteSshCredentialRepository(database).findByHostId('host-1');
    assert(stored);
    const context = { credentialId: stored.id, hostId: stored.hostId };
    assert.equal(new SecretCipher(MASTER_KEY).decrypt(context, stored.encryptedPrivateKey), PRIVATE_KEY);
    assert.throws(() => new SecretCipher(WRONG_MASTER_KEY).decrypt(context, stored.encryptedPrivateKey));
  } finally {
    database.close();
  }
});

test('backup and restore fail closed for symlinks, non-empty destinations and tampered paths', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orc-backup-safety-'));
  const sourceDirectory = path.join(root, 'source');
  fs.mkdirSync(sourceDirectory, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(sourceDirectory, 'state.sqlite'), 'state', { mode: 0o600 });
  fs.symlinkSync(path.join(sourceDirectory, 'state.sqlite'), path.join(sourceDirectory, 'linked.sqlite'));
  assert.throws(() => createDataBackup(sourceDirectory, path.join(root, 'unsafe.gz')), /Symlinks are not allowed/u);
  fs.unlinkSync(path.join(sourceDirectory, 'linked.sqlite'));

  const backupFile = path.join(root, 'safe.gz');
  createDataBackup(sourceDirectory, backupFile);
  const occupied = path.join(root, 'occupied');
  fs.mkdirSync(occupied);
  fs.writeFileSync(path.join(occupied, 'existing'), 'keep');
  assert.throws(() => restoreDataBackup(backupFile, occupied), /empty real directory/u);

  const payload = JSON.parse(zlib.gunzipSync(fs.readFileSync(backupFile)).toString('utf8'));
  payload.files[0].path = '../escape.sqlite';
  const tampered = path.join(root, 'tampered.gz');
  fs.writeFileSync(tampered, zlib.gzipSync(Buffer.from(JSON.stringify(payload), 'utf8')));
  assert.throws(() => restoreDataBackup(tampered, path.join(root, 'tampered-restore')), /escapes the data directory/u);
});
