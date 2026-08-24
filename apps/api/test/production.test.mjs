import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildProductionServer } from '../dist/production.js';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orc-production-'));
  const webDist = path.join(root, 'web');
  const assets = path.join(webDist, 'assets');
  fs.mkdirSync(assets, { recursive: true });
  fs.writeFileSync(path.join(webDist, 'index.html'), '<!doctype html><title>Ollama Remote Control</title><div id="root"></div>');
  fs.writeFileSync(path.join(assets, 'index-12345678.js'), 'console.log("production");');
  return {
    root,
    databasePath: path.join(root, 'app.sqlite'),
    webDist,
  };
}

test('production server serves the SPA and versioned API from the same Fastify instance', async () => {
  const { databasePath, webDist } = fixture();
  const app = buildProductionServer({
    ORC_DATABASE_PATH: databasePath,
    ORC_WEB_DIST_PATH: webDist,
    ORC_RELEASE_VERSION: '0.1.0-beta.1',
  });
  try {
    await app.ready();

    let response = await app.inject({ method: 'GET', url: '/' });
    assert.equal(response.statusCode, 200);
    assert.match(response.headers['content-type'], /^text\/html/u);
    assert.equal(response.body.includes('Ollama Remote Control'), true);

    response = await app.inject({ method: 'GET', url: '/assets/index-12345678.js' });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['cache-control'], 'public, max-age=31536000, immutable');

    response = await app.inject({ method: 'GET', url: '/api/v1/health' });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().status, 'ok');
    assert.equal(response.json().service, 'ollama-remote-control-api');
    assert.equal(response.json().version, '0.1.0-beta.1');

    response = await app.inject({ method: 'GET', url: '/api/v1/not-a-real-route' });
    assert.equal(response.statusCode, 404);
    assert.equal(response.body.includes('<!doctype html>'), false);
  } finally {
    await app.close();
  }
});

test('production server remains API-only when ORC_WEB_DIST_PATH is not configured', async () => {
  const { databasePath } = fixture();
  const app = buildProductionServer({ ORC_DATABASE_PATH: databasePath });
  try {
    await app.ready();
    const root = await app.inject({ method: 'GET', url: '/' });
    assert.equal(root.statusCode, 404);
    const health = await app.inject({ method: 'GET', url: '/api/v1/health' });
    assert.equal(health.statusCode, 200);
    assert.equal(health.json().version, '0.0.0-dev');
  } finally {
    await app.close();
  }
});
