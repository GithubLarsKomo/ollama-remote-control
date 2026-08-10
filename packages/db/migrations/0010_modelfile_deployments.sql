CREATE TABLE IF NOT EXISTS modelfile_deployments (
  id TEXT PRIMARY KEY,
  target_id TEXT NOT NULL REFERENCES ollama_targets(id) ON DELETE RESTRICT,
  modelfile_id TEXT NOT NULL REFERENCES modelfiles(id) ON DELETE RESTRICT,
  revision_id TEXT NOT NULL REFERENCES modelfile_revisions(id) ON DELETE RESTRICT,
  revision_sha256 TEXT NOT NULL CHECK (
    length(revision_sha256) = 64
    AND revision_sha256 = lower(revision_sha256)
    AND revision_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  output_model TEXT NOT NULL CHECK (length(output_model) BETWEEN 1 AND 512),
  model_digest TEXT NOT NULL CHECK (
    length(model_digest) = 64
    AND model_digest = lower(model_digest)
    AND model_digest NOT GLOB '*[^0-9a-f]*'
  ),
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  base_model TEXT NOT NULL CHECK (length(base_model) BETWEEN 1 AND 512),
  source_create_job_id TEXT NOT NULL UNIQUE REFERENCES jobs(id) ON DELETE RESTRICT,
  actor_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  selected_container_id TEXT NOT NULL CHECK (length(selected_container_id) BETWEEN 1 AND 128),
  verified_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_modelfile_deployments_revision
  ON modelfile_deployments(revision_id, verified_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_modelfile_deployments_artifact
  ON modelfile_deployments(modelfile_id, verified_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_modelfile_deployments_target_model
  ON modelfile_deployments(target_id, output_model, verified_at DESC, id DESC);

CREATE TRIGGER IF NOT EXISTS trg_modelfile_deployments_revision_integrity
BEFORE INSERT ON modelfile_deployments
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM modelfile_revisions revision
    WHERE revision.id = NEW.revision_id
      AND revision.modelfile_id = NEW.modelfile_id
      AND revision.content_sha256 = NEW.revision_sha256
  ) THEN RAISE(ABORT, 'Modelfile deployment revision identity is invalid') END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM jobs job
    WHERE job.id = NEW.source_create_job_id
      AND job.target_id = NEW.target_id
      AND job.actor_user_id = NEW.actor_user_id
      AND job.kind = 'model-create'
      AND job.state = 'succeeded'
  ) THEN RAISE(ABORT, 'Modelfile deployment source job is not verified successful create evidence') END;
END;

CREATE TRIGGER IF NOT EXISTS trg_modelfile_deployments_no_update
BEFORE UPDATE ON modelfile_deployments
BEGIN
  SELECT RAISE(ABORT, 'Modelfile deployments are immutable');
END;

CREATE TRIGGER IF NOT EXISTS trg_modelfile_deployments_no_delete
BEFORE DELETE ON modelfile_deployments
BEGIN
  SELECT RAISE(ABORT, 'Modelfile deployments are append-only');
END;
