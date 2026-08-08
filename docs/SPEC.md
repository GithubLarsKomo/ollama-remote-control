# SPEC — Ollama Remote Control

**Status:** approved  
**Version:** 0.1.0  
**Approved:** 2026-08-08  
**Project ID:** `ollama-remote-control`

## 1. Purpose

Ollama Remote Control is a standalone web application for secure administration of remote Ollama installations running in Docker on Linux hosts. It replaces recurring SSH, Docker and Ollama CLI workflows with a structured GUI without requiring public exposure of the Docker daemon or Ollama API.

The MVP supports one active host and one active Ollama container while all domain models and adapter boundaries must be multi-host and multi-container ready from the start.

The product is not a chat frontend and is not intended to replace Open WebUI. Model execution is limited to an administrative smoke test.

## 2. Product goals

The product shall:

1. connect to a Linux host through SSH private-key authentication;
2. display and pin the SSH host-key fingerprint during onboarding;
3. automatically discover Ollama Docker containers and allow manual override;
4. show Docker inspect/status information and stream logs;
5. start, stop and restart the selected container;
6. show Ollama version, relevant environment and runtime state;
7. show installed and loaded models;
8. pull, inspect, unload, delete and create models;
9. manage Modelfiles as persistent versioned GUI artifacts;
10. display model lineage, inheritance/provenance and source documentation links;
11. provide pull/create/generation/log streaming and reconnectable persistent jobs;
12. implement verified best-effort cancellation;
13. update the Ollama container with preflight, health verification and rollback;
14. show GPU, VRAM, disk and model-storage information;
15. persist an auditable history of administrative and model lifecycle events;
16. provide a separately gated Expert Mode with SSH and `docker exec` terminals.

## 3. MVP non-goals

The MVP excludes:

- full chat functionality;
- Open WebUI replacement;
- public Ollama API proxying;
- generic Docker administration;
- Kubernetes;
- generic server administration;
- SSH password authentication;
- SSH agent forwarding;
- jump hosts/bastions;
- OIDC/OAuth;
- full multi-user role administration;
- autonomous AI administration;
- cloud-LLM dependency;
- generic Docker Compose management.

Compose metadata may be detected and used internally for safe Ollama updates without becoming a generic Compose manager.

## 4. System context

```text
Browser
  |
  | HTTPS
  v
Ollama Remote Control
  |- Authentication
  |- Host Registry
  |- Secret Store
  |- Job Engine
  |- Audit Store
  |- SSH Transport
  |- Docker Adapter
  |- Ollama Adapter
  |- Modelfile / Provenance Services
  |
  | SSH
  v
Remote Linux Host
  |- Docker
  |   `- Ollama Container
  `- nvidia-smi / system utilities
```

The browser never talks directly to SSH, Docker or Ollama. All remote access is server-side.

## 5. Architecture principles

### 5.1 Adapter separation

The following responsibilities remain separate:

```text
SSHTransport
DockerAdapter
OllamaAdapter
JobEngine
AuditService
SecretStore
ModelfileService
ProvenanceService
```

The Ollama adapter must not depend directly on a concrete UI component or SSH library. The Docker adapter must not depend on presentation logic.

### 5.2 Hybrid Ollama access

SSH is the only required network transport to the target host.

Structured Ollama operations should use the Ollama HTTP API through an application-managed SSH tunnel. CLI access through `docker exec <container> ollama ...` remains the fallback and diagnostic path.

The application must not require port `11434` to be publicly reachable.

### 5.3 No Docker socket mount

The management application must not require `/var/run/docker.sock` to be mounted into its own container. Docker operations run remotely over SSH.

## 6. Deployment

Ollama Remote Control runs as its own Docker container on a management/app server.

```text
ollama-remote-control
  |- application
  |- persistent /data volume
  `- external master-key secret
```

Required network paths:

```text
Browser -> Control App : HTTPS
Control App -> target hosts : SSH/TCP 22
```

A direct browser-to-Ollama path is neither required nor desired.

## 7. Application authentication

The MVP has one local administrator account. The data model must include a role field for later extension.

Requirements:

- modern password hashing, preferably Argon2id;
- server-side sessions;
- `HttpOnly`, `Secure`, `SameSite=Lax` or stricter session cookies;
- CSRF protection on mutating requests;
- login rate limiting;
- no credentials in logs.

## 8. SSH onboarding and trust

A host profile contains at least:

```text
id
display_name
hostname
port
username
encrypted_private_key
host_key_fingerprint
created_at
updated_at
enabled
```

Onboarding flow:

```text
Add host
 -> enter host/port/user/private key
 -> connect
 -> display presented host-key fingerprint
 -> explicit administrator confirmation
 -> pin fingerprint
 -> reconnect using strict verification
 -> store host
```

A changed host key must produce `SSH_HOST_KEY_MISMATCH` and block administrative actions until reviewed explicitly.

## 9. Secret management

SSH private keys are encrypted at rest. The encryption master key must not live in the same SQLite database. It is injected externally, preferably through a read-only Docker secret/file.

Use authenticated encryption such as XChaCha20-Poly1305 or AES-256-GCM. The concrete library is an ADR decision.

Encrypted records contain at least:

```text
ciphertext
nonce
key_version
algorithm
created_at
```

Private keys must never be returned to the browser, logged, written into audit payloads or passed as command-line arguments.

## 10. Remote privilege model

Use a dedicated SSH user with a minimal `sudo` allowlist for the required Docker/system operations. Do not require direct root login. Avoid defaulting to membership in the `docker` group because that is effectively root-equivalent.

Free-form commands are permitted only in the separately gated Expert Mode.

## 11. Ollama target discovery

The Docker adapter discovers candidate Ollama containers using available evidence such as image reference, command/entrypoint, port 11434, labels, mounts and running processes. Ambiguous discovery must be shown to the administrator. Manual container selection/override is mandatory.

Domain relation:

```text
Host
  `- 0..n OllamaTarget
       `- selected ContainerBinding
```

The MVP exposes one active target but the schema supports many.

## 12. Ollama endpoint resolution

The Ollama adapter attempts a structured endpoint without public exposure, using an SSH tunnel to a loopback/internal endpoint. Resolution may consider host-local published port, container-internal address or explicit internal endpoint. If API access is unavailable, relevant operations may fall back to `docker exec ... ollama ...`.

The application must never create a tunnel listening on a publicly reachable local interface.

# 13. Model management

## 13.1 Installed models

Show at least:

```text
name
digest
size
modified
family
parameter size
quantization
```

## 13.2 Loaded models

Show at least:

```text
model
VRAM usage
context length
expiration
digest
```

## 13.3 Model details

Model details show the available Modelfile/configuration, parameters, template, system prompt, architecture, quantization and license metadata where available.

## 13.4 Pull

Pull runs as a persistent job with live progress. Show status, layer/digest, downloaded/total bytes, percentage and elapsed time where available.

## 13.5 Delete

Deletion requires explicit confirmation containing model name, size, host and target/container.

## 13.6 Stop/unload

Loaded models can be unloaded. CLI fallback is acceptable where required.

## 13.7 Smoke test

A compact administrative smoke-test UI allows model selection, one prompt and streamed output. Persist no chat history. Show timing/token metrics where available.

# 14. Modelfile management

## 14.1 First-class artifact

A Modelfile is a persistent first-class artifact independent from an already deployed Ollama model. It is not merely a transient create form.

The application must support:

```text
Create
Edit
Save
Version
Validate
Diff
Clone
Import
Export
Deploy
Redeploy
Audit
```

Conceptually:

```text
Modelfile
  |- revision 1
  |- revision 2
  `- revision 3
       `- deployment -> OllamaTarget -> model
```

## 14.2 Modelfile library

Main navigation includes `Modelfiles`.

List columns include:

```text
name
target model name
FROM/base model
current revision
validation state
last changed
last deployed
deployment target
actions
```

Actions include Edit, Clone, Validate, Diff, Deploy/Create, Export and Delete.

## 14.3 Creation/import paths

A Modelfile can be created as:

- blank;
- from an installed model;
- clone of another Modelfile;
- pasted/imported raw Modelfile.

Importing from an installed model must create a new local draft artifact and never modify the installed model implicitly.

## 14.4 Dual editor

Provide synchronized modes:

```text
[ Structured ] [ Raw Modelfile ]
```

Structured mode supports at least known instructions such as `FROM`, `PARAMETER`, `TEMPLATE`, `SYSTEM`, `ADAPTER`, `LICENSE`, `MESSAGE` and `REQUIRES` where supported by the managed Ollama version.

Known parameter fields may use typed controls, but arbitrary `PARAMETER <name> <value>` entries must remain possible.

Raw mode is the canonical lossless representation and provides at least monospace editing, line numbers, syntax highlighting, search, undo/redo, dirty-state and validation markers.

Unknown/future valid directives and comments must survive a Structured -> Raw -> Structured round trip. Structured editing must never silently discard raw content it does not understand.

## 14.5 Parser/AST

Persist raw source and derive an internal representation for known instructions, comments, ordering, multiline blocks and unknown instructions. The AST powers structured editing, validation and semantic diff; raw source remains authoritative.

## 14.6 Validation

Distinguish:

```text
syntax validation
semantic/preflight validation
Ollama create validation
```

Local validation checks at least presence of `FROM`, parseability, multiline closure, basic parameter plausibility, target model naming and parseability of relevant constraints. Final compatibility is decided by target Ollama during creation.

## 14.7 Immutable revisions

Every content change creates an immutable revision containing at least:

```text
id
modelfile_id
revision_number
content
content_sha256
parsed_metadata
created_at
created_by
validation_status
```

Older revisions can be viewed, diffed, cloned as a new revision and redeployed.

## 14.8 Diff

Provide textual unified diff and, where possible, semantic differences for known directives/parameters.

## 14.9 Deployment/create model

Deployment workflow:

```text
revision
 -> validate
 -> select target
 -> choose target model name
 -> preview
 -> persistent create job
 -> streaming progress
 -> verify model exists
 -> record deployment
```

For structured capabilities the Ollama API may be used. For complete raw Modelfile fidelity the application must support a CLI path that creates a temporary Modelfile remotely and executes `ollama create ... -f ...` through the managed container path. Temporary files must be cleaned up after success, failure and cancellation on a best-effort basis.

## 14.10 Editing an installed model

Installed models are never silently edited in place. The application derives/imports a local Modelfile artifact, edits it as revisions, then creates/rebuilds a model explicitly. Reusing an existing target model name requires an explicit collision/replace confirmation.

## 14.11 Draft/deployment state

Distinguish at least:

```text
Draft
Validated
Deployed
Modified since deployment
Deployment failed
```

The UI shows which revision produced the currently known deployed model.

## 14.12 Import/export

Import supports pasted text, uploaded Modelfile and derivation from an installed model. Export supports raw copy and a normal Ollama-compatible Modelfile without proprietary metadata.

## 14.13 Persistence

Add:

```text
modelfiles
modelfile_revisions
modelfile_deployments
```

A deployment references revision, target, target model name, job, status, resulting digest and deployment time.

# 15. Model provenance, inheritance and sources

## 15.1 Separate revision history from model lineage

The application distinguishes:

```text
Modelfile revision history
```

from:

```text
Model lineage / provenance / inheritance
```

They may reference one another but are not the same concept.

## 15.2 Visible lineage graph

Every model detail view provides a clickable directed lineage graph. It can contain foundation/upstream models, quantized variants, fine-tunes, adapters, merges, local Ollama models, Modelfiles, Modelfile revisions and deployments.

Example:

```text
Upstream foundation model
  -> quantized model
  -> imported/local Ollama model
  -> Modelfile revision
  -> deployed custom model
```

## 15.3 Relationship types

Support at least:

```text
base_model
quantized_from
finetuned_from
adapter_on
merge_of
imported_from
created_from_modelfile
derived_from
deployed_as
unknown
```

Multiple parents are permitted.

## 15.4 Provenance sources and confidence

Provenance may come from:

1. explicit administrator-confirmed data;
2. local Modelfile instructions such as `FROM` and `ADAPTER`;
3. Ollama metadata;
4. external repository metadata such as Hugging Face model-card metadata;
5. inference/heuristics.

Every edge records its origin and may record confidence. Inferred relationships must be visually distinguished from confirmed or source-backed relationships. The system must show `unknown` rather than invent lineage.

## 15.5 Source/documentation links

A model/Modelfile can have many sources:

```text
Hugging Face repository/model card
Ollama model page
GitHub repository
vendor/original model page
documentation
paper
license
dataset
arbitrary reference URL
```

A source record contains at least:

```text
id
model_id or modelfile_id
type
provider
label
url
is_primary
origin
verified_at
```

Hugging Face repositories should expose convenient navigation to the repository/model card/files when an explicit or reliably identified repository ID is available. Users can add or correct links manually.

External source availability must never block local administration.

## 15.6 Model details UI

Model detail tabs:

```text
Overview
Modelfile
Lineage
Sources
Runtime
Deployments
```

The Modelfile editor must also surface the visible base-model lineage near `FROM`, and adapter lineage near `ADAPTER`.

## 15.7 Provenance persistence

Add:

```text
model_sources
model_lineage_nodes
model_lineage_edges
```

A lineage node may represent an external model, Ollama model, Modelfile, Modelfile revision, adapter or local artifact.

A lineage edge stores at least parent, child, relationship, origin, confidence and creation timestamp.

## 15.8 External metadata privacy

External metadata lookups may use a public repository identifier explicitly associated with the model. Never send SSH credentials, local paths, private model names, internal host names, terminal contents or other private operational data to an external source.

# 16. Docker functions

The MVP supports discovery, inspect, status, live logs, start, stop, restart, update and rollback. It is not a general Docker manager.

Log streams must be closeable, must not continue indefinitely after navigation/disconnect, and should preserve stdout/stderr distinction where technically possible. Full logs are not persisted by default.

# 17. Runtime/system information

Dashboard shows at least:

Host:

```text
SSH status
hostname
uptime
disk free
```

Docker:

```text
Docker status
container state
image
digest
started at
restart count
```

Ollama:

```text
version
container
API connectivity
model storage
OLLAMA_* environment
```

Sensitive environment values are masked.

NVIDIA capability where present:

```text
GPU model
driver
GPU utilization
VRAM total/used/free
temperature
```

Missing NVIDIA capability is a capability state, not an application failure.

# 18. Persistent job engine

Long operations are not bound to one browser/HTTP request. Each job has a persistent UUID.

States:

```text
queued
running
cancelling
succeeded
failed
cancelled
```

Primary transitions:

```text
queued -> running
queued -> cancelled
running -> succeeded|failed|cancelling
cancelling -> cancelled|failed
```

After application restart, non-terminal jobs are reconciled against remote state rather than silently disappearing.

# 19. Streaming

Use reconnectable server-to-client event streaming for structured job output, preferably Server-Sent Events. Persist job event sequence information so the browser can reconnect from a known event. Use WebSockets where bidirectional interactive communication is required, especially Expert Mode terminals.

# 20. Cancellation semantics

Cancel means active cancellation, not only browser disconnection:

```text
cancel request
 -> job=cancelling
 -> attempt to cancel remote request/process
 -> verify target/remote state
 -> cancelled or failed
```

If termination cannot be verified, do not report `cancelled`; use an explicit error such as `CANCEL_UNVERIFIED`.

# 21. Concurrency

At most one mutating operation may run concurrently per `OllamaTarget`. Read operations may run in parallel where safe. The lock belongs to the target and persistent job system, not the browser connection.

Mutations include at least pull, create, delete, model unload, container start/stop/restart, update and rollback.

# 22. Container update

Before update show current image, current digest, Ollama version, configured tag and available new digest/version. Preserve the configured tag and require explicit confirmation.

Preflight captures the current container configuration required to recreate it, including image reference/digest, environment, mounts, ports, networks, restart policy, GPU/device settings, labels and Compose metadata when present.

For standalone containers, preserve the current container/configuration as rollback candidate until candidate health succeeds. For Compose-managed Ollama, use detected Ollama service metadata internally without exposing generic Compose administration.

# 23. Health and rollback

An updated target is healthy only if at least:

```text
container state = running
Ollama API reachable
Ollama version readable
```

A tags/model-list check may be added. Failed health triggers automatic rollback.

The MVP also provides manual one-click rollback to the previous image/configuration. Rollback includes runtime/container configuration but does not claim to back up model data volumes; this limitation must be visible before update.

# 24. Expert Mode

Provide:

```text
SSH shell
container shell via docker exec
```

Entry requires:

1. administrator password re-entry;
2. explicit warning acknowledgement;
3. explicit confirmation;
4. time-limited expert session.

An idle session terminates after 15 minutes.

# 25. Terminal audit

Persist session metadata and full terminal transcript with best-effort secret redaction:

```text
user
host
container
start/end
exit reason
input/output transcript
```

Transcripts are sensitive audit data. The UI warns that automatic redaction cannot guarantee removal of every secret.

# 26. Audit and retention

Persist administrative actions, normalized technical commands (with redaction), model lifecycle events, container lifecycle events and update/rollback events.

Action fields include at least:

```text
timestamp
actor
host
target
action
parameters_redacted
result
exit_code
error_class
job_id
```

Default retention is 90 days. Audit export supports JSON and CSV.

Modelfile events include creation, edit/revision, clone/import, validation, deploy start/success/failure, export and delete. Audit references immutable revision IDs/SHA-256 rather than duplicating the full source in every event.

# 27. Persistence

Use SQLite in a persistent volume, with WAL mode, foreign keys and versioned migrations. All domain IDs are UUIDs; timestamps are stored in UTC.

Core entities:

```text
users
sessions
hosts
host_keys
ssh_credentials
ollama_targets
container_bindings
jobs
job_events
audit_events
model_events
update_snapshots
expert_sessions
terminal_transcript_chunks
modelfiles
modelfile_revisions
modelfile_deployments
model_sources
model_lineage_nodes
model_lineage_edges
```

# 28. Conceptual domain model

```text
User
 |- Session
 `- AuditEvent

Host
 |- SSHCredential
 |- HostKey
 `- OllamaTarget
      |- ContainerBinding
      |- Job -> JobEvent
      |- ModelEvent
      |- UpdateSnapshot
      |- ExpertSession -> TerminalTranscriptChunk
      |- deployed models
      `- ModelfileDeployment

Modelfile
 `- ModelfileRevision
      `- 0..n ModelfileDeployment

ModelLineageNode
 `- ModelLineageEdge -> parent/child provenance graph
```

`OllamaTarget`, not `Host`, is the operation/concurrency boundary.

# 29. Error classes

At minimum:

```text
AUTH_FAILED
SSH_CONNECT_FAILED
SSH_HOST_KEY_MISMATCH
SSH_EXEC_FAILED
SUDO_DENIED
DOCKER_UNAVAILABLE
CONTAINER_NOT_FOUND
CONTAINER_AMBIGUOUS
CONTAINER_NOT_RUNNING
OLLAMA_API_UNAVAILABLE
OLLAMA_API_ERROR
OLLAMA_CLI_ERROR
MODEL_NOT_FOUND
JOB_CONFLICT
JOB_CANCEL_FAILED
CANCEL_UNVERIFIED
UPDATE_PREFLIGHT_FAILED
UPDATE_FAILED
UPDATE_HEALTHCHECK_FAILED
ROLLBACK_FAILED
GPU_UNAVAILABLE
MODELFILE_PARSE_ERROR
MODELFILE_VALIDATION_ERROR
MODEL_SOURCE_UNAVAILABLE
INTERNAL_ERROR
```

# 30. UI structure

Main navigation:

```text
Dashboard
Hosts
Models
Modelfiles
Runtime
Container
Jobs
Audit
Expert
Settings
```

Dashboard shows host/SSH/container/Ollama state, Ollama version, GPU/VRAM, disk/model storage, installed/loaded counts, current job and last failed action.

Models table shows name, size, parameters, quantization, loaded state, VRAM, primary source and actions. Details expose Overview, Modelfile, Lineage, Sources, Runtime and Deployments.

Modelfiles provide library, dual editor, validation, revision history, diff, import/export and deployment actions.

Expert is visually separated from normal administration.

# 31. Confirmation rules

At least these operations require explicit confirmation:

```text
model deletion
container stop
container restart
update
rollback
Expert Mode entry
replace/rebuild existing model name
```

Confirmations show concrete target information instead of generic `Are you sure?` dialogs.

# 32. Internal application API

Use a versioned backend API under `/api/v1/` with typed resources for session, hosts, targets, models, Modelfiles, provenance/sources, jobs, audit and expert sessions.

No route may concatenate unchecked browser input into arbitrary shell commands.

# 33. Command safety

Normal actions are modeled as typed operations such as:

```text
pullModel(targetId, modelName)
deleteModel(targetId, modelName)
restartContainer(targetId)
deployModelfile(targetId, revisionId, targetModelName)
```

not generic `execute(command: string)` calls.

Only Expert Mode accepts free-form terminal input.

# 34. AI/ML readiness and governance

The MVP has no AI dependency and uses no model for administrative decisions.

Future AI is advisory only for:

```text
log/error analysis
VRAM/capacity recommendations
model/quantization recommendations
```

It must never autonomously execute shell commands, pulls, deletes, model creation, container changes, updates or rollback.

Permitted future advisory inputs include logs, runtime/GPU metrics, error classes/exit codes, model/quantization metadata and job outcomes. SSH keys, master keys, credentials and Expert Mode transcripts are excluded by default.

Advisory inference should run on an explicitly selected managed Ollama target and must never become a dependency for managing that target.

The MVP should collect structured operation type, model metadata, runtime snapshot, GPU state, outcome, error class, duration and cancellation/retry outcome so later offline evaluation is possible.

Ground-truth signals may include operation success/failure, OOM events, measured VRAM, generation performance, update/rollback outcomes and user acceptance/rejection of future recommendations.

Introduction path:

```text
offline evaluation -> advisory mode -> human review
```

Autonomous administrative authority is explicitly out of scope.

# 35. Security invariants

The following invariants must not be silently weakened:

```text
Ollama need not be publicly exposed.
SSH host keys are verified and pinned.
Private keys are encrypted at rest.
The encryption master key is external.
The browser never receives SSH private keys.
The browser never talks directly to Docker.
The browser never talks directly to Ollama.
Structured actions cannot contain arbitrary shell commands.
Expert Mode requires reauthentication.
AI cannot execute administrative actions.
External metadata lookup never sends private operational context.
```

# 36. Recovery

After app restart retain host configuration, encrypted credentials, pinned host keys, targets, jobs/history/events, audit, model lifecycle, Modelfiles/revisions/deployments, lineage/sources, update snapshots and Expert audit.

Interrupted browser connections do not terminate persistent jobs.

# 37. MVP acceptance criteria

The following end-to-end path must work:

```text
admin login
 -> add SSH host
 -> confirm host fingerprint
 -> successful connection test
 -> discover/select Ollama container
 -> dashboard shows Ollama/GPU/disk
 -> list models
 -> pull model with live progress
 -> reload/reconnect browser to same job
 -> model present
 -> smoke test
 -> inspect/import Modelfile
 -> edit Structured and Raw views
 -> save immutable revision
 -> validate and diff
 -> deploy as new model
 -> inspect visible lineage and source links
 -> open primary Hugging Face/model documentation link where configured
 -> unload model
 -> view container logs
 -> restart container
 -> verify Ollama health
 -> inspect audit trail
```

Also verify:

```text
pull/create cancellation with state verification
one mutation per target
host-key mismatch handling
secret encryption
Expert reauthentication
15-minute terminal idle timeout
terminal audit
model deletion confirmation
update healthcheck
automatic rollback
manual rollback
JSON/CSV audit export
restart persistence
Modelfile clone/import/export
unknown raw directive survives round-trip
comments survive round-trip
failed/cancelled create leaves revision intact
older revision can be redeployed
model-name collision confirmation
multiple provenance parents
quantization/adapter lineage
manual source correction
external source outage does not block local administration
unknown provenance remains unknown
```

# 38. Test strategy

Unit tests cover job state machine, concurrency, error mapping, secret encryption, host fingerprint handling, model validation, Modelfile parser/round-trip, revision immutability, lineage/provenance rules, audit redaction, update and rollback planning.

Adapter contract tests cover SSHTransport, DockerAdapter and OllamaAdapter using versioned fixtures.

Integration tests exercise an SSH server, Docker host and Ollama API/runtime. GPU is optional in CI.

Update tests cover successful update, failed image/startup/healthcheck, automatic rollback and manual rollback.

Browser E2E covers login, host onboarding, model operations, Modelfile editing/versioning/deployment, lineage/sources, jobs/reconnect/cancel, audit, Expert gate, update and rollback.

# 39. Engineering waves

## Wave 0 — Foundation

- product repository and approved SPEC;
- architecture and security ADRs;
- technology decision;
- CI;
- base Docker setup;
- SQLite migration framework;
- security baseline.

## Wave 1 — Identity & SSH

- admin bootstrap;
- login/session management;
- Secret Store;
- Host CRUD;
- TOFU/pinning;
- SSH exec/forwarding;
- connection diagnostics.

Vertical slice: Login -> add host -> SSH status.

## Wave 2 — Docker target discovery

- DockerAdapter;
- Ollama discovery and manual override;
- inspect/status;
- runtime capabilities;
- GPU/disk/environment;
- dashboard.

Vertical slice: Host -> OllamaTarget -> status dashboard.

## Wave 3 — Models, Modelfiles, lineage & sources

- Ollama API adapter and CLI fallback;
- tags/ps/show/delete/stop/smoke test;
- pull/create;
- Modelfile library;
- Raw + Structured editor;
- lossless parser/AST;
- validation;
- immutable revisions;
- diff;
- clone/import/export;
- import from installed model;
- deployment/redeployment;
- model-name collision handling;
- lineage graph;
- source/documentation links;
- optional external metadata enrichment with strict privacy boundary.

Vertical slice: Installed model -> import Modelfile -> edit -> save revision -> diff -> deploy new model -> smoke test -> inspect lineage/source.

## Wave 4 — Persistent jobs & streaming

- job state machine;
- events/SSE;
- reconnect;
- cancellation/reconciliation;
- target mutation locks.

## Wave 5 — Logs, audit & Expert Mode

- container logs;
- audit/model events;
- exports;
- SSH/docker PTY;
- re-authentication;
- timeout;
- transcript/redaction.

## Wave 6 — Update & rollback

- preflight;
- digest comparison;
- standalone and Compose-aware Ollama update;
- health verification;
- automatic and manual rollback.

## Wave 7 — Hardening & release

- security review;
- failure injection/recovery tests;
- backup/restore;
- accessibility/responsive UI;
- installation and operations documentation;
- reproducible release packaging.

# 40. Implementation freedom

The product requirements do not prescribe the frontend framework, backend framework, SSH library, ORM/query builder, CSS framework or test framework.

The chosen implementation must support at least:

```text
SSH execution and forwarding
SSH PTY
WebSocket
SSE
SQLite
AEAD encryption
Docker deployment
automated tests
```

Technology selection is recorded separately as an ADR.

# 41. Definition of Done

The MVP is done when all acceptance criteria and security invariants are tested, no known critical/high security issues remain, update/rollback is reproducible, persistent jobs survive application restart, Expert Mode is gated/audited/timed out, Ollama need not be publicly exposed, normal administration is fully deterministic without AI, deployment/recovery documentation exists, Modelfiles have the full managed lifecycle, model lineage/sources are visible and a reproducible release build can be produced.

# 42. Approved product decisions

- MVP: one host / one Ollama target; architecture multi-host/multi-container-ready.
- Deployment: dedicated management container.
- SSH: private key; explicit TOFU confirmation then strict pinning.
- Secrets: encrypted persistently; master key external.
- Web auth: local admin.
- Remote privilege: dedicated user + minimal sudo allowlist.
- Ollama transport: SSH-tunneled API first; `docker exec` CLI fallback.
- Container discovery: automatic + manual override.
- Model operations: list, running models, show, pull, delete, stop/unload, create, smoke test.
- Modelfiles: first-class, GUI-editable, lossless Raw mode, structured mode, immutable revisions, diff, import/export, deploy/redeploy.
- Provenance: visible lineage/inheritance; explicit distinction between confirmed/source-backed/inferred; multiple parents supported.
- Sources: multiple links per model/Modelfile including Hugging Face/model cards, Ollama, GitHub, vendor docs, papers, license and datasets.
- Docker: discover, inspect, logs, start, stop, restart, update, rollback.
- Expert: SSH shell + docker-exec shell; admin reauth, warning, 15-minute idle timeout, transcript with best-effort redaction.
- Persistence: SQLite.
- Audit retention: 90 days; JSON + CSV export.
- Jobs: persistent, reconnectable, verified best-effort cancellation, one concurrent mutation per target.
- Update: managed recreate, preserve configured tag, preview digest/version, explicit confirmation.
- Rollback: automatic on failed healthcheck + manual one-click rollback.
- AI: future advisory-only, never administrative authority.
