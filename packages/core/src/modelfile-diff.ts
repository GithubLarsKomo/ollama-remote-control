export type ModelfileDiffLineKind = 'context' | 'remove' | 'add';
export type ModelfileLineEnding = 'lf' | 'crlf' | 'none';

export interface ModelfileDiffLine {
  readonly kind: ModelfileDiffLineKind;
  readonly oldLine: number | null;
  readonly newLine: number | null;
  readonly text: string;
  readonly ending: ModelfileLineEnding;
}

export interface ModelfileDiffHunk {
  readonly oldStart: number;
  readonly newStart: number;
  readonly lines: readonly ModelfileDiffLine[];
}

export interface ModelfileTextDiff {
  readonly changed: boolean;
  readonly strategy: 'lcs' | 'bounded-replacement';
  readonly truncated: boolean;
  readonly beforeLines: number;
  readonly afterLines: number;
  readonly hunks: readonly ModelfileDiffHunk[];
}

interface SourceLine {
  readonly number: number;
  readonly text: string;
  readonly ending: ModelfileLineEnding;
  readonly key: string;
}

interface DiffOp {
  readonly kind: ModelfileDiffLineKind;
  readonly before: SourceLine | null;
  readonly after: SourceLine | null;
}

const MAX_LCS_CELLS = 250_000;
const MAX_DIFF_OUTPUT_LINES = 2_000;
const CONTEXT_LINES = 3;

function splitSourceLines(raw: string): readonly SourceLine[] {
  if (raw.length === 0) return [];
  const lines: SourceLine[] = [];
  let start = 0;
  let number = 1;
  for (let index = 0; index < raw.length; index += 1) {
    if (raw[index] !== '\n') continue;
    const crlf = index > start && raw[index - 1] === '\r';
    const textEnd = crlf ? index - 1 : index;
    const text = raw.slice(start, textEnd);
    const ending: ModelfileLineEnding = crlf ? 'crlf' : 'lf';
    lines.push({ number, text, ending, key: `${text}\u0000${ending}` });
    start = index + 1;
    number += 1;
  }
  if (start < raw.length) {
    const text = raw.slice(start);
    lines.push({ number, text, ending: 'none', key: `${text}\u0000none` });
  }
  return lines;
}

function lineFromOp(operation: DiffOp): ModelfileDiffLine {
  const source = operation.kind === 'add' ? operation.after! : operation.before!;
  return {
    kind: operation.kind,
    oldLine: operation.before?.number ?? null,
    newLine: operation.after?.number ?? null,
    text: source.text,
    ending: source.ending,
  };
}

function lcsOperations(before: readonly SourceLine[], after: readonly SourceLine[]): readonly DiffOp[] {
  const width = after.length + 1;
  const matrix = new Uint16Array((before.length + 1) * width);
  for (let left = before.length - 1; left >= 0; left -= 1) {
    for (let right = after.length - 1; right >= 0; right -= 1) {
      const index = left * width + right;
      matrix[index] = before[left]!.key === after[right]!.key
        ? matrix[(left + 1) * width + right + 1]! + 1
        : Math.max(matrix[(left + 1) * width + right]!, matrix[left * width + right + 1]!);
    }
  }

  const operations: DiffOp[] = [];
  let left = 0;
  let right = 0;
  while (left < before.length || right < after.length) {
    if (left < before.length && right < after.length && before[left]!.key === after[right]!.key) {
      operations.push({ kind: 'context', before: before[left]!, after: after[right]! });
      left += 1;
      right += 1;
      continue;
    }
    if (
      right < after.length
      && (left >= before.length || matrix[left * width + right + 1]! >= matrix[(left + 1) * width + right]!)
    ) {
      operations.push({ kind: 'add', before: null, after: after[right]! });
      right += 1;
      continue;
    }
    operations.push({ kind: 'remove', before: before[left]!, after: null });
    left += 1;
  }
  return operations;
}

function buildContextHunks(operations: readonly DiffOp[]): { hunks: readonly ModelfileDiffHunk[]; truncated: boolean } {
  const changedIndexes: number[] = [];
  for (let index = 0; index < operations.length; index += 1) {
    if (operations[index]!.kind !== 'context') changedIndexes.push(index);
  }
  if (changedIndexes.length === 0) return { hunks: [], truncated: false };

  const windows: Array<{ start: number; end: number }> = [];
  for (const changed of changedIndexes) {
    const start = Math.max(0, changed - CONTEXT_LINES);
    const end = Math.min(operations.length, changed + CONTEXT_LINES + 1);
    const last = windows[windows.length - 1];
    if (last && start <= last.end) last.end = Math.max(last.end, end);
    else windows.push({ start, end });
  }

  const hunks: ModelfileDiffHunk[] = [];
  let emitted = 0;
  let truncated = false;
  for (const window of windows) {
    if (emitted >= MAX_DIFF_OUTPUT_LINES) {
      truncated = true;
      break;
    }
    const selected = operations.slice(window.start, window.end);
    const remaining = MAX_DIFF_OUTPUT_LINES - emitted;
    const visible = selected.slice(0, remaining);
    if (visible.length < selected.length) truncated = true;
    const first = visible[0]!;
    const oldStart = first.before?.number ?? first.after?.number ?? 1;
    const newStart = first.after?.number ?? first.before?.number ?? 1;
    hunks.push({ oldStart, newStart, lines: visible.map(lineFromOp) });
    emitted += visible.length;
    if (truncated) break;
  }
  return { hunks, truncated };
}

function boundedReplacementDiff(
  before: readonly SourceLine[],
  after: readonly SourceLine[],
): ModelfileTextDiff {
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix]!.key === after[prefix]!.key) prefix += 1;

  let suffix = 0;
  while (
    suffix < before.length - prefix
    && suffix < after.length - prefix
    && before[before.length - suffix - 1]!.key === after[after.length - suffix - 1]!.key
  ) suffix += 1;

  const beforeChanged = before.slice(prefix, before.length - suffix);
  const afterChanged = after.slice(prefix, after.length - suffix);
  if (beforeChanged.length === 0 && afterChanged.length === 0) {
    return {
      changed: false,
      strategy: 'bounded-replacement',
      truncated: false,
      beforeLines: before.length,
      afterLines: after.length,
      hunks: [],
    };
  }

  const contextBefore = before.slice(Math.max(0, prefix - CONTEXT_LINES), prefix);
  const contextAfter = after.slice(after.length - suffix, Math.min(after.length, after.length - suffix + CONTEXT_LINES));
  const operations: DiffOp[] = [
    ...contextBefore.map((line, index) => ({ kind: 'context' as const, before: line, after: after[Math.max(0, prefix - CONTEXT_LINES) + index] ?? line })),
    ...beforeChanged.map((line) => ({ kind: 'remove' as const, before: line, after: null })),
    ...afterChanged.map((line) => ({ kind: 'add' as const, before: null, after: line })),
    ...contextAfter.map((line, index) => ({
      kind: 'context' as const,
      before: before[before.length - suffix + index] ?? line,
      after: line,
    })),
  ];
  const visible = operations.slice(0, MAX_DIFF_OUTPUT_LINES);
  return {
    changed: true,
    strategy: 'bounded-replacement',
    truncated: visible.length < operations.length,
    beforeLines: before.length,
    afterLines: after.length,
    hunks: [{
      oldStart: visible[0]?.before?.number ?? visible[0]?.after?.number ?? 1,
      newStart: visible[0]?.after?.number ?? visible[0]?.before?.number ?? 1,
      lines: visible.map(lineFromOp),
    }],
  };
}

export function diffModelfileText(beforeRaw: string, afterRaw: string): ModelfileTextDiff {
  const before = splitSourceLines(beforeRaw);
  const after = splitSourceLines(afterRaw);
  const cells = (before.length + 1) * (after.length + 1);
  if (cells > MAX_LCS_CELLS) return boundedReplacementDiff(before, after);

  const operations = lcsOperations(before, after);
  const result = buildContextHunks(operations);
  return {
    changed: result.hunks.length > 0,
    strategy: 'lcs',
    truncated: result.truncated,
    beforeLines: before.length,
    afterLines: after.length,
    hunks: result.hunks,
  };
}
