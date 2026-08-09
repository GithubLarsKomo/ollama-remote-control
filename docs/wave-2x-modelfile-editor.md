# Wave 2x — synchronized raw and structured Modelfile editor

Wave 2x adds a safe GUI editing layer on top of Wave 2w's immutable local Modelfile revisions. It does not change the canonical-source rule and it does not create or mutate Ollama models.

## Raw source remains canonical

The exact raw Modelfile text stored in each Wave 2w revision remains the source of truth. The parser is deliberately not a pretty-printer or serializer. Parsing a document and rendering it without an edit returns the original bytes unchanged, including comments, blank lines, directive casing, whitespace, directive order and LF/CRLF line endings.

Structured edits are implemented as source-range patches against the current raw draft. Only the intended argument or directive slice is replaced or removed; unrelated source text is never regenerated.

## Recognized and opaque syntax

The shared parser currently recognizes the documented Modelfile directives `FROM`, `PARAMETER`, `TEMPLATE`, `SYSTEM`, `ADAPTER`, `LICENSE`, `MESSAGE` and `REQUIRES`.

Unknown or future directives are represented as opaque nodes with their exact raw slices and source ranges. The structured editor does not attempt to interpret them. Their presence is visible in the UI, but they remain byte-preserved while known safe regions are edited around them.

Malformed or partially understood documents are also retained. Parser diagnostics are local guidance rather than a destructive gate. Unsafe structured controls are disabled for the ambiguous region while Raw editing remains available.

## Bounded parser and diagnostics

The shared parser is browser-compatible and has no Node-only dependency. It enforces the same 512 KiB UTF-8/NUL content boundary as the Wave 2w library and also bounds parsed nodes and diagnostics.

Diagnostics include source offsets plus line/column positions and currently cover missing/duplicate `FROM`, missing directive arguments, incomplete `PARAMETER`/`MESSAGE` values, opaque text, unknown directives and unclosed triple-quoted blocks.

Triple-quoted `TEMPLATE`, `SYSTEM`, `LICENSE` and `MESSAGE` content is retained as one source-ranged directive region. The parser never puts their contents into logs or audit payloads.

## Structured source patches

The GUI exposes source-preserving controls for:

- singleton `FROM` and `REQUIRES` values;
- repeatable `PARAMETER` key/value entries;
- repeatable `ADAPTER` references;
- `SYSTEM`, `TEMPLATE` and `LICENSE` text regions;
- repeatable `MESSAGE` role/content entries.

The source patcher preserves existing argument separators/trivia where practical. Existing triple-quoted text keeps that style; introducing multiline text into a plain text directive promotes only that argument to a triple-quoted representation. Repeated directives remain repeated rather than being normalized into another model.

Raw and Structured views share the same in-memory draft string. Switching views does not serialize or reconstruct the document. Saving still calls the Wave 2w append-revision endpoint, so the server performs the same optimistic current-revision check and immutable transactional commit as before.

## Invalid drafts and conflicts

Local parser errors do not prevent a user from preserving an intermediate local revision. Deployment-level validity is intentionally deferred to Wave 2y, where model creation will require a stricter explicit plan/validation/confirmation boundary.

If a save loses the optimistic-concurrency race, the application refreshes the server's current revision but keeps the user's unsaved draft in memory. The draft is not silently replaced by the newer server text.

## Immutable revision diff

Diff compares two server-read immutable revisions of the same local artifact. The existing Wave 2w revision read route already rejects a revision that does not belong to the selected artifact, so Wave 2x does not add a new privileged diff endpoint.

The shared diff implementation is line based and treats line-ending changes as real changes. Small comparisons use an LCS-based diff with context. If the comparison would exceed the configured quadratic work bound, it switches to a linear common-prefix/common-suffix replacement view. Output lines are also bounded.

Diff content is rendered as React text nodes, not HTML, so Modelfile content cannot become markup through the diff view.

## SPA views

The local Modelfile editor now has three synchronized views:

- **Raw** — exact editable canonical draft;
- **Structured** — safe source-range controls plus bounded diagnostics and opaque-syntax warnings;
- **Diff** — read-only comparison between the immutable current revision and a selected historical revision.

Creating a new revision automatically makes the previous revision the initial diff baseline. Revision-history rows can also open their revision directly as the diff baseline.

No canonical Modelfile content is placed into localStorage or sessionStorage.

## Validation gates

Wave 2x adds Core tests to the root product test suite. Coverage includes byte-identical LF/CRLF no-op handling, comments/blank lines/order preservation, known and unknown directives, multiline content, malformed drafts, targeted patches, add/remove operations, key/value and text edits, bounded parser input, exact line-ending diff behavior and bounded large-revision diff fallback.

The web suite also renders the structured editor server-side to verify that known controls, diagnostics and opaque-syntax warnings are part of the actual React surface.

## Follow-on

- **Wave 2y:** consume a specific immutable revision through an explicit validation/plan/confirmation `ollama create` workflow with post-deploy verification and audit.
- **Wave 2z:** add persisted lineage/provenance and evidence-backed upstream source links, including Hugging Face documentation where a source relationship can actually be established. Lineage remains distinct from local revision history.
