# Architecture Decision Records

ADRs are immutable decision-history records.

States:

- `proposed` — evidence/review still required before irreversible implementation;
- `accepted` — authorized and active;
- `rejected` — considered but not selected;
- `superseded` — replaced by a later ADR; historical record remains;
- `deprecated` — no longer applicable but retained for history.

Accepted records are not rewritten to change the decision. A change creates a new ADR that explicitly supersedes the old record.

## Current records

- [ADR-0001 — Remote transport and adapter boundaries](ADR-0001-remote-transport-and-adapter-boundaries.md) — accepted
- [ADR-0002 — Security and secret boundaries](ADR-0002-security-and-secret-boundaries.md) — accepted
- [ADR-0003 — Initial technology stack](ADR-0003-initial-technology-stack.md) — accepted
- [ADR-0004 — Local admin password and session security](ADR-0004-local-admin-passwords-and-sessions.md) — accepted
- [ADR-0005 — SSH credential encryption and master-key source](ADR-0005-ssh-credential-encryption.md) — proposed
