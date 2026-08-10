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
  SqliteUpdateSnapshotRepository,
} from '@orc/db';
import { SqliteTargetContainerBindingRepository } from '@orc/db/target-binding';
import { SqliteUpdateHistoryRepository } from '@orc/db/update-history';
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
import { JobService, JobServiceError } from './jobs.js';
import {
  ManualRollbackCandidateError,
  ManualRollbackCandidateService,
} from './manual-rollback-candidate.js';
import {
  ManualRollbackExecutionError,
  ManualRollbackExecutionService,
  type ManualRollbackConfirmation,
} from './manual-rollback-execution.js';
import { ManualRollbackReconciliationService } from './manual-rollback-reconciliation.js';
import { OllamaHealthService } from './ollama-health.js';
import {
  createSshUpdateRemoteFactory,
  type UpdateRemoteFactory,
} from './update-orchestrator.js';

interface TargetParams { readonly targetId: string; }
interface ManualRollbackBody { readonly confirmation?: unknown; }

export interface RegisterManualRollbackFeatureOptions {
  readonly databasePath: string;
  readonly now?: () => Date;
  readonly sessionTtlMs?: number;
  readonly environment?: MasterKeyEnvironment;
  readonly remoteFactory?: UpdateRemoteFactory;
}

function csrfHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function rollbackConfirmation(value: unknown): ManualRollbackConfirmation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ManualRollbackExecutionError('ROLLBACK_CONFIRMATION_INVALID', 400, 'Rollback confirmation is required.');
  }
  const candidate = value as Record<string, unknown>;
  const targetId = typeof candidate.targetId === 'string' ? candidate.targetId.trim() : '';
  const sourceUpdateJobId = typeof candidate.sourceUpdateJobId === 'string' ? candidate.sourceUpdateJobId.trim() : '';
  const currentContainerId = typeof candidate.currentContainerId === 'string' ? candidate.currentContainerId.trim() : '';
  const rollbackDigest = typeof candidate.rollbackDigest === 'string' ? candidate.rollbackDigest.trim() : '';
  if (
    !targetId
    || !sourceUpdateJobId
    || !currentContainerId
    || !rollbackDigest
    || candidate.acknowledgeModelVolumeBoundary !== true
  ) {
    throw new ManualRollbackExecutionError(
      'ROLLBACK_CONFIRMATION_INVALID',
      400,
      'Rollback confirmation must bind the target, source update, current container, rollback digest and model-volume acknowledgement.',
    );
  }
  return {
    targetId,
    sourceUpdateJobId,
    currentContainerId,
    rollbackDigest,
    acknowledgeModelVolumeBoundary: true,
  };
}

function sendFeatureError(reply: FastifyReply, error: unknown): FastifyReply {
  if (
    error instanceof AuthError
    || error instanceof JobServiceError
    || error instanceof ManualRollbackCandidateError
    || error instanceof ManualRollbackExecutionError
  ) {
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
  const masterKey = loadConfiguredMasterKey(options.environment ?? process.env);
  const auth = new AuthService(
    new SqliteAuthRepository(database),
    now,
    options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS,
  );
  const hosts = new SqliteHostOnboardingRepository(database);
  const credentials = new SqliteSshCredentialRepository(database);
  const targets = new SqliteOllamaTargetRepository(database);
  const bindings = new SqliteTargetContainerBindingRepository(database);
  const snapshots = new SqliteUpdateSnapshotRepository(database);
  const jobRepository = new SqliteJobRepository(database);
  const jobs = new JobService(jobRepository, now);
  const audit = new AuditService(new SqliteAuditRepository(database), now);
  const rollbackCandidate = new ManualRollbackCandidateService(
    targets,
    jobRepository,
    snapshots,
    new SqliteUpdateHistoryRepository(database),
    masterKey,
  );
  const health = new OllamaHealthService(hosts, credentials, targets, masterKey);
  const remoteFactory = options.remoteFactory ?? createSshUpdateRemoteFactory(health);
  const rollbackExecution = new ManualRollbackExecutionService(
    hosts,
    credentials,
    targets,
    bindings,
    snapshots,
    masterKey,
    rollbackCandidate,
    jobs,
    audit,
    remoteFactory,
    now,
  );
  const rollbackReconciliation = new ManualRollbackReconciliationService(
    hosts,
    credentials,
    targets,
    bindings,
    snapshots,
    masterKey,
    jobs,
    audit,
    remoteFactory,
    now,
  );

  app.addHook('onReady', async () => {
    await rollbackReconciliation.reconcile();
  });

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
    '/api/v1/targets/:targetId/container/rollback-candidate',
    async (request, reply) => {
      try {
        requireAuthenticated(request);
        return reply.send(rollbackCandidate.read(request.params.targetId));
      } catch (error) {
        return sendFeatureError(reply, error);
      }
    },
  );

  app.post<{ Params: TargetParams; Body: ManualRollbackBody }>(
    '/api/v1/targets/:targetId/container/rollback',
    async (request, reply) => {
      try {
        const session = requireAuthenticatedMutation(request);
        const confirmation = rollbackConfirmation(request.body?.confirmation);
        const rollback = await rollbackExecution.execute(request.params.targetId, confirmation, session.userId);
        return reply.send({ rollback });
      } catch (error) {
        return sendFeatureError(reply, error);
      }
    },
  );

  app.addHook('onClose', async () => {
    database.close();
  });
}
