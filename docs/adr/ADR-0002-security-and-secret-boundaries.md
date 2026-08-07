# ADR-0002 — Security and secret boundaries

- **State:** accepted
- **Date:** 2026-08-08
- **Authority:** approved product SPEC

## Question

What trust and privilege boundaries are mandatory for SSH credentials, host identity, remote privilege and Expert Mode?

## Decision

The MVP uses these invariants:

1. SSH private-key authentication only.
2. First connection displays the server host-key fingerprint for explicit administrator confirmation; subsequent connections are strictly pinned.
3. SSH private keys are encrypted persistently.
4. The encryption master key is injected externally and is never stored in the same SQLite database.
5. A dedicated remote SSH identity with minimal `sudo` allowlist is preferred over root login or broad Docker-group membership.
6. Structured actions expose typed operations, not generic shell strings.
7. Free-form SSH/container shell access exists only in Expert Mode.
8. Expert Mode requires administrator reauthentication, warning confirmation and a 15-minute inactivity timeout.
9. Expert terminal transcripts are persisted as sensitive audit data with best-effort redaction.
10. Future AI assistance remains advisory and cannot execute administrative actions.

## Alternatives considered

- Store SSH keys unencrypted: rejected.
- Store encryption key beside ciphertext in SQLite: rejected.
- Disable SSH host-key validation: rejected.
- Use root SSH directly: rejected as default.
- Put remote user in Docker group: rejected as default because it is effectively root-equivalent.
- Allow generic command execution from normal API routes: rejected.

## Consequences

- Host-key replacement requires an explicit recovery flow.
- Secret-cipher implementation is security-critical and receives dedicated unit tests.
- Remote installation documentation must include the minimal sudo policy.
- Transcript access and retention need explicit authorization and deletion rules.

## Risks

- Secret-redaction cannot guarantee removal of every sensitive value from an interactive terminal transcript.
- A lost external master key makes encrypted credentials unrecoverable.

## Mitigation / exit path

- Warn before Expert Mode and discourage entering secrets interactively.
- Document master-key backup/rotation procedures.
- Keep cipher format versioned so future key rotation/algorithm migration is possible.

## Links

- `docs/SPEC.md`
- `docs/ARCHITECTURE.md`
