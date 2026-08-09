# Wave 2w — persistent Modelfile library and immutable revisions

Wave 2w turns Modelfiles into first-class local application objects without granting the browser or the application any new Ollama model-mutation authority.

## Canonical source and identity

A local Modelfile has a stable artifact identity and a pointer to its current immutable revision. The canonical content of a revision is the exact persisted raw Modelfile text. Comments, directive order, whitespace and line endings are preserved; the application does not reconstruct or normalize the source through a parser in this wave.

Each revision records a SHA-256 hash over the exact persisted UTF-8 text. The repository verifies the supplied hash before persistence. Revision rows are append-only: database triggers reject UPDATE and DELETE operations.

Revision history and model lineage are intentionally separate concepts. A revision describes how a local artifact changed over time; it does not prove that one model is derived from another.

## Atomic revision advancement

Creating an artifact with revision 1 and appending later revisions use `BEGIN IMMEDIATE` transactions.

For a new revision, the caller must supply the exact current revision ID it edited. The repository checks that identity inside the transaction, creates only revision N+1 with the current revision as its parent, and advances the artifact's current pointer with a compare-and-set update. A stale base fails closed and leaves no partial revision behind.

Database integrity also requires the current revision to belong to the artifact and requires each non-initial revision to point to the immediately preceding revision of the same artifact.

## Installed-model import trust boundary

An import request contains only:

- the selected persisted target ID;
- the installed model identifier to import;
- optional local display name and description.

The browser cannot provide or override the imported digest, generated Modelfile, source kind or observed target evidence.

The server reuses Wave 2v. It resolves the persisted target, host and encrypted SSH credential, re-inspects the persisted selected container, performs the fresh `/api/tags` membership check and then the dedicated fixed `/api/show` request through pinned SSH forwarding. Only the server-observed canonical model identifier, digest, target ID and generated Modelfile are persisted as revision-1 import evidence.

Import evidence is a historical snapshot rather than a foreign-key dependency on the remote model. Removing, rebinding or updating the remote model later cannot rewrite an existing imported revision.

A generated `FROM` path pointing at an Ollama blob remains only local artifact syntax. Wave 2w does not infer Hugging Face or other upstream lineage from it.

## API boundary

Authenticated read routes support artifact lists, the current artifact, revision history and a specific historical revision. List/history responses omit raw Modelfile bodies unless the caller explicitly requests the artifact or revision content.

Creating a local artifact, appending a revision and importing an installed model are CSRF-protected mutations. Audit records contain identities, hashes and import evidence needed for traceability but never duplicate the raw Modelfile source.

## SPA behavior

The Models workspace now contains a Local Modelfiles area with:

- raw creation of revision 1;
- explicit import of an installed model;
- current raw source editing where Save means creating a new immutable revision;
- visible base revision/hash for optimistic concurrency;
- read-only import evidence;
- immutable revision history and exact historical source preview.

A revision conflict refreshes the server's current revision while preserving the user's unsaved draft in the editor so it can be compared before retrying. Canonical Modelfile content is not stored in localStorage or sessionStorage.

## Security and integrity gates

Wave 2w tests cover migration idempotency, foreign-key and revision-parent integrity, deterministic hashes, lossless raw source, append-only revisions, stale-base rollback, CSRF/auth boundaries, audit redaction and a real OpenSSH installed-model import path. The import test deliberately submits forged browser-side digest/raw/provenance fields and verifies that only server-observed Ollama data is persisted.

The production-container, full product-test, compatibility/foundation and dependency-audit workflows must remain green before merge.

## Follow-on

- **Wave 2x:** synchronized raw + structured Modelfile editor, parser/validation and revision diff while keeping raw source canonical.
- **Wave 2y:** explicit plan/confirmation model creation or deployment with post-deploy verification.
- **Wave 2z:** persisted lineage/provenance graph and evidence-backed source links such as Hugging Face or upstream model documentation. Lineage must remain visibly distinct from revision history.
