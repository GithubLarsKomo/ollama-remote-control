import assert from 'node:assert/strict';
import test from 'node:test';
import {
  compileModelfileForDeploy,
  ModelfileDeployCompileError,
} from '../dist/modelfile-deploy.js';

function errorCode(fn) {
  try { fn(); }
  catch (error) {
    assert(error instanceof ModelfileDeployCompileError);
    return error.code;
  }
  assert.fail('Expected deploy compile error.');
}

test('compiles a supported immutable Modelfile into a structured Ollama create payload', () => {
  const raw = [
    'FROM qwen3.5:9b',
    'TEMPLATE """{{ .Prompt }}"""',
    'SYSTEM """Be concise."""',
    'PARAMETER temperature 0.7',
    'PARAMETER num_ctx 8192',
    'PARAMETER stop "END"',
    'PARAMETER stop "STOP"',
    'MESSAGE system You are useful.',
    'MESSAGE user """hello',
    'there"""',
    'LICENSE """Example license"""',
    'RENDERER qwen3.5',
    'PARSER qwen3.5',
    'REQUIRES 0.12.0',
    '',
  ].join('\n');

  const compiled = compileModelfileForDeploy(raw);
  assert.equal(compiled.payload.from, 'qwen3.5:9b');
  assert.equal(compiled.payload.template, '{{ .Prompt }}');
  assert.equal(compiled.payload.system, 'Be concise.');
  assert.deepEqual(compiled.payload.parameters, {
    temperature: 0.7,
    num_ctx: 8192,
    stop: ['END', 'STOP'],
  });
  assert.deepEqual(compiled.payload.messages, [
    { role: 'system', content: 'You are useful.' },
    { role: 'user', content: 'hello\nthere' },
  ]);
  assert.equal(compiled.payload.license, 'Example license');
  assert.equal(compiled.payload.renderer, 'qwen3.5');
  assert.equal(compiled.payload.parser, 'qwen3.5');
  assert.equal(compiled.payload.requires, '0.12.0');
  assert.equal(compiled.summary.baseModel, 'qwen3.5:9b');
  assert.deepEqual(compiled.summary.expectedFields, [
    'from', 'template', 'system', 'license', 'parameters', 'messages', 'renderer', 'parser', 'requires',
  ]);
  assert.equal(compiled.summary.directiveCounts.PARAMETER, 4);
});

test('adds latest only when FROM has no explicit tag', () => {
  const compiled = compileModelfileForDeploy('FROM llama3.2\n');
  assert.equal(compiled.payload.from, 'llama3.2:latest');
});

test('rejects opaque syntax and parser errors before mutation', () => {
  assert.equal(errorCode(() => compileModelfileForDeploy('FROM base:latest\nX-FUTURE value\n')), 'DEPLOY_OPAQUE_SYNTAX');
  assert.equal(errorCode(() => compileModelfileForDeploy('FROM base:latest\nPARAMETER num_ctx\n')), 'DEPLOY_SOURCE_DIAGNOSTICS');
});

test('rejects filesystem/blob FROM values in the model-only deploy slice', () => {
  for (const source of ['.', './model.gguf', '../model.gguf', '/tmp/model.gguf', 'sha256:abc', 'C:\\model.gguf']) {
    assert.equal(errorCode(() => compileModelfileForDeploy(`FROM ${source}\n`)), 'DEPLOY_FROM_UNSUPPORTED');
  }
});

test('rejects DRAFT and ADAPTER until file/blob authority exists', () => {
  assert.equal(
    errorCode(() => compileModelfileForDeploy('FROM base:latest\nDRAFT assistant:latest\n')),
    'DEPLOY_DRAFT_UNSUPPORTED',
  );
  assert.equal(
    errorCode(() => compileModelfileForDeploy('FROM base:latest\nADAPTER adapter.gguf\n')),
    'DEPLOY_ADAPTER_UNSUPPORTED',
  );
});

test('rejects multiple LICENSE directives because show verification exposes one license field', () => {
  assert.equal(
    errorCode(() => compileModelfileForDeploy([
      'FROM base:latest',
      'LICENSE """license one"""',
      'LICENSE """license two"""',
      '',
    ].join('\n'))),
    'DEPLOY_LICENSE_MULTIPLE_UNVERIFIABLE',
  );
});

test('rejects ambiguous duplicate non-stop parameters and invalid message roles', () => {
  assert.equal(
    errorCode(() => compileModelfileForDeploy('FROM base:latest\nPARAMETER temperature 0.7\nPARAMETER temperature 0.8\n')),
    'DEPLOY_PARAMETER_DUPLICATE',
  );
  assert.equal(
    errorCode(() => compileModelfileForDeploy('FROM base:latest\nMESSAGE tool hidden\n')),
    'DEPLOY_MESSAGE_ROLE_INVALID',
  );
});

test('rejects raw-only current directives rather than normalizing them', () => {
  const raw = 'FROM base:latest\nRENDERER """qwen\n3.5"""\n';
  assert.equal(errorCode(() => compileModelfileForDeploy(raw)), 'DEPLOY_SOURCE_DIAGNOSTICS');
});
