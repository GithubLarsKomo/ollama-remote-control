# ADR-0003 — Initial technology stack

- **State:** accepted
- **Date:** 2026-08-08
- **Accepted:** 2026-08-08
- **Decision owner/approver:** product owner

## Question

Which implementation stack best satisfies the approved requirements for SSH exec/forwarding/PTY, SSE/WebSocket, SQLite, browser terminal support, Docker packaging and strong testability while keeping infrastructure concerns replaceable?

## Evidence checked

- Node.js 24 is an active LTS line in August 2026.
- The `ssh2` Node library exposes private-key authentication, exec, port forwarding and pseudo-terminal/shell capabilities required by the SPEC.
- xterm.js remains an actively maintained browser terminal component and is used by established developer tools.
- Node 24 `node:sqlite` is only release-candidate stability, so the initial production persistence path should not depend on it yet.
- `better-sqlite3` is actively maintained and supports currently supported Node.js lines.
- React and Vite provide a straightforward SPA/tooling path; the product does not need React Server Components or server-side rendering.

## Criteria

1. Mature SSH client with PTY and forwarding.
2. Straightforward SSE and WebSocket support.
3. Low ceremony for a single deployable management container.
4. Strong TypeScript contracts across UI/API/domain.
5. Explicit SQLite schema/migration control.
6. Good unit/integration/E2E ecosystem.
7. No framework requirement to expose Ollama or Docker directly.
8. Reversible choice behind domain ports/adapters.

## Alternatives

### A. End-to-end TypeScript: Node + React/Vite

Backend: Node.js LTS + Fastify.  
Frontend: React + Vite.  
SSH: `ssh2`.  
Terminal: `@xterm/xterm`.  
SQLite: `better-sqlite3` with explicit SQL migrations and thin repository adapters.  
Testing: Vitest + Playwright.

**Benefits:** one language/type system, direct fit for streaming/web terminal, mature SSH support, low deployment complexity.  
**Risks:** native SQLite addon and npm supply-chain exposure; both require explicit build/reproducibility controls.

### B. Python backend + React frontend

Backend: FastAPI/Starlette + Paramiko/AsyncSSH; frontend still React/Vite.

**Benefits:** mature server and SSH ecosystem.  
**Costs:** two-language implementation, duplicated DTO/type generation, more packaging surface.

### C. Go backend + React frontend

Backend: Go HTTP/WebSocket + `x/crypto/ssh`.

**Benefits:** compact static server binary, strong concurrency and SSH support.  
**Costs:** two-language implementation, more bespoke SSE/PTY plumbing, slower iteration for this UI-heavy application.

## Decision

Use **Alternative A**.

Initial platform target:

```text
Node.js 24 LTS
TypeScript
npm workspaces
apps/api       Fastify HTTP/SSE/WebSocket boundary
apps/web       React + Vite SPA
packages/core  domain types, invariants, ports and application contracts
packages/db    explicit SQLite repositories/migrations
packages/ssh   ssh2 adapter
packages/ollama Ollama API/CLI adapter
packages/docker remote Docker adapter
```

Persistence initially uses `better-sqlite3` rather than `node:sqlite`. Migrations remain explicit SQL under application control; an ORM is not required for the first vertical slice.

Use `@xterm/xterm` only in the web Expert Mode; terminal data is transported over a dedicated WebSocket application protocol.

## Validation evidence

The Wave-0 compatibility spike is committed under `spikes/foundation/` and executed by `.github/workflows/foundation-spike.yml` on an Ubuntu 24.04 GitHub-hosted runner using Node `v24.19.0`.

The final reproducible run used the committed `package-lock.json` and `npm ci` and passed all required gates:

1. Fastify starts and serves a health endpoint — **passed**.
2. `ssh2` connects with a generated private key to a disposable OpenSSH server — **passed**.
3. SSH host-key fingerprint is observed, recorded and verified on a pinned reconnect — **passed**.
4. SSH `exec` captures stdout, stderr and a non-zero exit code separately — **passed**.
5. SSH local forwarding reaches a mocked Ollama `/api/version` endpoint — **passed**.
6. SSH PTY shell exchanges input/output — **passed**.
7. SSE reconnect resumes from `Last-Event-ID` — **passed**.
8. WebSocket duplex transport works for the terminal boundary — **passed**.
9. `better-sqlite3` opens a file database, enables WAL and foreign keys and applies an explicit migration — **passed**.
10. A multi-stage Node 24 Docker image with native SQLite dependency builds successfully — **passed**.

The dependency lockfile is committed. The CI workflow is read-only and uses `npm ci`; the Docker build uses the same lockfile and `npm ci --omit=dev`.

## Security note

Dependencies should remain deliberately small, lockfiles are committed, CI uses clean installs and dependency/security review belongs in Wave 0 and Wave 7. Native dependency build tooling exists only in the Docker build stage and is not carried into the runtime stage.

## Rollback / exit path

The architecture isolates HTTP, SSH and database implementations behind ports. A backend framework, SSH library or SQLite driver can be replaced without changing approved product behavior or persisted domain semantics, subject to migration compatibility.

## Links

- `docs/SPEC.md`
- `docs/ARCHITECTURE.md`
- `spikes/foundation/run.mjs`
- `.github/workflows/foundation-spike.yml`
- ADR-0001
- ADR-0002
