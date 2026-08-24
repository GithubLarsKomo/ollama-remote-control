import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {
  httpGetViaPinnedSsh,
  httpPostOllamaShowViaPinnedSsh,
  parseHttpResponse,
  SshHttpError,
} from '../dist/ssh-http.js';

const unreachableConnection = {
  hostname: '127.0.0.1',
  port: 1,
  username: 'nobody',
  privateKey: 'not-used',
  expectedFingerprint: 'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
};

test('SSH HTTP adapter rejects non-allowlisted Ollama paths before opening SSH', async () => {
  await assert.rejects(
    () => httpGetViaPinnedSsh(
      unreachableConnection,
      '127.0.0.1',
      11434,
      '/api/generate',
      { timeoutMs: 100 },
    ),
    (error) => error instanceof SshHttpError && error.code === 'HTTP_REQUEST_INVALID',
  );

  await assert.rejects(
    () => httpGetViaPinnedSsh(
      unreachableConnection,
      '127.0.0.1',
      11434,
      '/api/tags\r\nX-Injected: yes',
      { timeoutMs: 100 },
    ),
    (error) => error instanceof SshHttpError && error.code === 'HTTP_REQUEST_INVALID',
  );
});

test('SSH HTTP show primitive rejects model-name injection before opening SSH', async () => {
  for (const modelName of [
    '',
    'qwen3.5:9b\r\nX-Injected: yes',
    'qwen3.5:9b bad',
    `x${'a'.repeat(512)}`,
  ]) {
    await assert.rejects(
      () => httpPostOllamaShowViaPinnedSsh(
        unreachableConnection,
        '127.0.0.1',
        11434,
        modelName,
        { timeoutMs: 100 },
      ),
      (error) => error instanceof SshHttpError && error.code === 'HTTP_REQUEST_INVALID',
    );
  }
});

test('SSH HTTP response parser accepts a realistic large chunked Ollama tags response', () => {
  const payload = Buffer.from(JSON.stringify({ models: [{ name: 'x'.repeat(131_000) }] }), 'utf8');
  const raw = Buffer.concat([
    Buffer.from('HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n', 'ascii'),
    Buffer.from(`${payload.length.toString(16)}\r\n`, 'ascii'),
    payload,
    Buffer.from('\r\n0\r\n\r\n', 'ascii'),
  ]);
  const response = parseHttpResponse(raw, 1024 * 1024);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, payload);
});

test('SSH HTTP adapter lets the HTTP response own the forwarded-channel lifecycle', () => {
  const source = fs.readFileSync(new URL('../src/ssh-http.ts', import.meta.url), 'utf8');
  assert.match(source, /createConnection:\s*\(\)\s*=>\s*stream/u);
  assert.match(source, /responseStarted\s*=\s*true/u);
  assert.match(source, /if\s*\(!responseStarted\)\s*finish/u);
  assert.doesNotMatch(source, /stream\.end\(request\.body/u);
  assert.match(source, /Connection:\s*'close'/u);
});
