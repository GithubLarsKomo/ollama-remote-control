import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { applyMigrations, openDatabase } from '../dist/index.js';
import { sha256Modelfile, SqliteModelfileRepository } from '../dist/modelfiles.js';

const CREATED_AT = '2026-08-09T06:40:00.000Z';
const UPDATED_AT = '2026-08-09T06:41:00.000Z';
const IMPORT_DIGEST = 'a'.repeat(64);

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orc-modelfiles-'));
  const database = openDatabase(path.join(directory, 'modelfiles.sqlite'));
  applyMigrations(database);
  database.prepare(`
    INSERT INTO users(id, username, password_hash, role, created_at)
    VALUES (?, ?, ?, 'admin', ?)
  `).run('user-1', 'admin', 'hash', CREATED_AT);
  return { database, repository: new SqliteModelfileRepository(database) };
}

function importedInitial(rawText = '# imported\nFROM /root/.ollama/models/blobs/sha256:deadbeef\nPARAMETER num_ctx 8192\n') {
  const revision = {
    id: 'rev-1',
    modelfileId: 'mf-1',
    revisionNumber: 1,
    parentRevisionId: null,
    rawText,
    contentSha256: sha256Modelfile(rawText),
    sourceKind: 'installed-model-import',
    importedTargetId: 'target-at-import-time',
    importedModel: 'hf.co/example/model:Q4_K_M',
    importedDigest: IMPORT_DIGEST,
    createdByUserId: 'user-1',
    createdAt: CREATED_AT,
  };
  const artifact = {
    id: 'mf-1',
    displayName: 'Imported Qwen model',
    description: 'Local editable copy',
    currentRevisionId: revision.id,
    createdByUserId: 'user-1',
    updatedByUserId: 'user-1',
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  };
  return { artifact, revision };
}

test('creates artifact and initial revision atomically while preserving raw source and import evidence', () => {
  const { database, repository } = fixture();
  try {
    const { artifact, revision } = importedInitial();
    assert.equal(repository.createWithInitialRevision(artifact, revision), true);
    assert.deepEqual(repository.findById(artifact.id), artifact);
    assert.deepEqual(repository.findRevisionById(revision.id), revision);
    assert.deepEqual(repository.listRevisions(artifact.id), [revision]);
    assert.deepEqual(repository.list(), [artifact]);

    assert.equal(repository.createWithInitialRevision(artifact, revision), false);
    assert.equal(repository.listRevisions(artifact.id).length, 1);
  } finally {
    database.close();
  }
});

test('appends immutable revisions and atomically advances the current pointer', () => {
  const { database, repository } = fixture();
  try {
    const { artifact, revision } = importedInitial();
    repository.createWithInitialRevision(artifact, revision);
    const rawText = '# retained comment\nFROM llama3.2:latest\nPARAMETER num_ctx 16384\n';
    const revision2 = {
      id: 'rev-2',
      modelfileId: artifact.id,
      revisionNumber: 2,
      parentRevisionId: revision.id,
      rawText,
      contentSha256: sha256Modelfile(rawText),
      sourceKind: 'manual',
      importedTargetId: null,
      importedModel: null,
      importedDigest: null,
      createdByUserId: 'user-1',
      createdAt: UPDATED_AT,
    };

    assert.equal(repository.appendRevision(artifact.id, revision.id, revision2, UPDATED_AT, 'user-1'), true);
    assert.deepEqual(repository.findById(artifact.id), {
      ...artifact,
      currentRevisionId: revision2.id,
      updatedAt: UPDATED_AT,
    });
    assert.deepEqual(repository.listRevisions(artifact.id), [revision2, revision]);
    assert.equal(repository.findRevisionById(revision2.id).rawText, rawText);

    assert.throws(() => {
      database.prepare('UPDATE modelfile_revisions SET raw_text = ? WHERE id = ?').run('tampered', revision.id);
    }, /immutable/u);
    assert.throws(() => {
      database.prepare('DELETE FROM modelfile_revisions WHERE id = ?').run(revision.id);
    }, /append-only/u);
  } finally {
    database.close();
  }
});

test('rejects stale revision bases without leaving a partial revision', () => {
  const { database, repository } = fixture();
  try {
    const { artifact, revision } = importedInitial();
    repository.createWithInitialRevision(artifact, revision);

    const secondText = 'FROM llama3.2:latest\nPARAMETER num_ctx 16384\n';
    const revision2 = {
      id: 'rev-2', modelfileId: artifact.id, revisionNumber: 2, parentRevisionId: revision.id,
      rawText: secondText, contentSha256: sha256Modelfile(secondText), sourceKind: 'manual',
      importedTargetId: null, importedModel: null, importedDigest: null,
      createdByUserId: 'user-1', createdAt: UPDATED_AT,
    };
    assert.equal(repository.appendRevision(artifact.id, revision.id, revision2, UPDATED_AT, 'user-1'), true);

    const staleText = 'FROM stale:latest\n';
    const staleRevision = {
      id: 'rev-stale', modelfileId: artifact.id, revisionNumber: 2, parentRevisionId: revision.id,
      rawText: staleText, contentSha256: sha256Modelfile(staleText), sourceKind: 'manual',
      importedTargetId: null, importedModel: null, importedDigest: null,
      createdByUserId: 'user-1', createdAt: '2026-08-09T06:42:00.000Z',
    };
    assert.equal(repository.appendRevision(artifact.id, revision.id, staleRevision, staleRevision.createdAt, 'user-1'), false);
    assert.equal(repository.findRevisionById(staleRevision.id), null);
    assert.equal(repository.findById(artifact.id).currentRevisionId, revision2.id);
  } finally {
    database.close();
  }
});

test('verifies content hash before persistence and prevents cross-artifact current pointers', () => {
  const { database, repository } = fixture();
  try {
    const { artifact, revision } = importedInitial();
    assert.throws(
      () => repository.createWithInitialRevision(artifact, { ...revision, contentSha256: 'b'.repeat(64) }),
      /content hash/u,
    );
    assert.equal(repository.findById(artifact.id), null);

    repository.createWithInitialRevision(artifact, revision);
    const second = importedInitial('FROM second:latest\n');
    const artifact2 = {
      ...second.artifact,
      id: 'mf-2',
      displayName: 'Second',
      currentRevisionId: 'rev-other',
    };
    const revisionOther = {
      ...second.revision,
      id: 'rev-other',
      modelfileId: artifact2.id,
      contentSha256: sha256Modelfile(second.revision.rawText),
      sourceKind: 'manual',
      importedTargetId: null,
      importedModel: null,
      importedDigest: null,
    };
    repository.createWithInitialRevision(artifact2, revisionOther);

    assert.throws(() => {
      database.prepare('UPDATE modelfiles SET current_revision_id = ? WHERE id = ?').run(revision.id, artifact2.id);
    }, /must belong to artifact/u);
  } finally {
    database.close();
  }
});
