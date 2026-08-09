import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  applyMigrations,
  openDatabase,
  SqliteHostOnboardingRepository,
  SqliteOllamaTargetRepository,
  SqliteSshCredentialRepository,
} from '@orc/db';
import { HostOnboardingService } from '../dist/hosts.js';
import {
  OllamaModelInventoryError,
  OllamaModelInventoryService,
  parseInstalledModels,
  parseRunningModels,
} from '../dist/ollama-models.js';

const SSH_HOST = process.env.SSH_HOST;
const SSH_PORT = Number(process.env.SSH_PORT ?? '2222');
const SSH_USER = process.env.SSH_USER;
const SSH_PRIVATE_KEY_PATH = process.env.SSH_PRIVATE_KEY_PATH;
const DOCKER_FIXTURE_LOG = process.env.ORC_DOCKER_FIXTURE_LOG;
const CONTAINER_STATE = process.env.ORC_CONTAINER_STATE;
const HAS_FIXTURE = Boolean(SSH_HOST && SSH_USER && SSH_PRIVATE_KEY_PATH && DOCKER_FIXTURE_LOG && CONTAINER_STATE);
const MASTER_KEY = Buffer.alloc(32, 0x6d);
const NOW = '2026-08-08T20:30:00.000Z';
const DIGEST = 'a'.repeat(64);

function installedPayload() {
  return {
    models: [{
      name: 'qwen3.5:9b',
      model: 'qwen3.5:9b',
      modified_at: '2026-08-08T19:00:00.000Z',
      size: 6921000000,
      digest: DIGEST,
      details: {
        format: 'gguf', family: 'qwen3', families: ['qwen3'],
        parameter_size: '9.0B', quantization_level: 'Q4_K_XL',
      },
      secret_unknown_field: 'DO-NOT-RETURN',
    }],
    unknown_top_level: 'DO-NOT-RETURN',
  };
}

function runningPayload() {
  return {
    models: [{
      name: 'qwen3.5:9b',
      model: 'qwen3.5:9b',
      size: 6921000000,
      digest: DIGEST,
      details: {
        parent_model: '', format: 'gguf', family: 'qwen3', families: ['qwen3'],
        parameter_size: '9.0B', quantization_level: 'Q4_K_XL',
      },
      expires_at: '2026-08-08T21:30:00.000Z',
      size_vram: 6100000000,
      context_length: 32768,
      secret_unknown_field: 'DO-NOT-RETURN',
    }],
  };
}

function resetFixture() {
  if (!HAS_FIXTURE) return;
  fs.writeFileSync(DOCKER_FIXTURE_LOG, '');
  fs.writeFileSync(CONTAINER_STATE, 'running');
  fs.writeFileSync('/tmp/orc-status-fixture-mode', 'normal');
}

async function modelService() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orc-ollama-models-'));
  const database = openDatabase(path.join(directory, 'models.sqlite'));
  applyMigrations(database);
  const hosts = new SqliteHostOnboardingRepository(database);
  const credentials = new SqliteSshCredentialRepository(database);
  const targets = new SqliteOllamaTargetRepository(database);
  const onboarding = new HostOnboardingService(hosts, MASTER_KEY, () => new Date(NOW));
  const probe = await onboarding.probe({ hostname: SSH_HOST, port: SSH_PORT });
  const created = await onboarding.create({
    displayName: 'Model fixture host', hostname: SSH_HOST, port: SSH_PORT, username: SSH_USER,
    confirmedFingerprint: probe.fingerprint, privateKey: fs.readFileSync(SSH_PRIVATE_KEY_PATH, 'utf8'),
  });
  targets.saveSelection({
    id: 'target-models', hostId: created.id, displayName: 'Models Ollama',
    selectedContainerId: 'ollama-container-id', containerNameOverride: null, enabled: true,
    createdAt: NOW, updatedAt: NOW,
  });
  return {
    database,
    service: new OllamaModelInventoryService(hosts, credentials, targets, MASTER_KEY),
  };
}

async function listenModelServer(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(11434, '127.0.0.1', resolve);
  });
  return server;
}

async function closeServer(server) {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

test('model parsers normalize only bounded safe official fields and drop unknown fields', () => {
  const installed = parseInstalledModels(Buffer.from(JSON.stringify(installedPayload())));
  assert.deepEqual(installed, [{
    name: 'qwen3.5:9b', model: 'qwen3.5:9b', modifiedAt: '2026-08-08T19:00:00.000Z',
    sizeBytes: 6921000000, digest: DIGEST,
    details: {
      format: 'gguf', family: 'qwen3', families: ['qwen3'],
      parameterSize: '9.0B', quantizationLevel: 'Q4_K_XL',
    },
  }]);
  const running = parseRunningModels(Buffer.from(JSON.stringify(runningPayload())));
  assert.deepEqual(running, [{
    name: 'qwen3.5:9b', model: 'qwen3.5:9b', sizeBytes: 6921000000, digest: DIGEST,
    details: {
      format: 'gguf', family: 'qwen3', families: ['qwen3'],
      parameterSize: '9.0B', quantizationLevel: 'Q4_K_XL',
    },
    expiresAt: '2026-08-08T21:30:00.000Z', sizeVramBytes: 6100000000, contextLength: 32768,
  }]);
  assert.equal(JSON.stringify({ installed, running }).includes('DO-NOT-RETURN'), false);
});

test('model parsers reject malformed core fields, invalid timestamps and oversized arrays', () => {
  const invalidDigest = installedPayload();
  invalidDigest.models[0].digest = 'not-a-digest';
  assert.throws(
    () => parseInstalledModels(Buffer.from(JSON.stringify(invalidDigest))),
    (error) => error instanceof OllamaModelInventoryError && error.code === 'OLLAMA_MODEL_DATA_INVALID',
  );

  const invalidTime = runningPayload();
  invalidTime.models[0].expires_at = 'not-a-date';
  assert.throws(
    () => parseRunningModels(Buffer.from(JSON.stringify(invalidTime))),
    (error) => error instanceof OllamaModelInventoryError && error.code === 'OLLAMA_MODEL_DATA_INVALID',
  );

  assert.throws(
    () => parseInstalledModels(Buffer.from(JSON.stringify({ models: Array.from({ length: 1001 }, () => ({})) }))),
    (error) => error instanceof OllamaModelInventoryError && error.code === 'OLLAMA_MODEL_DATA_INVALID',
  );
});

test('real OpenSSH forwarding reads tags and ps after only persisted-container inspect', { skip: !HAS_FIXTURE }, async () => {
  resetFixture();
  const requests = [];
  const server = await listenModelServer((request, response) => {
    requests.push({ method: request.method, url: request.url });
    response.setHeader('content-type', 'application/json');
    if (request.url === '/api/tags') response.end(JSON.stringify(installedPayload()));
    else if (request.url === '/api/ps') response.end(JSON.stringify(runningPayload()));
    else { response.statusCode = 404; response.end('{}'); }
  });
  const { database, service } = await modelService();
  try {
    fs.writeFileSync(DOCKER_FIXTURE_LOG, '');
    const result = await service.read('target-models');
    assert.equal(result.targetId, 'target-models');
    assert.deepEqual(result.transport, { mode: 'published-binding' });
    assert.equal(result.installed.length, 1);
    assert.equal(result.running.length, 1);
    assert.deepEqual(requests, [
      { method: 'GET', url: '/api/tags' },
      { method: 'GET', url: '/api/ps' },
    ]);
    const dockerCalls = fs.readFileSync(DOCKER_FIXTURE_LOG, 'utf8').trim().split(/\r?\n/u).filter(Boolean);
    assert.deepEqual(dockerCalls, ['inspect ollama-container-id']);
  } finally {
    database.close();
    await closeServer(server);
    resetFixture();
  }
});

test('non-2xx and invalid model API responses fail safely without leaking remote bodies', { skip: !HAS_FIXTURE }, async () => {
  resetFixture();
  let mode = 'http-error';
  const server = await listenModelServer((request, response) => {
    if (request.url === '/api/tags') {
      if (mode === 'http-error') { response.statusCode = 503; response.end('SECRET-MODEL-BODY'); return; }
      response.end('not-json SECRET-MODEL-BODY');
      return;
    }
    response.end(JSON.stringify(runningPayload()));
  });
  const { database, service } = await modelService();
  try {
    for (const nextMode of ['http-error', 'invalid-json']) {
      mode = nextMode;
      await assert.rejects(
        () => service.read('target-models'),
        (error) => {
          assert(error instanceof OllamaModelInventoryError);
          assert.equal(error.message.includes('SECRET-MODEL-BODY'), false);
          return true;
        },
      );
    }
  } finally {
    database.close();
    await closeServer(server);
    resetFixture();
  }
});
