import {
  canonicalOllamaModelName,
  normalizeOllamaParameterScalar,
  type CompiledModelfileDeploy,
  type OllamaCreateMessage,
} from '@orc/core/modelfile-deploy';
import { parseTextArgument } from '@orc/core/modelfile-editor';
import { parseModelfile } from '@orc/core/modelfile-parser';
import type { OllamaModelDetailResult } from './ollama-model-details.js';

export interface ModelfileDeployVerificationResult {
  readonly verified: boolean;
  readonly mismatches: readonly string[];
  readonly baseModelObservation: 'matched' | 'unavailable' | 'mismatch';
}

function sameScalar(left: unknown, right: unknown): boolean {
  return typeof left === 'number' && typeof right === 'number'
    ? Object.is(left, right)
    : left === right;
}

function parseShownParameters(value: string | null): Readonly<Record<string, unknown>> {
  if (!value) return {};
  const result: Record<string, unknown> = {};
  for (const line of value.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = /^(\S+)[ \t]+(.+)$/u.exec(trimmed);
    if (!match) continue;
    const key = match[1]!;
    let parsed: unknown;
    try { parsed = normalizeOllamaParameterScalar(match[2]!); }
    catch { parsed = match[2]!.trim(); }
    if (key === 'stop') {
      const existing = result[key];
      result[key] = existing === undefined ? parsed : Array.isArray(existing) ? [...existing, parsed] : [existing, parsed];
    } else if (!Object.hasOwn(result, key)) {
      result[key] = parsed;
    }
  }
  return result;
}

function expectedParametersPresent(
  expected: Readonly<Record<string, unknown>> | undefined,
  actualText: string | null,
): boolean {
  if (!expected) return true;
  const actual = parseShownParameters(actualText);
  for (const [key, value] of Object.entries(expected)) {
    const observed = actual[key];
    if (Array.isArray(value)) {
      if (!Array.isArray(observed) || value.length !== observed.length) return false;
      if (value.some((entry, index) => !sameScalar(entry, observed[index]))) return false;
    } else if (!sameScalar(value, observed)) return false;
  }
  return true;
}

function parseGeneratedSemantics(modelfile: string | null): {
  readonly messages: readonly OllamaCreateMessage[];
  readonly renderer: string | null;
  readonly parser: string | null;
} | null {
  if (!modelfile) return null;
  let parsed;
  try { parsed = parseModelfile(modelfile); }
  catch { return null; }
  const messages: OllamaCreateMessage[] = [];
  let renderer: string | null = null;
  let parser: string | null = null;
  for (const node of parsed.nodes) {
    if (node.kind !== 'directive') continue;
    if (node.name === 'RENDERER' && renderer === null) renderer = node.argument.trim();
    if (node.name === 'PARSER' && parser === null) parser = node.argument.trim();
    if (node.name !== 'MESSAGE') continue;
    const match = /^(\s*)(\S+)[ \t]+([\s\S]+)$/u.exec(node.argument);
    const role = match?.[2]?.toLowerCase();
    if (role !== 'system' && role !== 'user' && role !== 'assistant') continue;
    messages.push({ role, content: parseTextArgument(match?.[3] ?? '').value });
  }
  return { messages, renderer, parser };
}

function messagesAppearInOrder(expected: readonly OllamaCreateMessage[] | undefined, actual: readonly OllamaCreateMessage[]): boolean {
  if (!expected) return true;
  let cursor = 0;
  for (const message of actual) {
    const wanted = expected[cursor];
    if (wanted && message.role === wanted.role && message.content === wanted.content) cursor += 1;
  }
  return cursor === expected.length;
}

export function verifyCompiledModelfileDeploy(
  compiled: CompiledModelfileDeploy,
  detail: OllamaModelDetailResult,
): ModelfileDeployVerificationResult {
  const mismatches: string[] = [];
  const expected = compiled.payload;

  if (expected.template !== undefined && detail.template !== expected.template) mismatches.push('template');
  if (expected.system !== undefined && detail.system !== expected.system) mismatches.push('system');
  if (expected.license !== undefined && detail.license !== expected.license) mismatches.push('license');
  if (expected.requires !== undefined && detail.requires !== expected.requires) mismatches.push('requires');
  if (!expectedParametersPresent(expected.parameters, detail.parameters)) mismatches.push('parameters');

  const generated = parseGeneratedSemantics(detail.modelfile);
  if (expected.messages !== undefined && (!generated || !messagesAppearInOrder(expected.messages, generated.messages))) {
    mismatches.push('messages');
  }
  if (expected.renderer !== undefined && generated?.renderer !== expected.renderer) mismatches.push('renderer');
  if (expected.parser !== undefined && generated?.parser !== expected.parser) mismatches.push('parser');

  let baseModelObservation: ModelfileDeployVerificationResult['baseModelObservation'] = 'unavailable';
  if (detail.details.parentModel) {
    try {
      baseModelObservation = canonicalOllamaModelName(detail.details.parentModel) === compiled.summary.baseModel
        ? 'matched'
        : 'mismatch';
    } catch {
      baseModelObservation = 'mismatch';
    }
    if (baseModelObservation === 'mismatch') mismatches.push('from');
  }

  return {
    verified: mismatches.length === 0,
    mismatches,
    baseModelObservation,
  };
}
