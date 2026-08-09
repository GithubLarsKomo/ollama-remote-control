import assert from 'node:assert/strict';
import test from 'node:test';
import {
  appendDirective,
  directiveNodes,
  parseKeyValueArgument,
  parseTextArgument,
  removeDirective,
  replaceKeyValueArgument,
  replaceTextArgument,
} from '../dist/modelfile-editor.js';
import { parseModelfile } from '../dist/modelfile-parser.js';

test('appends known directives using the document line ending without rewriting existing source', () => {
  const raw = '# keep\r\nFROM base:latest\r\nX-FUTURE opaque\r\n';
  const parsed = parseModelfile(raw);
  const next = appendDirective(parsed, 'PARAMETER', 'num_ctx 8192');
  assert.equal(next.raw, `${raw}PARAMETER num_ctx 8192\r\n`);
  assert.equal(next.raw.startsWith(raw), true);
  assert.equal(next.parsed.hasOpaqueSyntax, true);
});

test('refuses duplicate singleton directives but allows repeated parameters and adapters', () => {
  const parsed = parseModelfile('FROM base:latest\n');
  assert.throws(() => appendDirective(parsed, 'FROM', 'other:latest'), /already exists/u);
  const withParameter = appendDirective(parsed, 'PARAMETER', 'temperature 0.7');
  const withSecondParameter = appendDirective(withParameter.parsed, 'PARAMETER', 'num_ctx 8192');
  const withAdapter = appendDirective(withSecondParameter.parsed, 'ADAPTER', 'one:latest');
  const withSecondAdapter = appendDirective(withAdapter.parsed, 'ADAPTER', 'two:latest');
  assert.equal(directiveNodes(withSecondAdapter.parsed, 'PARAMETER').length, 2);
  assert.equal(directiveNodes(withSecondAdapter.parsed, 'ADAPTER').length, 2);
});

test('removes only the selected known directive raw slice', () => {
  const raw = '# keep\nFROM base:latest\nPARAMETER num_ctx 8192\nX-FUTURE keep\n';
  const parsed = parseModelfile(raw);
  const parameter = directiveNodes(parsed, 'PARAMETER')[0];
  const next = removeDirective(parsed, parameter.id);
  assert.equal(next.raw, '# keep\nFROM base:latest\nX-FUTURE keep\n');
});

test('parses and patches single-line PARAMETER and MESSAGE key/value arguments without rewriting surrounding trivia', () => {
  const raw = 'FROM base:latest\nPARAMETER\t temperature\t0.7   \nMESSAGE user Hello there\n';
  const parsed = parseModelfile(raw);
  const parameter = directiveNodes(parsed, 'PARAMETER')[0];
  const message = directiveNodes(parsed, 'MESSAGE')[0];
  assert.deepEqual(parseKeyValueArgument(parameter.argument), { key: 'temperature', value: '0.7' });
  assert.deepEqual(parseKeyValueArgument(message.argument), { key: 'user', value: 'Hello there' });
  const parameterPatched = replaceKeyValueArgument(parsed, parameter.id, 'temperature', '0.8');
  assert.equal(parameterPatched.raw.includes('PARAMETER\t temperature\t0.8   '), true);
  const reparsedMessage = directiveNodes(parameterPatched.parsed, 'MESSAGE')[0];
  const messagePatched = replaceKeyValueArgument(parameterPatched.parsed, reparsedMessage.id, 'assistant', 'Updated response');
  assert.equal(messagePatched.raw.includes('MESSAGE assistant Updated response'), true);
  assert.equal(messagePatched.raw.startsWith('FROM base:latest\n'), true);
});

test('multiline MESSAGE remains lossless but is raw-only for structured key/value editing', () => {
  const raw = 'FROM base:latest\nMESSAGE user """hello\nthere"""\n';
  const parsed = parseModelfile(raw);
  const message = directiveNodes(parsed, 'MESSAGE')[0];
  assert.equal(message.multiline, true);
  assert.equal(parseKeyValueArgument(message.argument), null);
  assert.throws(
    () => replaceKeyValueArgument(parsed, message.id, 'user', 'replacement'),
    /multiline syntax/u,
  );
  assert.equal(parsed.raw, raw);
});

test('structured text edits unwrap and preserve triple-quoted style', () => {
  const raw = 'FROM base:latest\nSYSTEM   """line one\nline two"""   \n';
  const parsed = parseModelfile(raw);
  const system = directiveNodes(parsed, 'SYSTEM')[0];
  assert.deepEqual(parseTextArgument(system.argument), {
    value: 'line one\nline two',
    tripleQuoted: true,
    leadingWhitespace: '',
    trailingWhitespace: '   ',
  });
  const noOp = replaceTextArgument(parsed, system.id, 'line one\nline two');
  assert.equal(noOp.raw, raw);
  const next = replaceTextArgument(parsed, system.id, 'updated\ncontent');
  assert.equal(next.raw, 'FROM base:latest\nSYSTEM   """updated\ncontent"""   \n');
});

test('plain structured text automatically becomes triple quoted when multiline content is introduced', () => {
  const parsed = parseModelfile('FROM base:latest\nSYSTEM concise\n');
  const system = directiveNodes(parsed, 'SYSTEM')[0];
  const next = replaceTextArgument(parsed, system.id, 'line one\nline two');
  assert.equal(next.raw, 'FROM base:latest\nSYSTEM """line one\nline two"""\n');
  assert.equal(next.parsed.diagnostics.length, 0);
});
