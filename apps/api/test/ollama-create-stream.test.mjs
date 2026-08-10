import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import test from 'node:test';
import { probeHostKey } from '@orc/ssh';
import {
  streamOllamaCreateViaPinnedSsh,
} from '../dist/ollama-create-stream.js';

const SSH_HOST = process.env.SSH_HOST;
const SSH_PORT = Number(process.env.SSH_PORT ?? '2222');
const SSH_USER = process.env.SSH_USER;
const SSH_PRIVATE_KEY_PATH = process.env.SSH_PRIVATE_KEY_PATH;
const HAS_FIXTURE = Boolean(SSH_HOST && SSH_USER && SSH_PRIVATE_KEY_PATH);

async function listenCreateServer(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(11434, '127.0.0.1', resolve);
  });
  return server;
}

async function closeServer(server) {
  if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function readJsonRequest(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

test('real OpenSSH create stream posts only the compiled structured payload and yields bounded progress', { skip: !HAS_FIXTURE }, async () => {
  const observed = await probeHostKey({ hostname: SSH_HOST, port: SSH_PORT });
  const requests = [];
  const server = await listenCreateServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/api/create') {
      response.statusCode = 404;
      response.end('{}');
      return;
    }
    requests.push(await readJsonRequest(request));
    response.setHeader('content-type', 'application/x-ndjson');
    response.write(`${JSON.stringify({ status: 'creating model layer' })}\n`);
    response.end(`${JSON.stringify({ status: 'success' })}\n`);
  });

  const progress = [];
  try {
    await streamOllamaCreateViaPinnedSsh(
      {
        hostname: SSH_HOST,
        port: SSH_PORT,
        username: SSH_USER,
        privateKey: fs.readFileSync(SSH_PRIVATE_KEY_PATH, 'utf8'),
        expectedFingerprint: observed.fingerprint,
      },
      '127.0.0.1',
      11434,
      'custom:latest',
      {
        from: 'base:latest',
        parameters: { temperature: 0.7 },
        renderer: 'qwen3.5',
      },
      { onProgress: (event) => progress.push(event) },
    );

    assert.deepEqual(requests, [{
      model: 'custom:latest',
      stream: true,
      from: 'base:latest',
      parameters: { temperature: 0.7 },
      renderer: 'qwen3.5',
    }]);
    assert.deepEqual(progress.map((event) => event.status), ['creating model layer', 'success']);
    assert.equal(progress.every((event) => event.digest === null), true);
  } finally {
    await closeServer(server);
  }
});
