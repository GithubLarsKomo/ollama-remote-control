# Ollama Remote Control

Web-GUI zur sicheren Remote-Administration von Ollama auf Linux-Hosts über SSH und Docker.

## Status

- Produkt-SPEC freigegeben am 2026-08-08.
- Wave 0/1 abgeschlossen: Foundation, lokale Admin-Session, verschlüsselter Secret Store, SSH-Onboarding und Host-Key-Pinning.
- Wave 2 weit fortgeschritten: Docker/Ollama-Target-Discovery, Status/Capabilities, Logs, Lifecycle, Update-Planung und digest-gepinnte Update-/Rollback-Transaktion einschließlich Startup-Reconciliation.
- React/Vite-Weboberfläche: Login/Bootstrap, Target-Auswahl und read-only Container/Ollama/GPU/Storage-Dashboard.
- Aktueller Deployment-Slice: SPA und API als gehärteter Single-Container auf demselben Origin.
- MVP: zunächst ein Host / ein Ollama-Container, Architektur von Beginn an Multi-Host/Multi-Container-ready.

## Kernprinzipien

- SSH ist der einzige erforderliche Remote-Transport.
- Docker- und Ollama-Zugriff sind getrennte Adapter.
- Strukturierte Ollama-Funktionen nutzen bevorzugt die Ollama-API über einen SSH-Tunnel; `docker exec ... ollama ...` bleibt Fallback und Diagnoseweg.
- Ollama muss nicht öffentlich exponiert werden.
- SSH-Private-Keys werden verschlüsselt persistent gespeichert; der Master-Key liegt extern.
- Der Browser spricht ausschließlich mit der Anwendungs-API und nie direkt mit Docker, SSH oder Ollama.
- Persistente Jobs, Audit-Trail, verifizierter Abbruch und ein gesicherter Expert Mode sind MVP-Bestandteile.
- Modelfiles sind versionierte GUI-Artefakte mit Structured/Raw Editor, Revisionen, Diff, Import/Export und Deployment.
- Modell-Lineage und Quellen/Model Cards (u. a. Hugging Face) sind sichtbar und nachvollziehbar.
- KI-Unterstützung ist später ausschließlich beratend; sie besitzt keine administrative Autorität.

## Dokumentation

- [`docs/SPEC.md`](docs/SPEC.md) – genehmigte Produktspezifikation
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) – Architekturrahmen und Invarianten
- [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) – gehärteter Single-Container-Betrieb, Master-Key und HTTPS-Grenze
- [`docs/adr/`](docs/adr/) – Architecture Decision Records

## Entwicklung

```bash
npm ci
npm run build
npm test
```

Der Vite-Devserver läuft nur lokal und proxyt `/api` an die lokale Fastify-API. Der Produktionspfad wird dagegen als gemeinsamer Origin aus dem Single-Container ausgeliefert.

## Deployment

Der sichere Standard ist eine Loopback-Bindung des Containers hinter HTTPS-Terminierung:

```bash
mkdir -p secrets
umask 077
openssl rand 32 | base64 -w0 > secrets/orc_master_key
printf '\n' >> secrets/orc_master_key

docker compose build --pull
docker compose up -d
curl --fail http://127.0.0.1:3000/api/v1/health
```

Port 3000 wird standardmäßig nur an `127.0.0.1` veröffentlicht. Für den Browser ist HTTPS erforderlich, weil Session- und CSRF-Cookies `Secure` sind. Details und Härtungsregeln stehen in [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).

## Roadmap

1. Wave 0 – Foundation, ADRs, CI, Security Baseline
2. Wave 1 – Identity & SSH
3. Wave 2 – Docker Target Discovery, Runtime Status, Lifecycle, Update/Rollback und Dashboard
4. Wave 3 – Models, Modelfiles, Lineage & Sources
5. Wave 4 – Persistent Jobs & Streaming
6. Wave 5 – Logs, Audit & Expert Mode
7. Wave 6 – Update & Rollback
8. Wave 7 – Hardening & Release

Die Implementierung folgt vertikalen, sicherheitsgeprüften Slices; Teile der späteren Roadmap (insbesondere Jobs, Logs und Update/Rollback) wurden bereits vorgezogen, weil sie für sichere Wave-2-Operationen erforderlich waren.

## Lizenz

Noch nicht festgelegt. Eine Lizenzentscheidung wird als eigener Decision Record dokumentiert.
