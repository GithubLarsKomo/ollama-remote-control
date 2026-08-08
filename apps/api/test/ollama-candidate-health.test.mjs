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
  OllamaHealthError,
  OllamaHealthService,
} from '../dist/ollama-health.js';

const SSH_HOST = process.env.SSH_HOST;
const SSH_PORT = Number(process.env.SSH_PORT ?? '2222');
const SSH_USER = process.env.SSH_USER;
const SSH_PRIVATE_KEY_PATH = process.env.SSH_PRIVATE_KEY_PATH;
const DOCKER_FIXTURE_LOG = process.env.ORC_DOCKER_FIXTURE_LOG;
const CONTAINER_STATE = process.env.ORC_CONTAINER_STATE;
const HAS_FIXTURE = Boolean(SSH_HOST && SSH_USER && SSH_PRIVATE_KEY_PATH && DOCKER_FIXTURE_LOG && CONTAINER_STATE);
const STATUS_MODE = '/tmp/orc-status-fixture-mode';
const MASTER_KEY = Buffer.alloc(32, 0x77);
const NOW = '2026-08-08T11:30:00.000Z';

function resetFixture() {
  if (!HAS_FIXTURE) return;
  fs.writeFileSync(DOCKER_FIXTURE_LOG, '');
  fs.writeFileSync(CONTAINER_STATE, 'running');
  fs.writeFileSync(STATUS_MODE, 'normal');
}

function dockerCalls() {
  return fs.readFileSync(DOCKER_FIXTURE_LOG, 'utf8').trim().split(/\r?\n/u).filter(Boolean);
}

async function createService() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orc-candidate-health-'));
  const database = openDatabase(path.join(directory, 'health.sqlite'));
  applyMigrations(database);
  const hosts = new SqliteHostOnboardingRepository(database);
  const credentials = new SqliteSshCredentialRepository(database);
  const targets = new SqliteOllamaTargetRepository(database);
  const onboarding = new HostOnboardingService(hosts, MASTER_KEY, () => new Date(NOW));
  const probe = await onboarding.probe({ hostname: SSH_HOST, port: SSH_PORT });
  const host = await onboarding.create({
    displayName: 'Candidate health host',
    hostname: SSH_HOST,
    port: SSH_PORT,
    username: SSH_USER,
    confirmedFingerprint: probe.fingerprint,
    privateKey: fs.readFileSync(SSH_PRIVATE_KEY_PATH, 'utf8'),
  });
  targets.saveSelection({
    id: 'target-candidate-health',
    hostId: host.id,
    displayName: 'Candidate Ollama',
    selectedContainerId: 'ollama-container-id',
    containerNameOverride: null,
    enabled: true,
    createdAt: NOW,
    updatedAt: NOW,
  });
  return {
    database,
    targets,
    service: new OllamaHealthService(hosts, credentials, targets, MASTER_KEY),
  };
}

async function listenVersionServer() {
  const server = http.createServer((request, response) => {
    assert.equal(request.method, 'GET');
    assert.equal(request.url, '/api/version');
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ version: '0.32.5' }));
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

test('candidate health checks a server-supplied container without changing the persisted target binding', { skip: !HAS_FIXTURE }, async () => {
  resetFixture();
  const server = await listenVersionServer();
  const { database, targets, service } = await createService();
  try {
    fs.writeFileSync(DOCKER_FIXTURE_LOG, '');
    const result = await service.readContainer('target-candidate-health', 'candidate-container-id');
    assert.equal(result.status, 'healthy');
    assert.equal(result.targetId, 'target-candidate-health');
    assert.equal(result.ollama.cliVersion, '0.32.5');
    assert.equal(result.ollama.apiVersion, '0.32.5');
    assert.deepEqual(dockerCalls(), [
      'inspect candidate-container-id',
      'exec candidate-container-id ollama --version',
    ]);
    assert.equal(targets.findById('target-candidate-health').selectedContainerId, 'ollama-container-id');
  } finally {
    database.close();
    await closeServer(server);
    resetFixture();
  }
});

test('invalid candidate container identifier fails before target resolution or SSH', async () => {
  let repositoryReads = 0;
  const never = () => { repositoryReads += 1; return null; };
  const service = new OllamaHealthService(
    { createHostWithCredential() { throw new Error('not used'); }, findHostById: never },
    { save() { throw new Error('not used'); }, findByHostId: never },
    { saveSelection() { throw new Error('not used'); }, findById: never, findByHostId() { repositoryReads += 1; return []; } },
    Buffer.alloc(32, 0x77),
  );
  await assert.rejects(
    () => service.readContainer('target-candidate-health', 'bad container;id'),
    (error) => error instanceof OllamaHealthError && error.code === 'INVALID_CONTAINER_ID',
  );
  assert.equal(repositoryReads, 0);
});
