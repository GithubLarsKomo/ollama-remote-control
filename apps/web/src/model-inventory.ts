import { ApiError } from './api.js';

export interface ModelDetailsView {
  readonly format: string | null;
  readonly family: string | null;
  readonly families: readonly string[];
  readonly parameterSize: string | null;
  readonly quantizationLevel: string | null;
}

export interface InstalledModelView {
  readonly name: string;
  readonly model: string;
  readonly modifiedAt: string | null;
  readonly sizeBytes: number;
  readonly digest: string;
  readonly details: ModelDetailsView;
}

export interface RunningModelView {
  readonly name: string;
  readonly model: string;
  readonly sizeBytes: number;
  readonly digest: string;
  readonly details: ModelDetailsView;
  readonly expiresAt: string | null;
  readonly sizeVramBytes: number;
  readonly contextLength: number;
}

export interface ModelInventoryView {
  readonly targetId: string;
  readonly transport: { readonly mode: 'published-binding' | 'container-network' };
  readonly installed: readonly InstalledModelView[];
  readonly running: readonly RunningModelView[];
}

export type ProvenanceReferenceKind = 'model-reference' | 'local-artifact' | 'unknown';

export interface ProvenanceReferencePreview {
  readonly reference: string;
  readonly kind: ProvenanceReferenceKind;
}

export interface ModelSourceResolutionView {
  readonly reference: string;
  readonly state: 'resolved' | 'local-artifact' | 'unresolved';
  readonly provider: 'huggingface' | null;
  readonly url: string | null;
}

export interface ModelSourceView {
  readonly targetId: string;
  readonly model: string;
  readonly sources: {
    readonly model: ModelSourceResolutionView;
    readonly from: ModelSourceResolutionView | null;
    readonly adapters: readonly ModelSourceResolutionView[];
  };
}

export interface ModelDetailView {
  readonly targetId: string;
  readonly transport: { readonly mode: 'published-binding' | 'container-network' };
  readonly identity: {
    readonly name: string;
    readonly model: string;
    readonly digest: string;
    readonly modifiedAt: string | null;
  };
  readonly details: ModelDetailsView & { readonly parentModel: string | null };
  readonly capabilities: readonly string[];
  readonly modelfile: string | null;
  readonly parameters: string | null;
  readonly template: string | null;
  readonly system: string | null;
  readonly license: string | null;
  readonly requires: string | null;
  readonly architecture: {
    readonly architecture: string | null;
    readonly parameterCount: number | null;
    readonly contextLength: number | null;
    readonly embeddingLength: number | null;
    readonly blockCount: number | null;
    readonly quantizationVersion: number | null;
  };
  readonly provenancePreview: {
    readonly from: ProvenanceReferencePreview | null;
    readonly adapters: readonly ProvenanceReferencePreview[];
  };
}

function isApiErrorPayload(value: unknown): value is { readonly error: { readonly code: string; readonly message: string } } {
  if (!value || typeof value !== 'object') return false;
  const error = (value as { error?: unknown }).error;
  return Boolean(
    error
    && typeof error === 'object'
    && typeof (error as { code?: unknown }).code === 'string'
    && typeof (error as { message?: unknown }).message === 'string',
  );
}

async function safeJsonError(response: Response, fallbackCode: string, fallbackMessage: string): Promise<never> {
  let payload: unknown = null;
  try { payload = await response.json(); } catch { /* safe generic error below */ }
  if (isApiErrorPayload(payload)) {
    throw new ApiError(response.status, payload.error.code, payload.error.message);
  }
  throw new ApiError(response.status, fallbackCode, fallbackMessage);
}

export async function fetchModelInventory(targetId: string): Promise<ModelInventoryView> {
  const response = await fetch(`/api/v1/targets/${encodeURIComponent(targetId)}/models`, {
    method: 'GET',
    credentials: 'include',
    headers: { accept: 'application/json' },
  });
  if (response.ok) return await response.json() as ModelInventoryView;
  return safeJsonError(response, 'HTTP_ERROR', `Model inventory failed with HTTP ${response.status}.`);
}

export async function fetchModelDetail(targetId: string, modelName: string): Promise<ModelDetailView> {
  const response = await fetch(
    `/api/v1/targets/${encodeURIComponent(targetId)}/model-details?model=${encodeURIComponent(modelName)}`,
    {
      method: 'GET',
      credentials: 'include',
      headers: { accept: 'application/json' },
    },
  );
  if (response.ok) return await response.json() as ModelDetailView;
  return safeJsonError(response, 'HTTP_ERROR', `Model detail failed with HTTP ${response.status}.`);
}

export async function fetchModelSources(targetId: string, modelName: string): Promise<ModelSourceView> {
  const response = await fetch(
    `/api/v1/targets/${encodeURIComponent(targetId)}/model-sources?model=${encodeURIComponent(modelName)}`,
    {
      method: 'GET',
      credentials: 'include',
      headers: { accept: 'application/json' },
    },
  );
  if (response.ok) return await response.json() as ModelSourceView;
  return safeJsonError(response, 'HTTP_ERROR', `Model source lookup failed with HTTP ${response.status}.`);
}

export interface ModelInventorySummary {
  readonly installedCount: number;
  readonly installedBytes: number;
  readonly runningCount: number;
  readonly runningVramBytes: number;
}

export function summarizeModelInventory(inventory: ModelInventoryView): ModelInventorySummary {
  return {
    installedCount: inventory.installed.length,
    installedBytes: inventory.installed.reduce((sum, model) => sum + model.sizeBytes, 0),
    runningCount: inventory.running.length,
    runningVramBytes: inventory.running.reduce((sum, model) => sum + model.sizeVramBytes, 0),
  };
}

export function runningModelDigests(inventory: ModelInventoryView): ReadonlySet<string> {
  return new Set(inventory.running.map((model) => model.digest));
}
