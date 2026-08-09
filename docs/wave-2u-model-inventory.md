# Wave 2u — read-only Ollama model inventory

Wave 2u replaces the first CLI table-reading workflows (`ollama ls` and `ollama ps`) with a read-only, server-authoritative model inventory.

## Trust boundary

The browser supplies only the selected target ID. The server resolves the persisted target, enabled host and encrypted SSH credential, re-inspects the persisted Docker container and derives a safe Ollama API route. Ollama port 11434 is never exposed by this feature.

Only three Ollama HTTP read paths are permitted by the SSH HTTP adapter at runtime: `/api/version`, `/api/tags` and `/api/ps`. Model inventory uses only `/api/tags` and `/api/ps` through host-key-pinned SSH forwarding.

## Response boundary

Remote JSON is normalized into bounded DTOs. Unknown Ollama fields are dropped. Model counts, strings, arrays, byte counts, timestamps and the total response size are bounded and validated. Remote response bodies and SSH/Docker stderr are not forwarded to the browser on errors.

## SPA behavior

The Models panel shows installed model count/storage, loaded model count/VRAM, transport mode, installed model metadata and currently loaded model runtime metadata. It is read-only, has an explicit refresh action and keeps no browser-persistent state. The panel is reset after target rebind or container restart so stale runtime inventory is not retained across a changed container instance.

Model mutation (`pull`, remove, unload, create/copy/push) and a generation console remain out of scope for this wave.
