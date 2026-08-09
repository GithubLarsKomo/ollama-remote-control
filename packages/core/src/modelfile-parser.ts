import { createHash } from 'node:crypto';

export type ModelfileDirectiveName =
  | 'FROM'
  | 'PARAMETER'
  | 'TEMPLATE'
  | 'SYSTEM'
  | 'ADAPTER'
  | 'LICENSE'
  | 'MESSAGE'
  | 'REQUIRES';

export type ModelfileDiagnosticSeverity = 'error' | 'warning' | 'info';

export interface ModelfileSourcePosition {
  readonly offset: number;
  readonly line: number;
  readonly column: number;
}

export interface ModelfileSourceRange {
  readonly start: ModelfileSourcePosition;
  readonly end: ModelfileSourcePosition;
}

export interface ModelfileDiagnostic {
  readonly severity: ModelfileDiagnosticSeverity;
  readonly code: string;
  readonly message: string;
  readonly range: ModelfileSourceRange;
}

interface ModelfileNodeBase {
  readonly id: string;
  readonly raw: string;
  readonly range: ModelfileSourceRange;
}

export interface ModelfileBlankNode extends ModelfileNodeBase {
  readonly kind: 'blank';
}

export interface ModelfileCommentNode extends ModelfileNodeBase {
  readonly kind: 'comment';
}

export interface ModelfileDirectiveNode extends ModelfileNodeBase {
  readonly kind: 'directive';
  readonly name: ModelfileDirectiveName;
  readonly originalName: string;
  readonly argument: string;
  readonly argumentRange: ModelfileSourceRange;
  readonly multiline: boolean;
  readonly structuredEditable: boolean;
}

export interface ModelfileOpaqueDirectiveNode extends ModelfileNodeBase {
  readonly kind: 'opaque-directive';
  readonly originalName: string;
  readonly argument: string;
  readonly argumentRange: ModelfileSourceRange;
  readonly multiline: boolean;
}

export interface ModelfileOpaqueTextNode extends ModelfileNodeBase {
  readonly kind: 'opaque-text';
}

export type ModelfileNode =
  | ModelfileBlankNode
  | ModelfileCommentNode
  | ModelfileDirectiveNode
  | ModelfileOpaqueDirectiveNode
  | ModelfileOpaqueTextNode;

export interface ParsedModelfile {
  readonly raw: string;
  readonly contentSha256: string;
  readonly lineEnding: '\n' | '\r\n' | 'mixed' | 'none';
  readonly nodes: readonly ModelfileNode[];
  readonly diagnostics: readonly ModelfileDiagnostic[];
  readonly hasOpaqueSyntax: boolean;
}

export interface ModelfilePatchResult {
  readonly raw: string;
  readonly parsed: ParsedModelfile;
}

const KNOWN_DIRECTIVES = new Set<ModelfileDirectiveName>([
  'FROM',
  'PARAMETER',
  'TEMPLATE',
  'SYSTEM',
  'ADAPTER',
  'LICENSE',
  'MESSAGE',
  'REQUIRES',
]);

const MAX_RAW_BYTES = 512 * 1024;
const MAX_NODES = 20_000;
const MAX_DIAGNOSTICS = 256;
const DIRECTIVE_PATTERN = /^(\s*)([A-Za-z][A-Za-z0-9_-]*)([ \t]*)(.*)$/u;

interface PhysicalLine {
  readonly start: number;
  readonly contentEnd: number;
  readonly end: number;
  readonly line: number;
  readonly raw: string;
  readonly content: string;
}

function sha256(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

function positionAt(lines: readonly PhysicalLine[], offset: number): ModelfileSourcePosition {
  if (lines.length === 0) return { offset, line: 1, column: offset + 1 };
  let low = 0;
  let high = lines.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const line = lines[middle]!;
    if (offset < line.start) high = middle - 1;
    else if (offset > line.end) low = middle + 1;
    else return { offset, line: line.line, column: offset - line.start + 1 };
  }
  const last = lines[lines.length - 1]!;
  return { offset, line: last.line, column: Math.max(1, offset - last.start + 1) };
}

function range(lines: readonly PhysicalLine[], start: number, end: number): ModelfileSourceRange {
  return { start: positionAt(lines, start), end: positionAt(lines, end) };
}

function splitPhysicalLines(raw: string): readonly PhysicalLine[] {
  if (raw.length === 0) return [];
  const lines: PhysicalLine[] = [];
  let start = 0;
  let line = 1;
  for (let index = 0; index < raw.length; index += 1) {
    if (raw[index] !== '\n') continue;
    const contentEnd = index > start && raw[index - 1] === '\r' ? index - 1 : index;
    lines.push({
      start,
      contentEnd,
      end: index + 1,
      line,
      raw: raw.slice(start, index + 1),
      content: raw.slice(start, contentEnd),
    });
    start = index + 1;
    line += 1;
  }
  if (start < raw.length) {
    lines.push({
      start,
      contentEnd: raw.length,
      end: raw.length,
      line,
      raw: raw.slice(start),
      content: raw.slice(start),
    });
  }
  return lines;
}

function detectedLineEnding(raw: string): ParsedModelfile['lineEnding'] {
  let lf = 0;
  let crlf = 0;
  for (let index = 0; index < raw.length; index += 1) {
    if (raw[index] !== '\n') continue;
    if (index > 0 && raw[index - 1] === '\r') crlf += 1;
    else lf += 1;
  }
  if (lf > 0 && crlf > 0) return 'mixed';
  if (crlf > 0) return '\r\n';
  if (lf > 0) return '\n';
  return 'none';
}

function tripleQuoteCount(value: string): number {
  let count = 0;
  for (let index = 0; index <= value.length - 3;) {
    if (value.slice(index, index + 3) === '"""') {
      count += 1;
      index += 3;
    } else index += 1;
  }
  return count;
}

function requiresMultilineContinuation(argument: string): boolean {
  return tripleQuoteCount(argument) % 2 === 1;
}

function nodeId(kind: string, start: number, end: number): string {
  return `${kind}:${start}:${end}`;
}

function diagnostic(
  diagnostics: ModelfileDiagnostic[],
  severity: ModelfileDiagnosticSeverity,
  code: string,
  message: string,
  valueRange: ModelfileSourceRange,
): void {
  if (diagnostics.length >= MAX_DIAGNOSTICS) return;
  diagnostics.push({ severity, code, message, range: valueRange });
}

function validateKnownDirective(
  node: ModelfileDirectiveNode,
  diagnostics: ModelfileDiagnostic[],
): void {
  const argument = node.argument.trim();
  if (!argument) {
    diagnostic(
      diagnostics,
      'error',
      'DIRECTIVE_ARGUMENT_REQUIRED',
      `${node.name} requires an argument.`,
      node.argumentRange,
    );
    return;
  }

  if (node.name === 'PARAMETER') {
    const match = /^(\S+)[ \t]+(.+)$/su.exec(argument);
    if (!match || !match[2]!.trim()) {
      diagnostic(
        diagnostics,
        'error',
        'PARAMETER_VALUE_REQUIRED',
        'PARAMETER requires a name and value.',
        node.argumentRange,
      );
    }
  }

  if (node.name === 'MESSAGE') {
    const match = /^(\S+)[ \t]+(.+)$/su.exec(argument);
    if (!match || !match[2]!.trim()) {
      diagnostic(
        diagnostics,
        'error',
        'MESSAGE_CONTENT_REQUIRED',
        'MESSAGE requires a role and content.',
        node.argumentRange,
      );
    }
  }
}

function structuredEditable(name: ModelfileDirectiveName, multilineBalanced: boolean): boolean {
  if (!multilineBalanced) return false;
  return KNOWN_DIRECTIVES.has(name);
}

export function parseModelfile(raw: string): ParsedModelfile {
  if (typeof raw !== 'string') throw new TypeError('Modelfile source must be text.');
  if (raw.includes('\u0000')) throw new Error('Modelfile source must not contain NUL characters.');
  if (Buffer.byteLength(raw, 'utf8') > MAX_RAW_BYTES) throw new Error(`Modelfile source exceeds ${MAX_RAW_BYTES} UTF-8 bytes.`);

  const lines = splitPhysicalLines(raw);
  const nodes: ModelfileNode[] = [];
  const diagnostics: ModelfileDiagnostic[] = [];
  let hasOpaqueSyntax = false;
  let index = 0;

  while (index < lines.length) {
    if (nodes.length >= MAX_NODES) throw new Error(`Modelfile source exceeds ${MAX_NODES} parsed nodes.`);
    const first = lines[index]!;
    const trimmed = first.content.trim();

    if (trimmed === '') {
      nodes.push({
        kind: 'blank',
        id: nodeId('blank', first.start, first.end),
        raw: raw.slice(first.start, first.end),
        range: range(lines, first.start, first.end),
      });
      index += 1;
      continue;
    }

    if (/^\s*#/u.test(first.content)) {
      nodes.push({
        kind: 'comment',
        id: nodeId('comment', first.start, first.end),
        raw: raw.slice(first.start, first.end),
        range: range(lines, first.start, first.end),
      });
      index += 1;
      continue;
    }

    const match = DIRECTIVE_PATTERN.exec(first.content);
    if (!match) {
      nodes.push({
        kind: 'opaque-text',
        id: nodeId('opaque-text', first.start, first.end),
        raw: raw.slice(first.start, first.end),
        range: range(lines, first.start, first.end),
      });
      hasOpaqueSyntax = true;
      diagnostic(diagnostics, 'warning', 'OPAQUE_TEXT', 'Unrecognized Modelfile text is preserved but cannot be edited structurally.', range(lines, first.start, first.contentEnd));
      index += 1;
      continue;
    }

    const leading = match[1]!;
    const originalName = match[2]!;
    const separator = match[3]!;
    const firstArgument = match[4]!;
    const argumentStart = first.start + leading.length + originalName.length + separator.length;
    let endLineIndex = index;
    let multilineBalanced = true;

    if (requiresMultilineContinuation(firstArgument)) {
      multilineBalanced = false;
      let quoteCount = tripleQuoteCount(firstArgument);
      for (let candidate = index + 1; candidate < lines.length; candidate += 1) {
        quoteCount += tripleQuoteCount(lines[candidate]!.content);
        endLineIndex = candidate;
        if (quoteCount % 2 === 0) {
          multilineBalanced = true;
          break;
        }
      }
    }

    const last = lines[endLineIndex]!;
    const nodeEnd = last.end;
    const argumentEnd = last.contentEnd;
    const argument = raw.slice(argumentStart, argumentEnd);
    const normalizedName = originalName.toUpperCase();
    const isKnown = KNOWN_DIRECTIVES.has(normalizedName as ModelfileDirectiveName);

    if (isKnown) {
      const name = normalizedName as ModelfileDirectiveName;
      const node: ModelfileDirectiveNode = {
        kind: 'directive',
        id: nodeId(`directive:${name}`, first.start, nodeEnd),
        raw: raw.slice(first.start, nodeEnd),
        range: range(lines, first.start, nodeEnd),
        name,
        originalName,
        argument,
        argumentRange: range(lines, argumentStart, argumentEnd),
        multiline: endLineIndex > index,
        structuredEditable: structuredEditable(name, multilineBalanced),
      };
      nodes.push(node);
      validateKnownDirective(node, diagnostics);
      if (!multilineBalanced) {
        diagnostic(diagnostics, 'error', 'UNCLOSED_MULTILINE', `${name} contains an unclosed triple-quoted value.`, node.range);
      }
    } else {
      nodes.push({
        kind: 'opaque-directive',
        id: nodeId(`opaque-directive:${normalizedName}`, first.start, nodeEnd),
        raw: raw.slice(first.start, nodeEnd),
        range: range(lines, first.start, nodeEnd),
        originalName,
        argument,
        argumentRange: range(lines, argumentStart, argumentEnd),
        multiline: endLineIndex > index,
      });
      hasOpaqueSyntax = true;
      diagnostic(
        diagnostics,
        'info',
        'UNKNOWN_DIRECTIVE',
        `${originalName} is not a known structured directive and will be preserved unchanged.`,
        range(lines, first.start + leading.length, first.start + leading.length + originalName.length),
      );
      if (!multilineBalanced) {
        diagnostic(diagnostics, 'error', 'UNCLOSED_MULTILINE', `${originalName} contains an unclosed triple-quoted value.`, range(lines, first.start, nodeEnd));
      }
    }

    index = endLineIndex + 1;
  }

  const fromNodes = nodes.filter(
    (node): node is ModelfileDirectiveNode => node.kind === 'directive' && node.name === 'FROM',
  );
  if (fromNodes.length === 0) {
    const emptyRange = range(lines, 0, 0);
    diagnostic(diagnostics, 'error', 'FROM_REQUIRED', 'A Modelfile requires a FROM directive.', emptyRange);
  } else if (fromNodes.length > 1) {
    for (const duplicate of fromNodes.slice(1)) {
      diagnostic(diagnostics, 'error', 'FROM_DUPLICATE', 'Only one FROM directive can be represented unambiguously by the structured editor.', duplicate.range);
    }
  }

  return {
    raw,
    contentSha256: sha256(raw),
    lineEnding: detectedLineEnding(raw),
    nodes,
    diagnostics,
    hasOpaqueSyntax,
  };
}

export function renderModelfile(parsed: ParsedModelfile): string {
  return parsed.raw;
}

export function replaceDirectiveArgument(
  parsed: ParsedModelfile,
  nodeIdValue: string,
  nextArgument: string,
): ModelfilePatchResult {
  if (typeof nextArgument !== 'string' || nextArgument.includes('\u0000')) {
    throw new Error('Replacement directive argument must be NUL-free text.');
  }
  const node = parsed.nodes.find((candidate) => candidate.id === nodeIdValue);
  if (!node || (node.kind !== 'directive' && node.kind !== 'opaque-directive')) {
    throw new Error('Directive node was not found.');
  }
  if (node.kind !== 'directive' || !node.structuredEditable) {
    throw new Error('Directive node is not safe for structured editing.');
  }
  if (Buffer.byteLength(nextArgument, 'utf8') > MAX_RAW_BYTES) {
    throw new Error('Replacement directive argument is too large.');
  }
  const start = node.argumentRange.start.offset;
  const end = node.argumentRange.end.offset;
  if (parsed.raw.slice(start, end) === nextArgument) {
    return { raw: parsed.raw, parsed };
  }
  const nextRaw = `${parsed.raw.slice(0, start)}${nextArgument}${parsed.raw.slice(end)}`;
  return { raw: nextRaw, parsed: parseModelfile(nextRaw) };
}
