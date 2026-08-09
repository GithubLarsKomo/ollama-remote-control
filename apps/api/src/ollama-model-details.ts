import type {
  HostOnboardingRepository,
  OllamaTargetRepository,
  SshCredentialRepository,
} from '@orc/core';
import { SecretCipher } from '@orc/security';
import {
  execPrivateKey,
  SshTransportError,
  type SshPrivateKeyConnection,
} from '@orc/ssh';
import {
  selectOllamaApiRoute,
  type OllamaHealthTransportMode,
} from './ollama-health.js';
import {
  OllamaModelInventoryError,
  parseInstalledModels,
  type InstalledOllamaModelView,
} from './ollama-models.js';
import {
  httpGetViaPinnedSsh,
  httpPostOllamaShowViaPinnedSsh,
  SshHttpError,
} from './ssh-http.js';

const MAX_MODEL_NAME = 512;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_CAPABILITIES = 32;
const MAX_CAPABILITY = 64;
const MAX_DETAIL_STRING = 256;
const MAX_FAMILIES = 32;
const MAX_MODEFILE = 512 * 1024;
const MAX_PARAMETERS = 128 * 1024;
const MAX_TEMPLATE = 256 * 1024;
const MAX_SYSTEM = 256 * 1024;
const MAX_LICENSE = 256 * 1024;
const MAX_REQUIRES = 8 * 1024;
const MAX_ADAPTERS = 32;

export type ProvenanceReferenceKind = 'model-reference' | 'local-artifact' | 'unknown';

export interface ProvenanceReferencePreview {
  readonly reference: string;
  readonly kind: ProvenanceReferenceKind;
}

export interface ModelfileProvenancePreview {
  readonly from: ProvenanceReferencePreview | null;
  readonly adapters: readonly ProvenanceReferencePreview[];
}

export interface OllamaArchitectureSummary {
  readonly architecture: string | null;
  readonly parameterCount: number | null;
  readonly contextLength: number | null;
  readonly embeddingLength: number | null;
  readonly blockCount: number | null;
  readonly quantizationVersion: number | null;
}

export interface OllamaModelDetailResult {
  readonly targetId: string;
  readonly transport: { readonly mode: OllamaHealthTransportMode };
  readonly identity: {
    readonly name: string;
    readonly model: string;
    readonly digest: string;
    readonly modifiedAt: string | null;
  };
  readonly details: {
    readonly format: string | null;
    readonly family: string | null;
    readonly families: readonly string[];
    readonly parameterSize: string | null;
    readonly quantizationLevel: string | null;
    readonly parentModel: string | null;
  };
  readonly capabilities: readonly string[];
  readonly modelfile: string | null;
  readonly parameters: string | null;
  readonly template: string | null;
  readonly system: string | null;
  readonly license: string | null;
  readonly requires: string | null;
  readonly architecture: OllamaArchitectureSummary;
  readonly provenancePreview: ModelfileProvenancePreview;
}

export class OllamaModelDetailError extends Error {
  constructor(
    readonly code: string,
    readonly statusCode: number,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

interface ResolvedTarget {
  readonly targetId: string;
  readonly selectedContainerId: string;
  readonly connection: SshPrivateKeyConnection;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

export function validateRequestedModelName(value: unknown): string {
  if (
    typeof value !== 'string'
    || value.length < 1
    || value.length > MAX_MODEL_NAME
    || !/^[A-Za-z0-9][A-Za-z0-9._/:@+-]*$/u.test(value)
  ) {
    throw new OllamaModelDetailError('INVALID_MODEL_NAME', 400, 'Model name is invalid.');
  }
  return value;
}

function safeScalarString(value: unknown, maxLength = MAX_DETAIL_STRING): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text || text.length > maxLength || /[\u0000-\u001f\u007f]/u.test(text)) return null;
  return text;
}

function boundedText(value: unknown, maxLength: number, field: string): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (
    typeof value !== 'string'
    || value.length > maxLength
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)
  ) {
    throw new OllamaModelDetailError('OLLAMA_MODEL_DETAIL_INVALID', 502, `Ollama model ${field} is invalid or too large.`);
  }
  return value;
}

function optionalNonNegativeInteger(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return null;
  return value;
}

function capabilities(value: unknown): readonly string[] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_CAPABILITIES) {
    throw new OllamaModelDetailError('OLLAMA_MODEL_DETAIL_INVALID', 502, 'Ollama model capabilities are invalid.');
  }
  return value.map((entry) => {
    const text = safeScalarString(entry, MAX_CAPABILITY);
    if (!text) throw new OllamaModelDetailError('OLLAMA_MODEL_DETAIL_INVALID', 502, 'Ollama model capability is invalid.');
    return text;
  });
}

function showDetails(value: unknown): { parentModel: string | null } {
  if (!isObject(value)) return { parentModel: null };
  return { parentModel: safeScalarString(value.parent_model) };
}

function architectureSummary(value: unknown): OllamaArchitectureSummary {
  const info = isObject(value) ? value : {};
  const architecture = safeScalarString(info['general.architecture']);
  const prefix = architecture ? `${architecture}.` : '';
  return {
    architecture,
    parameterCount: optionalNonNegativeInteger(info['general.parameter_count']),
    contextLength: prefix ? optionalNonNegativeInteger(info[`${prefix}context_length`]) : null,
    embeddingLength: prefix ? optionalNonNegativeInteger(info[`${prefix}embedding_length`]) : null,
    blockCount: prefix ? optionalNonNegativeInteger(info[`${prefix}block_count`]) : null,
    quantizationVersion: optionalNonNegativeInteger(info['general.quantization_version']),
  };
}

function classifyReference(reference: string): ProvenanceReferenceKind {
  if (
    reference.startsWith('/')
    || reference.startsWith('./')
    || reference.startsWith('../')
    || reference.startsWith('~/')
    || /^[A-Za-z]:[\\/]/u.test(reference)
    || /^sha256:/iu.test(reference)
  ) return 'local-artifact';
  if (/^[A-Za-z0-9][A-Za-z0-9._/:@+-]*$/u.test(reference)) return 'model-reference';
  return 'unknown';
}

function cleanDirectiveReference(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) return trimmed.slice(1, -1);
  }
  return trimmed;
}

export function parseModelfileProvenancePreview(modelfile: string | null): ModelfileProvenancePreview {
  if (!modelfile) return { from: null, adapters: [] };
  let from: ProvenanceReferencePreview | null = null;
  const adapters: ProvenanceReferencePreview[] = [];
  for (const line of modelfile.split(/\r?\n/u)) {
    if (/^\s*#/u.test(line)) continue;
    const match = /^\s*(FROM|ADAPTER)\s+(.+?)\s*$/iu.exec(line);
    if (!match) continue;
    const reference = cleanDirectiveReference(match[2]);
    if (!reference || reference.length > MAX_MODEL_NAME) continue;
    const preview = { reference, kind: classifyReference(reference) } as const;
    if (match[1].toUpperCase() === 'FROM') {
      if (!from) from = preview;
    } else if (adapters.length < MAX_ADAPTERS) {
      adapters.push(preview);
    }
  }
  return { from, adapters };
}

export function parseOllamaShowResponse(body: Buffer, installed: InstalledOllamaModelView): OllamaModelDetailResult['details'] & Omit<OllamaModelDetailResult, 'targetId' | 'transport' | 'identity' | 'details'> {
  let parsed: unknown;
  try { parsed = JSON.parse(body.toString('utf8')); }
  catch {
    throw new OllamaModelDetailError('OLLAMA_MODEL_DETAIL_INVALID', 502, 'Ollama model detail returned invalid JSON.');
  }
  if (!isObject(parsed)) {
    throw new OllamaModelDetailError('OLLAMA_MODEL_DETAIL_INVALID', 502, 'Ollama model detail shape is invalid.');
  }
  const modelfile = boundedText(parsed.modelfile, MAX_MODEFILE, 'Modelfile');
  const detail = showDetails(parsed.details);
  const families = installed.details.families;
  if (families.length > MAX_FAMILIES) {
    throw new OllamaModelDetailError('OLLAMA_MODEL_DETAIL_INVALID', 502, 'Ollama model families are invalid.');
  }
  return {
    format: installed.details.format,
    family: installed.details.family,
    families,
    parameterSize: installed.details.parameterSize,
    quantizationLevel: installed.details.quantizationLevel,
    parentModel: detail.parentModel,
    capabilities: capabilities(parsed.capabilities),
    modelfile,
    parameters: boundedText(parsed.parameters, MAX_PARAMETERS, 'parameters'),
    template: boundedText(parsed.template, MAX_TEMPLATE, 'template'),
    system: boundedText(parsed.system, MAX_SYSTEM, 'system prompt'),
    license: boundedText(parsed.license, MAX_LICENSE, 'license'),
    requires: boundedText(parsed.requires, MAX_REQUIRES, 'requires metadata'),
    architecture: architectureSummary(parsed.model_info),
    provenancePreview: parseModelfileProvenancePreview(modelfile),
  };
}

function parseInspect(stdout: string): Record<string, any> {
  try {
    const parsed = JSON.parse(stdout);
    const object = Array.isArray(parsed) ? parsed[0] : null;
    if (!object || typeof object !== 'object') throw new Error('missing inspect object');
    return object as Record<string, any>;
  } catch {
    throw new OllamaModelDetailError('DOCKER_OUTPUT_INVALID', 502, 'Docker inspect returned invalid data.');
  }
}

function mapSshHttpError(error: SshHttpError): OllamaModelDetailError {
  if (error.code === 'SSH_HOST_KEY_MISMATCH') {
    return new OllamaModelDetailError('SSH_HOST_KEY_MISMATCH', 409, 'SSH host-key verification failed.', { cause: error });
  }
  if (error.code === 'HTTP_REQUEST_INVALID') {
    return new OllamaModelDetailError('INVALID_MODEL_NAME', 400, 'Model name is invalid.', { cause: error });
  }
  if (error.code === 'HTTP_RESPONSE_TOO_LARGE' || error.code === 'HTTP_RESPONSE_INVALID') {
    return new OllamaModelDetailError('OLLAMA_MODEL_DETAIL_INVALID', 502, 'Ollama model detail response was invalid.', { cause: error });
  }
  return new OllamaModelDetailError('OLLAMA_API_UNAVAILABLE', 502, 'Ollama API could not be reached through SSH.', { cause: error });
}

export class OllamaModelDetailService {
  constructor(
    private readonly hosts: HostOnboardingRepository,
    private readonly credentials: SshCredentialRepository,
    private readonly targets: OllamaTargetRepository,
    private readonly masterKey: Buffer | null,
  ) {}

  private resolve(targetId: string): ResolvedTarget {
    if (!this.masterKey) throw new OllamaModelDetailError('MASTER_KEY_REQUIRED', 503, 'External master key is required.');
    const target = this.targets.findById(targetId);
    if (!target || !target.enabled) throw new OllamaModelDetailError('TARGET_NOT_FOUND', 404, 'Ollama target was not found or is disabled.');
    const host = this.hosts.findHostById(target.hostId);
    if (!host || !host.enabled) throw new OllamaModelDetailError('HOST_NOT_FOUND', 404, 'Host was not found or is disabled.');
    const credential = this.credentials.findByHostId(host.id);
    if (!credential) throw new OllamaModelDetailError('SSH_CREDENTIAL_NOT_FOUND', 409, 'Host has no SSH credential.');
    let privateKey: string;
    try {
      privateKey = new SecretCipher(this.masterKey).decrypt(
        { credentialId: credential.id, hostId: host.id },
        credential.encryptedPrivateKey,
      );
    } catch {
      throw new OllamaModelDetailError('SSH_CREDENTIAL_INVALID', 409, 'Stored SSH credential could not be decrypted.');
    }
    return {
      targetId: target.id,
      selectedContainerId: target.selectedContainerId,
      connection: {
        hostname: host.hostname,
        port: host.port,
        username: host.username,
        privateKey,
        expectedFingerprint: host.hostKeyFingerprint,
      },
    };
  }

  private async inspect(target: ResolvedTarget): Promise<Record<string, any>> {
    let inspectResult;
    try {
      inspectResult = await execPrivateKey(
        target.connection,
        ['docker', 'inspect', target.selectedContainerId],
        { timeoutMs: 10_000, maxOutputBytes: 2 * 1024 * 1024 },
      );
    } catch (error) {
      if (error instanceof SshTransportError) {
        const status = error.code === 'SSH_HOST_KEY_MISMATCH' ? 409 : error.code === 'AUTH_FAILED' ? 422 : 502;
        throw new OllamaModelDetailError(error.code, status, 'Remote SSH model detail inspection failed.', { cause: error });
      }
      throw error;
    }
    if (inspectResult.exitCode !== 0) {
      const detail = `${inspectResult.stderr}\n${inspectResult.stdout}`;
      if (/no such (object|container)/iu.test(detail)) throw new OllamaModelDetailError('CONTAINER_NOT_FOUND', 404, 'Ollama container was not found.');
      throw new OllamaModelDetailError('DOCKER_UNAVAILABLE', 502, 'Docker inspect failed.');
    }
    const inspect = parseInspect(inspectResult.stdout);
    if (!Boolean(inspect.State?.Running)) throw new OllamaModelDetailError('CONTAINER_NOT_RUNNING', 409, 'Ollama container is not running.');
    return inspect;
  }

  private async getInstalled(
    target: ResolvedTarget,
    route: { host: string; port: number },
  ): Promise<readonly InstalledOllamaModelView[]> {
    try {
      const response = await httpGetViaPinnedSsh(
        target.connection,
        route.host,
        route.port,
        '/api/tags',
        { timeoutMs: 7_500, maxResponseBytes: 1024 * 1024 },
      );
      if (response.statusCode < 200 || response.statusCode >= 300) {
        throw new OllamaModelDetailError('OLLAMA_API_ERROR', 502, `Ollama API returned HTTP ${response.statusCode}.`);
      }
      return parseInstalledModels(response.body);
    } catch (error) {
      if (error instanceof OllamaModelDetailError) throw error;
      if (error instanceof OllamaModelInventoryError) {
        throw new OllamaModelDetailError('OLLAMA_MODEL_DETAIL_INVALID', 502, 'Ollama model inventory response was invalid.', { cause: error });
      }
      if (error instanceof SshHttpError) throw mapSshHttpError(error);
      throw new OllamaModelDetailError('OLLAMA_API_UNAVAILABLE', 502, 'Ollama model inventory request failed.');
    }
  }

  async read(targetId: string, requestedModel: unknown): Promise<OllamaModelDetailResult> {
    const modelName = validateRequestedModelName(requestedModel);
    const target = this.resolve(targetId);
    const inspect = await this.inspect(target);
    const route = selectOllamaApiRoute(inspect);
    if (!route) throw new OllamaModelDetailError('OLLAMA_API_UNAVAILABLE', 502, 'No safe Ollama API route could be derived from Docker state.');

    const installedModels = await this.getInstalled(target, route);
    const installed = installedModels.find((candidate) => candidate.model === modelName)
      ?? installedModels.find((candidate) => candidate.name === modelName);
    if (!installed) throw new OllamaModelDetailError('MODEL_NOT_FOUND', 404, 'Requested model is not installed on the selected Ollama target.');

    let response;
    try {
      response = await httpPostOllamaShowViaPinnedSsh(
        target.connection,
        route.host,
        route.port,
        installed.model,
        { timeoutMs: 10_000, maxResponseBytes: MAX_RESPONSE_BYTES },
      );
    } catch (error) {
      if (error instanceof SshHttpError) throw mapSshHttpError(error);
      throw new OllamaModelDetailError('OLLAMA_API_UNAVAILABLE', 502, 'Ollama model detail request failed.');
    }
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new OllamaModelDetailError('OLLAMA_API_ERROR', 502, `Ollama API returned HTTP ${response.statusCode}.`);
    }

    const parsed = parseOllamaShowResponse(response.body, installed);
    const {
      format, family, families, parameterSize, quantizationLevel, parentModel,
      ...rest
    } = parsed;
    return {
      targetId: target.targetId,
      transport: { mode: route.mode },
      identity: {
        name: installed.name,
        model: installed.model,
        digest: installed.digest,
        modifiedAt: installed.modifiedAt,
      },
      details: { format, family, families, parameterSize, quantizationLevel, parentModel },
      ...rest,
    };
  }
}
