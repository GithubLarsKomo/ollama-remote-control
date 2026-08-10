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
  ModelSmokeError,
  ModelSmokeService,
  type ModelSmokeConfirmation,
} from './model-smoke.js';
import { OllamaModelInventoryService } from './ollama-models.js';

interface TargetParams { readonly targetId: string; }
interface ModelSmokeBody {
  readonly model?: unknown;
  readonly digest?: unknown;
  readonly confirmation?: ModelSmokeConfirmation;
}

export interface RegisterModelSmokeFeatureOptions {
  readonly databasePath: string;
  readonly now?: () => Date;
  readonly sessionTtlMs?: number;
  readonly environment?: MasterKeyEnvironment;
}

function csrfHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function sendFeatureError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof AuthError || error instanceof ModelSmokeError) {
    return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } });
  }
  throw error;
}

export function registerModelSmokeFeature(
  app: FastifyInstance,
  options: RegisterModelSmokeFeatureOptions,
): void {
  if (!options.databasePath || options.databasePath === ':memory:') {
    throw new Error('Model-smoke feature requires a persistent SQLite database path shared with the core server.');
  }

  const database = openDatabase(options.databasePath);
  applyMigrations(database);
  const now = options.now ?? (() => new Date());
  const auth = new AuthService(
    new SqliteAuthRepository(database),
    now,
    options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS,
  );
  const hosts = new SqliteHostOnboardingRepository(database);
  const credentials = new SqliteSshCredentialRepository(database);
  const targets = new SqliteOllamaTargetRepository(database);
  const masterKey = loadConfiguredMasterKey(options.environment ?? process.env);
  const smoke = new ModelSmokeService(
    hosts,
    credentials,
    targets,
    masterKey,
    new JobService(new SqliteJobRepository(database), now),
    new AuditService(new SqliteAuditRepository(database), now),
    new OllamaModelInventoryService(hosts, credentials, targets, masterKey),
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

  app.post<{ Params: TargetParams; Body: ModelSmokeBody }>(
    '/api/v1/targets/:targetId/models/smoke-test',
    async (request, reply) => {
      try {
        const session = requireAuthenticatedMutation(request);
        const result = await smoke.execute(
          request.params.targetId,
          session.userId,
          request.body?.model,
          request.body?.digest,
          request.body?.confirmation,
        );
        return reply.send({ smokeTest: result });
      } catch (error) {
        return sendFeatureError(reply, error);
      }
    },
  );

  app.addHook('onClose', async () => {
    database.close();
  });
}
