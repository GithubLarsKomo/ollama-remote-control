# 0.1 beta release packaging and verification

This document defines the release-package evidence for Ollama Remote Control 0.1 beta. It does not publish a Git tag, registry image or GitHub Release by itself.

## Authoritative release version

The public product release version is defined once in:

```text
release/version.json
```

For the first beta candidate it contains `0.1.0-beta.1` plus the exact Node/npm toolchain used by the release-package gate. The individual npm workspaces remain private implementation packages; their internal npm versions are validated against `package-lock.json` and are recorded in the release manifest together with the single public release version.

This distinction prevents a product release number from silently changing internal workspace dependency semantics while still making every workspace part of the same versioned product artifact.

## Exact candidate identity

The `beta-release-candidate` workflow packages the **tested checkout SHA**, not merely a branch name. For a pull request this is the GitHub merge-ref commit already exercised by the release-candidate path.

The workflow fails closed unless the same candidate already has successful `foundation-spike` and `production-container` evidence and matching bounded RC-scenario evidence.

## Locked build and production image

The packaging step:

1. installs dependencies with `npm ci` using `package-lock.json`;
2. uses the exact Node/npm versions in `release/version.json`;
3. builds the product;
4. pulls the current `node:24-bookworm-slim` base and resolves its immutable repo digest and local image ID;
5. builds the production image using that immutable base digest for both stages;
6. injects only non-sensitive OCI metadata:
   - `org.opencontainers.image.version`;
   - `org.opencontainers.image.revision`;
7. verifies the labels and image identity before writing release evidence.

The normal production-container gate may continue to test the moving supported Node 24 base with `--pull`. Release packaging records the exact base identity actually used by the candidate, so later verification does not pretend that a mutable tag alone is reproducible evidence.

## Release bundle

The bounded workflow artifact contains:

```text
release-manifest.json
version.json
Dockerfile
compose.yaml
SHA256SUMS
```

`release-manifest.json` binds at least:

- product release version;
- exact tested Git SHA;
- exact Node/npm versions;
- package-lock SHA-256;
- Dockerfile and Compose SHA-256;
- immutable base-image reference and image ID;
- resulting production image reference and image ID;
- OCI version/revision labels;
- all eight private workspace identities and their internal package versions.

The bundle contains no `/data`, master key, SSH credential, local secret file, database or Docker image tarball. The implementation PR establishes deterministic metadata/evidence; publishing a registry image or public release is a separate release action.

## Verify an artifact

After downloading the exact candidate artifact:

```bash
cd release-package
sha256sum -c SHA256SUMS
jq . release-manifest.json
```

Verify that `releaseVersion` is the intended beta version and `commitSha` is the exact accepted candidate. The `inputs.packageLockSha256`, Docker/Compose hashes, base-image identity and resulting image ID are evidence for the build that produced the artifact.

For a locally available candidate image, additionally verify:

```bash
docker image inspect -f '{{ index .Config.Labels "org.opencontainers.image.version" }}' <image>
docker image inspect -f '{{ index .Config.Labels "org.opencontainers.image.revision" }}' <image>
docker image inspect -f '{{ .Id }}' <image>
```

All three values must match `release-manifest.json`.

## Reproduce from an explicit commit

Do not reproduce from an unpinned moving branch if release evidence matters. Check out the exact accepted commit, verify a clean worktree, use the toolchain in `release/version.json`, and run the same locked build/package logic used by `.github/workflows/beta-release-candidate.yml`.

The packaging helper itself is:

```bash
npm run release:package -- \
  --out /tmp/orc-release \
  --commit <40-char-tested-sha> \
  --image-reference <local-image-reference> \
  --image-id sha256:<64-hex> \
  --base-image-reference <immutable-node-repo-digest> \
  --base-image-id sha256:<64-hex>
```

It refuses an unclean Git worktree, malformed commit/image identities, toolchain drift, package/lock mismatches or missing workspace synchronization.

## Public release boundary

A green package artifact does not by itself make the project public-beta ready. The release still requires:

- the four beta evidence gates green on the exact candidate;
- `beta-acceptance` demonstrably required by repository merge policy (#105);
- the explicit project license decision and committed license metadata (#145);
- no known critical/high security issue.
