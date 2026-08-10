import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from 'fastify';
import {
  applyMigrations,
  openDatabase,
  SqliteAuditRepository,
  SqliteAuthRepository,
} from '@orc/db';
import { SqliteModelfileRepository } from '@orc/db/modelfiles';
import {
  AuthError,
  AuthService,
  DEFAULT_SESSION_TTL_MS,
} from './auth.js';
import { AuditService } from './audit.js';
import {
  CSRF_COOKIE,
  parseCookies,
  SESSION_COOKIE,
} from './cookies.js';
import {
  ModelfilePortabilityError,
  ModelfilePortabilityService,
  type CloneModelfileInput,
} from './modelfile-portability.js';

interface CloneParams {
  readonly modelfileId: string;
  readonly revisionId: string;
}

export interface RegisterModelfilePortabilityFeatureOptions {
  readonly databasePath: string;
  readonly now?: () => Date;
  readonly sessionTtlMs?: number;
}

function csrfHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function sendError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof AuthError || error instanceof ModelfilePortabilityError) {
    return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } });
  }
  throw error;
}

export function registerModelfilePortabilityFeature(
  app: FastifyInstance,
  options: RegisterModelfilePortabilityFeatureOptions,
): void {
  if (!options.databasePath || options.databasePath === ':memory:') {
    throw new Error('Modelfile portability feature requires a persistent SQLite database path shared with the core server.');
  }

  const database = openDatabase(options.databasePath);
  applyMigrations(database);
  const now = options.now ?? (() => new Date());
  const auth = new AuthService(
    new SqliteAuthRepository(database),
    now,
    options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS,
  );
  const portability = new ModelfilePortabilityService(
    new SqliteModelfileRepository(database),
    new AuditService(new SqliteAuditRepository(database), now),
    now,
  );

  function requireAuthenticatedMutation(request: FastifyRequest) {
    const cookies = parseCookies(request.headers.cookie);
    const session = auth.getSession(cookies[SESSION_COOKIE]);
    if (!session) throw new AuthError('UNAUTHENTICATED', 401, 'Authentication is required.');
    const headerToken = csrfHeader(request.headers['x-csrf-token']);
    if (!headerToken || cookies[CSRF_COOKIE] !== headerToken) {
      throw new AuthError('CSRF_INVALID', 403, 'CSRF token is invalid.');
    }
    auth.assertCsrf(session, headerToken);
    return session;
  }

  app.post<{ Params: CloneParams; Body: CloneModelfileInput }>(
    '/api/v1/modelfiles/:modelfileId/revisions/:revisionId/clone',
    async (request, reply) => {
      try {
        const session = requireAuthenticatedMutation(request);
        const modelfile = portability.clone(
          session.userId,
          request.params.modelfileId,
          request.params.revisionId,
          request.body ?? {},
        );
        return reply.code(201).send({ modelfile });
      } catch (error) {
        return sendError(reply, error);
      }
    },
  );

  app.addHook('onClose', async () => {
    database.close();
  });
}
