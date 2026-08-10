import {
  parseModelfile,
  type ModelfileDirectiveNode,
  type ParsedModelfile,
} from './modelfile-parser.js';
import { parseKeyValueArgument, parseTextArgument } from './modelfile-editor.js';

export interface OllamaCreateMessage {
  readonly role: 'system' | 'user' | 'assistant';
  readonly content: string;
}

export interface CompiledOllamaCreatePayload {
  readonly from: string;
  readonly template?: string;
  readonly system?: string;
  readonly license?: string;
  readonly parameters?: Readonly<Record<string, unknown>>;
  readonly messages?: readonly OllamaCreateMessage[];
  readonly renderer?: string;
  readonly parser?: string;
  readonly requires?: string;
}

export interface ModelfileDeploySummary {
  readonly baseModel: string;
  readonly directiveCounts: Readonly<Record<string, number>>;
  readonly expectedFields: readonly string[];
}

export interface CompiledModelfileDeploy {
  readonly payload: CompiledOllamaCreatePayload;
  readonly summary: ModelfileDeploySummary;
}

export class ModelfileDeployCompileError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

const MODEL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/:@+-]*$/u;
const SAFE_ROLE = new Set<OllamaCreateMessage['role']>(['system', 'user', 'assistant']);
const SCALAR_SINGLETONS = new Set(['FROM', 'TEMPLATE', 'SYSTEM', 'RENDERER', 'PARSER', 'REQUIRES']);
const MAX_PARAMETER_KEY = 128;
const MAX_PARAMETER_VALUE = 64 * 1024;
const MAX_MESSAGE_CONTENT = 256 * 1024;

function directives(parsed: ParsedModelfile): readonly ModelfileDirectiveNode[] {
  return parsed.nodes.filter((node): node is ModelfileDirectiveNode => node.kind === 'directive');
}

export function canonicalOllamaModelName(value: string): string {
  const slash = value.lastIndexOf('/');
  const colon = value.lastIndexOf(':');
  return colon > slash ? value : `${value}:latest`;
}

function validateBaseModel(argument: string): string {
  const value = argument.trim();
  if (
    !value
    || value === '.'
    || value.startsWith('./')
    || value.startsWith('../')
    || value.startsWith('/')
    || value.includes('\\')
    || value.startsWith('sha256:')
    || value.includes('/.ollama/models/blobs/')
    || !MODEL_NAME_PATTERN.test(value)
  ) {
    throw new ModelfileDeployCompileError(
      'DEPLOY_FROM_UNSUPPORTED',
      'FROM must reference an installed Ollama model name for this deploy mode.',
    );
  }
  return canonicalOllamaModelName(value);
}

function singleton(nodes: readonly ModelfileDirectiveNode[], name: ModelfileDirectiveNode['name']): ModelfileDirectiveNode | undefined {
  const matches = nodes.filter((node) => node.name === name);
  if (matches.length > 1) {
    throw new ModelfileDeployCompileError('DEPLOY_DIRECTIVE_DUPLICATE', `${name} must not be duplicated for deployment.`);
  }
  return matches[0];
}

function unquotedText(node: ModelfileDirectiveNode): string {
  const value = parseTextArgument(node.argument).value;
  if (!value.trim()) throw new ModelfileDeployCompileError('DEPLOY_DIRECTIVE_EMPTY', `${node.name} must not be empty.`);
  return value;
}

export function normalizeOllamaParameterScalar(raw: string): unknown {
  const value = raw.trim();
  if (!value || value.length > MAX_PARAMETER_VALUE) {
    throw new ModelfileDeployCompileError('DEPLOY_PARAMETER_INVALID', 'PARAMETER value is empty or too large.');
  }
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      const parsed = JSON.parse(value);
      if (typeof parsed === 'string') return parsed;
    } catch {
      throw new ModelfileDeployCompileError('DEPLOY_PARAMETER_INVALID', 'Quoted PARAMETER value is not valid JSON string syntax.');
    }
  }
  if (/^(true|false)$/iu.test(value)) return value.toLowerCase() === 'true';
  if (/^-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/iu.test(value)) {
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return value;
}

function compileParameters(nodes: readonly ModelfileDirectiveNode[]): Readonly<Record<string, unknown>> | undefined {
  const result: Record<string, unknown> = {};
  for (const node of nodes.filter((candidate) => candidate.name === 'PARAMETER')) {
    const pair = parseKeyValueArgument(node.argument);
    if (!pair || !pair.key || pair.key.length > MAX_PARAMETER_KEY) {
      throw new ModelfileDeployCompileError('DEPLOY_PARAMETER_INVALID', 'PARAMETER must contain a bounded name and single-line value.');
    }
    const key = pair.key;
    const value = normalizeOllamaParameterScalar(pair.value);
    if (key === 'stop') {
      const existing = result[key];
      result[key] = existing === undefined ? value : Array.isArray(existing) ? [...existing, value] : [existing, value];
      continue;
    }
    if (Object.hasOwn(result, key)) {
      throw new ModelfileDeployCompileError('DEPLOY_PARAMETER_DUPLICATE', `PARAMETER ${key} is duplicated; only repeated stop is unambiguous.`);
    }
    result[key] = value;
  }
  return Object.keys(result).length ? result : undefined;
}

function compileMessages(nodes: readonly ModelfileDirectiveNode[]): readonly OllamaCreateMessage[] | undefined {
  const messages: OllamaCreateMessage[] = [];
  for (const node of nodes.filter((candidate) => candidate.name === 'MESSAGE')) {
    const argument = node.argument;
    const match = /^(\s*)(\S+)[ \t]+([\s\S]+)$/u.exec(argument);
    const role = match?.[2]?.toLowerCase() as OllamaCreateMessage['role'] | undefined;
    if (!role || !SAFE_ROLE.has(role)) {
      throw new ModelfileDeployCompileError('DEPLOY_MESSAGE_ROLE_INVALID', 'MESSAGE role must be system, user, or assistant.');
    }
    const rawContent = match?.[3] ?? '';
    const content = parseTextArgument(rawContent).value;
    if (!content.trim() || content.length > MAX_MESSAGE_CONTENT) {
      throw new ModelfileDeployCompileError('DEPLOY_MESSAGE_CONTENT_INVALID', 'MESSAGE content is empty or too large.');
    }
    messages.push({ role, content });
  }
  return messages.length ? messages : undefined;
}

function compileLicense(nodes: readonly ModelfileDirectiveNode[]): string | undefined {
  const licenses = nodes.filter((node) => node.name === 'LICENSE');
  if (licenses.length === 0) return undefined;
  if (licenses.length > 1) {
    throw new ModelfileDeployCompileError(
      'DEPLOY_LICENSE_MULTIPLE_UNVERIFIABLE',
      'Multiple LICENSE directives are not supported by this deploy mode because post-create show verification exposes one license field.',
    );
  }
  return unquotedText(licenses[0]!);
}

function directiveCounts(nodes: readonly ModelfileDirectiveNode[]): Readonly<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const node of nodes) counts[node.name] = (counts[node.name] ?? 0) + 1;
  return counts;
}

export function compileModelfileForDeploy(raw: string): CompiledModelfileDeploy {
  let parsed: ParsedModelfile;
  try {
    parsed = parseModelfile(raw);
  } catch (error) {
    throw new ModelfileDeployCompileError('DEPLOY_SOURCE_INVALID', error instanceof Error ? error.message : 'Modelfile source is invalid.');
  }

  if (parsed.diagnostics.some((diagnostic) => diagnostic.severity === 'error')) {
    throw new ModelfileDeployCompileError('DEPLOY_SOURCE_DIAGNOSTICS', 'Modelfile contains local parser errors and cannot be deployed.');
  }
  if (parsed.hasOpaqueSyntax) {
    throw new ModelfileDeployCompileError('DEPLOY_OPAQUE_SYNTAX', 'Unknown or opaque Modelfile syntax must be resolved before deployment.');
  }

  const nodes = directives(parsed);
  for (const name of SCALAR_SINGLETONS) singleton(nodes, name as ModelfileDirectiveNode['name']);
  if (nodes.some((node) => node.name === 'DRAFT')) {
    throw new ModelfileDeployCompileError('DEPLOY_DRAFT_UNSUPPORTED', 'DRAFT requires a separate file/blob trust boundary and is not supported by this deploy mode.');
  }
  if (nodes.some((node) => node.name === 'ADAPTER')) {
    throw new ModelfileDeployCompileError('DEPLOY_ADAPTER_UNSUPPORTED', 'ADAPTER requires a separate file/blob trust boundary and is not supported by this deploy mode.');
  }
  if (nodes.some((node) => !node.structuredEditable && node.name !== 'MESSAGE')) {
    throw new ModelfileDeployCompileError('DEPLOY_RAW_ONLY_DIRECTIVE', 'A directive is ambiguous or raw-only and cannot be deployed safely.');
  }

  const from = singleton(nodes, 'FROM');
  if (!from) throw new ModelfileDeployCompileError('DEPLOY_FROM_REQUIRED', 'FROM is required for deployment.');
  const baseModel = validateBaseModel(from.argument);
  const template = singleton(nodes, 'TEMPLATE');
  const system = singleton(nodes, 'SYSTEM');
  const renderer = singleton(nodes, 'RENDERER');
  const parser = singleton(nodes, 'PARSER');
  const requires = singleton(nodes, 'REQUIRES');
  const license = compileLicense(nodes);
  const parameters = compileParameters(nodes);
  const messages = compileMessages(nodes);

  const payload: CompiledOllamaCreatePayload = {
    from: baseModel,
    ...(template ? { template: unquotedText(template) } : {}),
    ...(system ? { system: unquotedText(system) } : {}),
    ...(license !== undefined ? { license } : {}),
    ...(parameters !== undefined ? { parameters } : {}),
    ...(messages !== undefined ? { messages } : {}),
    ...(renderer ? { renderer: renderer.argument.trim() } : {}),
    ...(parser ? { parser: parser.argument.trim() } : {}),
    ...(requires ? { requires: requires.argument.trim() } : {}),
  };

  const expectedFields = [
    'from',
    ...(payload.template !== undefined ? ['template'] : []),
    ...(payload.system !== undefined ? ['system'] : []),
    ...(payload.license !== undefined ? ['license'] : []),
    ...(payload.parameters !== undefined ? ['parameters'] : []),
    ...(payload.messages !== undefined ? ['messages'] : []),
    ...(payload.renderer !== undefined ? ['renderer'] : []),
    ...(payload.parser !== undefined ? ['parser'] : []),
    ...(payload.requires !== undefined ? ['requires'] : []),
  ];

  return {
    payload,
    summary: {
      baseModel,
      directiveCounts: directiveCounts(nodes),
      expectedFields,
    },
  };
}
