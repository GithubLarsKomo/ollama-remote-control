import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';

const ROOT = resolve(import.meta.dirname, '..');
const GIT_SHA = /^[a-f0-9]{40}$/u;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const SAFE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9_.\/-]+$/u;

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function packageNameFromLockPath(lockPath) {
  const marker = 'node_modules/';
  const index = lockPath.lastIndexOf(marker);
  if (index < 0) return null;
  const tail = lockPath.slice(index + marker.length);
  const parts = tail.split('/');
  if (!parts[0]) return null;
  return parts[0].startsWith('@') ? (parts[1] ? `${parts[0]}/${parts[1]}` : null) : parts[0];
}

function normalizedLicense(value, packageId, sourceLabel = 'lock metadata') {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Third-party package ${packageId} has no non-empty license in ${sourceLabel}.`);
  }
  const text = value.trim();
  if (text.length > 200 || /[\u0000-\u001f\u007f]/u.test(text)) {
    throw new Error(`Third-party package ${packageId} has invalid license metadata in ${sourceLabel}.`);
  }
  return text;
}

function reviewedEvidence(evidenceText) {
  const parsed = JSON.parse(evidenceText);
  if (parsed?.schemaVersion !== 1 || !parsed.overrides || typeof parsed.overrides !== 'object' || Array.isArray(parsed.overrides)) {
    throw new Error('Third-party license evidence must use schemaVersion 1 with an overrides object.');
  }

  const result = new Map();
  for (const [packageId, raw] of Object.entries(parsed.overrides)) {
    if (!packageId || packageId.length > 300 || !raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`Third-party license evidence entry ${packageId || '<empty>'} is invalid.`);
    }
    const entry = raw;
    const license = normalizedLicense(entry.license, packageId, 'reviewed evidence');
    if (typeof entry.repository !== 'string' || !REPOSITORY.test(entry.repository)) {
      throw new Error(`Third-party license evidence ${packageId} has an invalid repository.`);
    }
    for (const field of ['commitSha', 'packageJsonBlobSha', 'licenseBlobSha']) {
      if (typeof entry[field] !== 'string' || !GIT_SHA.test(entry[field])) {
        throw new Error(`Third-party license evidence ${packageId} has an invalid ${field}.`);
      }
    }
    for (const field of ['packageJsonPath', 'licensePath']) {
      if (typeof entry[field] !== 'string' || !SAFE_PATH.test(entry[field])) {
        throw new Error(`Third-party license evidence ${packageId} has an invalid ${field}.`);
      }
    }
    if (typeof entry.reviewNote !== 'string' || !entry.reviewNote.trim() || entry.reviewNote.length > 1000 || /[\u0000\u007f]/u.test(entry.reviewNote)) {
      throw new Error(`Third-party license evidence ${packageId} has an invalid reviewNote.`);
    }
    result.set(packageId, {
      license,
      repository: entry.repository,
      commitSha: entry.commitSha,
      packageJsonPath: entry.packageJsonPath,
      packageJsonBlobSha: entry.packageJsonBlobSha,
      licensePath: entry.licensePath,
      licenseBlobSha: entry.licenseBlobSha,
      reviewNote: entry.reviewNote.trim(),
    });
  }
  return result;
}

function publicEvidence(entry) {
  return {
    repository: entry.repository,
    commitSha: entry.commitSha,
    packageJsonPath: entry.packageJsonPath,
    packageJsonBlobSha: entry.packageJsonBlobSha,
    licensePath: entry.licensePath,
    licenseBlobSha: entry.licenseBlobSha,
    reviewNote: entry.reviewNote,
    packageJsonUrl: `https://github.com/${entry.repository}/blob/${entry.commitSha}/${entry.packageJsonPath}`,
    licenseUrl: `https://github.com/${entry.repository}/blob/${entry.commitSha}/${entry.licensePath}`,
  };
}

export function buildThirdPartyLicenseInventory(lockText, evidenceText = '{"schemaVersion":1,"overrides":{}}') {
  const lock = JSON.parse(lockText);
  const evidence = reviewedEvidence(evidenceText);
  const consumedEvidence = new Set();
  const unique = new Map();

  for (const [lockPath, entry] of Object.entries(lock.packages ?? {})) {
    if (!lockPath.includes('node_modules/') || entry?.link === true) continue;
    const name = packageNameFromLockPath(lockPath);
    const version = typeof entry?.version === 'string' ? entry.version.trim() : '';
    if (!name || !version) continue;
    if (name.startsWith('@orc/')) continue;
    const id = `${name}@${version}`;

    let license;
    let licenseOrigin;
    let evidenceView = null;
    if (typeof entry.license === 'string' && entry.license.trim()) {
      license = normalizedLicense(entry.license, id, 'package-lock.json');
      licenseOrigin = 'package-lock';
    } else {
      const override = evidence.get(id);
      if (!override) {
        throw new Error(`Locked third-party package ${id} has no non-empty license metadata and no exact reviewed evidence.`);
      }
      license = override.license;
      licenseOrigin = 'reviewed-evidence';
      evidenceView = publicEvidence(override);
      consumedEvidence.add(id);
    }

    const existing = unique.get(id);
    if (existing && existing.license !== license) {
      throw new Error(`Locked third-party package ${id} has conflicting license metadata.`);
    }
    if (!existing || existing.licenseOrigin !== 'package-lock') {
      unique.set(id, {
        name,
        version,
        license,
        licenseOrigin,
        ...(evidenceView ? { evidence: evidenceView } : {}),
      });
    }
  }

  const unusedEvidence = [...evidence.keys()].filter((id) => !consumedEvidence.has(id)).sort();
  if (unusedEvidence.length > 0) {
    throw new Error(`Reviewed third-party license evidence is stale or unused: ${unusedEvidence.join(', ')}.`);
  }

  const packages = [...unique.values()].sort((left, right) => (
    left.name.localeCompare(right.name) || left.version.localeCompare(right.version)
  ));
  if (packages.length === 0) throw new Error('No locked third-party packages were found.');

  const expressionCounts = {};
  for (const entry of packages) expressionCounts[entry.license] = (expressionCounts[entry.license] ?? 0) + 1;
  const licenseExpressionCounts = Object.fromEntries(
    Object.entries(expressionCounts).sort(([left], [right]) => left.localeCompare(right)),
  );

  return {
    schemaVersion: 1,
    source: 'package-lock.json',
    packageLockSha256: sha256(lockText),
    reviewedEvidenceSha256: sha256(evidenceText),
    reviewedEvidenceCount: consumedEvidence.size,
    packageCount: packages.length,
    licenseExpressionCounts,
    packages,
    disclaimer: 'Factual locked-dependency metadata only; exact reviewed evidence is used only where lock metadata is absent. Not legal advice and not a project license grant.',
  };
}

function main() {
  const out = process.argv[2];
  if (!out) throw new Error('Usage: node scripts/third-party-license-inventory.mjs <output.json>');
  const lockText = readFileSync(resolve(ROOT, 'package-lock.json'), 'utf8');
  const evidenceText = readFileSync(resolve(ROOT, 'release', 'third-party-license-evidence.json'), 'utf8');
  const inventory = buildThirdPartyLicenseInventory(lockText, evidenceText);
  writeFileSync(resolve(out), `${JSON.stringify(inventory, null, 2)}\n`, { mode: 0o644 });
  process.stdout.write(`${JSON.stringify({ packageCount: inventory.packageCount, reviewedEvidenceCount: inventory.reviewedEvidenceCount, licenseExpressionCounts: inventory.licenseExpressionCounts })}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) main();
