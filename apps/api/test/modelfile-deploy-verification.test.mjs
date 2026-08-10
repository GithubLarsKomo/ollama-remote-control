import assert from 'node:assert/strict';
import test from 'node:test';
import { compileModelfileForDeploy } from '@orc/core/modelfile-deploy';
import { verifyCompiledModelfileDeploy } from '../dist/modelfile-deploy-verification.js';

function detail(overrides = {}) {
  return {
    targetId: 'target-1',
    transport: { mode: 'published-binding' },
    identity: { name: 'custom:latest', model: 'custom:latest', digest: 'a'.repeat(64), modifiedAt: null },
    details: {
      format: 'gguf', family: null, families: [], parameterSize: null,
      quantizationLevel: null, parentModel: 'base:latest',
    },
    capabilities: [],
    modelfile: [
      '# generated',
      'FROM /root/.ollama/models/blobs/sha256:deadbeef',
      'MESSAGE user """hello',
      'there"""',
      'RENDERER qwen3.5',
      'PARSER qwen3.5',
      'PARAMETER temperature 0.7',
      'PARAMETER stop "END"',
    ].join('\n'),
    parameters: 'temperature 0.7\nstop "END"\nnum_ctx 8192',
    template: '{{ .Prompt }}',
    system: 'Be concise.',
    license: 'Test license',
    requires: '0.12.0',
    architecture: {
      architecture: null, parameterCount: null, contextLength: null,
      embeddingLength: null, blockCount: null, quantizationVersion: null,
    },
    provenancePreview: { from: null, adapters: [] },
    ...overrides,
  };
}

function compiled() {
  return compileModelfileForDeploy([
    'FROM base:latest',
    'TEMPLATE """{{ .Prompt }}"""',
    'SYSTEM """Be concise."""',
    'PARAMETER temperature 0.7',
    'PARAMETER stop "END"',
    'MESSAGE user """hello',
    'there"""',
    'LICENSE """Test license"""',
    'RENDERER qwen3.5',
    'PARSER qwen3.5',
    'REQUIRES 0.12.0',
    '',
  ].join('\n'));
}

test('verifies requested semantics while allowing unrelated inherited parameters', () => {
  const result = verifyCompiledModelfileDeploy(compiled(), detail());
  assert.deepEqual(result, {
    verified: true,
    mismatches: [],
    baseModelObservation: 'matched',
  });
});

test('stream success is not enough when requested renderer/parser/parameters disappear', () => {
  const result = verifyCompiledModelfileDeploy(compiled(), detail({
    modelfile: 'FROM /root/.ollama/models/blobs/sha256:deadbeef\nMESSAGE user """hello\nthere"""\n',
    parameters: 'num_ctx 8192',
  }));
  assert.equal(result.verified, false);
  assert.deepEqual(result.mismatches.sort(), ['parameters', 'parser', 'renderer']);
});

test('detects sensitive semantic mismatches without returning sensitive values', () => {
  const result = verifyCompiledModelfileDeploy(compiled(), detail({
    template: 'different',
    system: 'different',
    license: 'different',
    requires: 'different',
    modelfile: 'FROM /root/.ollama/models/blobs/sha256:deadbeef\n',
  }));
  assert.equal(result.verified, false);
  assert.deepEqual(result.mismatches.sort(), ['license', 'messages', 'parser', 'renderer', 'requires', 'system', 'template']);
  assert.equal(JSON.stringify(result).includes('Be concise'), false);
  assert.equal(JSON.stringify(result).includes('Test license'), false);
});

test('base model is informationally unverified when show has no parent model', () => {
  const result = verifyCompiledModelfileDeploy(compiled(), detail({
    details: {
      format: 'gguf', family: null, families: [], parameterSize: null,
      quantizationLevel: null, parentModel: null,
    },
  }));
  assert.equal(result.verified, true);
  assert.equal(result.baseModelObservation, 'unavailable');
});

test('observable parent-model mismatch fails verification', () => {
  const result = verifyCompiledModelfileDeploy(compiled(), detail({
    details: {
      format: 'gguf', family: null, families: [], parameterSize: null,
      quantizationLevel: null, parentModel: 'other:latest',
    },
  }));
  assert.equal(result.verified, false);
  assert.equal(result.baseModelObservation, 'mismatch');
  assert.equal(result.mismatches.includes('from'), true);
});
