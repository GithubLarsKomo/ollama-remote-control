import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseModelfile,
  renderModelfile,
  replaceDirectiveArgument,
} from '../dist/modelfile-parser.js';

const KNOWN = ['FROM', 'PARAMETER', 'TEMPLATE', 'SYSTEM', 'ADAPTER', 'LICENSE', 'MESSAGE', 'REQUIRES'];

test('parses all known directives while preserving exact LF source', () => {
  const raw = [
    '# top comment',
    '',
    'FROM llama3.2:latest',
    'PARAMETER temperature 0.7',
    'TEMPLATE """{{ .Prompt }}"""',
    'SYSTEM """You are useful."""',
    'ADAPTER hf.co/example/adapter:latest',
    'LICENSE """Example license"""',
    'MESSAGE user Hello',
    'REQUIRES ollama >= 0.12',
    '',
  ].join('\n');

  const parsed = parseModelfile(raw);
  assert.equal(parsed.raw, raw);
  assert.equal(renderModelfile(parsed), raw);
  assert.equal(parsed.lineEnding, '\n');
  assert.deepEqual(
    parsed.nodes.filter((node) => node.kind === 'directive').map((node) => node.name),
    KNOWN,
  );
  assert.equal(parsed.hasOpaqueSyntax, false);
  assert.deepEqual(parsed.diagnostics, []);
});

test('preserves CRLF, comments, blank lines, casing, whitespace and unknown directives byte-identically', () => {
  const raw = [
    '  # retained comment',
    '',
    '  from   llama3.2:latest',
    'X-FUTURE   one two three',
    'parameter\tnum_ctx\t8192',
    '',
  ].join('\r\n');

  const parsed = parseModelfile(raw);
  assert.equal(parsed.lineEnding, '\r\n');
  assert.equal(renderModelfile(parsed), raw);
  assert.equal(parsed.nodes.map((node) => node.raw).join(''), raw);
  assert.equal(parsed.hasOpaqueSyntax, true);
  const unknown = parsed.nodes.find((node) => node.kind === 'opaque-directive');
  assert(unknown);
  assert.equal(unknown.originalName, 'X-FUTURE');
  assert.equal(unknown.argument, 'one two three');
  assert.equal(parsed.diagnostics.some((item) => item.code === 'UNKNOWN_DIRECTIVE'), true);
  assert.equal(parsed.diagnostics.some((item) => item.code === 'FROM_REQUIRED'), false);
});

test('keeps multiline template/system/license/message blocks lossless and source ranged', () => {
  const raw = [
    'FROM base:latest',
    'TEMPLATE """line one',
    '{{ .Prompt }}',
    'line three"""',
    'SYSTEM """system',
    'line two"""',
    'LICENSE """license',
    'line two"""',
    'MESSAGE user """hello',
    'there"""',
  ].join('\n');

  const parsed = parseModelfile(raw);
  const multiline = parsed.nodes.filter((node) => node.kind === 'directive' && node.multiline);
  assert.deepEqual(multiline.map((node) => node.name), ['TEMPLATE', 'SYSTEM', 'LICENSE', 'MESSAGE']);
  assert.equal(multiline.every((node) => node.structuredEditable), true);
  assert.equal(multiline.map((node) => node.raw).join('').includes('{{ .Prompt }}'), true);
  assert.equal(renderModelfile(parsed), raw);
  assert.deepEqual(parsed.diagnostics, []);
});

test('reports malformed or ambiguous source without destroying it', () => {
  const raw = [
    'FROM one:latest',
    'FROM two:latest',
    'PARAMETER num_ctx',
    'MESSAGE user',
    'SYSTEM """unterminated',
  ].join('\n');
  const parsed = parseModelfile(raw);

  assert.equal(renderModelfile(parsed), raw);
  assert.deepEqual(
    new Set(parsed.diagnostics.map((item) => item.code)),
    new Set(['FROM_DUPLICATE', 'PARAMETER_VALUE_REQUIRED', 'MESSAGE_CONTENT_REQUIRED', 'UNCLOSED_MULTILINE']),
  );
  const system = parsed.nodes.find((node) => node.kind === 'directive' && node.name === 'SYSTEM');
  assert(system);
  assert.equal(system.structuredEditable, false);
});

test('reports missing FROM while retaining opaque source', () => {
  const raw = '# draft\nPARAMETER temperature 0.5\n';
  const parsed = parseModelfile(raw);
  assert.equal(parsed.diagnostics.some((item) => item.code === 'FROM_REQUIRED'), true);
  assert.equal(renderModelfile(parsed), raw);
});

test('targeted structured patch changes only the directive argument span', () => {
  const raw = [
    '# keep this exactly',
    'FROM old/model:latest',
    'PARAMETER temperature 0.7',
    'X-FUTURE untouched',
    '',
  ].join('\r\n');
  const parsed = parseModelfile(raw);
  const from = parsed.nodes.find((node) => node.kind === 'directive' && node.name === 'FROM');
  assert(from);

  const patched = replaceDirectiveArgument(parsed, from.id, 'new/model:Q4_K_M');
  const expected = raw.replace('old/model:latest', 'new/model:Q4_K_M');
  assert.equal(patched.raw, expected);
  assert.equal(patched.parsed.lineEnding, '\r\n');
  assert.equal(patched.raw.includes('X-FUTURE untouched'), true);
  assert.equal(patched.parsed.hasOpaqueSyntax, true);
});

test('no-op structured patch returns exact original source and parse identity', () => {
  const raw = 'FROM model:latest\r\nPARAMETER num_ctx 8192\r\n';
  const parsed = parseModelfile(raw);
  const parameter = parsed.nodes.find((node) => node.kind === 'directive' && node.name === 'PARAMETER');
  assert(parameter);
  const patched = replaceDirectiveArgument(parsed, parameter.id, parameter.argument);
  assert.equal(patched.raw, raw);
  assert.equal(patched.parsed, parsed);
});

test('structured patches are refused for unknown and unclosed directives', () => {
  const unknownParsed = parseModelfile('FROM base:latest\nX-FUTURE opaque\n');
  const unknown = unknownParsed.nodes.find((node) => node.kind === 'opaque-directive');
  assert(unknown);
  assert.throws(() => replaceDirectiveArgument(unknownParsed, unknown.id, 'replacement'), /not safe for structured editing/u);

  const unclosedParsed = parseModelfile('FROM base:latest\nSYSTEM """open');
  const unclosed = unclosedParsed.nodes.find((node) => node.kind === 'directive' && node.name === 'SYSTEM');
  assert(unclosed);
  assert.equal(unclosed.structuredEditable, false);
  assert.throws(() => replaceDirectiveArgument(unclosedParsed, unclosed.id, '"""closed"""'), /not safe for structured editing/u);
});

test('parser enforces NUL and UTF-8 byte bounds', () => {
  assert.throws(() => parseModelfile('FROM a\u0000b'), /NUL/u);
  assert.throws(() => parseModelfile(`FROM model:latest\n# ${'ä'.repeat(300_000)}`), /UTF-8 bytes/u);
});
