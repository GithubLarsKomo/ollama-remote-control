# Beta release-candidate scenarios

The 0.1-beta release-candidate scenario runner (`scripts/beta-rc-scenarios.mjs`) groups existing real product/integration tests into bounded release scenarios. It does not create new product authority and it does not copy test output into release evidence.

The scenario buckets cover:

- identity, login, SSH onboarding, target discovery and status;
- Ollama health, inventory, fixed administrative smoke test and unload;
- model pull, event reconnect and restart reconciliation without unsafe pull replay;
- Modelfile lifecycle, validation, create/replace, create reconciliation and lineage/source reads;
- container logs/lifecycle, audit and persistent target-mutation conflict;
- update and manual-rollback restart reconciliation;
- browser/client reconnect and operator-surface contracts for pull, create/replace, logs, onboarding, audit and raw Modelfile import.

Each command is executed without a shell. A nonzero exit code, signal/missing exit status, invalid scenario definition or evidence-write failure is fail-closed. The runner executes every bucket so one candidate run can expose more than one failing release area.

The output uses the bounded `beta-rc-evidence` schema and contains only the exact tested Git commit SHA plus scenario IDs and `passed`/`failed` states. Raw stdout/stderr, credentials, remote command output, Modelfile source, prompts and model output are not copied into the artifact.

This file defines the runner contract only. The release-candidate workflow must execute the runner while the disposable SSH/Docker/Ollama fixtures are active before #123 can be considered complete.
