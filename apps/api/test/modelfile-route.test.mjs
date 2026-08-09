import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildServer } from '../dist/server.js';

const SSH_HOST = process.env.SSH_HOST;
const SSH_PORT = Number(process.env.SSH_PORT ?? '2222');
const SSH_USER = process.env.SSH_USER;
const SSH_PRIVATE_KEY_PATH = process.env.SSH_PRIVATE_KEY_PATH;
const DOCKER_FIXTURE_LOG = process.env.ORC_DOCKER_FIXTURE_LOG;
const CONTAINER_STATE = process.env.ORC_CONTAINER_STATE;
const HAS_FIXTURE = Boolean(SSH_HOST && SSH_USER && SSH_PRIVATE_KEY_PATH && DOCKER_FIXTURE_LOG && CONTAINER_STATE);
const MASTER_KEY = Buffer.alloc(32, 0x74);
const PASSWORD = 'modelfile-route-admin-password!';
const OBSERVED_DIGEST = 'e'.repeat(64);
const FORGED_DIGEST = 'f'.repeat(64);
const OBSERVED_MODEFILE = '# observed from Ollama\nFROM /root/.ollama/models/blobs/sha256:abc\nPARAMETER num_ctx 32768\n';
const FORGED_MODEFILE = 'FROM forged-browser-content:latest\n';

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
  const bootstrap = await app.inject({
    method: 'POST', url: '/api/v1/setup/admin', payload: { username: 'admin', password: PASSWORD },
  });
  assert.equal(bootstrap.statusCode, 201);
  const login = await app.inject({
    method: 'POST', url: '/api/v1/session', payload: { username: 'admin', password: PASSWORD },
  });
  assert.equal(login.statusCode, 200);
  return cookiesFrom(login);
}

async function onboard(app, cookies) {
  const probe = await app.inject({
    method: 'POST', url: '/api/v1/hosts/probe', headers: mutationHeaders(cookies),
    payload: { hostname: SSH_HOST, port: SSH_PORT },
  });
  assert.equal(probe.statusCode, 200);
  const create = await app.inject({
    method: 'POST', url: '/api/v1/hosts', headers: mutationHeaders(cookies),
    payload: {
      displayName: 'Modelfile import host', hostname: SSH_HOST, port: SSH_PORT, username: SSH_USER,
      confirmedFingerprint: probe.json().fingerprint,
      privateKey: fs.readFileSync(SSH_PRIVATE_KEY_PATH, 'utf8'),
    },
  });
  assert.equal(create.statusCode, 201);
  const hostId = create.json().host.id;
  const selected = await app.inject({
    method: 'POST', url: `/api/v1/hosts/${hostId}/targets`, headers: mutationHeaders(cookies),
    payload: { containerId: 'ollama-container-id', displayName: 'Primary Ollama' },
  });
  assert.equal(selected.statusCode, 201);
  return selected.json().target.id;
}

async function readJsonRequest(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function listenModelServer(requests) {
  const server = http.createServer(async (request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.method === 'GET' && request.url === '/api/tags') {
      requests.push({ method: request.method, url: request.url, body: null });
      response.end(JSON.stringify({
        models: [{
          name: 'hf.co/example/model:Q4_K_M',
          model: 'hf.co/example/model:Q4_K_M',
          modified_at: '2026-08-09T05:00:00Z',
          size: 123456,
          digest: OBSERVED_DIGEST,
          details: {
            format: 'gguf', family: 'qwen3', families: ['qwen3'],
            parameter_size: '9B', quantization_level: 'Q4_K_M',
          },
        }],
      }));
      return;
    }
    if (request.method === 'POST' && request.url === '/api/show') {
      const body = await readJsonRequest(request);
      requests.push({ method: request.method, url: request.url, body });
      response.end(JSON.stringify({
        modelfile: OBSERVED_MODEFILE,
        parameters: 'num_ctx 32768',
        template: '{{ .Prompt }}',
        details: { parent_model: '' },
        capabilities: ['completion'],
        model_info: {
          'general.architecture': 'qwen3',
          'general.parameter_count': 9000000000,
          'qwen3.context_length': 32768,
        },
      }));
      return;
    }
    response.statusCode = 404;
    response.end('{}');
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(11434, '127.0.0.1', resolve);
  });
  return server;
}

async function closeServer(server) {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

test('local Modelfile routes enforce auth, CSRF, exact raw revisions and optimistic concurrency', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orc-modelfile-route-'));
  const app = buildServer({
    databasePath: path.join(directory, 'app.sqlite'),
    environment: { ORC_MASTER_KEY: MASTER_KEY.toString('base64') },
  });
  try {
    const unauthenticated = await app.inject({ method: 'GET', url: '/api/v1/modelfiles' });
    assert.equal(unauthenticated.statusCode, 401);

    const cookies = await authenticate(app);
    const noCsrf = await app.inject({
      method: 'POST',
      url: '/api/v1/modelfiles',
      headers: { cookie: cookieHeader(cookies) },
      payload: { displayName: 'Rejected', rawText: 'FROM rejected:latest\n' },
    });
    assert.equal(noCsrf.statusCode, 403);
    assert.equal(noCsrf.json().error.code, 'CSRF_INVALID');

    const raw1 = '# preserve CRLF\r\nFROM llama3.2:latest\r\nPARAMETER num_ctx 8192\r\n';
    const createdResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/modelfiles',
      headers: mutationHeaders(cookies),
      payload: { displayName: 'Local llama', description: 'First draft', rawText: raw1 },
    });
    assert.equal(createdResponse.statusCode, 201);
    const created = createdResponse.json().modelfile;
    assert.equal(created.currentRevision.revisionNumber, 1);
    assert.equal(created.currentRevision.rawText, raw1);

    const listResponse = await app.inject({
      method: 'GET', url: '/api/v1/modelfiles', headers: { cookie: cookieHeader(cookies) },
    });
    assert.equal(listResponse.statusCode, 200);
    const listed = listResponse.json().modelfiles;
    assert.equal(listed.length, 1);
    assert.equal(Object.hasOwn(listed[0], 'currentRevision'), false);
    assert.equal(JSON.stringify(listed).includes(raw1), false);

    const raw2 = '# revision 2\nFROM llama3.2:latest\nPARAMETER num_ctx 16384\n';
    const appendedResponse = await app.inject({
      method: 'POST',
      url: `/api/v1/modelfiles/${created.id}/revisions`,
      headers: mutationHeaders(cookies),
      payload: { expectedCurrentRevisionId: created.currentRevisionId, rawText: raw2 },
    });
    assert.equal(appendedResponse.statusCode, 201);
    const appended = appendedResponse.json().modelfile;
    assert.equal(appended.currentRevision.revisionNumber, 2);
    assert.equal(appended.currentRevision.parentRevisionId, created.currentRevisionId);
    assert.equal(appended.currentRevision.rawText, raw2);

    const staleResponse = await app.inject({
      method: 'POST',
      url: `/api/v1/modelfiles/${created.id}/revisions`,
      headers: mutationHeaders(cookies),
      payload: { expectedCurrentRevisionId: created.currentRevisionId, rawText: 'FROM stale:latest\n' },
    });
    assert.equal(staleResponse.statusCode, 409);
    assert.equal(staleResponse.json().error.code, 'MODEFILE_REVISION_CONFLICT');

    const historyResponse = await app.inject({
      method: 'GET',
      url: `/api/v1/modelfiles/${created.id}/revisions`,
      headers: { cookie: cookieHeader(cookies) },
    });
    assert.equal(historyResponse.statusCode, 200);
    const history = historyResponse.json().revisions;
    assert.deepEqual(history.map((revision) => revision.revisionNumber), [2, 1]);
    assert.equal(JSON.stringify(history).includes(raw1), false);
    assert.equal(JSON.stringify(history).includes(raw2), false);

    const oldRevisionResponse = await app.inject({
      method: 'GET',
      url: `/api/v1/modelfiles/${created.id}/revisions/${created.currentRevisionId}`,
      headers: { cookie: cookieHeader(cookies) },
    });
    assert.equal(oldRevisionResponse.statusCode, 200);
    assert.equal(oldRevisionResponse.json().revision.rawText, raw1);

    const currentResponse = await app.inject({
      method: 'GET',
      url: `/api/v1/modelfiles/${created.id}`,
      headers: { cookie: cookieHeader(cookies) },
    });
    assert.equal(currentResponse.statusCode, 200);
    assert.equal(currentResponse.json().modelfile.currentRevision.rawText, raw2);
  } finally {
    await app.close();
  }
});

test('installed-model import requires CSRF and persists only server-observed model digest and Modelfile', { skip: !HAS_FIXTURE }, async () => {
  fs.writeFileSync(DOCKER_FIXTURE_LOG, '');
  fs.writeFileSync(CONTAINER_STATE, 'running');
  fs.writeFileSync('/tmp/orc-status-fixture-mode', 'normal');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orc-modelfile-import-route-'));
  const app = buildServer({
    databasePath: path.join(directory, 'app.sqlite'),
    environment: { ORC_MASTER_KEY: MASTER_KEY.toString('base64') },
  });
  const requests = [];
  const modelServer = await listenModelServer(requests);
  try {
    const cookies = await authenticate(app);
    const targetId = await onboard(app, cookies);
    fs.writeFileSync(DOCKER_FIXTURE_LOG, '');
    requests.length = 0;

    const noCsrf = await app.inject({
      method: 'POST',
      url: '/api/v1/modelfiles/import-installed',
      headers: { cookie: cookieHeader(cookies) },
      payload: { targetId, model: 'hf.co/example/model:Q4_K_M' },
    });
    assert.equal(noCsrf.statusCode, 403);
    assert.deepEqual(requests, []);
    assert.equal(fs.readFileSync(DOCKER_FIXTURE_LOG, 'utf8'), '');

    const importedResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/modelfiles/import-installed',
      headers: mutationHeaders(cookies),
      payload: {
        targetId,
        model: 'hf.co/example/model:Q4_K_M',
        displayName: 'Imported through API',
        description: 'Browser may set local metadata only',
        digest: FORGED_DIGEST,
        rawText: FORGED_MODEFILE,
        importedTargetId: 'forged-target',
      },
    });
    assert.equal(importedResponse.statusCode, 201);
    const imported = importedResponse.json().modelfile;
    assert.equal(imported.displayName, 'Imported through API');
    assert.equal(imported.currentRevision.sourceKind, 'installed-model-import');
    assert.equal(imported.currentRevision.importedTargetId, targetId);
    assert.equal(imported.currentRevision.importedModel, 'hf.co/example/model:Q4_K_M');
    assert.equal(imported.currentRevision.importedDigest, OBSERVED_DIGEST);
    assert.equal(imported.currentRevision.rawText, OBSERVED_MODEFILE);
    assert.equal(imported.currentRevision.rawText.includes(FORGED_MODEFILE), false);
    assert.equal(imported.currentRevision.importedDigest === FORGED_DIGEST, false);

    assert.deepEqual(requests, [
      { method: 'GET', url: '/api/tags', body: null },
      { method: 'POST', url: '/api/show', body: { model: 'hf.co/example/model:Q4_K_M', verbose: false } },
    ]);
    assert.deepEqual(fs.readFileSync(DOCKER_FIXTURE_LOG, 'utf8').trim().split(/\r?\n/u).filter(Boolean), [
      'inspect ollama-container-id',
    ]);
  } finally {
    await app.close();
    await closeServer(modelServer);
  }
});
