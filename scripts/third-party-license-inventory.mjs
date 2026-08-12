import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';

const ROOT = resolve(import.meta.dirname, '..');

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

function normalizedLicense(value, packageId) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Locked third-party package ${packageId} has no non-empty license metadata.`);
  }
  const text = value.trim();
  if (text.length > 200 || /[\u0000-\u001f\u007f]/u.test(text)) {
    throw new Error(`Locked third-party package ${packageId} has invalid license metadata.`);
  }
  return text;
}

export function buildThirdPartyLicenseInventory(lockText) {
  const lock = JSON.parse(lockText);
  const unique = new Map();

  for (const [lockPath, entry] of Object.entries(lock.packages ?? {})) {
    if (!lockPath.includes('node_modules/') || entry?.link === true) continue;
    const name = packageNameFromLockPath(lockPath);
    const version = typeof entry?.version === 'string' ? entry.version.trim() : '';
    if (!name || !version) continue;
    if (name.startsWith('@orc/')) continue;
    const id = `${name}@${version}`;
    const license = normalizedLicense(entry.license, id);
    const existing = unique.get(id);
    if (existing && existing.license !== license) {
      throw new Error(`Locked third-party package ${id} has conflicting license metadata.`);
    }
    unique.set(id, { name, version, license });
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
    packageCount: packages.length,
    licenseExpressionCounts,
    packages,
    disclaimer: 'Factual locked-dependency metadata only; not legal advice and not a project license grant.',
  };
}

function main() {
  const out = process.argv[2];
  if (!out) throw new Error('Usage: node scripts/third-party-license-inventory.mjs <output.json>');
  const lockText = readFileSync(resolve(ROOT, 'package-lock.json'));
  const inventory = buildThirdPartyLicenseInventory(lockText);
  writeFileSync(resolve(out), `${JSON.stringify(inventory, null, 2)}\n`, { mode: 0o644 });
  process.stdout.write(`${JSON.stringify({ packageCount: inventory.packageCount, licenseExpressionCounts: inventory.licenseExpressionCounts })}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) main();
