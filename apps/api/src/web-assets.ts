import {
  lstat,
  readFile,
  realpath,
} from 'node:fs/promises';
import {
  basename,
  extname,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import type { FastifyInstance, FastifyReply } from 'fastify';

const MIME_TYPES: Readonly<Record<string, string>> = {
  '.avif': 'image/avif',
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

function mimeType(filename: string): string {
  return MIME_TYPES[extname(filename).toLowerCase()] ?? 'application/octet-stream';
}

function safeAssetRelativePath(value: string): string | null {
  const normalized = value.replaceAll('\\', '/');
  if (!normalized || normalized.startsWith('/') || normalized.includes('\0')) return null;
  const segments = normalized.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) return null;
  return segments.join('/');
}

function isFingerprintedAsset(filename: string): boolean {
  return /(?:^|[-.])[A-Za-z0-9_-]{8,}\.[A-Za-z0-9]+$/u.test(basename(filename));
}

async function fileInsideRoot(root: string, candidate: string): Promise<string | null> {
  try {
    const [rootReal, candidateReal, candidateStat] = await Promise.all([
      realpath(root),
      realpath(candidate),
      lstat(candidate),
    ]);
    if (!candidateStat.isFile() || candidateStat.isSymbolicLink()) return null;
    const rel = relative(rootReal, candidateReal);
    if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || resolve(rootReal, rel) !== candidateReal) return null;
    return candidateReal;
  } catch {
    return null;
  }
}

function staticHeaders(reply: FastifyReply, immutable: boolean, document = false): FastifyReply {
  reply
    .header('x-content-type-options', 'nosniff')
    .header('cache-control', immutable ? 'public, max-age=31536000, immutable' : 'no-cache');
  if (document) {
    reply
      .header('x-frame-options', 'DENY')
      .header('referrer-policy', 'no-referrer')
      .header('permissions-policy', 'camera=(), microphone=(), geolocation=()');
  }
  return reply;
}

async function sendFile(
  reply: FastifyReply,
  root: string,
  candidate: string,
  immutable: boolean,
  document = false,
): Promise<FastifyReply> {
  const safeFile = await fileInsideRoot(root, candidate);
  if (!safeFile) return reply.code(404).send({ error: { code: 'WEB_ASSET_NOT_FOUND', message: 'Web asset was not found.' } });
  const body = await readFile(safeFile);
  return staticHeaders(reply, immutable, document)
    .type(mimeType(safeFile))
    .send(body);
}

export function registerWebAssets(app: FastifyInstance, webDistPath: string | null | undefined): void {
  const configured = webDistPath?.trim();
  if (!configured) return;
  const root = resolve(configured);
  const assetsRoot = join(root, 'assets');

  const indexHandler = async (_request: unknown, reply: FastifyReply) => sendFile(reply, root, join(root, 'index.html'), false, true);
  app.get('/', indexHandler);
  app.get('/index.html', indexHandler);
  app.get<{ Params: { '*': string } }>('/assets/*', async (request, reply) => {
    const relativeAsset = safeAssetRelativePath(request.params['*']);
    if (!relativeAsset) return reply.code(404).send({ error: { code: 'WEB_ASSET_NOT_FOUND', message: 'Web asset was not found.' } });
    const candidate = join(assetsRoot, relativeAsset);
    return sendFile(reply, assetsRoot, candidate, isFingerprintedAsset(candidate));
  });
}
