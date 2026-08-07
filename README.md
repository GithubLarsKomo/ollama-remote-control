# Ollama Remote Control

Web-GUI zur sicheren Remote-Administration von Ollama auf Linux-Hosts über SSH und Docker.

## Status

- Produkt-SPEC freigegeben am 2026-08-08
- Wave 0 – Foundation läuft
- MVP: ein Host / ein Ollama-Container, Architektur von Beginn an Multi-Host/Multi-Container-ready

## Kernprinzipien

- SSH ist der einzige erforderliche Remote-Transport.
- Docker- und Ollama-Zugriff sind getrennte Adapter.
- Strukturierte Ollama-Funktionen nutzen bevorzugt die Ollama-API über einen SSH-Tunnel; `docker exec ... ollama ...` bleibt Fallback und Diagnoseweg.
- Ollama muss nicht öffentlich exponiert werden.
- SSH-Private-Keys werden verschlüsselt persistent gespeichert; der Master-Key liegt extern.
- Persistente Jobs, Audit-Trail, verifizierter Abbruch und ein gesicherter Expert Mode sind MVP-Bestandteile.
- Modelfiles sind versionierte GUI-Artefakte mit Structured/Raw Editor, Revisionen, Diff, Import/Export und Deployment.
- Modell-Lineage und Quellen/Model Cards (u. a. Hugging Face) sind sichtbar und nachvollziehbar.
- KI-Unterstützung ist später ausschließlich beratend; sie besitzt keine administrative Autorität.

## Dokumentation

- [`docs/SPEC.md`](docs/SPEC.md) – genehmigte Produktspezifikation
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) – Architekturrahmen und Invarianten
- [`docs/adr/`](docs/adr/) – Architecture Decision Records

## Roadmap

1. Wave 0 – Foundation, ADRs, CI, Security Baseline
2. Wave 1 – Identity & SSH
3. Wave 2 – Docker Target Discovery
4. Wave 3 – Models, Modelfiles, Lineage & Sources
5. Wave 4 – Persistent Jobs & Streaming
6. Wave 5 – Logs, Audit & Expert Mode
7. Wave 6 – Update & Rollback
8. Wave 7 – Hardening & Release

## Lizenz

Noch nicht festgelegt. Eine Lizenzentscheidung wird als eigener Decision Record dokumentiert.
