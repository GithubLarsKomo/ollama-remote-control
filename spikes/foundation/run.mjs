import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import Fastify from 'fastify';
import Database from 'better-sqlite3';
import { Client as SSHClient } from 'ssh2';
import WebSocket, { WebSocketServer } from 'ws';

const results = [];
const pass = (name, detail = '') => {
  results.push({ name, ok: true, detail });
  console.log(`[PASS] ${name}${detail ? ` — ${detail}` : ''}`);
};
const fail = (name, error) => {
  results.push({ name, ok: false, detail: error?.stack ?? String(error) });
  console.error(`[FAIL] ${name}`, error);
};

async function withStep(name, fn) {
  try {
    const detail = await fn();
    pass(name, detail ?? '');
  } catch (error) {
    fail(name, error);
    throw error;
  }
}

function fingerprint(key) {
  return `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/u, '')}`;
}

function connectSsh({ expectedFingerprint = null } = {}) {
  const privateKeyPath = process.env.SSH_PRIVATE_KEY_PATH;
  assert(privateKeyPath, 'SSH_PRIVATE_KEY_PATH is required');
  const config = {
    host: process.env.SSH_HOST ?? '127.0.0.1',
    port: Number(process.env.SSH_PORT ?? '2222'),
    username: process.env.SSH_USER ?? 'orcspike',
    privateKey: fs.readFileSync(privateKeyPath),
    readyTimeout: 10_000,
  };

  return new Promise((resolve, reject) => {
    const client = new SSHClient();
    let observedFingerprint = null;
    client
      .on('ready', () => resolve({ client, fingerprint: observedFingerprint }))
      .on('error', reject)
      .connect({
        ...config,
        hostVerifier(key) {
          observedFingerprint = fingerprint(key);
          return expectedFingerprint ? observedFingerprint === expectedFingerprint : true;
        },
      });
  });
}

function endSsh(client) {
  return new Promise((resolve) => {
    client.once('close', resolve);
    client.end();
  });
}

function sshExec(client, command) {
  return new Promise((resolve, reject) => {
    client.exec(command, (error, stream) => {
      if (error) return reject(error);
      let stdout = '';
      let stderr = '';
      let exitCode = null;
      stream.on('data', (chunk) => { stdout += chunk.toString(); });
      stream.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
      stream.on('exit', (code) => { exitCode = code; });
      stream.on('close', () => resolve({ stdout, stderr, exitCode }));
      stream.on('error', reject);
    });
  });
}

function sshForwardHttp(client, targetPort) {
  return new Promise((resolve, reject) => {
    client.forwardOut('127.0.0.1', 0, '127.0.0.1', targetPort, (error, stream) => {
      if (error) return reject(error);
      let response = '';
      stream.on('data', (chunk) => { response += chunk.toString(); });
      stream.on('end', () => resolve(response));
      stream.on('error', reject);
      stream.end('GET /api/version HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n');
    });
  });
}

function sshPty(client) {
  return new Promise((resolve, reject) => {
    client.shell({ term: 'xterm', cols: 80, rows: 24 }, (error, stream) => {
      if (error) return reject(error);
      let output = '';
      stream.on('data', (chunk) => { output += chunk.toString(); });
      stream.on('close', () => resolve(output));
      stream.on('error', reject);
      stream.write("printf 'PTY_OK\\n'\nexit\n");
    });
  });
}

async function runDatabaseGate() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orc-sqlite-'));
  const filename = path.join(dir, 'foundation.sqlite');
  const db = new Database(filename);
  try {
    const journalMode = db.pragma('journal_mode = WAL', { simple: true });
    db.pragma('foreign_keys = ON');
    assert.equal(String(journalMode).toLowerCase(), 'wal');
    assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
    db.exec(`
      CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      CREATE TABLE hosts(id TEXT PRIMARY KEY, display_name TEXT NOT NULL);
      INSERT INTO schema_migrations(version, applied_at) VALUES (1, datetime('now'));
      INSERT INTO hosts(id, display_name) VALUES ('host-1', 'Foundation Spike');
    `);
    assert.equal(db.prepare('SELECT count(*) AS n FROM schema_migrations').get().n, 1);
    assert.equal(db.prepare('SELECT display_name FROM hosts WHERE id = ?').get('host-1').display_name, 'Foundation Spike');
  } finally {
    db.close();
  }
  assert(fs.existsSync(filename));
  return `WAL + FK + migration on ${path.basename(filename)}`;
}

async function runWebGate() {
  const app = Fastify({ logger: false });
  app.get('/health', async () => ({ ok: true }));
  app.get('/events', async (request, reply) => {
    reply.hijack();
    const last = Number(request.headers['last-event-id'] ?? 0);
    const sequence = last + 1;
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'close',
    });
    reply.raw.end(`id: ${sequence}\nevent: progress\ndata: ${JSON.stringify({ sequence })}\n\n`);
  });

  const wss = new WebSocketServer({ server: app.server, path: '/expert-terminal' });
  wss.on('connection', (socket) => socket.on('message', (data) => socket.send(`echo:${data.toString()}`)));

  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  assert(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;

  try {
    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true });

    const first = await fetch(`${base}/events`);
    const firstText = await first.text();
    assert.match(firstText, /id: 1/u);

    const second = await fetch(`${base}/events`, { headers: { 'Last-Event-ID': '1' } });
    const secondText = await second.text();
    assert.match(secondText, /id: 2/u);

    const wsUrl = `ws://127.0.0.1:${address.port}/expert-terminal`;
    const ws = new WebSocket(wsUrl);
    await once(ws, 'open');
    ws.send('terminal-probe');
    const [message] = await once(ws, 'message');
    assert.equal(message.toString(), 'echo:terminal-probe');
    ws.close();
    await once(ws, 'close');
  } finally {
    wss.close();
    await app.close();
  }

  return 'Fastify health + SSE replay + WebSocket duplex';
}

async function runSshGate() {
  const probe = await connectSsh();
  const pinnedFingerprint = probe.fingerprint;
  assert.match(pinnedFingerprint, /^SHA256:/u);
  await endSsh(probe.client);

  const { client, fingerprint: verifiedFingerprint } = await connectSsh({ expectedFingerprint: pinnedFingerprint });
  assert.equal(verifiedFingerprint, pinnedFingerprint);

  const mock = http.createServer((request, response) => {
    if (request.url === '/api/version') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ version: 'foundation-mock' }));
      return;
    }
    response.writeHead(404).end();
  });
  mock.listen(0, '127.0.0.1');
  await once(mock, 'listening');
  const mockAddress = mock.address();
  assert(mockAddress && typeof mockAddress === 'object');

  try {
    const exec = await sshExec(client, "sh -lc 'printf STDOUT_OK; printf STDERR_OK >&2; exit 7'");
    assert.equal(exec.stdout, 'STDOUT_OK');
    assert.equal(exec.stderr, 'STDERR_OK');
    assert.equal(exec.exitCode, 7);

    const forwarded = await sshForwardHttp(client, mockAddress.port);
    assert.match(forwarded, /200 OK/u);
    assert.match(forwarded, /foundation-mock/u);

    const ptyOutput = await sshPty(client);
    assert.match(ptyOutput, /PTY_OK/u);
  } finally {
    mock.close();
    await endSsh(client);
  }

  return `${pinnedFingerprint}; exec + forward + PTY`;
}

let failed = false;
for (const [name, fn] of [
  ['SQLite file/WAL/FK/migration', runDatabaseGate],
  ['Fastify/SSE/WebSocket', runWebGate],
  ['SSH probe/pin/exec/forward/PTY', runSshGate],
]) {
  try {
    await withStep(name, fn);
  } catch {
    failed = true;
  }
}

console.log(JSON.stringify({ node: process.version, results }, null, 2));
if (failed) process.exitCode = 1;
