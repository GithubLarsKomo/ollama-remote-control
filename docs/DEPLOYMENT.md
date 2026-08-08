# Deployment

Status: Wave 2p1 deployment contract.

Ollama Remote Control is packaged as one application container. Fastify serves the versioned `/api/v1/*` API and the built React/Vite SPA from the same origin. The application container does **not** require the Docker socket and does **not** expose the managed Ollama port.

## Security model

The default Compose deployment deliberately binds only to:

```text
127.0.0.1:3000
```

The browser-facing deployment should terminate HTTPS in front of that loopback endpoint. Session and CSRF cookies are `Secure` and `SameSite=Strict`; do not publish plain HTTP port 3000 to an untrusted network.

Typical supported topologies are:

```text
Browser -> HTTPS reverse proxy on the host -> 127.0.0.1:3000 -> ORC container
```

or an SSH/private-network path with HTTPS termination before the browser reaches the application. Do not depend on plain HTTP for authenticated browser use.

Ollama Remote Control reaches managed Linux hosts through SSH. The managed host's Docker daemon and Ollama API do not need inbound public exposure.

## Master key

SSH private keys and update snapshots are encrypted with a persistent 32-byte master key that must remain outside SQLite and outside the image.

The production image runs as the official Node image's non-root `node` user (UID/GID 1000). For file-backed Compose secrets, local Docker Compose bind-mounts the source file and cannot portably enforce `uid`, `gid` or `mode` from the Compose definition. Therefore prepare the host file itself with restrictive ownership and permissions:

```bash
mkdir -p secrets
tmp="$(mktemp)"
umask 077
openssl rand 32 | base64 -w0 > "$tmp"
printf '\n' >> "$tmp"
sudo install -o 1000 -g 1000 -m 0400 "$tmp" secrets/orc_master_key
rm -f "$tmp"
```

Verify before starting:

```bash
stat -c '%u:%g:%a %n' secrets/orc_master_key
# expected: 1000:1000:400 secrets/orc_master_key
```

Do not regenerate this file on container recreation. Losing or replacing it makes existing encrypted credentials/snapshots undecryptable. Back it up through the same protected secret-management process used for other infrastructure keys.

The default `compose.yaml` mounts it read-only at `/run/secrets/orc_master_key` and configures:

```text
ORC_MASTER_KEY_FILE=/run/secrets/orc_master_key
```

To keep the secret elsewhere, set `ORC_MASTER_KEY_SECRET_FILE` to the host path before invoking Compose and retain equivalent restrictive ownership/permissions.

## Start

Build and start locally:

```bash
docker compose build --pull
docker compose up -d
```

Check container status and the unauthenticated health endpoint from the deployment host:

```bash
docker compose ps
curl --fail http://127.0.0.1:3000/api/v1/health
```

The named `orc-data` volume contains the SQLite database under `/data`. It is the only persistent writable filesystem location. The container root filesystem is read-only; `/tmp` is an ephemeral `noexec`, `nosuid`, `nodev` tmpfs.

## Runtime hardening

The Compose definition applies these defaults:

- runtime user `node` (non-root, UID/GID 1000 in the pinned base family);
- read-only root filesystem;
- `cap_drop: ALL`;
- `no-new-privileges:true`;
- PID limit;
- `/data` named volume;
- bounded tmpfs at `/tmp`;
- loopback-only published port;
- external read-only file secret for the encryption master key;
- no `/var/run/docker.sock` mount;
- no port 11434 publication.

The image contains compiled application/package output, database migration SQL, the built SPA and production dependencies. TypeScript source/tests and local secret/data files are not copied into the runtime image.

## Reverse proxy

Terminate TLS in a reverse proxy on the deployment host and forward to `http://127.0.0.1:3000`. Preserve normal HTTP upgrade semantics when Expert Mode WebSocket support is enabled later. Do not rewrite `/api/v1/*` to the SPA; Fastify owns API routing and returns genuine API 404 responses.

Because the SPA and API intentionally share one origin, no CORS exception is required for the normal deployment.

## Binding override

The loopback default can be overridden explicitly:

```bash
ORC_BIND_ADDRESS=10.0.0.10 docker compose up -d
```

Only do this on a trusted/private interface with an intentional firewall and HTTPS topology. Binding `0.0.0.0` merely for convenience weakens the default network boundary and is not recommended.

## Backup minimum

Back up together:

1. the persistent `orc-data` volume / SQLite database;
2. the external master-key file.

The two artifacts have different security handling: the database contains encrypted operational state, while the master key must remain separately protected.

## Update the ORC application itself

For a locally built deployment:

```bash
docker compose build --pull
docker compose up -d
```

Application-container upgrades are distinct from the managed Ollama container update/rollback workflow. Never mount the local Docker socket into ORC to automate its own deployment.
