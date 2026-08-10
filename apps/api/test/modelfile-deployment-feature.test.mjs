import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openDatabase } from '@orc/db';
import { registerModelfileDeploymentFeature } from '../dist/modelfile-deployment-feature.js';
import { buildServer } from '../dist/server.js';

const PASSWORD = 'deployment-read-password!';
const NOW = '2026-08-10T12:00:00.000Z';
const REV1_SHA = '1'.repeat(64);
const REV2_SHA = '2'.repeat(64);
const MODEL_DIGEST = 'a'.repeat(64);

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

async function login(app) {
  assert.equal((await app.inject({
    method: 'POST',
    url: '/api/v1/setup/admin',
    payload: { username: 'admin', password: PASSWORD },
  })).statusCode, 201);
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/session',
    payload: { username: 'admin', password: PASSWORD },
  });
  assert.equal(response.statusCode, 200);
  return cookieHeader(cookiesFrom(response));
}

function seedVerifiedDeployment(databasePath) {
  const database = openDatabase(databasePath);
  try {
    const user = database.prepare(`SELECT id FROM users WHERE username = 'admin'`).get();
    assert(user?.id);
    database.prepare(`
      INSERT INTO hosts(id, display_name, hostname, port, username, host_key_fingerprint, enabled, created_at, updated_at)
      VALUES ('host-1', 'Host', 'host.internal', 22, 'orc', 'SHA256:test', 1, ?, ?)
    `).run(NOW, NOW);
    database.prepare(`
      INSERT INTO ollama_targets(id, host_id, display_name, selected_container_id, enabled, created_at, updated_at)
      VALUES ('target-1', 'host-1', 'Primary target', 'container-1', 1, ?, ?)
    `).run(NOW, NOW);
    database.prepare(`
      INSERT INTO modelfiles(
        id, display_name, description, current_revision_id,
        created_by_user_id, updated_by_user_id, created_at, updated_at
      ) VALUES ('mf-1', 'Lifecycle Modelfile', NULL, NULL, ?, ?, ?, ?)
    `).run(String(user.id), String(user.id), NOW, NOW);
    database.prepare(`
      INSERT INTO modelfile_revisions(
        id, modelfile_id, revision_number, parent_revision_id, raw_text, content_sha256,
        source_kind, imported_target_id, imported_model, imported_digest,
        created_by_user_id, created_at
      ) VALUES ('rev-1', 'mf-1', 1, NULL, 'FROM llama3.2:latest\n', ?, 'manual', NULL, NULL, NULL, ?, ?)
    `).run(REV1_SHA, String(user.id), NOW);
    database.prepare(`
      INSERT INTO modelfile_revisions(
        id, modelfile_id, revision_number, parent_revision_id, raw_text, content_sha256,
        source_kind, imported_target_id, imported_model, imported_digest,
        created_by_user_id, created_at
      ) VALUES ('rev-2', 'mf-1', 2, 'rev-1', 'FROM llama3.2:latest\nPARAMETER num_ctx 8192\n', ?, 'manual', NULL, NULL, NULL, ?, ?)
    `).run(REV2_SHA, String(user.id), NOW);
    database.prepare(`UPDATE modelfiles SET current_revision_id = 'rev-2' WHERE id = 'mf-1'`).run();

    database.prepare(`
      INSERT INTO jobs(
        id, target_id, actor_user_id, kind, mutating, state, created_at, started_at,
        finished_at, result_json, error_class, exit_code
      ) VALUES ('create-1', 'target-1', ?, 'model-create', 1, 'running', ?, ?, NULL, NULL, NULL, NULL)
    `).run(String(user.id), NOW, NOW);
    database.prepare(`
      UPDATE jobs
      SET state = 'succeeded', finished_at = ?, result_json = ?
      WHERE id = 'create-1'
    `).run(NOW, JSON.stringify({
      planId: 'plan-1',
      modelfileId: 'mf-1',
      revisionId: 'rev-1',
      revisionSha256: REV1_SHA,
      payloadSha256: 'f'.repeat(64),
      outputModel: 'custom:model',
      baseModel: 'llama3.2:latest',
      selectedContainerId: 'container-1',
      digest: MODEL_DIGEST,
      sizeBytes: 123456,
      verified: true,
      baseModelObservation: { source: 'from' },
    }));
  } finally {
    database.close();
  }
}

test('deployment lifecycle routes are authenticated and expose evidence-backed producing revisions only', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orc-modelfile-deployment-read-'));
  const databasePath = path.join(directory, 'app.sqlite');
  const app = buildServer({ databasePath });
  registerModelfileDeploymentFeature(app, { databasePath });
  try {
    assert.equal((await app.inject({ method: 'GET', url: '/api/v1/modelfiles/mf-1/deployments' })).statusCode, 401);

    const cookie = await login(app);
    seedVerifiedDeployment(databasePath);

    let response = await app.inject({
      method: 'GET',
      url: '/api/v1/modelfiles/mf-1/deployments',
      headers: { cookie },
    });
    assert.equal(response.statusCode, 200);
    const artifactHistory = response.json().deployments;
    assert.equal(artifactHistory.length, 1);
    assert.deepEqual(artifactHistory[0], {
      id: 'create-1',
      targetId: 'target-1',
      modelfileId: 'mf-1',
      revisionId: 'rev-1',
      revisionSha256: REV1_SHA,
      outputModel: 'custom:model',
      modelDigest: MODEL_DIGEST,
      sizeBytes: 123456,
      baseModel: 'llama3.2:latest',
      sourceCreateJobId: 'create-1',
      actorUserId: artifactHistory[0].actorUserId,
      selectedContainerId: 'container-1',
      verifiedAt: NOW,
      libraryCurrentRevisionId: 'rev-2',
      producingRevisionIsLibraryCurrent: false,
    });
    assert.equal(typeof artifactHistory[0].actorUserId, 'string');

    response = await app.inject({
      method: 'GET',
      url: '/api/v1/modelfiles/mf-1/revisions/rev-1/deployments',
      headers: { cookie },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().deployments[0].revisionId, 'rev-1');

    response = await app.inject({
      method: 'GET',
      url: `/api/v1/targets/target-1/models/producing-revision?model=${encodeURIComponent('custom:model')}`,
      headers: { cookie },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().deployment.revisionId, 'rev-1');
    assert.equal(response.json().deployment.producingRevisionIsLibraryCurrent, false);

    response = await app.inject({
      method: 'GET',
      url: `/api/v1/targets/target-1/models/producing-revision?model=${encodeURIComponent('not-deployed:model')}`,
      headers: { cookie },
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { deployment: null });

    response = await app.inject({
      method: 'GET',
      url: '/api/v1/targets/target-1/models/producing-revision',
      headers: { cookie },
    });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error.code, 'MODEL_REQUIRED');

    response = await app.inject({
      method: 'GET',
      url: '/api/v1/modelfiles/mf-1/revisions/rev-missing/deployments',
      headers: { cookie },
    });
    assert.equal(response.statusCode, 404);
    assert.equal(response.json().error.code, 'MODELFILE_REVISION_NOT_FOUND');
  } finally {
    await app.close();
  }
});
