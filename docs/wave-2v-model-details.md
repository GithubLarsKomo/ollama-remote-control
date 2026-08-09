# Wave 2v — read-only Ollama model details and Modelfile preview

Wave 2v adds the read-only detail layer required before local Modelfile revisions, editing and provenance management.

## Trust boundary

The browser supplies only an authenticated target ID and a validated model identifier. The server resolves the persisted target, enabled host and encrypted SSH credential, re-inspects the persisted selected Docker container and derives the same safe Ollama API route used by health and model inventory.

The server first reads `/api/tags` and requires the requested model to exist in that fresh inventory. Only then may it invoke the dedicated SSH-tunneled Ollama Show primitive. That primitive always emits `POST /api/show` with a server-generated JSON body containing exactly the canonical installed model identifier and `verbose: false`. The browser cannot choose the remote HTTP method, path, headers, destination, SSH host or Docker container.

The generic GET allowlist remains `/api/version`, `/api/tags` and `/api/ps`. `/api/show` is not added to that generic path list; it is reachable only through the dedicated typed Show operation.

## Response boundary

Ollama Show data is projected into an explicit bounded DTO. The application may return the generated Modelfile, parameters, template, system prompt, license, capabilities, selected model details and a small allowlisted architecture summary. Text sizes and capability counts are bounded. Unknown fields, verbose tensors, arbitrary token arrays, projector data and remote-host fields are dropped.

Non-2xx responses, malformed JSON and oversized data are mapped to safe typed errors. Raw Ollama response bodies and SSH stderr are never forwarded to the browser.

## Provenance preview

The generated Modelfile is rendered read-only as text. The application parses only syntactic `FROM` and `ADAPTER` references for a preview. A normal Ollama-style identifier can be classified as a model reference; an absolute/relative path or blob reference is classified as a local artifact. The preview never converts local blob paths into asserted upstream lineage and performs no external metadata lookup.

This distinction is intentional: revision history and provenance are separate concerns, and provenance remains unknown until a later persistence/source-resolution wave can support evidence-backed relationships.

## SPA behavior

The installed-model inventory exposes an explicit Details action. Details are fetched only for the selected model; the normal inventory does not issue `/api/show` for every installed model. The detail view provides Overview, Modelfile and Runtime metadata sections and keeps no browser-persistent state.

The parent Models panel is already keyed by target, persisted container and container start identity, so rebinds and restarts discard detail state together with the inventory. Lifecycle/update busy states also disable detail selection.

## Follow-on

Wave 2w should introduce a local first-class Modelfile library with immutable revisions and an explicit import-from-installed-model action backed by this read-only Show substrate. Structured/raw editing, diff/validation/deploy and persisted lineage/source links remain later waves.
