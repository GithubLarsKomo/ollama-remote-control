CREATE TABLE IF NOT EXISTS update_snapshots (
  id TEXT PRIMARY KEY,
  target_id TEXT NOT NULL REFERENCES ollama_targets(id) ON DELETE CASCADE,
  actor_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  public_metadata_json TEXT NOT NULL,
  algorithm TEXT NOT NULL CHECK (algorithm = 'aes-256-gcm'),
  key_version INTEGER NOT NULL CHECK (key_version >= 1),
  nonce TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  auth_tag TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_update_snapshots_target_created
  ON update_snapshots(target_id, created_at DESC, id DESC);

CREATE TRIGGER IF NOT EXISTS trg_update_snapshots_no_update
BEFORE UPDATE ON update_snapshots
BEGIN
  SELECT RAISE(ABORT, 'update_snapshots are immutable');
END;
