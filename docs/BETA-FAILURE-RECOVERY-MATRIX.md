# Beta failure and recovery matrix

The normative machine-readable 0.1-beta target-mutation matrix is `scripts/beta-failure-recovery-matrix.mjs`.

It enumerates every target-mutating job kind in the amended beta scope and requires explicit evidence for preflight failure, remote/transport failure, postcondition verification, cancellation semantics, application restart, target/digest races, persistent mutation locking and terminal/recovery state.

`model-delete` and `expert-mode` are explicitly excluded because the normative beta scope amendment in #111 defers them until after 0.1 beta. Their absence from the matrix must not be interpreted as implemented coverage.

The validator checks that every referenced automated test exists and that referenced RC scenario IDs are part of the bounded RC manifest. `requireComplete` fails closed if any operation is marked as a coverage gap.

The exact-SHA release-candidate harness includes `mutation-failure-recovery-matrix` as a separate bounded scenario. That scenario validates the matrix and exercises restart reconciliation for bounded synchronous mutations.

## Restart rule for bounded synchronous mutations

A process restart never replays smoke-test generation, model unload or container lifecycle commands.

- An interrupted model unload may be reconstructed as successful only when fresh remote state proves the exact confirmed digest is no longer loaded.
- An interrupted smoke test is never reconstructed as successful because the generation result was lost. A clean unloaded postcondition is recorded as an explicit interrupted failure; a residual loaded model is an explicit failure.
- Container start/stop/restart persists pre-mutation identity/state. Recovery reads the exact container. Restart additionally requires a changed `startedAt` value; merely finding a running container is insufficient proof.
- Missing metadata, changed target binding or failed remote observation terminalizes the stale job as failed so the persistent target lock cannot remain orphaned indefinitely.

No recovery path in this slice introduces a new SSH, Docker or Ollama command authority.