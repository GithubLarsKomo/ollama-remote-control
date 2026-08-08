CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  target_id TEXT NOT NULL REFERENCES ollama_targets(id) ON DELETE CASCADE,
  actor_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL,
  mutating INTEGER NOT NULL CHECK (mutating IN (0, 1)),
  state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'cancelling', 'succeeded', 'failed', 'cancelled')),
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  result_json TEXT,
  error_class TEXT,
  exit_code INTEGER
);

CREATE INDEX IF NOT EXISTS idx_jobs_target_created
  ON jobs(target_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_jobs_state_created
  ON jobs(state, created_at);

CREATE UNIQUE INDEX IF NOT EXISTS uq_jobs_active_mutation_target
  ON jobs(target_id)
  WHERE mutating = 1 AND state IN ('queued', 'running', 'cancelling');

CREATE TABLE IF NOT EXISTS job_events (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL CHECK (sequence >= 1),
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(job_id, sequence)
);

CREATE INDEX IF NOT EXISTS idx_job_events_job_sequence
  ON job_events(job_id, sequence);

CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  timestamp TEXT NOT NULL,
  actor_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  host_id TEXT REFERENCES hosts(id) ON DELETE SET NULL,
  target_id TEXT REFERENCES ollama_targets(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  parameters_redacted_json TEXT NOT NULL,
  result TEXT NOT NULL,
  exit_code INTEGER,
  error_class TEXT,
  job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_events_timestamp
  ON audit_events(timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_audit_events_target_timestamp
  ON audit_events(target_id, timestamp DESC);
