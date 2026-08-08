# ADR-0005 — SSH credential encryption and master-key source

- **State:** proposed
- **Date:** 2026-08-08
- **Decision owner/approver:** product owner

## Question

How should SSH private keys be encrypted at rest while keeping the encryption key outside the application database and detecting ciphertext or record-context manipulation?

## Constraints

- The approved SPEC requires encrypted persistent SSH secrets.
- The master encryption key must be externally injected and must never be stored in the same SQLite database.
- Private keys must not appear in logs, audit events, process arguments or browser responses.
- The encrypted record must carry algorithm and key-version metadata for later rotation/migration.

## Evidence

- OWASP recommends strong symmetric encryption and prefers authenticated encryption modes such as GCM where available.
- Node.js 24 provides stable AES-GCM primitives through `node:crypto`, avoiding a new cryptographic dependency.
- A 256-bit uniformly random key is appropriate for AES-256; a fresh 96-bit nonce is the conventional GCM nonce size and must never be reused with the same key.
- AEAD additional authenticated data can bind ciphertext to non-secret record identity without storing that context inside the ciphertext.

## Alternatives

### A. AES-256-GCM using Node `crypto`

**Benefits:** authenticated encryption, platform primitive, no additional crypto package, straightforward key/nonce/tag representation.  
**Risks:** nonce uniqueness is mandatory and therefore generated randomly for every encryption; key rotation must remain explicit.

### B. XChaCha20-Poly1305 via an external library

**Benefits:** large nonce space and strong AEAD properties.  
**Cost:** introduces an additional security-critical native/cryptographic dependency without a demonstrated MVP need.

### C. Database-level encryption only

**Rejected:** does not provide the required field-level separation of the SSH private key from the SQLite file and does not by itself satisfy the external master-key boundary.

## Proposed decision

Use **Alternative A**.

### Master key

- exactly 32 random bytes;
- canonical Base64 representation;
- preferred source: read-only file supplied through `ORC_MASTER_KEY_FILE`;
- fallback source: secret environment variable `ORC_MASTER_KEY`;
- file source takes precedence if both are present;
- malformed configured values fail application startup before the database is opened;
- no configured master key is allowed until a feature requiring encrypted credentials is invoked.

### Encrypted record

```text
algorithm   aes-256-gcm
key_version positive integer, initially 1
nonce       12 random bytes, Base64
ciphertext  Base64
auth_tag    16 bytes, Base64
```

Every encryption generates a fresh nonce.

### AEAD context binding

The GCM additional authenticated data contains:

```text
purpose + key_version + host_id + credential_id
```

This means ciphertext copied to another credential or another host fails authentication even if all encrypted fields are copied intact.

### Persistence

SQLite stores only encrypted fields and metadata in `ssh_credentials`, with a one-to-one `host_id` relationship. Plaintext private-key material exists only at the encrypt/decrypt boundary.

`key_version` is persisted from the first schema version even though online key rotation is deferred. A future rotation workflow must decrypt with the old version and re-encrypt with the new key/version under an explicit migration job.

## Acceptance gate

Before this ADR becomes `accepted`, CI must prove:

1. identical plaintext encrypted twice produces different nonce/ciphertext;
2. correct host+credential context round-trips;
3. modified authentication tag fails;
4. wrong master key fails;
5. wrong credential ID fails;
6. wrong host ID fails;
7. malformed Base64 or non-32-byte master keys fail closed;
8. master-key file overrides environment fallback;
9. migration 3 is idempotent and preserves previous schemas;
10. persisted SQLite bytes do not contain the SSH private-key plaintext;
11. an explicitly malformed API master-key configuration fails before normal startup;
12. all prior authentication, SSH, streaming and Docker gates remain green.

## Rollback / exit path

The database explicitly records `algorithm` and `key_version`. A future AEAD algorithm or key can be introduced by adding a new decryptor/encryptor path and migrating encrypted records without changing host identity or Ollama target data.

## Links

- `docs/SPEC.md`
- `SECURITY.md`
- Issue #5
