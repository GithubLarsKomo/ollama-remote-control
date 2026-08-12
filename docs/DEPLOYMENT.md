# Deployment and operations

Status: 0.1-beta-candidate operator contract.

Ollama Remote Control (ORC) is packaged as one application container. Fastify serves the versioned `/api/v1/*` API and the built React/Vite SPA from the same origin. The application container does **not** require the local Docker socket and does **not** expose the managed Ollama port.

This document covers installation, normal operation, ORC application upgrades and the entry points for recovery evidence. It does not replace the detailed procedures in [`BACKUP-RESTORE.md`](BACKUP-RESTORE.md).

## 1. Prerequisites and trust boundary

The management host needs:

- Docker Engine and the Docker Compose plugin;
- persistent storage for the `orc-data` volume;
- a separately protected persistent master-key file;
- an HTTPS reverse proxy or equivalent HTTPS termination for browser access;
- outbound SSH connectivity from ORC to each managed Linux host.

Managed Linux hosts need a dedicated SSH account/private-key path appropriate for the approved remote Docker/system operations. ORC pins the presented SSH host key during onboarding. A changed fingerprint is a trust failure and must not be bypassed by replacing the stored value without operator review.

Normal topology:

```text
Browser
  -> HTTPS reverse proxy
  -> 127.0.0.1:3000
  -> ORC container
  -> SSH
  -> managed Linux host
  -> Docker / private Ollama endpoint
```

The managed host's Docker daemon and Ollama API do not need inbound public exposure. Do not mount `/var/run/docker.sock` into ORC and do not publish port 11434 merely to make administration work.

## 2. Production container security model

The default Compose deployment binds only to:

```text
127.0.0.1:3000
```

Authenticated browser access requires HTTPS because the session/CSRF cookies are `Secure`. Do not publish plain HTTP port 3000 to an untrusted network.

The production Compose/runtime contract includes:

- non-root `node` user (UID/GID 1000 in the current Node 24 Debian base image family);
- read-only root filesystem;
- `cap_drop: ALL`;
- `no-new-privileges:true`;
- PID limit;
- persistent `/data` named volume;
- bounded `noexec,nosuid,nodev` tmpfs at `/tmp`;
- loopback-only published application port by default;
- external read-only master-key secret;
- no local Docker-socket mount;
- no Ollama port publication.

The runtime image contains compiled application/package output, database migrations, the built SPA, the bounded application-data backup helper and production dependencies. Source/test trees and local secret/data files are not copied into the runtime image.

## 3. Persistent state and master key

ORC has two independent pieces of recovery material:

1. `/data`, including the SQLite database; and
2. the external 32-byte master key.

They must remain separate. The key encrypts SSH credentials and other persisted sensitive authority and is intentionally not stored in SQLite, `/data` or the image.

Prepare the default file-backed Compose secret on the deployment host:

```bash
mkdir -p secrets
tmp="$(mktemp)"
umask 077
openssl rand 32 | base64 -w0 > "$tmp"
printf '\n' >> "$tmp"
sudo install -o 1000 -g 1000 -m 0400 "$tmp" secrets/orc_master_key
rm -f "$tmp"

stat -c '%u:%g:%a %n' secrets/orc_master_key
# expected for the current image family: 1000:1000:400 secrets/orc_master_key
```

The default Compose file mounts this read-only at `/run/secrets/orc_master_key` and sets:

```text
ORC_MASTER_KEY_FILE=/run/secrets/orc_master_key
```

Set `ORC_MASTER_KEY_SECRET_FILE` before invoking Compose if the host-side secret lives elsewhere. Preserve equivalent restrictive permissions.

**Never regenerate the key when recreating or upgrading the ORC container.** A different key cannot decrypt existing encrypted records. Escrow an exact copy through the infrastructure secret-management process, separately from application-data backups.

## 4. First installation and start

From an exact reviewed repository commit:

```bash
docker compose config >/dev/null
docker compose build --pull
docker compose up -d

docker compose ps app
curl --fail http://127.0.0.1:3000/api/v1/health
```

The host-local HTTP health check is intentionally loopback-only. Browser access should go through the configured HTTPS endpoint.

On first browser use:

1. bootstrap the local administrator account;
2. sign in through HTTPS;
3. add the SSH host and credential;
4. inspect the presented SSH fingerprint and explicitly confirm it;
5. discover/select the intended Ollama container;
6. verify Dashboard/Runtime health before starting a mutation.

The `orc-data` volume contains the SQLite database under `/data`. It is the only persistent writable application filesystem location.

## 5. Normal operations and evidence

Normal administration uses typed server-owned actions rather than a generic shell/API proxy. Long-running mutations use persistent jobs and a persistent per-target mutation lock. Browser disconnect/reload does not define job success; restart reconciliation uses observed target state and does not blindly replay remote mutations.

Operator evidence is available through:

- Jobs/reconnect state for persistent operations;
- Audit history and JSON/CSV export;
- immutable Modelfile revisions and deployment evidence;
- exact-digest provenance/source evidence;
- update/rollback state and recovery records.

The 0.1-beta failure/restart expectations are summarized in [`BETA-FAILURE-RECOVERY-MATRIX.md`](BETA-FAILURE-RECOVERY-MATRIX.md).

## 6. Managed Ollama update boundary

Updating a **managed Ollama container** is different from upgrading the ORC application itself.

For 0.1 beta, executable Ollama update/rollback is supported only when ORC positively validates the target as the supported Docker Compose strategy. The workflow binds current configuration/digest, candidate digest, Compose service/container identity, health verification and rollback authority before mutation.

Standalone Ollama containers remain supported for normal non-update administration, but standalone update execution is deliberately fail-closed in the 0.1-beta scope. ORC may analyze the runtime and explain blockers; it must not partially reconstruct an unsupported standalone container.

See [`SPEC-0.1-BETA-AMENDMENT.md`](SPEC-0.1-BETA-AMENDMENT.md) for the normative scope boundary.

The managed Ollama update/rollback feature does **not** claim to back up remote Ollama model/data volumes.

## 7. Back up before an ORC application upgrade

Every ORC application upgrade requires a recoverable pre-upgrade point.

Use the complete procedure in [`BACKUP-RESTORE.md`](BACKUP-RESTORE.md). Its critical rules are:

- stop/quiesce the ORC app before backing up `/data`;
- use the bounded helper included in the tested ORC image;
- store the application-data archive/checksum separately from the master key;
- preserve the exact master-key bytes in protected external escrow;
- record the currently used ORC image/commit and the actual Docker volume mounted at `/data`;
- retain the old image and old volume/backup until post-upgrade validation succeeds.

Do not copy a live SQLite database/WAL/SHM set and call it a supported backup.

## 8. Upgrade the ORC application itself

An ORC application upgrade changes the management application/container, not the managed Ollama container.

For the current source-built deployment model:

1. confirm the candidate commit is the intended release candidate;
2. confirm its four release evidence gates are green (`foundation-spike`, `production-container`, `beta-acceptance`, `beta-release-candidate`);
3. perform and verify the pre-upgrade `/data` backup and separate key escrow;
4. move the deployment checkout to the exact intended commit;
5. review `compose.yaml`/configuration changes before applying them;
6. build and recreate the application;
7. verify application and operator state before retiring the rollback point.

Typical apply step after backup:

```bash
docker compose config >/dev/null
docker compose build --pull
docker compose up -d app

docker compose ps app
curl --fail http://127.0.0.1:3000/api/v1/health
```

Then verify through the HTTPS UI:

- administrator login succeeds;
- configured hosts/targets are present;
- at least one encrypted SSH credential works through normal target/status access;
- Ollama/container health is readable;
- immutable Modelfile/deployment/provenance evidence remains present;
- Audit/Jobs history is queryable;
- no unexpected active mutation remains after reconciliation.

Database migrations are applied by the application. Treat them as potentially forward-only unless a specific release states otherwise.

## 9. Roll back an ORC application upgrade

Do **not** assume that running an older ORC image against a database already migrated by a newer image is a supported rollback.

The safe generic rollback point is the pair recorded before upgrade:

- the previous ORC image/commit; and
- the matching pre-upgrade `/data` backup,

with the **same original external master key**.

If post-upgrade validation fails:

1. stop the application;
2. preserve the failed upgraded volume for diagnosis instead of overwriting it in place;
3. restore the recorded pre-upgrade `/data` backup into an empty intended volume using [`BACKUP-RESTORE.md`](BACKUP-RESTORE.md);
4. restore/retain the matching external master key;
5. start the previous tested ORC image/commit against that restored state;
6. verify health, login, target visibility, credential decryption and persisted evidence.

This ORC application rollback is separate from the in-product managed Ollama rollback workflow.

## 10. Recovery and restart evidence

Use these documents together instead of inventing ad-hoc recovery steps:

- [`BACKUP-RESTORE.md`](BACKUP-RESTORE.md) — durable ORC application-state recovery and key separation;
- [`BETA-FAILURE-RECOVERY-MATRIX.md`](BETA-FAILURE-RECOVERY-MATRIX.md) — fail/restart behavior for each mutating beta operation;
- [`BETA-RC-SCENARIOS.md`](BETA-RC-SCENARIOS.md) — bounded exact-SHA release-candidate scenarios;
- [`BETA-ACCEPTANCE.md`](BETA-ACCEPTANCE.md) — merge-ref acceptance and the remaining repository-rule requirement;
- [`BETA-ACCESSIBILITY-RESPONSIVE.md`](BETA-ACCESSIBILITY-RESPONSIVE.md) — bounded UI hardening evidence and residual manual checks.

The release-candidate harness proves application restart/reconnect and bounded recovery scenarios in a disposable SSH/Docker/Ollama fixture. It does not replace a real deployment backup policy.

## 11. Reverse proxy and binding override

Terminate TLS in a reverse proxy on the deployment host and forward to `http://127.0.0.1:3000`. Do not rewrite `/api/v1/*` to the SPA; Fastify owns API routing and returns genuine API 404 responses. SPA and API intentionally share one origin, so the standard deployment does not need a CORS exception.

The loopback default can be overridden explicitly:

```bash
ORC_BIND_ADDRESS=10.0.0.10 docker compose up -d
```

Only bind a trusted/private interface with an intentional firewall and HTTPS topology. Binding `0.0.0.0` merely for convenience weakens the default boundary and is not recommended.

## 12. 0.1-beta deferred authority

The amended 0.1-beta release intentionally does **not** expose:

- arbitrary SSH/container Expert Mode terminals; or
- destructive model deletion.

Those remain post-beta roadmap capabilities with their original security requirements. Their absence must not be worked around by adding generic shell execution, direct Docker access or an Ollama API proxy.

## 13. Release-candidate acceptance

For an exact candidate SHA, require all four evidence paths to be green:

```text
foundation-spike
production-container
beta-acceptance
beta-release-candidate
```

`beta-release-candidate` validates bounded exact-SHA scenario evidence produced inside the disposable integration fixture. See [`BETA-RC-SCENARIOS.md`](BETA-RC-SCENARIOS.md).

A green workflow file alone does not prove repository merge enforcement. The `main` repository rule/branch protection must separately require `beta-acceptance` and be deliberately tested with a failing candidate before public beta can claim mandatory enforcement.
