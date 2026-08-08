# Security Policy

Ollama Remote Control manages SSH credentials and privileged remote operations. Security issues should not be disclosed in public issues when they contain exploit details, secrets, host information or other sensitive data.

## Security invariants

The project treats these as non-negotiable product boundaries:

- Ollama does not need public exposure.
- SSH host keys are verified and pinned.
- SSH private keys are encrypted at rest.
- The encryption master key is external to SQLite.
- The browser never receives SSH private keys.
- The browser never talks directly to Docker or Ollama.
- Normal structured actions cannot execute arbitrary shell strings.
- Expert Mode requires reauthentication and inactivity timeout.
- Future AI assistance cannot execute administrative actions.

## Dependency policy

- Commit lockfiles once executable dependencies are introduced.
- Use clean/reproducible installs in CI.
- Prefer a small dependency set and first-party/platform capabilities where mature.
- Review install/postinstall scripts and native dependencies deliberately.
- Pin GitHub Actions to reviewed versions/commits when CI is introduced.

## Secret handling

Never commit:

- SSH private keys;
- encryption master keys;
- target host credentials;
- production hostnames or connection profiles containing sensitive information;
- terminal transcripts containing secrets;
- `.env` files with credentials.

Detailed threat modeling and reporting channels will be added before the first public release.
