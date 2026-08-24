# Configuration

Ollama Remote Control uses Docker Compose environment substitution for deployment-host settings. Local settings belong in a repository-root `.env` file, which is intentionally ignored by Git. Start from the tracked template:

```bash
cp .env.example .env
```

Docker Compose reads `.env` automatically when commands are run from the repository root.

## Core variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `ORC_IMAGE` | `ollama-remote-control:local` | Image tag used by Compose. |
| `ORC_BIND_ADDRESS` | `127.0.0.1` | Host interface that publishes the ORC HTTP listener. |
| `ORC_PORT` | `3000` | Host-side published port. |
| `ORC_SECURE_COOKIES` | `true` | Controls whether session/CSRF cookies carry the `Secure` attribute. |
| `ORC_MASTER_KEY_SECRET_FILE` | `./secrets/orc_master_key` | Optional alternative host-side path for the external master-key secret. |

## HTTPS is the default

The secure/default configuration is:

```dotenv
ORC_SECURE_COOKIES=true
```

With this setting, ORC marks authentication cookies as `Secure`. Normal and production browser access therefore runs through HTTPS, typically using a reverse proxy in front of the loopback-bound ORC container.

Do not disable secure cookies merely to simplify a normal deployment. `ORC_SECURE_COOKIES=false` weakens the browser transport boundary and must be treated as an explicit local/test exception.

## Trusted HTTP beta or loopback testing

Some controlled environments, for example a workstation inside a corporate network, may need to exercise ORC directly over local HTTP rather than through an HTTPS reverse proxy. For that case, create or edit `.env` and set:

```dotenv
ORC_BIND_ADDRESS=127.0.0.1
ORC_PORT=3300
ORC_SECURE_COOKIES=false
```

Then recreate the application container so the changed environment is applied:

```bash
docker compose up -d --build --force-recreate
```

Use this mode only when browser access is restricted to a trusted local/loopback path. Do not combine `ORC_SECURE_COOKIES=false` with a broadly reachable bind address such as `0.0.0.0`.

To verify the effective Compose environment before starting:

```bash
docker compose config
```

To verify the value inside the running container:

```bash
docker compose exec app printenv ORC_SECURE_COOKIES
```

## Corporate HTTP proxies and loopback

If command-line HTTP clients route `127.0.0.1` or `localhost` through a corporate proxy, explicitly exempt loopback traffic. For example:

```bash
export NO_PROXY=localhost,127.0.0.1,::1
export no_proxy=localhost,127.0.0.1,::1
```

or use curl's one-shot bypass:

```bash
curl --noproxy '*' http://127.0.0.1:${ORC_PORT:-3000}/api/v1/health
```

This proxy bypass is independent from `ORC_SECURE_COOKIES`: the proxy setting determines how the client reaches ORC, while `ORC_SECURE_COOKIES` controls whether the browser may use the authentication cookies over plain HTTP.

## Security boundary

The repository tracks `.env.example`, but local `.env` and `.env.*` files remain ignored. Do not store master-key contents, passwords, SSH private keys or other secrets in the tracked template. The ORC encryption master key remains a separate file-backed Docker secret and is not replaced by `.env` configuration.
