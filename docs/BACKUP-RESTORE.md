# Backup and restore

Ollama Remote Control has two independent pieces of recovery material:

1. the application `/data` volume, including the SQLite database; and
2. the external master key referenced by `ORC_MASTER_KEY_FILE` / `ORC_MASTER_KEY_SECRET_FILE`.

They **must be backed up and escrowed separately**. The master key is intentionally not stored in `/data` and must never be copied into an application-data backup.

This procedure covers only the management application's persistent state. It does **not** back up remote Ollama model/data volumes on managed hosts.

## Preconditions

Use the exact application image/version that corresponds to the backup or a tested newer version whose migrations are supported. Run the procedure from the deployment directory containing `compose.yaml`.

The backup helper is bounded and fail-closed:

- regular files and directories only;
- no symlinks;
- no absolute/traversal paths;
- at most 128 files and 256 MiB of uncompressed application data;
- per-file SHA-256 integrity metadata;
- output archive mode `0600`;
- restore only into an empty real directory/volume.

The helper does not acquire a live SQLite lock. **The app must be stopped before backup.** This quiesces SQLite and prevents an inconsistent database/WAL/SHM snapshot.

## 1. Identify the current data volume

Before removing or recreating any container, record the volume mounted at `/data`:

```sh
APP_CONTAINER="$(docker compose ps -aq app)"
DATA_VOLUME="$(docker inspect "$APP_CONTAINER" --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Name}}{{end}}{{end}}')"
test -n "$DATA_VOLUME"
printf 'Application data volume: %s\n' "$DATA_VOLUME"
```

Store the value with the operational recovery record. Do not infer or guess the Compose-generated volume name.

## 2. Quiesced application-data backup

Stop the application and create a one-off helper container using the same service definition and `/data` volume:

```sh
docker compose stop app

docker rm -f orc-backup-helper 2>/dev/null || true
docker compose run --name orc-backup-helper --no-deps app \
  node /app/scripts/orc-data-backup.mjs create \
  /data /tmp/orc-data.backup.gz

mkdir -p backups
chmod 700 backups
docker cp orc-backup-helper:/tmp/orc-data.backup.gz \
  ./backups/orc-data.backup.gz
chmod 600 ./backups/orc-data.backup.gz
docker rm orc-backup-helper
sha256sum ./backups/orc-data.backup.gz > ./backups/orc-data.backup.gz.sha256
chmod 600 ./backups/orc-data.backup.gz.sha256
```

The helper's JSON result contains only format, file count, total byte count, archive SHA-256 and output path. It must not contain SSH keys, the master key, Modelfile source, terminal content or remote stdout/stderr.

After the backup and external-key escrow are both confirmed, normal service may be resumed:

```sh
docker compose start app
```

## 3. Back up the external master key separately

The default Compose configuration reads the key from:

```text
${ORC_MASTER_KEY_SECRET_FILE:-./secrets/orc_master_key}
```

Copy that file to a separate secrets escrow using your normal secret-management process. Do not place it under `backups/`, `/data`, inside the SQLite file, or in the same backup archive.

Preserve the exact key bytes. Protect the escrowed copy with permissions equivalent to `0600` or stronger access controls. A restored database containing encrypted SSH credentials is intentionally unusable without the matching key.

## 4. Restore into an empty data volume

A restore is destructive to the chosen target volume. Keep the old volume until the backup archive and master-key escrow have been independently verified.

Capture `DATA_VOLUME` as shown above, stop the app, and remove only the application container while preserving the volume:

```sh
docker compose stop app
docker compose rm -f app
```

When intentionally replacing the damaged data volume, remove and recreate **the recorded volume name**:

```sh
docker volume rm "$DATA_VOLUME"
docker volume create "$DATA_VOLUME"
```

Restore the archive with the same tested application image used by Compose. `ORC_IMAGE` defaults to the image name in `compose.yaml`; set it explicitly for a pinned release image:

```sh
ORC_IMAGE="${ORC_IMAGE:-ollama-remote-control:local}"
BACKUP_PATH="$(pwd)/backups/orc-data.backup.gz"

docker run --rm \
  -v "$DATA_VOLUME:/data" \
  -v "$BACKUP_PATH:/backup/orc-data.backup.gz:ro" \
  "$ORC_IMAGE" \
  node /app/scripts/orc-data-backup.mjs restore \
  /backup/orc-data.backup.gz /data
```

The target `/data` must be empty. The helper refuses non-empty destinations, symlinks, duplicate paths, path traversal and integrity mismatches.

## 5. Restore the external key and start

Restore the matching master-key file separately to the configured `ORC_MASTER_KEY_SECRET_FILE` path and restrict its permissions. Then recreate/start the application:

```sh
docker compose up -d app
docker compose ps app
```

Verify `/api/v1/health`, login, target visibility and at least one encrypted host credential through the normal connection/status flow. If the key is missing or different, encrypted credentials must fail closed; do not overwrite them or generate a replacement key as a recovery shortcut.

## 6. Recovery validation checklist

A release recovery exercise is successful only when all of the following are true:

- the restored database opens and migrations complete;
- host/target configuration remains present;
- encrypted SSH credentials decrypt only with the original external master key;
- immutable Modelfile revisions remain byte-identical;
- verified deployment evidence remains present;
- provenance/source evidence remains present;
- audit history remains queryable;
- application health is green after restart;
- no backup artifact or checksum metadata contains the master key or plaintext SSH private key.

## Scope limitation

This backup is **application-state recovery only**. Remote Ollama model storage, model blobs, host filesystem state, Docker volumes on managed target hosts and other application stacks require their own backup procedures. Ollama Remote Control does not claim to back those up.