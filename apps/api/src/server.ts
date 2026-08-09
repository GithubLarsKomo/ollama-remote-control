import { pathToFileURL } from 'node:url';
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify';
import type { ApiHealthResponse, StoredSession } from '@orc/core';
import {
  applyMigrations,
  getSchemaVersion,
  openDatabase,
  pingDatabase,
  SqliteAuditRepository,
  SqliteAuthRepository,
  SqliteHostOnboardingRepository,
  SqliteJobRepository,
  SqliteOllamaTargetRepository,
  SqliteSshCredentialRepository,
  SqliteUpdateSnapshotRepository,
} from '@orc/db';
import { SqliteHostCatalogRepository } from '@orc/db/host-catalog';
import { SqliteTargetContainerBindingRepository } from '@orc/db/target-binding';
import { SqliteTargetCatalogRepository } from '@orc/db/target-catalog';
import { DockerDiscoveryError, type DockerLifecycleAction } from '@orc/docker';
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
  ContainerLifecycleError,
  ContainerLifecycleService,
  type ContainerLifecycleConfirmation,
} from './container-lifecycle.js';
import {
  clearSessionCookies,
  CSRF_COOKIE,
  csrfCookie,
  parseCookies,
  SESSION_COOKIE,
  sessionCookie,
} from './cookies.js';
import {
  HostOnboardingError,
  HostOnboardingService,
  type HostCreateInput,
  type HostProbeInput,
} from './hosts.js';
import { JobService, JobServiceError } from './jobs.js';
import {
  parseLogTail,
  TargetLogError,
  TargetLogService,
} from './logs.js';
import {
  ModelPullError,
  ModelPullService,
} from './model-pull.js';
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
import { publicDockerDiscovery } from './public-discovery.js';
import {
  parsePullEventCursor,
  PullJobEventError,
  streamPullJobEvents,
} from './pull-job-events.js';
import {
  TargetStatusError,
  TargetStatusService,
} from './status.js';
import {
  TargetDiscoveryError,
  TargetDiscoveryService,
} from './targets.js';
import {
  parseUpdateExecutionRequest,
  UpdateExecutionRequestError,
} from './update-execution.js';
import {
  UpdateExecutionIntentError,
  UpdateExecutionIntentService,
} from './update-execution-intent.js';
import {
  createSshUpdateRemoteFactory,
  type UpdateRemoteFactory,
  UpdateOrchestratorError,
  UpdateOrchestratorService,
} from './update-orchestrator.js';
import {
  UpdatePlanError,
  UpdatePlanService,
} from './update-plan.js';
import {
  UpdatePreflightError,
  UpdatePreflightService,
} from './update-preflight.js';
import { UpdateReconciliationService } from './update-reconciliation.js';
import {
  UpdateStrategyError,
  UpdateStrategyService,
} from './update-strategy.js';

export interface BuildServerOptions {
  readonly databasePath?: string;
  readonly now?: () => Date;
  readonly sessionTtlMs?: number;
  readonly environment?: MasterKeyEnvironment;
  readonly updateRemoteFactory?: UpdateRemoteFactory;
}

interface CredentialsBody { readonly username?: unknown; readonly password?: unknown; }
interface HostProbeBody { readonly hostname?: unknown; readonly port?: unknown; }
interface HostCreateBody extends HostProbeBody {
  readonly displayName?: unknown;
  readonly username?: unknown;
  readonly confirmedFingerprint?: unknown;
  readonly privateKey?: unknown;
}
interface TargetSelectionBody { readonly containerId?: unknown; readonly displayName?: unknown; }
interface ContainerLifecycleBody { readonly confirmation?: ContainerLifecycleConfirmation; }
interface UpdateIntentBody { readonly snapshotId?: unknown; }
interface ModelPullBody { readonly model?: unknown; }
interface HostParams { readonly hostId: string; }
interface TargetParams { readonly targetId: string; }
interface JobParams { readonly jobId: string; }
interface SnapshotQuery { readonly snapshotId?: unknown; }
interface ModelDetailQuery { readonly model?: unknown; }
interface LogQuery { readonly tail?: unknown; }
interface PullEventQuery { readonly after?: unknown; }
interface LoginBucket { failures: number; resetAt: number; }

class LoginLimiter {
  private readonly buckets = new Map<string, LoginBucket>();
  constructor(private readonly maxFailures = 5, private readonly windowMs = 60_000) {}
  assertAllowed(key: string, nowMs: number): void {
    const bucket = this.buckets.get(key);
    if (!bucket) return;
    if (nowMs >= bucket.resetAt) { this.buckets.delete(key); return; }
    if (bucket.failures >= this.maxFailures) throw new AuthError('LOGIN_RATE_LIMITED', 429, 'Too many failed login attempts.');
  }
  recordFailure(key: string, nowMs: number): void {
    const current = this.buckets.get(key);
    if (!current || nowMs >= current.resetAt) { this.buckets.set(key, { failures: 1, resetAt: nowMs + this.windowMs }); return; }
    current.failures += 1;
  }
  reset(key: string): void { this.buckets.delete(key); }
}

function credentials(body: CredentialsBody): { username: string; password: string } {
  if (typeof body?.username !== 'string' || typeof body?.password !== 'string') throw new AuthError('INVALID_REQUEST', 400, 'Username and password are required.');
  return { username: body.username, password: body.password };
}
function hostProbeInput(body: HostProbeBody): HostProbeInput {
  if (typeof body?.hostname !== 'string') throw new HostOnboardingError('INVALID_HOST', 400, 'SSH hostname is required.');
  if (body.port !== undefined && typeof body.port !== 'number') throw new HostOnboardingError('INVALID_HOST', 400, 'SSH port must be a number.');
  return { hostname: body.hostname, port: body.port };
}
function hostCreateInput(body: HostCreateBody): HostCreateInput {
  const endpoint = hostProbeInput(body);
  if (typeof body.displayName !== 'string' || typeof body.username !== 'string' || typeof body.confirmedFingerprint !== 'string' || typeof body.privateKey !== 'string') {
    throw new HostOnboardingError('INVALID_HOST', 400, 'Display name, username, confirmed fingerprint and private key are required.');
  }
  return { ...endpoint, displayName: body.displayName, username: body.username, confirmedFingerprint: body.confirmedFingerprint, privateKey: body.privateKey };
}
function csrfHeader(value: string | string[] | undefined): string | undefined { return Array.isArray(value) ? value[0] : value; }
function requireSnapshotId(query: SnapshotQuery): string {
  if (typeof query?.snapshotId !== 'string' || !query.snapshotId.trim()) {
    throw new UpdatePlanError('INVALID_UPDATE_SNAPSHOT', 400, 'snapshotId query parameter is required.');
  }
  return query.snapshotId.trim();
}
function requireIntentSnapshotId(body: UpdateIntentBody): string {
  if (typeof body?.snapshotId !== 'string' || !body.snapshotId.trim()) {
    throw new UpdateExecutionIntentError('INVALID_UPDATE_SNAPSHOT', 400, 'snapshotId is required.');
  }
  return body.snapshotId.trim();
}
function sendApiError(reply: FastifyReply, error: unknown): FastifyReply {
  if (
    error instanceof AuthError
    || error instanceof HostOnboardingError
    || error instanceof TargetDiscoveryError
    || error instanceof TargetStatusError
    || error instanceof TargetLogError
    || error instanceof ModelPullError
    || error instanceof PullJobEventError
    || error instanceof OllamaHealthError
    || error instanceof OllamaModelDetailError
    || error instanceof OllamaModelInventoryError
    || error instanceof ContainerLifecycleError
    || error instanceof JobServiceError
    || error instanceof UpdatePreflightError
    || error instanceof UpdatePlanError
    || error instanceof UpdateStrategyError
    || error instanceof UpdateExecutionIntentError
    || error instanceof UpdateExecutionRequestError
    || error instanceof UpdateOrchestratorError
  ) {
    return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } });
  }
  if (error instanceof DockerDiscoveryError) {
    const statusCode = error.code === 'CONTAINER_NOT_FOUND' ? 404 : 502;
    return reply.code(statusCode).send({ error: { code: error.code, message: error.message } });
  }
  if (error instanceof SshTransportError) {
    const statusCode = error.code === 'SSH_HOST_KEY_MISMATCH' ? 409 : error.code === 'AUTH_FAILED' ? 422 : 502;
    return reply.code(statusCode).send({ error: { code: error.code, message: error.message } });
  }
  throw error;
}
function publicSession(session: StoredSession) {
  return { user: { id: session.userId, username: session.username, role: session.role }, expiresAt: session.expiresAt };
}

export function buildServer(options: BuildServerOptions = {}): FastifyInstance {
  const masterKey = loadConfiguredMasterKey(options.environment ?? process.env);
  const database = openDatabase(options.databasePath ?? ':memory:');
  applyMigrations(database);
  const now = options.now ?? (() => new Date());
  const sessionTtlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
  const auth = new AuthService(new SqliteAuthRepository(database), now, sessionTtlMs);
  const hostRepository = new SqliteHostOnboardingRepository(database);
  const hostCatalogRepository = new SqliteHostCatalogRepository(database);
  const credentialRepository = new SqliteSshCredentialRepository(database);
  const targetRepository = new SqliteOllamaTargetRepository(database);
  const targetCatalogRepository = new SqliteTargetCatalogRepository(database);
  const targetBindingRepository = new SqliteTargetContainerBindingRepository(database);
  const snapshotRepository = new SqliteUpdateSnapshotRepository(database);
  const jobService = new JobService(new SqliteJobRepository(database), now);
  const auditService = new AuditService(new SqliteAuditRepository(database), now);
  const hosts = new HostOnboardingService(hostRepository, masterKey, now);
  const targets = new TargetDiscoveryService(hostRepository, credentialRepository, targetRepository, masterKey, now);
  const targetStatus = new TargetStatusService(hostRepository, credentialRepository, targetRepository, masterKey);
  const targetLogs = new TargetLogService(hostRepository, credentialRepository, targetRepository, masterKey);
  const ollamaHealth = new OllamaHealthService(hostRepository, credentialRepository, targetRepository, masterKey);
  const ollamaModels = new OllamaModelInventoryService(hostRepository, credentialRepository, targetRepository, masterKey);
  const ollamaModelDetails = new OllamaModelDetailService(hostRepository, credentialRepository, targetRepository, masterKey);
  const modelPull = new ModelPullService(
    hostRepository,
    credentialRepository,
    targetRepository,
    masterKey,
    jobService,
    auditService,
    ollamaModels,
    now,
  );
  const updateRemoteFactory = options.updateRemoteFactory ?? createSshUpdateRemoteFactory(ollamaHealth);
  const containerLifecycle = new ContainerLifecycleService(
    hostRepository,
    credentialRepository,
    targetRepository,
    masterKey,
    jobService,
    auditService,
  );
  const updatePreflight = new UpdatePreflightService(
    hostRepository,
    credentialRepository,
    targetRepository,
    snapshotRepository,
    masterKey,
    auditService,
    now,
  );
  const updatePlan = new UpdatePlanService(
    hostRepository,
    credentialRepository,
    targetRepository,
    snapshotRepository,
    masterKey,
    auditService,
  );
  const updateStrategy = new UpdateStrategyService(
    hostRepository,
    credentialRepository,
    targetRepository,
    snapshotRepository,
    masterKey,
    auditService,
  );
  const updateExecutionIntent = new UpdateExecutionIntentService(
    hostRepository,
    credentialRepository,
    targetRepository,
    masterKey,
    jobService,
    auditService,
    updatePlan,
    updateStrategy,
  );
  const updateOrchestrator = new UpdateOrchestratorService(
    hostRepository,
    credentialRepository,
    targetRepository,
    targetBindingRepository,
    snapshotRepository,
    masterKey,
    jobService,
    auditService,
    updateRemoteFactory,
    now,
  );
  const updateReconciliation = new UpdateReconciliationService(
    hostRepository,
    credentialRepository,
    targetRepository,
    targetBindingRepository,
    snapshotRepository,
    masterKey,
    jobService,
    auditService,
    updateRemoteFactory,
    now,
  );
  const loginLimiter = new LoginLimiter();
  const app = Fastify({ logger: false });

  app.addHook('onReady', async () => {
    await updateReconciliation.reconcile();
    await modelPull.reconcile();
  });

  function requireAuthenticated(request: FastifyRequest): StoredSession {
    const session = auth.getSession(parseCookies(request.headers.cookie)[SESSION_COOKIE]);
    if (!session) throw new AuthError('UNAUTHENTICATED', 401, 'Authentication is required.');
    return session;
  }
  function requireAuthenticatedMutation(request: FastifyRequest): StoredSession {
    const cookies = parseCookies(request.headers.cookie);
    const session = requireAuthenticated(request);
    const headerToken = csrfHeader(request.headers['x-csrf-token']);
    if (!headerToken || cookies[CSRF_COOKIE] !== headerToken) throw new AuthError('CSRF_INVALID', 403, 'CSRF token is invalid.');
    auth.assertCsrf(session, headerToken);
    return session;
  }

  app.get('/api/v1/health', async (): Promise<ApiHealthResponse> => {
    if (!pingDatabase(database)) throw new Error('Database health check failed');
    return { status: 'ok', service: 'ollama-remote-control-api', version: '0.0.0', database: { status: 'ok', schemaVersion: getSchemaVersion(database) } };
  });
  app.get('/api/v1/setup/status', async () => ({ requiresAdminBootstrap: auth.requiresBootstrap() }));
  app.post<{ Body: CredentialsBody }>('/api/v1/setup/admin', async (request, reply) => {
    try { const input = credentials(request.body); return reply.code(201).send({ user: await auth.bootstrapAdmin(input.username, input.password) }); }
    catch (error) { return sendApiError(reply, error); }
  });
  app.post<{ Body: CredentialsBody }>('/api/v1/session', async (request, reply) => {
    const limiterKey = request.ip;
    try {
      loginLimiter.assertAllowed(limiterKey, now().getTime());
      const input = credentials(request.body);
      const session = await auth.login(input.username, input.password);
      loginLimiter.reset(limiterKey);
      const maxAgeSeconds = Math.ceil(sessionTtlMs / 1000);
      reply.header('set-cookie', [sessionCookie(session.token, maxAgeSeconds), csrfCookie(session.csrfToken, maxAgeSeconds)]);
      return reply.send({ user: session.user, expiresAt: session.expiresAt });
    } catch (error) {
      if (error instanceof AuthError && error.code === 'INVALID_CREDENTIALS') loginLimiter.recordFailure(limiterKey, now().getTime());
      return sendApiError(reply, error);
    }
  });
  app.get('/api/v1/session', async (request, reply) => {
    try { return reply.send(publicSession(requireAuthenticated(request))); }
    catch (error) { return sendApiError(reply, error); }
  });
  app.delete('/api/v1/session', async (request, reply) => {
    try { auth.logout(requireAuthenticatedMutation(request)); reply.header('set-cookie', clearSessionCookies()); return reply.code(204).send(); }
    catch (error) { return sendApiError(reply, error); }
  });
  app.get('/api/v1/hosts', async (request, reply) => {
    try { requireAuthenticated(request); return reply.send({ hosts: hostCatalogRepository.listEnabled() }); }
    catch (error) { return sendApiError(reply, error); }
  });
  app.post<{ Body: HostProbeBody }>('/api/v1/hosts/probe', async (request, reply) => {
    try { requireAuthenticatedMutation(request); return reply.send(await hosts.probe(hostProbeInput(request.body))); }
    catch (error) { return sendApiError(reply, error); }
  });
  app.post<{ Body: HostCreateBody }>('/api/v1/hosts', async (request, reply) => {
    try { requireAuthenticatedMutation(request); return reply.code(201).send({ host: await hosts.create(hostCreateInput(request.body)) }); }
    catch (error) { return sendApiError(reply, error); }
  });
  app.post<{ Params: HostParams }>(
    '/api/v1/hosts/:hostId/discover-ollama',
    async (request, reply) => {
      try {
        requireAuthenticatedMutation(request);
        return reply.send(publicDockerDiscovery(await targets.discover(request.params.hostId)));
      } catch (error) { return sendApiError(reply, error); }
    },
  );
  app.post<{ Params: HostParams; Body: TargetSelectionBody }>(
    '/api/v1/hosts/:hostId/targets',
    async (request, reply) => {
      try {
        requireAuthenticatedMutation(request);
        if (typeof request.body?.containerId !== 'string' || (request.body.displayName !== undefined && typeof request.body.displayName !== 'string')) {
          throw new TargetDiscoveryError('INVALID_TARGET', 400, 'Container ID is required and display name must be a string.');
        }
        return reply.code(201).send({ target: await targets.select(request.params.hostId, request.body.containerId, request.body.displayName as string | undefined) });
      } catch (error) { return sendApiError(reply, error); }
    },
  );
  app.get<{ Params: HostParams }>('/api/v1/hosts/:hostId/targets', async (request, reply) => {
    try { requireAuthenticated(request); return reply.send({ targets: targetRepository.findByHostId(request.params.hostId) }); }
    catch (error) { return sendApiError(reply, error); }
  });
  app.get('/api/v1/targets', async (request, reply) => {
    try { requireAuthenticated(request); return reply.send({ targets: targetCatalogRepository.listEnabled() }); }
    catch (error) { return sendApiError(reply, error); }
  });
  app.get<{ Params: TargetParams }>('/api/v1/targets/:targetId/status', async (request, reply) => {
    try {
      requireAuthenticated(request);
      return reply.send(await targetStatus.read(request.params.targetId));
    } catch (error) { return sendApiError(reply, error); }
  });
  app.get<{ Params: TargetParams }>('/api/v1/targets/:targetId/health', async (request, reply) => {
    try {
      requireAuthenticated(request);
      return reply.send(await ollamaHealth.read(request.params.targetId));
    } catch (error) { return sendApiError(reply, error); }
  });
  app.get<{ Params: TargetParams }>('/api/v1/targets/:targetId/models', async (request, reply) => {
    try {
      requireAuthenticated(request);
      return reply.send(await ollamaModels.read(request.params.targetId));
    } catch (error) { return sendApiError(reply, error); }
  });
  app.get<{ Params: TargetParams; Querystring: ModelDetailQuery }>('/api/v1/targets/:targetId/model-details', async (request, reply) => {
    try {
      requireAuthenticated(request);
      return reply.send(await ollamaModelDetails.read(request.params.targetId, request.query?.model));
    } catch (error) { return sendApiError(reply, error); }
  });
  app.post<{ Params: TargetParams; Body: ModelPullBody }>('/api/v1/targets/:targetId/models/pull', async (request, reply) => {
    try {
      const session = requireAuthenticatedMutation(request);
      return reply.code(202).send({ job: modelPull.start(request.params.targetId, session.userId, request.body?.model) });
    } catch (error) { return sendApiError(reply, error); }
  });
  app.get<{ Params: TargetParams }>('/api/v1/targets/:targetId/models/pull/active', async (request, reply) => {
    try {
      const session = requireAuthenticated(request);
      const active = jobService.jobsNeedingReconciliation().find((job) => (
        job.kind === 'model-pull'
        && job.targetId === request.params.targetId
        && job.actorUserId === session.userId
      ));
      return reply.send({ job: active ? modelPull.get(active.id, session.userId) : null });
    } catch (error) { return sendApiError(reply, error); }
  });
  app.get<{ Params: JobParams }>('/api/v1/jobs/:jobId', async (request, reply) => {
    try {
      const session = requireAuthenticated(request);
      return reply.send({ job: modelPull.get(request.params.jobId, session.userId) });
    } catch (error) { return sendApiError(reply, error); }
  });
  app.post<{ Params: JobParams }>('/api/v1/jobs/:jobId/cancel', async (request, reply) => {
    try {
      const session = requireAuthenticatedMutation(request);
      return reply.send({ job: modelPull.cancel(request.params.jobId, session.userId) });
    } catch (error) { return sendApiError(reply, error); }
  });
  app.get<{ Params: JobParams; Querystring: PullEventQuery }>('/api/v1/jobs/:jobId/events', async (request, reply) => {
    let session: StoredSession;
    let cursor: number;
    try {
      session = requireAuthenticated(request);
      modelPull.get(request.params.jobId, session.userId);
      cursor = parsePullEventCursor(request.query?.after ?? request.headers['last-event-id']);
    } catch (error) {
      return sendApiError(reply, error);
    }
    reply.hijack();
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    void streamPullJobEvents(reply.raw, modelPull, request.params.jobId, session.userId, cursor).catch(() => {
      if (!reply.raw.destroyed && !reply.raw.writableEnded) {
        reply.raw.write(`event: error\ndata: ${JSON.stringify({ code: 'JOB_EVENT_STREAM_FAILED', message: 'Pull job event stream failed.' })}\n\n`);
        reply.raw.end();
      }
    });
  });

  function registerContainerLifecycleRoute(action: DockerLifecycleAction): void {
    app.post<{ Params: TargetParams; Body: ContainerLifecycleBody }>(
      `/api/v1/targets/:targetId/container/${action}`,
      async (request, reply) => {
        try {
          const session = requireAuthenticatedMutation(request);
          return reply.send(await containerLifecycle.execute(
            request.params.targetId,
            action,
            session.userId,
            request.body?.confirmation,
          ));
        } catch (error) { return sendApiError(reply, error); }
      },
    );
  }
  registerContainerLifecycleRoute('start');
  registerContainerLifecycleRoute('stop');
  registerContainerLifecycleRoute('restart');

  app.post<{ Params: TargetParams }>('/api/v1/targets/:targetId/container/update-preflight', async (request, reply) => {
    try {
      const session = requireAuthenticatedMutation(request);
      return reply.code(201).send({ snapshot: await updatePreflight.capture(request.params.targetId, session.userId) });
    } catch (error) { return sendApiError(reply, error); }
  });

  app.get<{ Params: TargetParams; Querystring: SnapshotQuery }>('/api/v1/targets/:targetId/container/update-plan', async (request, reply) => {
    try {
      const session = requireAuthenticated(request);
      return reply.send({ plan: await updatePlan.create(request.params.targetId, requireSnapshotId(request.query), session.userId) });
    } catch (error) { return sendApiError(reply, error); }
  });

  app.get<{ Params: TargetParams; Querystring: SnapshotQuery }>('/api/v1/targets/:targetId/container/update-strategy', async (request, reply) => {
    try {
      const session = requireAuthenticated(request);
      return reply.send(await updateStrategy.create(request.params.targetId, requireSnapshotId(request.query), session.userId));
    } catch (error) { return sendApiError(reply, error); }
  });

  app.post<{ Params: TargetParams; Body: UpdateIntentBody }>('/api/v1/targets/:targetId/container/update-execution-intent', async (request, reply) => {
    try {
      const session = requireAuthenticatedMutation(request);
      const intent = await updateExecutionIntent.create(
        request.params.targetId,
        requireIntentSnapshotId(request.body),
        session.userId,
      );
      return reply.code(201).send({ intent });
    } catch (error) { return sendApiError(reply, error); }
  });

  app.post<{ Params: TargetParams; Body: unknown }>('/api/v1/targets/:targetId/container/update', async (request, reply) => {
    try {
      const session = requireAuthenticatedMutation(request);
      const execution = parseUpdateExecutionRequest(request.body, request.params.targetId);
      const result = await updateOrchestrator.execute(
        request.params.targetId,
        execution.intentId,
        session.userId,
      );
      return reply.send({ update: result });
    } catch (error) { return sendApiError(reply, error); }
  });

  app.get<{ Params: TargetParams; Querystring: LogQuery }>('/api/v1/targets/:targetId/logs/stream', async (request, reply) => {
    let remoteStream;
    let tail: number;
    try {
      requireAuthenticated(request);
      tail = parseLogTail(request.query?.tail);
      remoteStream = await targetLogs.open(request.params.targetId, tail);
    } catch (error) {
      return sendApiError(reply, error);
    }

    reply.hijack();
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    const writeEvent = (event: string, data: unknown) => {
      if (reply.raw.destroyed || reply.raw.writableEnded) return;
      reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    writeEvent('ready', { tail });
    remoteStream.onStdout((chunk) => writeEvent('log', { stream: 'stdout', chunk }));
    remoteStream.onStderr((chunk) => writeEvent('log', { stream: 'stderr', chunk }));

    let completed = false;
    const disconnect = () => {
      if (!completed) remoteStream.cancel();
    };
    reply.raw.once('close', disconnect);
    void remoteStream.done.then(
      (result) => {
        completed = true;
        reply.raw.off('close', disconnect);
        writeEvent('end', { exitCode: result.exitCode, signal: result.signal ?? null, cancelled: result.cancelled });
        if (!reply.raw.destroyed && !reply.raw.writableEnded) reply.raw.end();
      },
      () => {
        completed = true;
        reply.raw.off('close', disconnect);
        writeEvent('error', { code: 'LOG_STREAM_FAILED', message: 'Remote log stream failed.' });
        if (!reply.raw.destroyed && !reply.raw.writableEnded) reply.raw.end();
      },
    );
    remoteStream.start();
  });

  app.addHook('onClose', async () => {
    await modelPull.shutdown();
    database.close();
  });
  return app;
}

async function main(): Promise<void> {
  const app = buildServer({ databasePath: process.env.ORC_DATABASE_PATH ?? '/data/ollama-remote-control.sqlite', environment: process.env });
  await app.listen({ host: process.env.HOST ?? '0.0.0.0', port: Number(process.env.PORT ?? 3000) });
}
const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) await main();
