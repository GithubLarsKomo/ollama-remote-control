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
  httpGetViaPinnedSsh,
  SshHttpError,
  type OllamaReadPath,
} from './ssh-http.js';

const MAX_MODELS = 1000;
const MAX_MODEL_NAME = 512;
const MAX_DETAIL_STRING = 256;
const MAX_FAMILIES = 32;
const MAX_RESPONSE_BYTES = 1024 * 1024;

export interface OllamaModelDetailsView {
  readonly format: string | null;
  readonly family: string | null;
  readonly families: readonly string[];
  readonly parameterSize: string | null;
  readonly quantizationLevel: string | null;
}

export interface InstalledOllamaModelView {
  readonly name: string;
  readonly model: string;
  readonly modifiedAt: string | null;
  readonly sizeBytes: number;
  readonly digest: string;
  readonly details: OllamaModelDetailsView;
}

export interface RunningOllamaModelView {
  readonly name: string;
  readonly model: string;
  readonly sizeBytes: number;
  readonly digest: string;
  readonly details: OllamaModelDetailsView;
  readonly expiresAt: string | null;
  readonly sizeVramBytes: number;
  readonly contextLength: number;
}

export interface OllamaModelInventoryResult {
  readonly targetId: string;
  readonly transport: {
    readonly mode: OllamaHealthTransportMode;
  };
  readonly installed: readonly InstalledOllamaModelView[];
  readonly running: readonly RunningOllamaModelView[];
}

export class OllamaModelInventoryError extends Error {
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

function safeString(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text || text.length > maxLength || /[\u0000-\u001f\u007f]/u.test(text)) return null;
  return text;
}

function requiredModelName(value: unknown, field: string): string {
  const text = safeString(value, MAX_MODEL_NAME);
  if (!text) throw new OllamaModelInventoryError('OLLAMA_MODEL_DATA_INVALID', 502, `Ollama model ${field} is invalid.`);
  return text;
}

function digest(value: unknown): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!/^[a-f0-9]{64}$/iu.test(text)) {
    throw new OllamaModelInventoryError('OLLAMA_MODEL_DATA_INVALID', 502, 'Ollama model digest is invalid.');
  }
  return text.toLowerCase();
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new OllamaModelInventoryError('OLLAMA_MODEL_DATA_INVALID', 502, `Ollama model ${field} is invalid.`);
  }
  return value;
}

function optionalTimestamp(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || value.length > 100 || /[\u0000-\u001f\u007f]/u.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new OllamaModelInventoryError('OLLAMA_MODEL_DATA_INVALID', 502, 'Ollama model timestamp is invalid.');
  }
  return value;
}

function details(value: unknown): OllamaModelDetailsView {
  const object = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const familiesRaw = Array.isArray(object.families) ? object.families : [];
  if (familiesRaw.length > MAX_FAMILIES) {
    throw new OllamaModelInventoryError('OLLAMA_MODEL_DATA_INVALID', 502, 'Ollama model families list is too large.');
  }
  const families = familiesRaw.map((entry) => {
    const text = safeString(entry, MAX_DETAIL_STRING);
    if (!text) throw new OllamaModelInventoryError('OLLAMA_MODEL_DATA_INVALID', 502, 'Ollama model family is invalid.');
    return text;
  });
  return {
    format: safeString(object.format, MAX_DETAIL_STRING),
    family: safeString(object.family, MAX_DETAIL_STRING),
    families,
    parameterSize: safeString(object.parameter_size, MAX_DETAIL_STRING),
    quantizationLevel: safeString(object.quantization_level, MAX_DETAIL_STRING),
  };
}

function parseModelsArray(body: Buffer): readonly Record<string, unknown>[] {
  let parsed: unknown;
  try { parsed = JSON.parse(body.toString('utf8')); }
  catch {
    throw new OllamaModelInventoryError('OLLAMA_MODEL_DATA_INVALID', 502, 'Ollama model inventory returned invalid JSON.');
  }
  const models = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>).models
    : undefined;
  if (!Array.isArray(models) || models.length > MAX_MODELS) {
    throw new OllamaModelInventoryError('OLLAMA_MODEL_DATA_INVALID', 502, 'Ollama model inventory shape is invalid.');
  }
  return models.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new OllamaModelInventoryError('OLLAMA_MODEL_DATA_INVALID', 502, 'Ollama model entry is invalid.');
    }
    return entry as Record<string, unknown>;
  });
}

export function parseInstalledModels(body: Buffer): readonly InstalledOllamaModelView[] {
  return parseModelsArray(body).map((model) => ({
    name: requiredModelName(model.name, 'name'),
    model: requiredModelName(model.model, 'identifier'),
    modifiedAt: optionalTimestamp(model.modified_at),
    sizeBytes: nonNegativeInteger(model.size, 'size'),
    digest: digest(model.digest),
    details: details(model.details),
  }));
}

export function parseRunningModels(body: Buffer): readonly RunningOllamaModelView[] {
  return parseModelsArray(body).map((model) => ({
    name: requiredModelName(model.name, 'name'),
    model: requiredModelName(model.model, 'identifier'),
    sizeBytes: nonNegativeInteger(model.size, 'size'),
    digest: digest(model.digest),
    details: details(model.details),
    expiresAt: optionalTimestamp(model.expires_at),
    sizeVramBytes: nonNegativeInteger(model.size_vram, 'VRAM size'),
    contextLength: nonNegativeInteger(model.context_length, 'context length'),
  }));
}

function parseInspect(stdout: string): Record<string, any> {
  try {
    const parsed = JSON.parse(stdout);
    const object = Array.isArray(parsed) ? parsed[0] : null;
    if (!object || typeof object !== 'object') throw new Error('missing inspect object');
    return object as Record<string, any>;
  } catch {
    throw new OllamaModelInventoryError('DOCKER_OUTPUT_INVALID', 502, 'Docker inspect returned invalid data.');
  }
}

function mapSshHttpError(error: SshHttpError): OllamaModelInventoryError {
  if (error.code === 'SSH_HOST_KEY_MISMATCH') {
    return new OllamaModelInventoryError('SSH_HOST_KEY_MISMATCH', 409, 'SSH host-key verification failed.', { cause: error });
  }
  if (error.code === 'HTTP_RESPONSE_TOO_LARGE' || error.code === 'HTTP_RESPONSE_INVALID') {
    return new OllamaModelInventoryError('OLLAMA_MODEL_DATA_INVALID', 502, 'Ollama model inventory response was invalid.', { cause: error });
  }
  return new OllamaModelInventoryError('OLLAMA_API_UNAVAILABLE', 502, 'Ollama API could not be reached through SSH.', { cause: error });
}

export class OllamaModelInventoryService {
  constructor(
    private readonly hosts: HostOnboardingRepository,
    private readonly credentials: SshCredentialRepository,
    private readonly targets: OllamaTargetRepository,
    private readonly masterKey: Buffer | null,
  ) {}

  private resolve(targetId: string): ResolvedTarget {
    if (!this.masterKey) throw new OllamaModelInventoryError('MASTER_KEY_REQUIRED', 503, 'External master key is required.');
    const target = this.targets.findById(targetId);
    if (!target || !target.enabled) throw new OllamaModelInventoryError('TARGET_NOT_FOUND', 404, 'Ollama target was not found or is disabled.');
    const host = this.hosts.findHostById(target.hostId);
    if (!host || !host.enabled) throw new OllamaModelInventoryError('HOST_NOT_FOUND', 404, 'Host was not found or is disabled.');
    const credential = this.credentials.findByHostId(host.id);
    if (!credential) throw new OllamaModelInventoryError('SSH_CREDENTIAL_NOT_FOUND', 409, 'Host has no SSH credential.');
    let privateKey: string;
    try {
      privateKey = new SecretCipher(this.masterKey).decrypt(
        { credentialId: credential.id, hostId: host.id },
        credential.encryptedPrivateKey,
      );
    } catch {
      throw new OllamaModelInventoryError('SSH_CREDENTIAL_INVALID', 409, 'Stored SSH credential could not be decrypted.');
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

  private async get(connection: SshPrivateKeyConnection, route: { host: string; port: number }, path: OllamaReadPath): Promise<Buffer> {
    let response;
    try {
      response = await httpGetViaPinnedSsh(
        connection,
        route.host,
        route.port,
        path,
        { timeoutMs: 7_500, maxResponseBytes: MAX_RESPONSE_BYTES },
      );
    } catch (error) {
      if (error instanceof SshHttpError) throw mapSshHttpError(error);
      throw new OllamaModelInventoryError('OLLAMA_API_UNAVAILABLE', 502, 'Ollama model inventory request failed.');
    }
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new OllamaModelInventoryError('OLLAMA_API_ERROR', 502, `Ollama API returned HTTP ${response.statusCode}.`);
    }
    return response.body;
  }

  async read(targetId: string): Promise<OllamaModelInventoryResult> {
    const target = this.resolve(targetId);
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
        throw new OllamaModelInventoryError(error.code, status, 'Remote SSH model inventory inspection failed.', { cause: error });
      }
      throw error;
    }
    if (inspectResult.exitCode !== 0) {
      const detail = `${inspectResult.stderr}\n${inspectResult.stdout}`;
      if (/no such (object|container)/iu.test(detail)) throw new OllamaModelInventoryError('CONTAINER_NOT_FOUND', 404, 'Ollama container was not found.');
      throw new OllamaModelInventoryError('DOCKER_UNAVAILABLE', 502, 'Docker inspect failed.');
    }
    const inspect = parseInspect(inspectResult.stdout);
    if (!Boolean(inspect.State?.Running)) {
      throw new OllamaModelInventoryError('CONTAINER_NOT_RUNNING', 409, 'Ollama container is not running.');
    }
    const route = selectOllamaApiRoute(inspect);
    if (!route) throw new OllamaModelInventoryError('OLLAMA_API_UNAVAILABLE', 502, 'No safe Ollama API route could be derived from Docker state.');

    const installedBody = await this.get(target.connection, route, '/api/tags');
    const runningBody = await this.get(target.connection, route, '/api/ps');
    return {
      targetId: target.targetId,
      transport: { mode: route.mode },
      installed: parseInstalledModels(installedBody),
      running: parseRunningModels(runningBody),
    };
  }
}
