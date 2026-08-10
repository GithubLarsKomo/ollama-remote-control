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
  SqliteHostOnboardingRepository,
  SqliteJobRepository,
  SqliteOllamaTargetRepository,
  SqliteSshCredentialRepository,
} from '@orc/db';
import {
  loadConfiguredMasterKey,
  type MasterKeyEnvironment,
} from '@orc/security';
import { AuditService } from './audit.js';
import {
  AuthError,
  AuthService,
  DEFAULT_SESSION_TTL_MS,
} from './auth.js';
import {
  CSRF_COOKIE,
  parseCookies,
  SESSION_COOKIE,
} from './cookies.js';
import { JobService } from './jobs.js';
import {
  ModelUnloadError,
  ModelUnloadService,
  type ModelUnloadConfirmation,
} from './model-unload.js';

interface TargetParams { readonly targetId: string; }
interface ModelUnloadBody {
  readonly model?: unknown;
  readonly digest?: unknown;
  readonly confirmation?: ModelUnloadConfirmation;
}

export interface RegisterModelUnloadFeatureOptions {
  readonly databasePath: string;
  readonly now?: () => Date;
  readonly sessionTtlMs?: number;
  readonly environment?: MasterKeyEnvironment;
}

function csrfHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function sendFeatureError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof AuthError || error instanceof ModelUnloadError) {
    return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } });
  }
  throw error;
}

export function registerModelUnloadFeature(
  app: FastifyInstance,
  options: RegisterModelUnloadFeatureOptions,
): void {
  if (!options.databasePath || options.databasePath === ':memory:') {
    throw new Error('Model-unload feature requires a persistent SQLite database path shared with the core server.');
  }

  const database = openDatabase(options.databasePath);
  applyMigrations(database);
  const now = options.now ?? (() => new Date());
  const auth = new AuthService(
    new SqliteAuthRepository(database),
    now,
    options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS,
  );
  const jobs = new JobService(new SqliteJobRepository(database), now);
  const unload = new ModelUnloadService(
    new SqliteHostOnboardingRepository(database),
    new SqliteSshCredentialRepository(database),
    new SqliteOllamaTargetRepository(database),
    loadConfiguredMasterKey(options.environment ?? process.env),
    jobs,
    new AuditService(new SqliteAuditRepository(database), now),
  );

  function requireAuthenticated(request: FastifyRequest) {
    const session = auth.getSession(parseCookies(request.headers.cookie)[SESSION_COOKIE]);
    if (!session) throw new AuthError('UNAUTHENTICATED', 401, 'Authentication is required.');
    return session;
  }

  function requireAuthenticatedMutation(request: FastifyRequest) {
    const cookies = parseCookies(request.headers.cookie);
    const session = requireAuthenticated(request);
    const headerToken = csrfHeader(request.headers['x-csrf-token']);
    if (!headerToken || cookies[CSRF_COOKIE] !== headerToken) {
      throw new AuthError('CSRF_INVALID', 403, 'CSRF token is invalid.');
    }
    auth.assertCsrf(session, headerToken);
    return session;
  }

  app.get<{ Params: TargetParams }>(
    '/api/v1/targets/:targetId/mutation/active',
    async (request, reply) => {
      try {
        requireAuthenticated(request);
        const active = jobs.jobsNeedingReconciliation().find((job) => (
          job.targetId === request.params.targetId && job.mutating
        ));
        return reply.send({
          mutation: active ? { kind: active.kind, state: active.state } : null,
        });
      } catch (error) {
        return sendFeatureError(reply, error);
      }
    },
  );

  app.post<{ Params: TargetParams; Body: ModelUnloadBody }>(
    '/api/v1/targets/:targetId/models/unload',
    async (request, reply) => {
      try {
        const session = requireAuthenticatedMutation(request);
        const result = await unload.execute(
          request.params.targetId,
          session.userId,
          request.body?.model,
          request.body?.digest,
          request.body?.confirmation,
        );
        return reply.send({ unload: result });
      } catch (error) {
        return sendFeatureError(reply, error);
      }
    },
  );

  app.addHook('onClose', async () => {
    database.close();
  });
}
