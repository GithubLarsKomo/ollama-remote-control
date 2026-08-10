import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveModelSourceReference } from '@orc/core/model-source';

test('resolves explicit Hugging Face references to canonical repository URLs', () => {
  assert.deepEqual(resolveModelSourceReference('hf.co/unsloth/Qwen3.5-9B-GGUF:UD-Q4_K_XL'), {
    reference: 'hf.co/unsloth/Qwen3.5-9B-GGUF:UD-Q4_K_XL',
    state: 'resolved',
    provider: 'huggingface',
    url: 'https://huggingface.co/unsloth/Qwen3.5-9B-GGUF',
  });
  assert.deepEqual(resolveModelSourceReference('hf.co/org/model.repo'), {
    reference: 'hf.co/org/model.repo',
    state: 'resolved',
    provider: 'huggingface',
    url: 'https://huggingface.co/org/model.repo',
  });
});

test('never invents external sources for local paths, blobs or digests', () => {
  for (const reference of [
    '/root/.ollama/models/blobs/sha256:deadbeef',
    './model.gguf',
    '../model.gguf',
    '~/model.gguf',
    'C:\\models\\model.gguf',
    'sha256:deadbeef',
  ]) {
    const result = resolveModelSourceReference(reference);
    assert.equal(result.reference, reference);
    assert.equal(result.state, 'local-artifact');
    assert.equal(result.provider, null);
    assert.equal(result.url, null);
  }
});

test('rejects ambiguous or hostile Hugging Face lookalikes rather than constructing links', () => {
  for (const reference of [
    'huggingface.co/org/repo',
    'hf.co.evil/org/repo',
    'evil-hf.co/org/repo',
    'hf.co/org/repo/extra',
    'hf.co/org/repo:variant/extra',
    'hf.co/org/repo?download=1',
    'hf.co/org/repo#fragment',
    'hf.co/org/repo%2Fextra',
    'hf.co/org/../repo',
    'hf.co/../repo',
    'hf.co/org/repo\\extra',
    'hf.co/org/repo:bad variant',
    'hf.co/org/repo:\u0000bad',
  ]) {
    const result = resolveModelSourceReference(reference);
    assert.equal(result.state, 'unresolved');
    assert.equal(result.provider, null);
    assert.equal(result.url, null);
  }
});

test('keeps ordinary Ollama model names unresolved until a dedicated resolver exists', () => {
  for (const reference of ['llama3.2:latest', 'qwen3.5:9b', 'library/model:latest']) {
    assert.deepEqual(resolveModelSourceReference(reference), {
      reference,
      state: 'unresolved',
      provider: null,
      url: null,
    });
  }
});
