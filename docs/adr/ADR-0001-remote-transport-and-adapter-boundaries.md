# ADR-0001 — Remote transport and adapter boundaries

- **State:** accepted
- **Date:** 2026-08-08
- **Authority:** approved product SPEC

## Question

How should the control application reach and manage remote Ollama installations without exposing Ollama or Docker publicly and without coupling domain logic to CLI output?

## Facts and constraints

- The approved product requires SSH private-key access to a remote Linux host.
- Ollama runs in Docker.
- Ollama does not need to be publicly exposed.
- Structured streaming model operations are required.
- Expert SSH and container terminals are required.
- Multi-host/multi-container readiness is required although the MVP exposes one active target.

## Alternatives

### A. CLI-only through SSH + docker exec

Pros: single transport path, simple network model.  
Cons: fragile parsing for structured state, harder progress streaming, larger dependency on CLI output stability.

### B. Direct Ollama HTTP API plus separate SSH administration

Pros: structured Ollama data.  
Cons: requires exposing or separately networking Ollama, violating the preferred trust boundary.

### C. SSH transport + tunneled Ollama API + CLI fallback

Pros: preserves SSH as the only required remote network path, keeps Ollama private, uses structured API where useful and retains CLI for diagnostics/unsupported operations.  
Cons: requires SSH forwarding lifecycle management and two Ollama execution paths.

## Decision

Choose **C**.

Define explicit application ports for `SSHTransport`, `DockerRuntime` and `OllamaRuntime`. Structured Ollama operations prefer the HTTP API through an application-managed SSH tunnel. Docker administration runs remotely over SSH. `docker exec ... ollama ...` remains fallback/diagnostic execution. Free-form shell input exists only in Expert Mode.

## Consequences

- The browser never talks directly to SSH, Docker or Ollama.
- Ollama may remain bound to loopback/internal networking.
- Adapter contract tests are required for both API and CLI fallback behavior.
- Stable domain error mapping must hide transport-specific errors from higher layers.

## Risks

- Tunnel lifecycle leaks could consume resources.
- API and CLI paths may diverge in behavior across Ollama versions.

## Mitigation / exit path

Keep both paths behind `OllamaRuntime`; either path can later be replaced or disabled without changing domain/application contracts.

## Links

- `docs/SPEC.md`
- `docs/ARCHITECTURE.md`
