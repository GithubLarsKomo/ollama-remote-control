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
import { SecretCipher } from '@orc/security';
import { HostOnboardingService } from '../dist/hosts.js';
import {
  OllamaHealthError,
  OllamaHealthService,
  selectOllamaApiRoute,
} from '../dist/ollama-health.js';
import {
  parseHttpResponse,
  SshHttpError,
} from '../dist/ssh-http.js';

const SSH_HOST = process.env.SSH_HOST;
const SSH_PORT = Number(process.env.SSH_PORT ?? '2222');
const SSH_USER = process.env.SSH_USER;
const SSH_PRIVATE_KEY_PATH = process.env.SSH_PRIVATE_KEY_PATH;
const DOCKER_FIXTURE_LOG = process.env.ORC_DOCKER_FIXTURE_LOG;
const CONTAINER_STATE = process.env.ORC_CONTAINER_STATE;
const HAS_FIXTURE = Boolean(SSH_HOST && SSH_USER && SSH_PRIVATE_KEY_PATH && DOCKER_FIXTURE_LOG && CONTAINER_STATE);
const STATUS_MODE = '/tmp/orc-status-fixture-mode';
const MASTER_KEY = Buffer.alloc(32, 0x74);
const NOW = '2026-08-08T10:30:00.000Z';

function resetFixture() {
  if (!HAS_FIXTURE) return;
  fs.writeFileSync(DOCKER_FIXTURE_LOG, '');
  fs.writeFileSync(CONTAINER_STATE, 'running');
  fs.writeFileSync(STATUS_MODE, 'normal');
}

function dockerCalls() {
  return fs.readFileSync(DOCKER_FIXTURE_LOG, 'utf8').trim().split(/\r?\n/u).filter(Boolean);
}

async function healthService() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orc-ollama-health-'));
  const database = openDatabase(path.join(directory, 'health.sqlite'));
  applyMigrations(database);
  const hosts = new SqliteHostOnboardingRepository(database);
  const credentials = new SqliteSshCredentialRepository(database);
  const targets = new SqliteOllamaTargetRepository(database);
  const onboarding = new HostOnboardingService(hosts, MASTER_KEY, () => new Date(NOW));
  const probe = await onboarding.probe({ hostname: SSH_HOST, port: SSH_PORT });
  const created = await onboarding.create({
    displayName: 'Health fixture host',
    hostname: SSH_HOST,
    port: SSH_PORT,
    username: SSH_USER,
    confirmedFingerprint: probe.fingerprint,
    privateKey: fs.readFileSync(SSH_PRIVATE_KEY_PATH, 'utf8'),
  });
  targets.saveSelection({
    id: 'target-health',
    hostId: created.id,
    displayName: 'Health Ollama',
    selectedContainerId: 'ollama-container-id',
    containerNameOverride: null,
    enabled: true,
    createdAt: NOW,
    updatedAt: NOW,
  });
  const service = new OllamaHealthService(hosts, credentials, targets, MASTER_KEY);
  return { database, service };
}

async function listenVersionServer(handler) {
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

test('published binding selection is deterministic and container-network fallback accepts only safe IPv4', () => {
  assert.deepEqual(selectOllamaApiRoute({
    HostConfig: { PortBindings: { '11434/tcp': [
      { HostIp: '192.168.1.20', HostPort: '22000' },
      { HostIp: '0.0.0.0', HostPort: '11434' },
      { HostIp: '127.0.0.1', HostPort: '12000' },
    ] } },
  }), { mode: 'published-binding', host: '127.0.0.1', port: 11434 });

  assert.deepEqual(selectOllamaApiRoute({
    HostConfig: { PortBindings: {} },
    NetworkSettings: { Networks: {
      zeta: { IPAddress: '127.0.0.2' },
      alpha: { IPAddress: '172.18.0.9' },
      beta: { IPAddress: '169.254.1.2' },
    } },
  }), { mode: 'container-network', host: '172.18.0.9', port: 11434 });

  assert.equal(selectOllamaApiRoute({
    HostConfig: { PortBindings: {} },
    NetworkSettings: { Networks: { bad: { IPAddress: '224.0.0.1' } } },
  }), null);
});

test('HTTP parser accepts content-length and chunked responses and enforces body limits', () => {
  const content = parseHttpResponse(Buffer.from('HTTP/1.1 200 OK\r\nContent-Length: 19\r\n\r\n{"version":"1.2.3"}', 'utf8'), 1024);
  assert.equal(content.statusCode, 200);
  assert.equal(content.body.toString('utf8'), '{"version":"1.2.3"}');

  const chunked = parseHttpResponse(Buffer.from('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n7\r\n{"versi\r\nc\r\non":"1.2.3"}\r\n0\r\n\r\n', 'utf8'), 1024);
  assert.equal(chunked.body.toString('utf8'), '{"version":"1.2.3"}');

  assert.throws(
    () => parseHttpResponse(Buffer.from('HTTP/1.1 200 OK\r\nContent-Length: 2048\r\n\r\n', 'utf8'), 1024),
    (error) => error instanceof SshHttpError && error.code === 'HTTP_RESPONSE_TOO_LARGE',
  );
});

test('real OpenSSH forwarding verifies container, CLI and Ollama /api/version without exposing port publicly', { skip: !HAS_FIXTURE }, async () => {
  resetFixture();
  let requests = 0;
  const server = await listenVersionServer((request, response) => {
    requests += 1;
    assert.equal(request.method, 'GET');
    assert.equal(request.url, '/api/version');
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ version: '0.32.5' }));
  });
  const { database, service } = await healthService();
  try {
    fs.writeFileSync(DOCKER_FIXTURE_LOG, '');
    const result = await service.read('target-health');
    assert.deepEqual(result, {
      targetId: 'target-health',
      status: 'healthy',
      container: { running: true },
      ollama: {
        cliVersion: '0.32.5',
        apiReachable: true,
        apiVersion: '0.32.5',
        versionMatch: true,
      },
      transport: { mode: 'published-binding' },
    });
    assert.equal(requests, 1);
    assert.deepEqual(dockerCalls(), [
      'inspect ollama-container-id',
      'exec ollama-container-id ollama --version',
    ]);
  } finally {
    database.close();
    await closeServer(server);
    resetFixture();
  }
});

test('CLI/API mismatch is explicit degraded health rather than a guessed version', { skip: !HAS_FIXTURE }, async () => {
  resetFixture();
  const server = await listenVersionServer((_request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ version: '0.33.0' }));
  });
  const { database, service } = await healthService();
  try {
    const result = await service.read('target-health');
    assert.equal(result.status, 'degraded');
    assert.equal(result.ollama.cliVersion, '0.32.5');
    assert.equal(result.ollama.apiVersion, '0.33.0');
    assert.equal(result.ollama.versionMatch, false);
  } finally {
    database.close();
    await closeServer(server);
    resetFixture();
  }
});

test('container-not-running and CLI failure stop before any API request', { skip: !HAS_FIXTURE }, async () => {
  resetFixture();
  let requests = 0;
  const server = await listenVersionServer((_request, response) => {
    requests += 1;
    response.end(JSON.stringify({ version: '0.32.5' }));
  });
  const { database, service } = await healthService();
  try {
    fs.writeFileSync(CONTAINER_STATE, 'stopped');
    await assert.rejects(
      () => service.read('target-health'),
      (error) => error instanceof OllamaHealthError && error.code === 'CONTAINER_NOT_RUNNING',
    );
    assert.equal(requests, 0);
    assert.deepEqual(dockerCalls(), ['inspect ollama-container-id']);

    resetFixture();
    fs.writeFileSync(STATUS_MODE, 'degraded');
    await assert.rejects(
      () => service.read('target-health'),
      (error) => error instanceof OllamaHealthError && error.code === 'OLLAMA_CLI_ERROR',
    );
    assert.equal(requests, 0);
    assert.deepEqual(dockerCalls(), [
      'inspect ollama-container-id',
      'exec ollama-container-id ollama --version',
    ]);
  } finally {
    database.close();
    await closeServer(server);
    resetFixture();
  }
});

test('invalid, non-2xx and oversized API responses fail with safe typed errors', { skip: !HAS_FIXTURE }, async () => {
  resetFixture();
  let mode = 'invalid';
  const server = await listenVersionServer((_request, response) => {
    if (mode === 'invalid') response.end('not-json SECRET-HTTP-BODY');
    else if (mode === 'error') { response.statusCode = 503; response.end('SECRET-HTTP-BODY'); }
    else response.end(JSON.stringify({ version: 'x'.repeat(70 * 1024) }));
  });
  const { database, service } = await healthService();
  try {
    for (const nextMode of ['invalid', 'error', 'oversized']) {
      mode = nextMode;
      await assert.rejects(
        () => service.read('target-health'),
        (error) => {
          assert(error instanceof OllamaHealthError);
          assert.equal(error.code, 'OLLAMA_API_ERROR');
          assert.equal(error.message.includes('SECRET-HTTP-BODY'), false);
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
