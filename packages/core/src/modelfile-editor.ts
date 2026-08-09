import {
  parseModelfile,
  replaceDirectiveArgument,
  type ModelfileDirectiveName,
  type ModelfileDirectiveNode,
  type ModelfilePatchResult,
  type ParsedModelfile,
} from './modelfile-parser.js';

const SINGLETON_DIRECTIVES = new Set<ModelfileDirectiveName>([
  'FROM',
  'TEMPLATE',
  'SYSTEM',
  'LICENSE',
  'REQUIRES',
]);

export interface ModelfileKeyValueArgument {
  readonly key: string;
  readonly value: string;
}

export interface ModelfileTextArgument {
  readonly value: string;
  readonly tripleQuoted: boolean;
  readonly leadingWhitespace: string;
  readonly trailingWhitespace: string;
}

function preferredLineEnding(parsed: ParsedModelfile): '\n' | '\r\n' {
  if (parsed.lineEnding === '\r\n') return '\r\n';
  if (parsed.lineEnding === '\n') return '\n';
  if (parsed.lineEnding === 'mixed') {
    const lastLf = parsed.raw.lastIndexOf('\n');
    if (lastLf > 0 && parsed.raw[lastLf - 1] === '\r') return '\r\n';
  }
  return '\n';
}

function endsWithLineEnding(raw: string): boolean {
  return raw.endsWith('\n');
}

function assertKnownDirective(name: string): asserts name is ModelfileDirectiveName {
  if (!['FROM', 'PARAMETER', 'TEMPLATE', 'SYSTEM', 'ADAPTER', 'LICENSE', 'MESSAGE', 'REQUIRES'].includes(name)) {
    throw new Error('Unknown Modelfile directive cannot be added through the structured editor.');
  }
}

export function directiveNodes(
  parsed: ParsedModelfile,
  name: ModelfileDirectiveName,
): readonly ModelfileDirectiveNode[] {
  return parsed.nodes.filter(
    (node): node is ModelfileDirectiveNode => node.kind === 'directive' && node.name === name,
  );
}

export function appendDirective(
  parsed: ParsedModelfile,
  nameValue: ModelfileDirectiveName,
  argument: string,
): ModelfilePatchResult {
  assertKnownDirective(nameValue);
  if (typeof argument !== 'string' || argument.includes('\u0000')) {
    throw new Error('Directive argument must be NUL-free text.');
  }
  if (SINGLETON_DIRECTIVES.has(nameValue) && directiveNodes(parsed, nameValue).length > 0) {
    throw new Error(`${nameValue} already exists and cannot be appended as a duplicate singleton directive.`);
  }
  if (['PARAMETER', 'MESSAGE'].includes(nameValue) && /[\r\n]/u.test(argument)) {
    throw new Error(`${nameValue} structured input must remain single-line; use Raw view for multiline syntax.`);
  }
  const ending = preferredLineEnding(parsed);
  const separator = parsed.raw.length > 0 && !endsWithLineEnding(parsed.raw) ? ending : '';
  const nextRaw = `${parsed.raw}${separator}${nameValue} ${argument}${ending}`;
  return { raw: nextRaw, parsed: parseModelfile(nextRaw) };
}

export function removeDirective(
  parsed: ParsedModelfile,
  nodeId: string,
): ModelfilePatchResult {
  const node = parsed.nodes.find((candidate) => candidate.id === nodeId);
  if (!node || node.kind !== 'directive') throw new Error('Known directive node was not found.');
  if (!node.structuredEditable) throw new Error('Directive node is not safe for structured removal.');
  const start = node.range.start.offset;
  const end = node.range.end.offset;
  const nextRaw = `${parsed.raw.slice(0, start)}${parsed.raw.slice(end)}`;
  return { raw: nextRaw, parsed: parseModelfile(nextRaw) };
}

export function parseKeyValueArgument(argument: string): ModelfileKeyValueArgument | null {
  if (/[\r\n]/u.test(argument)) return null;
  const match = /^(\s*)(\S+)([ \t]+)(.*?)([ \t]*)$/u.exec(argument);
  if (!match || !match[2] || !match[4]) return null;
  return { key: match[2], value: match[4] };
}

export function replaceKeyValueArgument(
  parsed: ParsedModelfile,
  nodeId: string,
  key: string,
  value: string,
): ModelfilePatchResult {
  if (!key.trim() || /\s/u.test(key) || key.includes('\u0000') || value.includes('\u0000') || /[\r\n]/u.test(value)) {
    throw new Error('Structured key/value directive input is invalid or multiline; use Raw view for multiline syntax.');
  }
  const node = parsed.nodes.find((candidate) => candidate.id === nodeId);
  if (!node || node.kind !== 'directive' || !['PARAMETER', 'MESSAGE'].includes(node.name)) {
    throw new Error('Directive is not a structured key/value directive.');
  }
  if (node.multiline || /[\r\n]/u.test(node.argument)) {
    throw new Error(`${node.name} multiline syntax is preserved as raw source and is not edited structurally.`);
  }
  const match = /^(\s*)(\S+)([ \t]+)(.*?)([ \t]*)$/u.exec(node.argument);
  const leading = match?.[1] ?? '';
  const separator = match?.[3] ?? ' ';
  const trailing = match?.[5] ?? '';
  return replaceDirectiveArgument(parsed, node.id, `${leading}${key}${separator}${value}${trailing}`);
}

export function parseTextArgument(argument: string): ModelfileTextArgument {
  const match = /^(\s*)"""([\s\S]*)"""(\s*)$/u.exec(argument);
  if (match) {
    return {
      value: match[2] ?? '',
      tripleQuoted: true,
      leadingWhitespace: match[1] ?? '',
      trailingWhitespace: match[3] ?? '',
    };
  }
  const leading = /^\s*/u.exec(argument)?.[0] ?? '';
  const trailing = /\s*$/u.exec(argument)?.[0] ?? '';
  return {
    value: argument.slice(leading.length, argument.length - trailing.length),
    tripleQuoted: false,
    leadingWhitespace: leading,
    trailingWhitespace: trailing,
  };
}

export function replaceTextArgument(
  parsed: ParsedModelfile,
  nodeId: string,
  value: string,
): ModelfilePatchResult {
  if (value.includes('\u0000')) throw new Error('Structured text directive input is invalid.');
  const node = parsed.nodes.find((candidate) => candidate.id === nodeId);
  if (!node || node.kind !== 'directive' || !['TEMPLATE', 'SYSTEM', 'LICENSE'].includes(node.name)) {
    throw new Error('Directive is not a structured text directive.');
  }
  const current = parseTextArgument(node.argument);
  if (current.value === value) return { raw: parsed.raw, parsed };
  const needsTripleQuotes = current.tripleQuoted || value.includes('\n') || value.includes('\r');
  const nextArgument = needsTripleQuotes
    ? `${current.leadingWhitespace}"""${value}"""${current.trailingWhitespace}`
    : `${current.leadingWhitespace}${value}${current.trailingWhitespace}`;
  return replaceDirectiveArgument(parsed, node.id, nextArgument);
}
