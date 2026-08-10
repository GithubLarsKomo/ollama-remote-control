# Beta audit surface

Issue: #85

This beta slice adds an authenticated, server-authoritative audit history without widening SSH, Docker or Ollama authority.

## Read path

- Exact named filters only: target, host, actor, action, result and time window.
- History is bounded to 100 rows per page and offset 10,000.
- Deterministic ordering is newest first by timestamp and event ID.
- Persisted parameter JSON is size-bounded, parsed defensively and redacted again before leaving the server.
- Malformed, oversized or non-object parameter JSON is replaced with an unavailable sentinel; raw persisted text is never returned.

## Export

- JSON and CSV exports use the same server-side filters and redacted event view.
- Exports are capped at 5,000 rows and 4 MiB.
- CSV cells beginning with spreadsheet formula prefixes (`=`, `+`, `-`, `@`, including leading whitespace) are prefixed with an apostrophe before CSV quoting.
- The browser receives an attachment response only; no filesystem destination is accepted from the client.

## Retention

- Default retention is 90 days.
- Rows strictly older than the UTC cutoff are removed; rows exactly at the cutoff remain.
- Startup maintenance is bounded to 10 batches of 1,000 rows and is idempotent.
- Retention failure is logged but does not indefinitely block readiness.
- Jobs and job events are not touched.

## Deliberate boundary

This slice adds no log export, shell transcript export, arbitrary database query, audit edit/delete API, remote access, retention configuration UI, SSH authority, Docker authority or Ollama authority.
