import { createHash } from 'node:crypto';
import type {
  ModelfileRepository,
  ModelfileSourceKind,
  StoredModelfileArtifact,
  StoredModelfileRevision,
} from '@orc/core/modelfiles';
import type { DatabaseConnection } from './index.js';

function mapArtifact(row: Record<string, unknown> | undefined): StoredModelfileArtifact | null {
  if (!row) return null;
  return {
    id: String(row.id),
    displayName: String(row.display_name),
    description: row.description === null ? null : String(row.description),
    currentRevisionId: String(row.current_revision_id),
    createdByUserId: String(row.created_by_user_id),
    updatedByUserId: String(row.updated_by_user_id),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapRevision(row: Record<string, unknown> | undefined): StoredModelfileRevision | null {
  if (!row) return null;
  return {
    id: String(row.id),
    modelfileId: String(row.modelfile_id),
    revisionNumber: Number(row.revision_number),
    parentRevisionId: row.parent_revision_id === null ? null : String(row.parent_revision_id),
    rawText: String(row.raw_text),
    contentSha256: String(row.content_sha256),
    sourceKind: String(row.source_kind) as ModelfileSourceKind,
    importedTargetId: row.imported_target_id === null ? null : String(row.imported_target_id),
    importedModel: row.imported_model === null ? null : String(row.imported_model),
    importedDigest: row.imported_digest === null ? null : String(row.imported_digest),
    createdByUserId: String(row.created_by_user_id),
    createdAt: String(row.created_at),
  };
}

function contentHash(rawText: string): string {
  return createHash('sha256').update(rawText, 'utf8').digest('hex');
}

function assertRevisionHash(revision: StoredModelfileRevision): void {
  if (contentHash(revision.rawText) !== revision.contentSha256) {
    throw new Error('Modelfile revision content hash does not match raw text.');
  }
}

function insertRevision(database: DatabaseConnection, revision: StoredModelfileRevision): void {
  database.prepare(`
    INSERT INTO modelfile_revisions(
      id, modelfile_id, revision_number, parent_revision_id, raw_text, content_sha256,
      source_kind, imported_target_id, imported_model, imported_digest,
      created_by_user_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    revision.id,
    revision.modelfileId,
    revision.revisionNumber,
    revision.parentRevisionId,
    revision.rawText,
    revision.contentSha256,
    revision.sourceKind,
    revision.importedTargetId,
    revision.importedModel,
    revision.importedDigest,
    revision.createdByUserId,
    revision.createdAt,
  );
}

export function sha256Modelfile(rawText: string): string {
  return contentHash(rawText);
}

export class SqliteModelfileRepository implements ModelfileRepository {
  constructor(private readonly database: DatabaseConnection) {}

  createWithInitialRevision(
    artifact: StoredModelfileArtifact,
    revision: StoredModelfileRevision,
  ): boolean {
    if (revision.modelfileId !== artifact.id) {
      throw new Error('Initial Modelfile revision must belong to the created artifact.');
    }
    if (revision.id !== artifact.currentRevisionId) {
      throw new Error('Initial Modelfile revision must match the artifact current revision.');
    }
    if (revision.revisionNumber !== 1 || revision.parentRevisionId !== null) {
      throw new Error('Initial Modelfile revision must be revision 1 without a parent.');
    }
    assertRevisionHash(revision);

    this.database.exec('BEGIN IMMEDIATE');
    try {
      const inserted = this.database.prepare(`
        INSERT OR IGNORE INTO modelfiles(
          id, display_name, description, current_revision_id,
          created_by_user_id, updated_by_user_id, created_at, updated_at
        ) VALUES (?, ?, ?, NULL, ?, ?, ?, ?)
      `).run(
        artifact.id,
        artifact.displayName,
        artifact.description,
        artifact.createdByUserId,
        artifact.updatedByUserId,
        artifact.createdAt,
        artifact.updatedAt,
      );
      if (inserted.changes !== 1) {
        this.database.exec('ROLLBACK');
        return false;
      }
      insertRevision(this.database, revision);
      const pointed = this.database.prepare(`
        UPDATE modelfiles
        SET current_revision_id = ?
        WHERE id = ? AND current_revision_id IS NULL
      `).run(revision.id, artifact.id);
      if (pointed.changes !== 1) throw new Error('Initial Modelfile current revision could not be set.');
      this.database.exec('COMMIT');
      return true;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  appendRevision(
    modelfileId: string,
    expectedCurrentRevisionId: string,
    revision: StoredModelfileRevision,
    updatedAt: string,
    updatedByUserId: string,
  ): boolean {
    if (revision.modelfileId !== modelfileId) {
      throw new Error('Appended Modelfile revision must belong to the artifact.');
    }
    if (revision.parentRevisionId !== expectedCurrentRevisionId) {
      throw new Error('Appended Modelfile revision parent must match expected current revision.');
    }
    assertRevisionHash(revision);

    this.database.exec('BEGIN IMMEDIATE');
    try {
      const current = this.database.prepare(`
        SELECT m.current_revision_id, r.revision_number
        FROM modelfiles m
        JOIN modelfile_revisions r ON r.id = m.current_revision_id
        WHERE m.id = ?
      `).get(modelfileId);
      if (!current || String(current.current_revision_id) !== expectedCurrentRevisionId) {
        this.database.exec('ROLLBACK');
        return false;
      }
      const expectedNumber = Number(current.revision_number) + 1;
      if (revision.revisionNumber !== expectedNumber) {
        throw new Error(`Appended Modelfile revision must be revision ${expectedNumber}.`);
      }

      insertRevision(this.database, revision);
      const changed = this.database.prepare(`
        UPDATE modelfiles
        SET current_revision_id = ?, updated_at = ?, updated_by_user_id = ?
        WHERE id = ? AND current_revision_id = ?
      `).run(
        revision.id,
        updatedAt,
        updatedByUserId,
        modelfileId,
        expectedCurrentRevisionId,
      );
      if (changed.changes !== 1) {
        this.database.exec('ROLLBACK');
        return false;
      }
      this.database.exec('COMMIT');
      return true;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  findById(modelfileId: string): StoredModelfileArtifact | null {
    return mapArtifact(this.database.prepare(`
      SELECT id, display_name, description, current_revision_id,
             created_by_user_id, updated_by_user_id, created_at, updated_at
      FROM modelfiles WHERE id = ? AND current_revision_id IS NOT NULL
    `).get(modelfileId));
  }

  list(): readonly StoredModelfileArtifact[] {
    return this.database.prepare(`
      SELECT id, display_name, description, current_revision_id,
             created_by_user_id, updated_by_user_id, created_at, updated_at
      FROM modelfiles
      WHERE current_revision_id IS NOT NULL
      ORDER BY updated_at DESC, id DESC
    `).all().map((row) => mapArtifact(row)!).filter(Boolean);
  }

  findRevisionById(revisionId: string): StoredModelfileRevision | null {
    return mapRevision(this.database.prepare(`
      SELECT id, modelfile_id, revision_number, parent_revision_id, raw_text, content_sha256,
             source_kind, imported_target_id, imported_model, imported_digest,
             created_by_user_id, created_at
      FROM modelfile_revisions WHERE id = ?
    `).get(revisionId));
  }

  listRevisions(modelfileId: string): readonly StoredModelfileRevision[] {
    return this.database.prepare(`
      SELECT id, modelfile_id, revision_number, parent_revision_id, raw_text, content_sha256,
             source_kind, imported_target_id, imported_model, imported_digest,
             created_by_user_id, created_at
      FROM modelfile_revisions
      WHERE modelfile_id = ?
      ORDER BY revision_number DESC
    `).all(modelfileId).map((row) => mapRevision(row)!).filter(Boolean);
  }
}
