# ADR-0003 — Initial technology stack

- **State:** proposed
- **Date:** 2026-08-08
- **Decision owner/approver:** product owner

## Question

Which implementation stack best satisfies the approved requirements for SSH exec/forwarding/PTY, SSE/WebSocket, SQLite, browser terminal support, Docker packaging and strong testability while keeping infrastructure concerns replaceable?

## Evidence checked

- Node.js 24 is an active LTS line in August 2026.
- The `ssh2` Node library exposes private-key authentication, exec, port forwarding and pseudo-terminal/shell capabilities required by the SPEC.
- xterm.js remains an actively maintained browser terminal component and is used by established developer tools.
- Node 24 `node:sqlite` is only release-candidate stability, so the initial production persistence path should not depend on it yet.
- `better-sqlite3` is actively maintained and supports currently supported Node.js lines.
- React latest stable and Vite stable provide a straightforward SPA/tooling path; the product does not need React Server Components or server-side rendering.

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
**Risks:** native SQLite addon; npm supply-chain exposure; Fastify/Node-24 compatibility must be demonstrated by the foundation spike rather than assumed.

### B. Python backend + React frontend

Backend: FastAPI/Starlette + Paramiko/AsyncSSH; frontend still React/Vite.

**Benefits:** mature server and SSH ecosystem.  
**Costs:** two-language implementation, duplicated DTO/type generation, more packaging surface.

### C. Go backend + React frontend

Backend: Go HTTP/WebSocket + `x/crypto/ssh`.

**Benefits:** compact static server binary, strong concurrency and SSH support.  
**Costs:** two-language implementation, more bespoke SSE/PTY plumbing, slower iteration for this UI-heavy application.

## Proposed decision

Use **Alternative A**, subject to a Wave-0 compatibility spike.

Initial platform target:

```text
Node.js 24 LTS
TypeScript
npm workspaces
apps/api     Fastify HTTP/SSE/WebSocket boundary
apps/web     React + Vite SPA
packages/core  domain types, invariants, ports and application contracts
packages/db    explicit SQLite repositories/migrations
packages/ssh   ssh2 adapter
packages/ollama Ollama API/CLI adapter
packages/docker remote Docker adapter
```

Persistence should initially use `better-sqlite3` rather than `node:sqlite`. Migrations remain explicit SQL under application control; an ORM is not required for the first vertical slice.

Use `@xterm/xterm` only in the web Expert Mode; terminal data is transported over a dedicated WebSocket application protocol.

## Acceptance gate before changing this ADR to `accepted`

A minimal automated spike must prove on Node 24 LTS:

1. Fastify process starts and serves health endpoint.
2. `ssh2` can connect using private key to a test SSH server.
3. SSH host-key fingerprint is observable/validatable.
4. remote `exec` captures stdout/stderr/exit code.
5. local forwarding can reach a mocked Ollama HTTP endpoint.
6. PTY shell can exchange input/output.
7. SSE reconnect test works.
8. WebSocket terminal transport works.
9. `better-sqlite3` opens a file DB, enables WAL/foreign keys and runs migrations.
10. Docker image builds reproducibly on the deployment architecture.

If any critical gate fails, keep application/domain contracts and replace only the failing adapter/framework choice.

## Security note

Because the npm ecosystem is a meaningful supply-chain surface, dependencies should be deliberately small, lockfiles must be committed, CI should use clean installs, and dependency/security review belongs in Wave 0/7.

## Rollback / exit path

The architecture isolates HTTP, SSH and database implementations behind ports. A backend framework, SSH library or SQLite driver can be replaced without changing approved product behavior or persisted domain semantics (subject to migration compatibility).

## Links

- `docs/SPEC.md`
- `docs/ARCHITECTURE.md`
- ADR-0001
- ADR-0002
