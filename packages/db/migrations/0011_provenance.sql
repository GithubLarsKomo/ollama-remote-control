CREATE TABLE IF NOT EXISTS provenance_sources (
  id TEXT PRIMARY KEY,
  subject_kind TEXT NOT NULL CHECK (subject_kind IN ('installed-model', 'modelfile-revision')),
  target_id TEXT NULL REFERENCES ollama_targets(id) ON DELETE RESTRICT,
  model_name TEXT NULL CHECK (model_name IS NULL OR length(model_name) BETWEEN 1 AND 512),
  model_digest TEXT NULL CHECK (
    model_digest IS NULL OR (
      length(model_digest) = 64
      AND model_digest = lower(model_digest)
      AND model_digest NOT GLOB '*[^0-9a-f]*'
    )
  ),
  revision_id TEXT NULL REFERENCES modelfile_revisions(id) ON DELETE RESTRICT,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('huggingface', 'ollama', 'url', 'unknown')),
  source_reference TEXT NULL CHECK (source_reference IS NULL OR length(source_reference) BETWEEN 1 AND 2048),
  origin TEXT NOT NULL CHECK (origin IN ('observed', 'operator')),
  confidence TEXT NOT NULL CHECK (confidence IN ('high', 'medium', 'low', 'unknown')),
  actor_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  supersedes_source_id TEXT NULL REFERENCES provenance_sources(id) ON DELETE RESTRICT,
  note TEXT NULL CHECK (note IS NULL OR length(note) <= 1024),
  created_at TEXT NOT NULL,
  CHECK (
    (subject_kind = 'installed-model' AND target_id IS NOT NULL AND model_name IS NOT NULL AND model_digest IS NOT NULL AND revision_id IS NULL)
    OR
    (subject_kind = 'modelfile-revision' AND target_id IS NULL AND model_name IS NULL AND model_digest IS NULL AND revision_id IS NOT NULL)
  ),
  CHECK (
    (source_kind = 'unknown' AND source_reference IS NULL AND confidence = 'unknown')
    OR
    (source_kind <> 'unknown' AND source_reference IS NOT NULL)
  ),
  CHECK (supersedes_source_id IS NULL OR supersedes_source_id <> id)
);

CREATE INDEX IF NOT EXISTS idx_provenance_sources_model
  ON provenance_sources(target_id, model_name, model_digest, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_provenance_sources_revision
  ON provenance_sources(revision_id, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS provenance_nodes (
  id TEXT PRIMARY KEY,
  identity_key TEXT NOT NULL UNIQUE CHECK (length(identity_key) BETWEEN 1 AND 1024),
  kind TEXT NOT NULL CHECK (kind IN ('installed-model', 'model-reference', 'modelfile-revision')),
  target_id TEXT NULL REFERENCES ollama_targets(id) ON DELETE RESTRICT,
  model_name TEXT NULL CHECK (model_name IS NULL OR length(model_name) BETWEEN 1 AND 512),
  model_digest TEXT NULL CHECK (
    model_digest IS NULL OR (
      length(model_digest) = 64
      AND model_digest = lower(model_digest)
      AND model_digest NOT GLOB '*[^0-9a-f]*'
    )
  ),
  revision_id TEXT NULL REFERENCES modelfile_revisions(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  CHECK (
    (kind = 'installed-model' AND target_id IS NOT NULL AND model_name IS NOT NULL AND model_digest IS NOT NULL AND revision_id IS NULL)
    OR
    (kind = 'model-reference' AND target_id IS NULL AND model_name IS NOT NULL AND model_digest IS NULL AND revision_id IS NULL)
    OR
    (kind = 'modelfile-revision' AND target_id IS NULL AND model_name IS NULL AND model_digest IS NULL AND revision_id IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS provenance_edges (
  id TEXT PRIMARY KEY,
  from_node_id TEXT NOT NULL REFERENCES provenance_nodes(id) ON DELETE RESTRICT,
  to_node_id TEXT NOT NULL REFERENCES provenance_nodes(id) ON DELETE RESTRICT,
  relation TEXT NOT NULL CHECK (relation IN ('base-model', 'adapter', 'quantized-from', 'created-from-revision', 'captured-as-revision')),
  origin TEXT NOT NULL CHECK (origin IN ('observed', 'operator')),
  confidence TEXT NOT NULL CHECK (confidence IN ('high', 'medium', 'low', 'unknown')),
  source_job_id TEXT NULL REFERENCES jobs(id) ON DELETE RESTRICT,
  actor_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  CHECK (from_node_id <> to_node_id),
  UNIQUE(from_node_id, to_node_id, relation, origin, source_job_id)
);

CREATE INDEX IF NOT EXISTS idx_provenance_edges_from
  ON provenance_edges(from_node_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_provenance_edges_to
  ON provenance_edges(to_node_id, created_at DESC, id DESC);

CREATE TRIGGER IF NOT EXISTS trg_provenance_sources_supersedes_subject
BEFORE INSERT ON provenance_sources
WHEN NEW.supersedes_source_id IS NOT NULL
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM provenance_sources old
    WHERE old.id = NEW.supersedes_source_id
      AND old.subject_kind = NEW.subject_kind
      AND COALESCE(old.target_id, '') = COALESCE(NEW.target_id, '')
      AND COALESCE(old.model_name, '') = COALESCE(NEW.model_name, '')
      AND COALESCE(old.model_digest, '') = COALESCE(NEW.model_digest, '')
      AND COALESCE(old.revision_id, '') = COALESCE(NEW.revision_id, '')
  ) THEN RAISE(ABORT, 'Superseded provenance source must refer to the same subject') END;
END;

CREATE TRIGGER IF NOT EXISTS trg_provenance_sources_no_update
BEFORE UPDATE ON provenance_sources
BEGIN
  SELECT RAISE(ABORT, 'Provenance sources are immutable');
END;
CREATE TRIGGER IF NOT EXISTS trg_provenance_sources_no_delete
BEFORE DELETE ON provenance_sources
BEGIN
  SELECT RAISE(ABORT, 'Provenance sources are append-only');
END;
CREATE TRIGGER IF NOT EXISTS trg_provenance_nodes_no_update
BEFORE UPDATE ON provenance_nodes
BEGIN
  SELECT RAISE(ABORT, 'Provenance nodes are immutable');
END;
CREATE TRIGGER IF NOT EXISTS trg_provenance_nodes_no_delete
BEFORE DELETE ON provenance_nodes
BEGIN
  SELECT RAISE(ABORT, 'Provenance nodes are append-only');
END;
CREATE TRIGGER IF NOT EXISTS trg_provenance_edges_no_update
BEFORE UPDATE ON provenance_edges
BEGIN
  SELECT RAISE(ABORT, 'Provenance edges are immutable');
END;
CREATE TRIGGER IF NOT EXISTS trg_provenance_edges_no_delete
BEFORE DELETE ON provenance_edges
BEGIN
  SELECT RAISE(ABORT, 'Provenance edges are append-only');
END;
