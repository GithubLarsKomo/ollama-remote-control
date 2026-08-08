import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Fastify from 'fastify';
import { registerWebAssets } from '../dist/web-assets.js';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orc-web-assets-'));
  const dist = path.join(root, 'dist');
  const assets = path.join(dist, 'assets');
  fs.mkdirSync(assets, { recursive: true });
  fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><title>ORC</title><div id="root"></div>');
  fs.writeFileSync(path.join(assets, 'index-abc123.js'), 'console.log("orc");');
  fs.writeFileSync(path.join(assets, 'index-abc123.css'), ':root{color-scheme:dark}');
  fs.writeFileSync(path.join(root, 'outside.txt'), 'OUTSIDE-SECRET');
  fs.symlinkSync(path.join(root, 'outside.txt'), path.join(assets, 'linked.js'));
  return { root, dist };
}

test('static web adapter serves index and hashed assets with bounded cache/content headers', async () => {
  const { dist } = fixture();
  const app = Fastify({ logger: false });
  registerWebAssets(app, dist);
  try {
    let response = await app.inject({ method: 'GET', url: '/' });
    assert.equal(response.statusCode, 200);
    assert.match(response.headers['content-type'], /^text\/html/u);
    assert.equal(response.headers['cache-control'], 'no-cache');
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
    assert.equal(response.body.includes('ORC'), true);

    response = await app.inject({ method: 'GET', url: '/index.html' });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['cache-control'], 'no-cache');

    response = await app.inject({ method: 'GET', url: '/assets/index-abc123.js' });
    assert.equal(response.statusCode, 200);
    assert.match(response.headers['content-type'], /^text\/javascript/u);
    assert.equal(response.headers['cache-control'], 'public, max-age=31536000, immutable');
    assert.equal(response.headers['x-content-type-options'], 'nosniff');

    response = await app.inject({ method: 'GET', url: '/assets/index-abc123.css' });
    assert.equal(response.statusCode, 200);
    assert.match(response.headers['content-type'], /^text\/css/u);
  } finally {
    await app.close();
  }
});

test('static web adapter rejects traversal, symlinks and missing assets without exposing filesystem content', async () => {
  const { dist } = fixture();
  const app = Fastify({ logger: false });
  registerWebAssets(app, dist);
  try {
    for (const url of [
      '/assets/%2e%2e%2Foutside.txt',
      '/assets/linked.js',
      '/assets/missing.js',
      '/assets/subdir%2F..%2Findex-abc123.js',
    ]) {
      const response = await app.inject({ method: 'GET', url });
      assert.equal(response.statusCode, 404, url);
      assert.equal(response.body.includes('OUTSIDE-SECRET'), false);
    }
  } finally {
    await app.close();
  }
});

test('static web adapter is disabled without an explicit dist path and never masks API-style 404s', async () => {
  const app = Fastify({ logger: false });
  registerWebAssets(app, null);
  try {
    let response = await app.inject({ method: 'GET', url: '/' });
    assert.equal(response.statusCode, 404);

    response = await app.inject({ method: 'GET', url: '/api/v1/not-a-real-route' });
    assert.equal(response.statusCode, 404);
    assert.equal(response.body.includes('<!doctype html>'), false);
  } finally {
    await app.close();
  }
});
