export interface UpdateExecutionConfirmation {
  readonly action: 'update';
  readonly targetId: string;
  readonly intentId: string;
}

export interface UpdateExecutionRequest {
  readonly intentId: string;
  readonly confirmation: UpdateExecutionConfirmation;
}

export class UpdateExecutionRequestError extends Error {
  constructor(
    readonly code: string,
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

const TOP_LEVEL_KEYS = new Set(['intentId', 'confirmation']);
const CONFIRMATION_KEYS = new Set(['action', 'targetId', 'intentId']);

function objectValue(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  const keys = Object.keys(value);
  return keys.length === allowed.size && keys.every((key) => allowed.has(key));
}

function normalizedIntentId(value: unknown): string {
  if (typeof value !== 'string') {
    throw new UpdateExecutionRequestError(
      'INVALID_UPDATE_EXECUTION_REQUEST',
      400,
      'A server-issued update execution intent ID is required.',
    );
  }
  const intentId = value.trim();
  if (!intentId || intentId.length > 128) {
    throw new UpdateExecutionRequestError(
      'INVALID_UPDATE_EXECUTION_REQUEST',
      400,
      'A server-issued update execution intent ID is required.',
    );
  }
  return intentId;
}

export function parseUpdateExecutionRequest(body: unknown, targetId: string): UpdateExecutionRequest {
  const request = objectValue(body);
  if (!request || !exactKeys(request, TOP_LEVEL_KEYS)) {
    throw new UpdateExecutionRequestError(
      'INVALID_UPDATE_EXECUTION_REQUEST',
      400,
      'Update execution accepts only intentId and confirmation.',
    );
  }

  const intentId = normalizedIntentId(request.intentId);
  const confirmation = objectValue(request.confirmation);
  if (!confirmation || !exactKeys(confirmation, CONFIRMATION_KEYS)) {
    throw new UpdateExecutionRequestError(
      'CONFIRMATION_REQUIRED',
      400,
      'Container update requires confirmation of the exact action, target and execution intent.',
    );
  }
  if (
    confirmation.action !== 'update'
    || confirmation.targetId !== targetId
    || confirmation.intentId !== intentId
  ) {
    throw new UpdateExecutionRequestError(
      'CONFIRMATION_REQUIRED',
      400,
      'Container update requires confirmation of the exact action, target and execution intent.',
    );
  }

  return {
    intentId,
    confirmation: {
      action: 'update',
      targetId,
      intentId,
    },
  };
}
