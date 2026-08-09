CREATE TABLE IF NOT EXISTS modelfiles (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 160),
  description TEXT CHECK (description IS NULL OR length(description) <= 1000),
  current_revision_id TEXT REFERENCES modelfile_revisions(id) ON DELETE RESTRICT,
  created_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  updated_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS modelfile_revisions (
  id TEXT PRIMARY KEY,
  modelfile_id TEXT NOT NULL REFERENCES modelfiles(id) ON DELETE RESTRICT,
  revision_number INTEGER NOT NULL CHECK (revision_number >= 1),
  parent_revision_id TEXT REFERENCES modelfile_revisions(id) ON DELETE RESTRICT,
  raw_text TEXT NOT NULL CHECK (length(raw_text) BETWEEN 1 AND 524288),
  content_sha256 TEXT NOT NULL CHECK (
    length(content_sha256) = 64
    AND content_sha256 = lower(content_sha256)
    AND content_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  source_kind TEXT NOT NULL CHECK (source_kind IN ('manual', 'installed-model-import')),
  imported_target_id TEXT,
  imported_model TEXT,
  imported_digest TEXT,
  created_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  UNIQUE(modelfile_id, revision_number),
  CHECK (
    (source_kind = 'manual'
      AND imported_target_id IS NULL
      AND imported_model IS NULL
      AND imported_digest IS NULL)
    OR
    (source_kind = 'installed-model-import'
      AND imported_target_id IS NOT NULL
      AND length(imported_target_id) BETWEEN 1 AND 256
      AND imported_model IS NOT NULL
      AND length(imported_model) BETWEEN 1 AND 512
      AND imported_digest IS NOT NULL
      AND length(imported_digest) = 64
      AND imported_digest = lower(imported_digest)
      AND imported_digest NOT GLOB '*[^0-9a-f]*')
  )
);

CREATE INDEX IF NOT EXISTS idx_modelfiles_updated
  ON modelfiles(updated_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_modelfile_revisions_artifact
  ON modelfile_revisions(modelfile_id, revision_number DESC);

CREATE TRIGGER IF NOT EXISTS trg_modelfile_revision_parent_integrity
BEFORE INSERT ON modelfile_revisions
BEGIN
  SELECT CASE
    WHEN NEW.revision_number = 1 AND NEW.parent_revision_id IS NOT NULL
      THEN RAISE(ABORT, 'initial Modelfile revision cannot have a parent')
    WHEN NEW.revision_number > 1 AND NEW.parent_revision_id IS NULL
      THEN RAISE(ABORT, 'non-initial Modelfile revision requires a parent')
    WHEN NEW.parent_revision_id IS NOT NULL AND NOT EXISTS (
      SELECT 1
      FROM modelfile_revisions parent
      WHERE parent.id = NEW.parent_revision_id
        AND parent.modelfile_id = NEW.modelfile_id
        AND parent.revision_number = NEW.revision_number - 1
    )
      THEN RAISE(ABORT, 'Modelfile revision parent is invalid')
  END;
END;

CREATE TRIGGER IF NOT EXISTS trg_modelfile_current_revision_integrity
BEFORE UPDATE OF current_revision_id ON modelfiles
WHEN NEW.current_revision_id IS NOT NULL
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM modelfile_revisions revision
    WHERE revision.id = NEW.current_revision_id
      AND revision.modelfile_id = NEW.id
  ) THEN RAISE(ABORT, 'current Modelfile revision must belong to artifact') END;
END;

CREATE TRIGGER IF NOT EXISTS trg_modelfile_revisions_no_update
BEFORE UPDATE ON modelfile_revisions
BEGIN
  SELECT RAISE(ABORT, 'Modelfile revisions are immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_modelfile_revisions_no_delete
BEFORE DELETE ON modelfile_revisions
BEGIN
  SELECT RAISE(ABORT, 'Modelfile revisions are append-only');
END;
