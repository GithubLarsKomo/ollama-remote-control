import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from 'fastify';
import {
  applyMigrations,
  openDatabase,
  SqliteAuthRepository,
  SqliteJobRepository,
  SqliteOllamaTargetRepository,
  SqliteUpdateSnapshotRepository,
} from '@orc/db';
import { SqliteUpdateHistoryRepository } from '@orc/db/update-history';
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
  ManualRollbackCandidateError,
  ManualRollbackCandidateService,
} from './manual-rollback-candidate.js';

interface TargetParams { readonly targetId: string; }

export interface RegisterManualRollbackFeatureOptions {
  readonly databasePath: string;
  readonly now?: () => Date;
  readonly sessionTtlMs?: number;
  readonly environment?: MasterKeyEnvironment;
}

function sendFeatureError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof AuthError || error instanceof ManualRollbackCandidateError) {
    return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } });
  }
  throw error;
}

export function registerManualRollbackFeature(
  app: FastifyInstance,
  options: RegisterManualRollbackFeatureOptions,
): void {
  if (!options.databasePath || options.databasePath === ':memory:') {
    throw new Error('Manual-rollback feature requires a persistent SQLite database path shared with the core server.');
  }

  const database = openDatabase(options.databasePath);
  applyMigrations(database);
  const now = options.now ?? (() => new Date());
  const auth = new AuthService(
    new SqliteAuthRepository(database),
    now,
    options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS,
  );
  const rollback = new ManualRollbackCandidateService(
    new SqliteOllamaTargetRepository(database),
    new SqliteJobRepository(database),
    new SqliteUpdateSnapshotRepository(database),
    new SqliteUpdateHistoryRepository(database),
    loadConfiguredMasterKey(options.environment ?? process.env),
  );

  function requireAuthenticated(request: FastifyRequest) {
    const session = auth.getSession(parseCookies(request.headers.cookie)[SESSION_COOKIE]);
    if (!session) throw new AuthError('UNAUTHENTICATED', 401, 'Authentication is required.');
    return session;
  }

  app.get<{ Params: TargetParams }>(
    '/api/v1/targets/:targetId/container/rollback-candidate',
    async (request, reply) => {
      try {
        requireAuthenticated(request);
        return reply.send(rollback.read(request.params.targetId));
      } catch (error) {
        return sendFeatureError(reply, error);
      }
    },
  );

  app.addHook('onClose', async () => {
    database.close();
  });
}
