# Architecture

Status: Wave 0 foundation. The approved product contract lives in [`SPEC.md`](SPEC.md). This document describes architectural boundaries; implementation choices are recorded in ADRs.

## 1. Architectural objective

Keep three external concerns separate:

1. **SSH transport** — authentication, host-key verification, exec, forwarding, PTY and file transfer.
2. **Docker runtime** — discovery, inspect/status/logs, lifecycle, update and rollback.
3. **Ollama runtime** — structured model/runtime operations through a tunneled API plus CLI fallback.

The UI talks only to the application API and never directly to SSH, Docker or Ollama.

## 2. Major components

```text
Web UI
  |
  v
Application API
  |- Identity / Session
  |- Host Registry
  |- Target Registry
  |- Model Application Services
  |- Modelfile Application Services
  |- Provenance / Source Services
  |- Job Engine
  |- Audit Service
  |- Update / Rollback Orchestrator
  |- Expert Session Service
  |
  +--> ports/interfaces
        |- SSHTransport
        |- DockerRuntime
        |- OllamaRuntime
        |- SecretCipher
        |- Persistence
        `- ExternalMetadataProvider
```

Infrastructure adapters implement the ports. Domain/application services must not import concrete SSH, Docker or HTTP client libraries.

## 3. Domain boundaries

### Identity

Owns users, sessions, authentication, reauthentication and roles.

### Hosts and trust

Owns SSH endpoints, encrypted credentials, pinned host keys and connectivity state.

### Ollama targets

Represents the operational boundary. A host may contain many targets. Locks, jobs, container binding and runtime capabilities attach to a target rather than directly to a host.

### Models

Represents runtime model state discovered from Ollama. Runtime models are not the source-of-truth for Modelfile editing history.

### Modelfiles

Owns editable source artifacts, canonical raw source, parsed representation, immutable revisions, validation and deployments.

### Provenance

Owns lineage nodes/edges and external source references. Provenance differentiates explicit, source-backed and inferred relationships.

### Jobs

Owns queued/running/cancelling/terminal state, target mutation locks, persistent event sequences, cancellation and restart reconciliation.

### Audit

Owns append-oriented administrative history and sensitive terminal transcripts with retention rules.

### Updates

Owns preflight snapshots, candidate deployment, health verification and automatic/manual rollback.

## 4. Dependency direction

```text
UI -> Application API -> Application Services -> Domain
                                      |
                                      v
                               Port interfaces
                                      ^
                                      |
                              Infrastructure
```

Forbidden dependency examples:

- model domain code importing an SSH client;
- UI code assembling shell commands;
- Docker adapter writing audit rows directly;
- Ollama adapter deciding authorization;
- external Hugging Face metadata becoming required for local model operations.

## 5. Remote operation model

Normal structured operations are typed application commands. Example:

```text
PullModel(targetId, modelName)
DeployModelfile(targetId, revisionId, targetModelName)
RestartContainer(targetId)
```

Adapters may internally translate these into SSH exec, Docker CLI or tunneled Ollama HTTP requests.

Free-form shell input exists only inside an explicitly created Expert Session.

## 6. SSH tunnel model

Structured Ollama API access is established through an SSH connection using local/internal forwarding owned by the server process. The tunnel must never listen on a publicly reachable interface.

Connection lifecycle is bounded to an operation or managed target session and is observable for diagnostics.

## 7. Persistence model

SQLite is the MVP persistence engine. The application owns explicit versioned migrations and enables foreign keys and WAL where appropriate.

Persistence interfaces isolate application services from SQL details. Multi-host support is designed into IDs/relations from the first migration even though only one active target is exposed by the MVP UI.

## 8. Streaming model

- **SSE**: reconnectable structured job/log/progress events where communication is predominantly server -> browser.
- **WebSocket**: bidirectional Expert Mode terminal sessions.
- Persistent `job_events.sequence` enables replay/reconnect.

Browser disconnection never implies job cancellation.

## 9. Modelfile representation

The canonical persisted representation is raw source. A parser derives a representation/AST for structured editing, validation and semantic diff.

Unknown valid directives, comments and ordering must not be silently lost by structured editing. A parser upgrade can enrich understanding without rewriting immutable historic revisions.

## 10. Provenance model

A graph is preferred over a simple parent column because a model may be a merge, combine adapters, be quantized from another artifact or be deployed from a Modelfile revision.

Lineage edges record relation plus evidence origin. External metadata enriches but never owns local truth.

## 11. Security boundaries

- browser cannot access SSH private keys;
- master encryption key is external to SQLite;
- host keys are pinned after explicit first-use confirmation;
- normal operations have no arbitrary shell surface;
- remote SSH identity is dedicated and minimally privileged;
- Expert Mode requires reauthentication and expires after inactivity;
- terminal transcripts are sensitive data;
- AI remains advisory and cannot call administrative actions.

## 12. Failure model

External failures are mapped into stable application error classes. Raw adapter errors may be retained for diagnostics but are not the public domain contract.

Cancellation is verified best effort. If remote termination cannot be proven, the state is an explicit failure such as `CANCEL_UNVERIFIED` rather than a false success.

## 13. Update safety

Updates are transactions at the orchestration level:

```text
preflight snapshot
 -> pull candidate
 -> preserve current rollback candidate
 -> start candidate
 -> health verification
 -> promote OR automatic rollback
```

Model data volume backup is not implied by container rollback.

## 14. Technology-selection constraints

The implementation platform must provide mature support for:

- SSH private-key auth, fingerprint inspection, exec, forwarding and PTY;
- SSE and WebSocket;
- SQLite with explicit migrations;
- authenticated encryption;
- Docker deployment;
- browser terminal integration;
- automated unit/integration/E2E testing.

See ADR-0003 for the initial proposed stack.
