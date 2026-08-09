import assert from 'node:assert/strict';
import test from 'node:test';
import {
  httpGetViaPinnedSsh,
  httpPostOllamaShowViaPinnedSsh,
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
