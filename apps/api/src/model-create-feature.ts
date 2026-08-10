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
import { SqliteModelfileDeployPlanRepository } from '@orc/db/modelfile-deploy-plans';
import { SqliteModelfileRepository } from '@orc/db/modelfiles';
import {
  loadConfiguredMasterKey,
  type MasterKeyEnvironment,
} from '@orc/security';
import { SshTransportError } from '@orc/ssh';
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
import {
  CreateJobEventError,
  parseCreateEventCursor,
  streamCreateJobEvents,
} from './create-job-events.js';
import { JobService, JobServiceError } from './jobs.js';
import {
  ModelCreateError,
  ModelCreateService,
} from './model-create.js';
import {
  ModelfileDeployPlanError,
  ModelfileDeployPlanService,
  type CreateModelfileDeployPlanInput,
} from './modelfile-deploy-plan.js';
import {
  OllamaHealthError,
  OllamaHealthService,
} from './ollama-health.js';
import {
  OllamaModelDetailError,
  OllamaModelDetailService,
} from './ollama-model-details.js';
import {
  OllamaModelInventoryError,
  OllamaModelInventoryService,
} from './ollama-models.js';

interface DeployParams {
  readonly targetId: string;
  readonly modelfileId: string;
  readonly revisionId: string;
}
interface ConfirmDeployBody {
  readonly planId?: unknown;
  readonly confirmationToken?: unknown;
}
interface CreateJobParams { readonly jobId: string; }
interface CreateEventQuery { readonly after?: unknown; }

export interface RegisterModelCreateFeatureOptions {
  readonly databasePath: string;
  readonly now?: () => Date;
  readonly sessionTtlMs?: number;
  readonly environment?: MasterKeyEnvironment;
}

function csrfHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function sendFeatureError(reply: FastifyReply, error: unknown): FastifyReply {
  if (
    error instanceof AuthError
    || error instanceof ModelfileDeployPlanError
    || error instanceof ModelCreateError
    || error instanceof CreateJobEventError
    || error instanceof JobServiceError
    || error instanceof OllamaHealthError
    || error instanceof OllamaModelInventoryError
    || error instanceof OllamaModelDetailError
  ) {
    return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } });
  }
  if (error instanceof SshTransportError) {
    const statusCode = error.code === 'SSH_HOST_KEY_MISMATCH' ? 409 : error.code === 'AUTH_FAILED' ? 422 : 502;
    return reply.code(statusCode).send({ error: { code: error.code, message: error.message } });
  }
  throw error;
}

export function registerModelCreateFeature(
  app: FastifyInstance,
  options: RegisterModelCreateFeatureOptions,
): void {
  if (!options.databasePath || options.databasePath === ':memory:') {
    throw new Error('Model-create feature requires a persistent SQLite database path shared with the core server.');
  }
  const now = options.now ?? (() => new Date());
  const masterKey = loadConfiguredMasterKey(options.environment ?? process.env);
  const database = openDatabase(options.databasePath);
  applyMigrations(database);

  const auth = new AuthService(
    new SqliteAuthRepository(database),
    now,
    options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS,
  );
  const hostRepository = new SqliteHostOnboardingRepository(database);
  const credentialRepository = new SqliteSshCredentialRepository(database);
  const targetRepository = new SqliteOllamaTargetRepository(database);
  const modelfileRepository = new SqliteModelfileRepository(database);
  const deployPlanRepository = new SqliteModelfileDeployPlanRepository(database);
  const jobService = new JobService(new SqliteJobRepository(database), now);
  const auditService = new AuditService(new SqliteAuditRepository(database), now);
  const health = new OllamaHealthService(hostRepository, credentialRepository, targetRepository, masterKey);
  const inventory = new OllamaModelInventoryService(hostRepository, credentialRepository, targetRepository, masterKey);
  const details = new OllamaModelDetailService(hostRepository, credentialRepository, targetRepository, masterKey);
  const deployPlans = new ModelfileDeployPlanService(
    modelfileRepository,
    deployPlanRepository,
    targetRepository,
    health,
    inventory,
    auditService,
    now,
  );
  const creates = new ModelCreateService(
    hostRepository,
    credentialRepository,
    targetRepository,
    modelfileRepository,
    deployPlanRepository,
    masterKey,
    jobService,
    auditService,
    health,
    inventory,
    details,
    now,
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

  app.addHook('onReady', async () => {
    await creates.reconcile();
  });

  app.post<{ Params: DeployParams; Body: CreateModelfileDeployPlanInput }>(
    '/api/v1/targets/:targetId/modelfiles/:modelfileId/revisions/:revisionId/deploy-plan',
    async (request, reply) => {
      try {
        const session = requireAuthenticatedMutation(request);
        const plan = await deployPlans.create(
          request.params.targetId,
          request.params.modelfileId,
          request.params.revisionId,
          session.userId,
          request.body ?? {},
        );
        return reply.code(201).send({ plan });
      } catch (error) {
        return sendFeatureError(reply, error);
      }
    },
  );

  app.post<{ Params: DeployParams; Body: ConfirmDeployBody }>(
    '/api/v1/targets/:targetId/modelfiles/:modelfileId/revisions/:revisionId/deploy',
    async (request, reply) => {
      try {
        const session = requireAuthenticatedMutation(request);
        const job = await creates.start(
          request.params.targetId,
          request.params.modelfileId,
          request.params.revisionId,
          session.userId,
          request.body?.planId,
          request.body?.confirmationToken,
        );
        return reply.code(202).send({ job });
      } catch (error) {
        return sendFeatureError(reply, error);
      }
    },
  );

  app.get<{ Params: CreateJobParams }>('/api/v1/model-create-jobs/:jobId', async (request, reply) => {
    try {
      const session = requireAuthenticated(request);
      return reply.send({ job: creates.get(request.params.jobId, session.userId) });
    } catch (error) {
      return sendFeatureError(reply, error);
    }
  });

  app.post<{ Params: CreateJobParams }>('/api/v1/model-create-jobs/:jobId/cancel', async (request, reply) => {
    try {
      const session = requireAuthenticatedMutation(request);
      return reply.send({ job: creates.cancel(request.params.jobId, session.userId) });
    } catch (error) {
      return sendFeatureError(reply, error);
    }
  });

  app.get<{ Params: CreateJobParams; Querystring: CreateEventQuery }>(
    '/api/v1/model-create-jobs/:jobId/events',
    async (request, reply) => {
      let actorUserId: string;
      let cursor: number;
      try {
        actorUserId = requireAuthenticated(request).userId;
        creates.get(request.params.jobId, actorUserId);
        cursor = parseCreateEventCursor(request.query?.after ?? request.headers['last-event-id']);
      } catch (error) {
        return sendFeatureError(reply, error);
      }
      reply.hijack();
      reply.raw.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      void streamCreateJobEvents(reply.raw, creates, request.params.jobId, actorUserId, cursor).catch(() => {
        if (!reply.raw.destroyed && !reply.raw.writableEnded) {
          reply.raw.write(`event: error\ndata: ${JSON.stringify({ code: 'JOB_EVENT_STREAM_FAILED', message: 'Model-create job event stream failed.' })}\n\n`);
          reply.raw.end();
        }
      });
    },
  );

  app.addHook('onClose', async () => {
    await creates.shutdown();
    database.close();
  });
}
