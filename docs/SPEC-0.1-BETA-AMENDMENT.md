# SPEC 0.1 Beta Scope Amendment

**Status:** approved beta-scope amendment  
**Applies to:** `docs/SPEC.md` version 0.1.0  
**Effective:** 2026-08-11  
**Scope:** 0.1 beta only

This document is a normative amendment to the approved Ollama Remote Control SPEC for the 0.1 beta. Where this amendment conflicts with `docs/SPEC.md`, this amendment governs the 0.1 beta acceptance scope. The deferred capabilities remain roadmap items and are not permanently removed from the product direction.

## 1. Administrative smoke test

For the 0.1 beta, SPEC §13.7 and the corresponding generation wording in §§2, 37, 39 and 42 are narrowed to a fixed administrative smoke test.

The beta smoke test:

- uses a server-owned fixed prompt;
- does not expose an operator-authored generation prompt;
- is not a chat or general generation console;
- does not persist chat history;
- does not need to return generated model text to the browser;
- may expose bounded administrative pass/fail status and timing/token metrics where available;
- must retain the existing target binding, authentication, CSRF, mutation/concurrency and audit boundaries.

This is an intentional reduction of generation surface for the beta, not an implementation gap.

## 2. Expert Mode deferred from 0.1 beta

SPEC product-goal item 16, §§24–25, the Expert navigation/confirmation requirements in §§30–31, Expert-specific acceptance items in §37, the Wave 5 terminal work in §39, the Expert-specific portions of §§35–36, 40–42 are **deferred from the 0.1 beta**.

Accordingly, the 0.1 beta does not require:

- arbitrary SSH shell input;
- arbitrary container shell / `docker exec` terminal input;
- WebSocket/PTTY terminal support;
- administrator password reauthentication for terminal entry;
- 15-minute terminal idle-session handling;
- terminal transcript persistence/redaction.

Normal administration remains restricted to typed, server-owned operations. No generic `execute(command: string)` authority is introduced by this amendment. The security invariant that structured actions cannot contain arbitrary shell commands remains mandatory.

Expert Mode remains a post-beta roadmap feature and, when implemented, must satisfy the original reauthentication, warning, confirmation, timeout and sensitive transcript requirements before release.

## 3. Destructive model deletion deferred from 0.1 beta

The delete capability in SPEC product-goal item 8, §13.5, the model-deletion confirmation requirement in §31, delete-specific acceptance items in §37, delete work in §39 and the model-operation summary in §42 are **deferred from the 0.1 beta**.

The 0.1 beta therefore does not expose model deletion authority. Installed models can still be inspected, pulled, created/redeployed under the approved create rules, smoke-tested and unloaded where implemented.

Deferral is preferable to shipping a partially verified destructive operation. A later delete implementation must still require concrete confirmation including model identity, size, host and target/container; persistent target mutation locking; fresh digest/identity preflight; post-delete verification; and audit evidence.

## 4. Acceptance interpretation

For the 0.1 beta, the end-to-end acceptance path in SPEC §37 is interpreted as follows:

- `smoke test` means the fixed server-owned administrative smoke test defined above;
- `Expert reauthentication`, `15-minute terminal idle timeout` and `terminal audit` are not beta acceptance criteria;
- `model deletion confirmation` is not a beta acceptance criterion;
- all other non-deferred acceptance criteria remain in force unless separately amended in a later approved SPEC amendment.

The beta remains **not ready** until the remaining release-candidate CI, recovery, documentation, packaging, accessibility, collision handling and other tracked release gates are satisfied.

## 5. Security rationale

The amendment intentionally avoids expanding two high-risk authority surfaces immediately before beta:

1. arbitrary remote command execution through interactive terminals;
2. destructive model deletion.

The product remains useful as a deterministic administration GUI while preserving the existing principles: pinned SSH trust, encrypted credentials, server-side typed operations, private Ollama connectivity, persistent mutation locks, auditability and explicit human confirmation for consequential supported actions.
