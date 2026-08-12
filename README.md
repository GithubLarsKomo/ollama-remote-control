# Ollama Remote Control

Web-GUI zur sicheren Remote-Administration von Ollama auf Linux-Hosts über SSH und Docker.

## Status

**0.1 Beta Candidate – noch nicht für eine öffentliche Beta freigegeben.**

Der funktionale Beta-Pfad ist weitgehend vollständig und wird auf Pull-Request-Merge-Refs durch Build-, Produkt-, Compatibility-, Production-Container- und exakte Release-Candidate-Evidence geprüft. Implementiert sind unter anderem:

- lokale Admin-Authentifizierung, serverseitige Sessions und CSRF-Schutz;
- verschlüsselte SSH-Credentials mit externem Master-Key sowie TOFU/Host-Key-Pinning;
- Docker/Ollama-Discovery, Runtime/GPU/Storage-Status, Logs und verifizierter Container-Lifecycle;
- persistente Pull-/Create-Jobs mit Reconnect, Cancellation und Restart-Reconciliation;
- Modell-Inventar, Details, Create/Replace, Unload und fester administrativer Smoke-Test;
- first-class Modelfiles mit Raw/Structured-Editor, immutable Revisionen, Diff, Import/Export, Validation, Deploy/Redeploy und Deployment-Evidence;
- persistente Provenance/Lineage/Sources inklusive Multi-Parent- und manueller Evidence;
- Compose-validierte Ollama-Updates mit Digest-Pinning, Healthcheck, automatischem/manuellem Rollback und Recovery;
- Audit-Historie, JSON/CSV-Export und Retention;
- `/data`-Backup/Restore, Mutation-Failure/Recovery-Matrix und exakte Release-Candidate-Szenarien;
- bounded Accessibility-/Responsive-Hardening mit dokumentierten manuellen Restchecks.

Vor der **öffentlichen** Beta bleiben insbesondere die tatsächlich verpflichtende GitHub-Repository-Policy für `beta-acceptance`, reproduzierbare Release-Paketierung/Versionierung sowie die explizite Projekt-Lizenzentscheidung offen. Siehe Issue `#84`.

Für die 0.1-Beta sind **Expert Mode** und **Model Delete** normativ auf post-beta verschoben. Standalone-Ollama-Targets bleiben für normale Administration unterstützt; die Update-Ausführung ist für 0.1 Beta bewusst fail-closed und nur für positiv validierte Docker-Compose-Targets freigeschaltet.

## Kernprinzipien

- SSH ist der einzige erforderliche Remote-Transport zu verwalteten Hosts.
- Docker- und Ollama-Zugriff bleiben getrennte, serverseitige Adapter.
- Ollama muss nicht öffentlich exponiert werden; der Browser spricht nie direkt mit SSH, Docker oder Ollama.
- Normale Administration besteht aus typisierten, serverdefinierten Operationen statt frei zusammengesetzten Shell-Kommandos.
- SSH-Private-Keys werden verschlüsselt persistent gespeichert; der Master-Key liegt getrennt von `/data` und vom Container-Image.
- Pro `OllamaTarget` läuft höchstens eine mutierende Operation gleichzeitig; die Sperre gehört zum persistenten Job-System, nicht zur Browser-Session.
- Persistierte Jobs werden nach Browser- oder App-Neustart anhand beobachtbarer Remote-Zustände reconciled statt blind erneut ausgeführt.
- Modelfile-Rohtext ist kanonisch und verlustfrei; strukturierte Bearbeitung darf unbekannte Direktiven oder Kommentare nicht stillschweigend verwerfen.
- Deployment-, Provenance- und Audit-Evidence wird an konkrete Revisionen/Digests gebunden und nicht aus Namen geraten.
- KI-Unterstützung ist später ausschließlich beratend und besitzt keine administrative Autorität.

## Dokumentation

- [`docs/SPEC.md`](docs/SPEC.md) – genehmigte Produktspezifikation
- [`docs/SPEC-0.1-BETA-AMENDMENT.md`](docs/SPEC-0.1-BETA-AMENDMENT.md) – normative 0.1-Beta-Scope-Grenzen
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) – Architekturrahmen und Sicherheitsinvarianten
- [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) – Installation, Betrieb, ORC-Upgrade und Recovery-Einstieg
- [`docs/BACKUP-RESTORE.md`](docs/BACKUP-RESTORE.md) – quiesced `/data`-Backup/Restore und separater Master-Key
- [`docs/BETA-ACCEPTANCE.md`](docs/BETA-ACCEPTANCE.md) – Merge-Ref-Beta-Gate und Repository-Policy-Grenze
- [`docs/BETA-RC-SCENARIOS.md`](docs/BETA-RC-SCENARIOS.md) – exakte Release-Candidate-Szenario-Evidence
- [`docs/BETA-FAILURE-RECOVERY-MATRIX.md`](docs/BETA-FAILURE-RECOVERY-MATRIX.md) – Mutation-/Restart-Recovery-Abdeckung
- [`docs/BETA-ACCESSIBILITY-RESPONSIVE.md`](docs/BETA-ACCESSIBILITY-RESPONSIVE.md) – Accessibility-/Responsive-Scope und manuelle Restchecks
- [`docs/adr/`](docs/adr/) – Architecture Decision Records

## Entwicklung

Voraussetzung ist Node.js 24 oder neuer.

```bash
npm ci
npm run build
npm test
```

Der Vite-Devserver läuft lokal und proxyt `/api` an die lokale Fastify-API. Der Produktionspfad liefert SPA und `/api/v1/*` dagegen aus demselben Fastify-/Container-Origin aus.

## Produktion

Der sichere Standard ist ein loopback-gebundener ORC-Container hinter einem HTTPS-Reverse-Proxy. Der Container läuft als non-root `node`-User, hat ein read-only Root-Filesystem, besitzt keinen Docker-Socket und veröffentlicht weder Docker noch Ollama.

Minimaler Einstieg:

```bash
mkdir -p secrets
tmp="$(mktemp)"
umask 077
openssl rand 32 | base64 -w0 > "$tmp"
printf '\n' >> "$tmp"
sudo install -o 1000 -g 1000 -m 0400 "$tmp" secrets/orc_master_key
rm -f "$tmp"

docker compose build --pull
docker compose up -d
curl --fail http://127.0.0.1:3000/api/v1/health
```

Port 3000 wird standardmäßig nur an `127.0.0.1` veröffentlicht. Authentifizierte Browser-Nutzung erfordert HTTPS, weil Session-/CSRF-Cookies `Secure` sind. Vor jedem ORC-App-Upgrade muss ein quiesced `/data`-Backup erstellt und der unveränderte externe Master-Key separat gesichert werden. Die vollständige Betriebs- und Upgrade-Sequenz steht in [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).

## Release-Pfad

Ein Beta-Release-Kandidat ist nur akzeptiert, wenn für denselben getesteten SHA alle folgenden Evidence-Gates grün sind:

1. `foundation-spike`;
2. `production-container`;
3. `beta-acceptance`;
4. `beta-release-candidate`.

Der Workflow allein macht `beta-acceptance` noch nicht zu einer verpflichtenden Merge-Regel. Die `main`-Repository-Policy muss diesen Check zusätzlich als required konfigurieren und mit einem absichtlich roten Kandidaten verifiziert werden.

## Roadmap

### Bis öffentliche 0.1 Beta

- reproduzierbare Versionierung/Release-Paketierung und Artifact-Evidence (`#144`);
- explizite Projekt-Lizenzentscheidung (`#145`);
- verpflichtende Repository-Policy für `beta-acceptance` verifizieren (`#105`).

### Post-beta

- Expert Mode mit separater Re-Authentifizierung, Warnung, Timeout und sensibler Terminal-Auditierung;
- verifizierter Model-Delete-Flow;
- separat geprüfte Standalone-Container-Update-Ausführung;
- weitere Multi-Host/Multi-Target- und Bedienungsverbesserungen.

## Lizenz

Noch nicht festgelegt. Die öffentliche Repository-Sichtbarkeit wird **nicht** als Lizenzgrant interpretiert. Auswahl und Anwendung einer Projektlizenz sind vor öffentlicher Beta separat in `#145` zu entscheiden.
