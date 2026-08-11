ALTER TABLE modelfile_deploy_plans
  ADD COLUMN replace_existing INTEGER NOT NULL DEFAULT 0 CHECK (replace_existing IN (0, 1));

ALTER TABLE modelfile_deploy_plans
  ADD COLUMN expected_existing_digest TEXT;

ALTER TABLE modelfile_deploy_plans
  ADD COLUMN expected_existing_size_bytes INTEGER;

CREATE TRIGGER IF NOT EXISTS trg_modelfile_deploy_plan_replace_integrity_insert
BEFORE INSERT ON modelfile_deploy_plans
BEGIN
  SELECT CASE WHEN NEW.replace_existing = 0 AND (
    NEW.expected_existing_digest IS NOT NULL OR NEW.expected_existing_size_bytes IS NOT NULL
  ) THEN RAISE(ABORT, 'non-replacement deploy plan cannot bind existing model identity') END;
  SELECT CASE WHEN NEW.replace_existing = 1 AND (
    NEW.expected_existing_digest IS NULL
    OR length(NEW.expected_existing_digest) < 12
    OR NEW.expected_existing_size_bytes IS NULL
    OR NEW.expected_existing_size_bytes < 0
  ) THEN RAISE(ABORT, 'replacement deploy plan requires existing model identity') END;
END;

CREATE TRIGGER IF NOT EXISTS trg_modelfile_deploy_plan_replace_integrity_update
BEFORE UPDATE OF replace_existing, expected_existing_digest, expected_existing_size_bytes ON modelfile_deploy_plans
BEGIN
  SELECT RAISE(ABORT, 'deploy plan replacement authority is immutable');
END;
