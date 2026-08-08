CREATE UNIQUE INDEX IF NOT EXISTS idx_hosts_connection_identity
  ON hosts(hostname COLLATE NOCASE, port, username COLLATE NOCASE);
