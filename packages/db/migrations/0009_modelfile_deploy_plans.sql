CREATE TABLE IF NOT EXISTS modelfile_deploy_plans (
  id TEXT PRIMARY KEY,
  target_id TEXT NOT NULL REFERENCES ollama_targets(id) ON DELETE RESTRICT,
  modelfile_id TEXT NOT NULL REFERENCES modelfiles(id) ON DELETE RESTRICT,
  revision_id TEXT NOT NULL REFERENCES modelfile_revisions(id) ON DELETE RESTRICT,
  revision_sha256 TEXT NOT NULL CHECK (
    length(revision_sha256) = 64
    AND revision_sha256 = lower(revision_sha256)
    AND revision_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  actor_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  selected_container_id TEXT NOT NULL CHECK (length(selected_container_id) BETWEEN 1 AND 128),
  output_model TEXT NOT NULL CHECK (length(output_model) BETWEEN 1 AND 512),
  base_model TEXT NOT NULL CHECK (length(base_model) BETWEEN 1 AND 512),
  payload_sha256 TEXT NOT NULL CHECK (
    length(payload_sha256) = 64
    AND payload_sha256 = lower(payload_sha256)
    AND payload_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  confirmation_token_hash TEXT NOT NULL CHECK (
    length(confirmation_token_hash) = 64
    AND confirmation_token_hash = lower(confirmation_token_hash)
    AND confirmation_token_hash NOT GLOB '*[^0-9a-f]*'
  ),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  CHECK (expires_at > created_at),
  CHECK (consumed_at IS NULL OR consumed_at >= created_at)
);

CREATE INDEX IF NOT EXISTS idx_modelfile_deploy_plans_actor_expiry
  ON modelfile_deploy_plans(actor_user_id, expires_at, consumed_at);

CREATE INDEX IF NOT EXISTS idx_modelfile_deploy_plans_revision
  ON modelfile_deploy_plans(modelfile_id, revision_id);

CREATE TRIGGER IF NOT EXISTS trg_modelfile_deploy_plan_revision_integrity
BEFORE INSERT ON modelfile_deploy_plans
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM modelfile_revisions revision
    WHERE revision.id = NEW.revision_id
      AND revision.modelfile_id = NEW.modelfile_id
      AND revision.content_sha256 = NEW.revision_sha256
  ) THEN RAISE(ABORT, 'deploy plan revision identity is invalid') END;
END;
