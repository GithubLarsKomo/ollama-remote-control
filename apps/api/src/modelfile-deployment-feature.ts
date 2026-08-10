import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from 'fastify';
import {
  applyMigrations,
  openDatabase,
  SqliteAuthRepository,
  SqliteOllamaTargetRepository,
} from '@orc/db';
import { SqliteModelfileDeploymentRepository } from '@orc/db/modelfile-deployments';
import { SqliteModelfileRepository } from '@orc/db/modelfiles';
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
  ModelfileDeploymentReadError,
  ModelfileDeploymentReadService,
} from './modelfile-deployment-read.js';

interface ModelfileParams { readonly modelfileId: string; }
interface ModelfileRevisionParams extends ModelfileParams { readonly revisionId: string; }
interface TargetParams { readonly targetId: string; }
interface ModelQuery { readonly model?: unknown; }

export interface RegisterModelfileDeploymentFeatureOptions {
  readonly databasePath: string;
  readonly now?: () => Date;
  readonly sessionTtlMs?: number;
}

function sendFeatureError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof AuthError || error instanceof ModelfileDeploymentReadError) {
    return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } });
  }
  throw error;
}

export function registerModelfileDeploymentFeature(
  app: FastifyInstance,
  options: RegisterModelfileDeploymentFeatureOptions,
): void {
  if (!options.databasePath || options.databasePath === ':memory:') {
    throw new Error('Modelfile deployment feature requires a persistent SQLite database path shared with the core server.');
  }

  const database = openDatabase(options.databasePath);
  applyMigrations(database);
  const now = options.now ?? (() => new Date());
  const auth = new AuthService(
    new SqliteAuthRepository(database),
    now,
    options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS,
  );
  const deployments = new ModelfileDeploymentReadService(
    new SqliteModelfileRepository(database),
    new SqliteModelfileDeploymentRepository(database),
    new SqliteOllamaTargetRepository(database),
  );

  function requireAuthenticated(request: FastifyRequest) {
    const session = auth.getSession(parseCookies(request.headers.cookie)[SESSION_COOKIE]);
    if (!session) throw new AuthError('UNAUTHENTICATED', 401, 'Authentication is required.');
    return session;
  }

  app.get<{ Params: ModelfileParams }>(
    '/api/v1/modelfiles/:modelfileId/deployments',
    async (request, reply) => {
      try {
        requireAuthenticated(request);
        return reply.send({ deployments: deployments.forModelfile(request.params.modelfileId) });
      } catch (error) {
        return sendFeatureError(reply, error);
      }
    },
  );

  app.get<{ Params: ModelfileRevisionParams }>(
    '/api/v1/modelfiles/:modelfileId/revisions/:revisionId/deployments',
    async (request, reply) => {
      try {
        requireAuthenticated(request);
        return reply.send({ deployments: deployments.forRevision(request.params.modelfileId, request.params.revisionId) });
      } catch (error) {
        return sendFeatureError(reply, error);
      }
    },
  );

  app.get<{ Params: TargetParams; Querystring: ModelQuery }>(
    '/api/v1/targets/:targetId/models/producing-revision',
    async (request, reply) => {
      try {
        requireAuthenticated(request);
        return reply.send({ deployment: deployments.currentProducing(request.params.targetId, request.query?.model) });
      } catch (error) {
        return sendFeatureError(reply, error);
      }
    },
  );

  app.addHook('onClose', async () => {
    database.close();
  });
}
