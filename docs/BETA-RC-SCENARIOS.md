# Beta release-candidate scenarios

The 0.1-beta release-candidate scenario runner (`scripts/beta-rc-scenarios.mjs`) groups existing real product/integration tests into bounded release scenarios. It does not create new product authority and it does not copy test output into release evidence.

The scenario buckets cover:

- identity, login, SSH onboarding, target discovery and status;
- Ollama health, inventory, fixed administrative smoke test and unload;
- model pull, event reconnect and restart reconciliation without unsafe pull replay;
- Modelfile lifecycle, validation, create/replace, create reconciliation and lineage/source reads;
- container logs/lifecycle, audit and persistent target-mutation conflict;
- update and manual-rollback restart reconciliation;
- application-state backup/restore, including restored durable SQLite evidence and the requirement that encrypted SSH credentials remain bound to the separately escrowed original master key;
- browser/client reconnect and operator-surface contracts for pull, create/replace, logs, onboarding, audit and raw Modelfile import.

Each command is executed without a shell. A nonzero exit code, signal/missing exit status, invalid scenario definition or evidence-write failure is fail-closed. The runner executes every bucket so one candidate run can expose more than one failing release area.

The output uses the bounded `beta-rc-evidence` schema and contains only the exact tested Git commit SHA plus scenario IDs and `passed`/`failed` states. Raw stdout/stderr, credentials, remote command output, Modelfile source, prompts, backup contents, private keys, master keys and model output are not copied into the artifact.

## Release-candidate wiring

`foundation-spike` executes the scenario runner while its disposable SSH/Docker/Ollama fixture is still active and uploads `beta-rc-scenarios-<tested-sha>` with 30-day retention. The artifact contains only `beta-rc-scenarios.json` in the bounded schema above.

`beta-release-candidate` first binds itself to the successful `foundation-spike` run selected for the same source SHA. It then requires the non-expired artifact whose name contains its own exact tested merge/ref SHA, downloads it, and fails closed unless the JSON has:

- schema version 1;
- the exact tested SHA;
- overall status `passed`;
- exactly the eight approved scenario IDs, each exactly once and each `passed`.

A missing, expired, malformed, SHA-mismatched, incomplete or failed scenario artifact prevents release-candidate acceptance. The final bounded release evidence records `rc-scenarios=passed` only after this verification succeeds.

The joined-path integration test additionally carries one persistent SQLite state through onboarding, pull reconnect/restart reconciliation, immutable Modelfile creation, confirmed model create/verification, audit inspection and a second application restart. This complements rather than replaces the scenario buckets.

The `application-state-backup-restore` bucket is intentionally separate from remote Ollama model storage. It proves management-application state recovery only; remote model/data volumes remain outside this backup claim.