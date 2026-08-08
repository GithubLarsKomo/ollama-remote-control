CREATE UNIQUE INDEX IF NOT EXISTS idx_ollama_targets_host_container
  ON ollama_targets(host_id, selected_container_id)
  WHERE selected_container_id IS NOT NULL;
