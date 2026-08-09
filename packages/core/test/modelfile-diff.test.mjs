import assert from 'node:assert/strict';
import test from 'node:test';
import { diffModelfileText } from '../dist/modelfile-diff.js';

test('returns no hunks for byte-identical revisions', () => {
  const raw = 'FROM model:latest\r\nPARAMETER num_ctx 8192\r\n';
  assert.deepEqual(diffModelfileText(raw, raw), {
    changed: false,
    strategy: 'lcs',
    truncated: false,
    beforeLines: 2,
    afterLines: 2,
    hunks: [],
  });
});

test('reports bounded line additions/removals with context and exact line endings', () => {
  const before = [
    '# header',
    'FROM old:latest',
    'PARAMETER num_ctx 8192',
    'X-FUTURE keep',
    '',
  ].join('\r\n');
  const after = [
    '# header',
    'FROM new:latest',
    'PARAMETER num_ctx 16384',
    'X-FUTURE keep',
    '',
  ].join('\r\n');

  const diff = diffModelfileText(before, after);
  assert.equal(diff.changed, true);
  assert.equal(diff.strategy, 'lcs');
  assert.equal(diff.truncated, false);
  assert.equal(diff.hunks.length, 1);
  const lines = diff.hunks[0].lines;
  assert.equal(lines.some((line) => line.kind === 'remove' && line.text === 'FROM old:latest'), true);
  assert.equal(lines.some((line) => line.kind === 'add' && line.text === 'FROM new:latest'), true);
  assert.equal(lines.some((line) => line.kind === 'remove' && line.text === 'PARAMETER num_ctx 8192'), true);
  assert.equal(lines.some((line) => line.kind === 'add' && line.text === 'PARAMETER num_ctx 16384'), true);
  assert.equal(lines.every((line) => line.ending === 'crlf'), true);
});

test('detects line-ending-only changes', () => {
  const diff = diffModelfileText('FROM model:latest\n', 'FROM model:latest\r\n');
  assert.equal(diff.changed, true);
  const lines = diff.hunks.flatMap((hunk) => hunk.lines);
  assert.equal(lines.some((line) => line.kind === 'remove' && line.ending === 'lf'), true);
  assert.equal(lines.some((line) => line.kind === 'add' && line.ending === 'crlf'), true);
});

test('uses bounded replacement strategy instead of quadratic work for large revisions', () => {
  const before = Array.from({ length: 600 }, (_, index) => `PARAMETER p${index} ${index}`).join('\n');
  const after = Array.from({ length: 600 }, (_, index) => `PARAMETER p${index} ${index + 1}`).join('\n');
  const diff = diffModelfileText(before, after);
  assert.equal(diff.changed, true);
  assert.equal(diff.strategy, 'bounded-replacement');
  assert.equal(diff.beforeLines, 600);
  assert.equal(diff.afterLines, 600);
  assert.equal(diff.hunks.length, 1);
  assert.equal(diff.hunks[0].lines.length <= 2000, true);
});

test('large equal prefix and suffix are collapsed around replacement', () => {
  const prefix = Array.from({ length: 300 }, (_, index) => `# prefix ${index}`);
  const suffix = Array.from({ length: 300 }, (_, index) => `# suffix ${index}`);
  const before = [...prefix, 'FROM old:latest', ...suffix].join('\n');
  const after = [...prefix, 'FROM new:latest', ...suffix].join('\n');
  const diff = diffModelfileText(before, after);
  assert.equal(diff.strategy, 'bounded-replacement');
  assert.equal(diff.changed, true);
  assert.equal(diff.truncated, false);
  assert.equal(diff.hunks[0].lines.length, 8);
  assert.equal(diff.hunks[0].lines.some((line) => line.kind === 'remove' && line.text === 'FROM old:latest'), true);
  assert.equal(diff.hunks[0].lines.some((line) => line.kind === 'add' && line.text === 'FROM new:latest'), true);
});
