import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildProductionServer } from '../dist/production.js';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orc-production-server-'));
  const dist = path.join(root, 'web-dist');
  fs.mkdirSync(path.join(dist, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><title>Production ORC</title>');
  fs.writeFileSync(path.join(dist, 'assets', 'app-123.js'), 'console.log("production");');
  return {
    databasePath: path.join(root, 'data', 'orc.sqlite'),
    dist,
  };
}

test('production server exposes SPA and API from the same Fastify instance without SPA API fallback', async () => {
  const { databasePath, dist } = fixture();
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const app = buildProductionServer({
    ORC_DATABASE_PATH: databasePath,
    ORC_WEB_DIST_PATH: dist,
  });
  try {
    await app.ready();

    let response = await app.inject({ method: 'GET', url: '/' });
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.includes('Production ORC'), true);

    response = await app.inject({ method: 'GET', url: '/api/v1/health' });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().status, 'ok');

    response = await app.inject({ method: 'POST', url: '/api/v1/targets/target-1/models/smoke-test', payload: {} });
    assert.equal(response.statusCode, 401);
    assert.equal(response.json().error.code, 'UNAUTHENTICATED');

    response = await app.inject({ method: 'GET', url: '/api/v1/targets/target-1/container/rollback-candidate' });
    assert.equal(response.statusCode, 401);
    assert.equal(response.json().error.code, 'UNAUTHENTICATED');

    response = await app.inject({
      method: 'POST',
      url: '/api/v1/targets/target-1/container/rollback',
      payload: { confirmation: {} },
    });
    assert.equal(response.statusCode, 401);
    assert.equal(response.json().error.code, 'UNAUTHENTICATED');

    response = await app.inject({ method: 'GET', url: '/api/v1/not-real' });
    assert.equal(response.statusCode, 404);
    assert.equal(response.body.includes('Production ORC'), false);
  } finally {
    await app.close();
  }
});
