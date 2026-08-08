CREATE TABLE IF NOT EXISTS ssh_credentials (
  id TEXT PRIMARY KEY,
  host_id TEXT NOT NULL UNIQUE REFERENCES hosts(id) ON DELETE CASCADE,
  algorithm TEXT NOT NULL CHECK (algorithm IN ('aes-256-gcm')),
  key_version INTEGER NOT NULL CHECK (key_version >= 1),
  nonce TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  auth_tag TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ssh_credentials_host_id
  ON ssh_credentials(host_id);
