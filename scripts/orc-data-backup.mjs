#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const FORMAT = 'orc-data-backup-v1';
const MAX_FILES = 128;
const MAX_TOTAL_BYTES = 512 * 1024 * 1024;

function fail(message) {
  const error = new Error(message);
  error.code = 'ORC_BACKUP_INVALID';
  throw error;
}

function safeRelative(relativePath) {
  if (typeof relativePath !== 'string' || !relativePath || relativePath.includes('\\')) fail('Backup path is invalid.');
  const normalized = path.posix.normalize(relativePath);
  if (normalized === '.' || normalized.startsWith('../') || normalized.startsWith('/') || normalized.includes('/../')) fail('Backup path escapes the data directory.');
  return normalized;
}

function walk(root, current = '') {
  const directory = path.join(root, current);
  const directoryStat = fs.lstatSync(directory);
  if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) fail('Data tree contains an invalid directory entry.');
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const relative = safeRelative(current ? `${current}/${entry.name}` : entry.name);
    const absolute = path.join(root, ...relative.split('/'));
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) fail(`Symlinks are not allowed in application data backups: ${relative}`);
    if (stat.isDirectory()) files.push(...walk(root, relative));
    else if (stat.isFile()) files.push({ relative, absolute, size: stat.size, mode: stat.mode & 0o777 });
    else fail(`Unsupported application data entry: ${relative}`);
  }
  return files;
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

export function createDataBackup(dataDirectory, outputFile) {
  const root = path.resolve(dataDirectory);
  const rootStat = fs.lstatSync(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) fail('Application data path must be a real directory.');
  const files = walk(root).sort((left, right) => left.relative.localeCompare(right.relative));
  if (files.length === 0 || files.length > MAX_FILES) fail('Application data backup file count is outside the allowed range.');
  const totalBytes = files.reduce((sum, entry) => sum + entry.size, 0);
  if (totalBytes > MAX_TOTAL_BYTES) fail('Application data backup exceeds the allowed size.');

  const payload = {
    format: FORMAT,
    files: files.map((entry) => {
      const bytes = fs.readFileSync(entry.absolute);
      return {
        path: entry.relative,
        mode: Math.min(entry.mode || 0o600, 0o700),
        size: bytes.length,
        sha256: sha256(bytes),
        contentBase64: bytes.toString('base64'),
      };
    }),
  };
  const compressed = zlib.gzipSync(Buffer.from(JSON.stringify(payload), 'utf8'), { level: 9, mtime: 0 });
  const destination = path.resolve(outputFile);
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  const temp = `${destination}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try {
    fs.writeFileSync(temp, compressed, { mode: 0o600, flag: 'wx' });
    fs.renameSync(temp, destination);
    fs.chmodSync(destination, 0o600);
  } finally {
    fs.rmSync(temp, { force: true });
  }
  return { format: FORMAT, fileCount: files.length, totalBytes, sha256: sha256(compressed), outputFile: destination };
}

export function restoreDataBackup(backupFile, destinationDirectory) {
  const source = path.resolve(backupFile);
  const sourceStat = fs.lstatSync(source);
  if (sourceStat.isSymbolicLink() || !sourceStat.isFile()) fail('Backup must be a real regular file.');
  const compressed = fs.readFileSync(source);
  let payload;
  try { payload = JSON.parse(zlib.gunzipSync(compressed).toString('utf8')); }
  catch { fail('Backup payload is invalid.'); }
  if (!payload || payload.format !== FORMAT || !Array.isArray(payload.files) || payload.files.length === 0 || payload.files.length > MAX_FILES) fail('Backup manifest is invalid.');

  const destination = path.resolve(destinationDirectory);
  if (fs.existsSync(destination)) {
    const stat = fs.lstatSync(destination);
    if (stat.isSymbolicLink() || !stat.isDirectory() || fs.readdirSync(destination).length !== 0) fail('Restore destination must be an empty real directory.');
  } else {
    fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  }

  let totalBytes = 0;
  const seen = new Set();
  for (const entry of payload.files) {
    const relative = safeRelative(entry?.path);
    if (seen.has(relative)) fail('Backup contains duplicate paths.');
    seen.add(relative);
    if (!Number.isInteger(entry.size) || entry.size < 0 || typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(entry.sha256) || typeof entry.contentBase64 !== 'string') fail('Backup entry metadata is invalid.');
    const bytes = Buffer.from(entry.contentBase64, 'base64');
    if (bytes.length !== entry.size || sha256(bytes) !== entry.sha256) fail('Backup entry integrity check failed.');
    totalBytes += bytes.length;
    if (totalBytes > MAX_TOTAL_BYTES) fail('Restored application data exceeds the allowed size.');
    const absolute = path.join(destination, ...relative.split('/'));
    const parent = path.dirname(absolute);
    fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
    fs.writeFileSync(absolute, bytes, { flag: 'wx', mode: 0o600 });
    fs.chmodSync(absolute, 0o600);
  }
  return { format: FORMAT, fileCount: payload.files.length, totalBytes, sha256: sha256(compressed), destinationDirectory: destination };
}

function usage() {
  console.error('Usage: node scripts/orc-data-backup.mjs create <data-directory> <backup-file> | restore <backup-file> <empty-data-directory>');
  process.exitCode = 64;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const [operation, first, second] = process.argv.slice(2);
  try {
    if (operation === 'create' && first && second) console.log(JSON.stringify(createDataBackup(first, second)));
    else if (operation === 'restore' && first && second) console.log(JSON.stringify(restoreDataBackup(first, second)));
    else usage();
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Backup operation failed.');
    process.exitCode = 1;
  }
}
