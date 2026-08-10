import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import test from 'node:test';
import { openDatabase } from '@orc/db';
import { registerModelfilePortabilityFeature } from '../dist/modelfile-portability-feature.js';
import { buildServer } from '../dist/server.js';

const PASSWORD = 'modelfile-portability-password!';
const MASTER_KEY = Buffer.alloc(32, 0x5d);

function cookiesFrom(response) {
  const header = response.headers['set-cookie'];
  const values = Array.isArray(header) ? header : header ? [header] : [];
  const cookies = {};
  for (const value of values) {
    const [pair] = value.split(';');
    const separator = pair.indexOf('=');
    cookies[pair.slice(0, separator)] = decodeURIComponent(pair.slice(separator + 1));
  }
  return cookies;
}
function cookieHeader(cookies) {
  return Object.entries(cookies).map(([name, value]) => `${name}=${encodeURIComponent(value)}`).join('; ');
}
function mutationHeaders(cookies) {
  return { cookie: cookieHeader(cookies), 'x-csrf-token': cookies.orc_csrf };
}

async function authenticate(app) {
  const setup = await app.inject({
    method: 'POST', url: '/api/v1/setup/admin', payload: { username: 'admin', password: PASSWORD },
  });
  assert.equal(setup.statusCode, 201);
  const login = await app.inject({
    method: 'POST', url: '/api/v1/session', payload: { username: 'admin', password: PASSWORD },
  });
  assert.equal(login.statusCode, 200);
  return cookiesFrom(login);
}

test('clone re-reads the selected immutable historical revision exactly and clears imported provenance', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orc-modelfile-portability-'));
  const databasePath = path.join(directory, 'app.sqlite');
  const environment = { ORC_MASTER_KEY: MASTER_KEY.toString('base64') };
  const app = buildServer({ databasePath, environment });
  registerModelfilePortabilityFeature(app, { databasePath });
  try {
    const cookies = await authenticate(app);
    const raw1 = '# historical CRLF\r\nFROM hf.co/example/base:Q4_K_M\r\nX-FUTURE opaque value\r\n';
    const raw2 = '# current LF\nFROM current:latest\nPARAMETER temperature 0.9\n';

    const createdResponse = await app.inject({
      method: 'POST', url: '/api/v1/modelfiles', headers: mutationHeaders(cookies),
      payload: { displayName: 'Source artifact', description: 'Original', rawText: raw1 },
    });
    assert.equal(createdResponse.statusCode, 201);
    const created = createdResponse.json().modelfile;

    const appendedResponse = await app.inject({
      method: 'POST', url: `/api/v1/modelfiles/${created.id}/revisions`, headers: mutationHeaders(cookies),
      payload: { expectedCurrentRevisionId: created.currentRevisionId, rawText: raw2 },
    });
    assert.equal(appendedResponse.statusCode, 201);
    assert.equal(appendedResponse.json().modelfile.currentRevision.rawText, raw2);

    const noCsrf = await app.inject({
      method: 'POST',
      url: `/api/v1/modelfiles/${created.id}/revisions/${created.currentRevisionId}/clone`,
      headers: { cookie: cookieHeader(cookies) },
      payload: { displayName: 'Rejected clone' },
    });
    assert.equal(noCsrf.statusCode, 403);

    const clonedResponse = await app.inject({
      method: 'POST',
      url: `/api/v1/modelfiles/${created.id}/revisions/${created.currentRevisionId}/clone`,
      headers: mutationHeaders(cookies),
      payload: { displayName: 'Historical clone', description: 'Independent branch' },
    });
    assert.equal(clonedResponse.statusCode, 201);
    const clone = clonedResponse.json().modelfile;
    assert.notEqual(clone.id, created.id);
    assert.notEqual(clone.currentRevisionId, created.currentRevisionId);
    assert.equal(clone.currentRevisionNumber, 1);
    assert.equal(clone.currentSourceKind, 'manual');
    assert.equal(clone.currentRevision.revisionNumber, 1);
    assert.equal(clone.currentRevision.parentRevisionId, null);
    assert.equal(clone.currentRevision.rawText, raw1);
    assert.equal(clone.currentRevision.sourceKind, 'manual');
    assert.equal(clone.currentRevision.importedTargetId, null);
    assert.equal(clone.currentRevision.importedModel, null);
    assert.equal(clone.currentRevision.importedDigest, null);
    assert.equal(clone.currentRevision.contentSha256, created.currentRevision.contentSha256);

    const sourceNow = await app.inject({
      method: 'GET', url: `/api/v1/modelfiles/${created.id}`,
      headers: { cookie: cookieHeader(cookies) },
    });
    assert.equal(sourceNow.statusCode, 200);
    assert.equal(sourceNow.json().modelfile.currentRevision.rawText, raw2);

    const database = openDatabase(databasePath);
    try {
      const audit = database.prepare(`
        SELECT parameters_redacted_json AS parameters
        FROM audit_events
        WHERE action = 'modelfile.cloned'
      `).get();
      assert(audit);
      const parameters = JSON.parse(audit.parameters);
      assert.equal(parameters.modelfileId, clone.id);
      assert.equal(parameters.revisionId, clone.currentRevisionId);
      assert.equal(parameters.sourceModelfileId, created.id);
      assert.equal(parameters.sourceRevisionId, created.currentRevisionId);
      assert.equal(parameters.sourceRevisionSha256, created.currentRevision.contentSha256);
      const auditText = JSON.stringify(audit);
      assert.equal(auditText.includes(raw1), false);
      assert.equal(auditText.includes('X-FUTURE opaque value'), false);
    } finally {
      database.close();
    }
  } finally {
    await app.close();
  }
});
