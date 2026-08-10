import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from 'fastify';
import { resolveModelSourceReference } from '@orc/core/model-source';
import {
  applyMigrations,
  openDatabase,
  SqliteAuthRepository,
  SqliteHostOnboardingRepository,
  SqliteOllamaTargetRepository,
  SqliteSshCredentialRepository,
} from '@orc/db';
import {
  loadConfiguredMasterKey,
  type MasterKeyEnvironment,
} from '@orc/security';
import {
  AuthError,
  AuthService,
  DEFAULT_SESSION_TTL_MS,
} from './auth.js';
import {
  parseCookies,
  SESSION_COOKIE,
} from './cookies.js';
import {
  OllamaModelDetailError,
  OllamaModelDetailService,
} from './ollama-model-details.js';

interface TargetParams { readonly targetId: string; }
interface ModelQuery { readonly model?: unknown; }

export interface RegisterModelSourceFeatureOptions {
  readonly databasePath: string;
  readonly now?: () => Date;
  readonly sessionTtlMs?: number;
  readonly environment?: MasterKeyEnvironment;
}

function sendFeatureError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof AuthError || error instanceof OllamaModelDetailError) {
    return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } });
  }
  throw error;
}

export function registerModelSourceFeature(
  app: FastifyInstance,
  options: RegisterModelSourceFeatureOptions,
): void {
  if (!options.databasePath || options.databasePath === ':memory:') {
    throw new Error('Model-source feature requires a persistent SQLite database path shared with the core server.');
  }

  const database = openDatabase(options.databasePath);
  applyMigrations(database);
  const now = options.now ?? (() => new Date());
  const auth = new AuthService(
    new SqliteAuthRepository(database),
    now,
    options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS,
  );
  const details = new OllamaModelDetailService(
    new SqliteHostOnboardingRepository(database),
    new SqliteSshCredentialRepository(database),
    new SqliteOllamaTargetRepository(database),
    loadConfiguredMasterKey(options.environment ?? process.env),
  );

  function requireAuthenticated(request: FastifyRequest) {
    const session = auth.getSession(parseCookies(request.headers.cookie)[SESSION_COOKIE]);
    if (!session) throw new AuthError('UNAUTHENTICATED', 401, 'Authentication is required.');
    return session;
  }

  app.get<{ Params: TargetParams; Querystring: ModelQuery }>(
    '/api/v1/targets/:targetId/model-sources',
    async (request, reply) => {
      try {
        requireAuthenticated(request);
        const detail = await details.read(request.params.targetId, request.query?.model);
        const from = detail.provenancePreview.from;
        return reply.send({
          targetId: detail.targetId,
          model: detail.identity.model,
          sources: {
            model: resolveModelSourceReference(detail.identity.model),
            from: from ? resolveModelSourceReference(from.reference) : null,
            adapters: detail.provenancePreview.adapters.map((adapter) => resolveModelSourceReference(adapter.reference)),
          },
        });
      } catch (error) {
        return sendFeatureError(reply, error);
      }
    },
  );

  app.addHook('onClose', async () => {
    database.close();
  });
}
