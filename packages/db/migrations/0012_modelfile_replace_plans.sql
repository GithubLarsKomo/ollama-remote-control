ALTER TABLE modelfile_deploy_plans
  ADD COLUMN replace_existing INTEGER NOT NULL DEFAULT 0
  CHECK (replace_existing IN (0, 1));

ALTER TABLE modelfile_deploy_plans
  ADD COLUMN existing_destination_digest TEXT
  CHECK (
    existing_destination_digest IS NULL
    OR (
      length(existing_destination_digest) = 64
      AND existing_destination_digest = lower(existing_destination_digest)
      AND existing_destination_digest NOT GLOB '*[^0-9a-f]*'
    )
  );

ALTER TABLE modelfile_deploy_plans
  ADD COLUMN existing_destination_size_bytes INTEGER
  CHECK (existing_destination_size_bytes IS NULL OR existing_destination_size_bytes >= 0);

CREATE TRIGGER IF NOT EXISTS trg_modelfile_deploy_plan_replace_integrity_insert
BEFORE INSERT ON modelfile_deploy_plans
BEGIN
  SELECT CASE WHEN (
    (NEW.replace_existing = 1 AND (NEW.existing_destination_digest IS NULL OR NEW.existing_destination_size_bytes IS NULL))
    OR
    (NEW.replace_existing = 0 AND (NEW.existing_destination_digest IS NOT NULL OR NEW.existing_destination_size_bytes IS NOT NULL))
  ) THEN RAISE(ABORT, 'deploy plan replacement evidence is invalid') END;
END;

CREATE TRIGGER IF NOT EXISTS trg_modelfile_deploy_plan_replace_integrity_update
BEFORE UPDATE OF replace_existing, existing_destination_digest, existing_destination_size_bytes
ON modelfile_deploy_plans
BEGIN
  SELECT CASE WHEN (
    (NEW.replace_existing = 1 AND (NEW.existing_destination_digest IS NULL OR NEW.existing_destination_size_bytes IS NULL))
    OR
    (NEW.replace_existing = 0 AND (NEW.existing_destination_digest IS NOT NULL OR NEW.existing_destination_size_bytes IS NOT NULL))
  ) THEN RAISE(ABORT, 'deploy plan replacement evidence is invalid') END;
END;
