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
  SqliteAuthRepository,
  SqliteHostOnboardingRepository,
} from '@orc/db';
import {
  loadConfiguredMasterKey,
  type MasterKeyEnvironment,
} from '@orc/security';
import { SshTransportError } from '@orc/ssh';
import {
  AuthError,
  AuthService,
  DEFAULT_SESSION_TTL_MS,
} from './auth.js';
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

export interface BuildServerOptions {
  readonly databasePath?: string;
  readonly now?: () => Date;
  readonly sessionTtlMs?: number;
  readonly environment?: MasterKeyEnvironment;
}

interface CredentialsBody {
  readonly username?: unknown;
  readonly password?: unknown;
}

interface HostProbeBody {
  readonly hostname?: unknown;
  readonly port?: unknown;
}

interface HostCreateBody extends HostProbeBody {
  readonly displayName?: unknown;
  readonly username?: unknown;
  readonly confirmedFingerprint?: unknown;
  readonly privateKey?: unknown;
}

interface LoginBucket {
  failures: number;
  resetAt: number;
}

class LoginLimiter {
  private readonly buckets = new Map<string, LoginBucket>();

  constructor(
    private readonly maxFailures = 5,
    private readonly windowMs = 60_000,
  ) {}

  assertAllowed(key: string, nowMs: number): void {
    const bucket = this.buckets.get(key);
    if (!bucket) return;
    if (nowMs >= bucket.resetAt) {
      this.buckets.delete(key);
      return;
    }
    if (bucket.failures >= this.maxFailures) {
      throw new AuthError('LOGIN_RATE_LIMITED', 429, 'Too many failed login attempts.');
    }
  }

  recordFailure(key: string, nowMs: number): void {
    const current = this.buckets.get(key);
    if (!current || nowMs >= current.resetAt) {
      this.buckets.set(key, { failures: 1, resetAt: nowMs + this.windowMs });
      return;
    }
    current.failures += 1;
  }

  reset(key: string): void {
    this.buckets.delete(key);
  }
}

function credentials(body: CredentialsBody): { username: string; password: string } {
  if (typeof body?.username !== 'string' || typeof body?.password !== 'string') {
    throw new AuthError('INVALID_REQUEST', 400, 'Username and password are required.');
  }
  return { username: body.username, password: body.password };
}

function hostProbeInput(body: HostProbeBody): HostProbeInput {
  if (typeof body?.hostname !== 'string') {
    throw new HostOnboardingError('INVALID_HOST', 400, 'SSH hostname is required.');
  }
  if (body.port !== undefined && typeof body.port !== 'number') {
    throw new HostOnboardingError('INVALID_HOST', 400, 'SSH port must be a number.');
  }
  return { hostname: body.hostname, port: body.port };
}

function hostCreateInput(body: HostCreateBody): HostCreateInput {
  const endpoint = hostProbeInput(body);
  if (
    typeof body.displayName !== 'string'
    || typeof body.username !== 'string'
    || typeof body.confirmedFingerprint !== 'string'
    || typeof body.privateKey !== 'string'
  ) {
    throw new HostOnboardingError(
      'INVALID_HOST',
      400,
      'Display name, username, confirmed fingerprint and private key are required.',
    );
  }
  return {
    ...endpoint,
    displayName: body.displayName,
    username: body.username,
    confirmedFingerprint: body.confirmedFingerprint,
    privateKey: body.privateKey,
  };
}

function csrfHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function sendApiError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof AuthError || error instanceof HostOnboardingError) {
    return reply.code(error.statusCode).send({
      error: { code: error.code, message: error.message },
    });
  }
  if (error instanceof SshTransportError) {
    const statusCode = error.code === 'SSH_HOST_KEY_MISMATCH'
      ? 409
      : error.code === 'AUTH_FAILED'
        ? 422
        : 502;
    return reply.code(statusCode).send({
      error: { code: error.code, message: error.message },
    });
  }
  throw error;
}

function publicSession(session: StoredSession) {
  return {
    user: {
      id: session.userId,
      username: session.username,
      role: session.role,
    },
    expiresAt: session.expiresAt,
  };
}

export function buildServer(options: BuildServerOptions = {}): FastifyInstance {
  const masterKey = loadConfiguredMasterKey(options.environment ?? process.env);
  const database = openDatabase(options.databasePath ?? ':memory:');
  applyMigrations(database);
  const now = options.now ?? (() => new Date());
  const sessionTtlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
  const auth = new AuthService(new SqliteAuthRepository(database), now, sessionTtlMs);
  const hosts = new HostOnboardingService(
    new SqliteHostOnboardingRepository(database),
    masterKey,
    now,
  );
  const loginLimiter = new LoginLimiter();

  const app = Fastify({ logger: false });

  function requireAuthenticatedMutation(request: FastifyRequest): StoredSession {
    const cookies = parseCookies(request.headers.cookie);
    const session = auth.getSession(cookies[SESSION_COOKIE]);
    if (!session) {
      throw new AuthError('UNAUTHENTICATED', 401, 'Authentication is required.');
    }
    const headerToken = csrfHeader(request.headers['x-csrf-token']);
    if (!headerToken || cookies[CSRF_COOKIE] !== headerToken) {
      throw new AuthError('CSRF_INVALID', 403, 'CSRF token is invalid.');
    }
    auth.assertCsrf(session, headerToken);
    return session;
  }

  app.get('/api/v1/health', async (): Promise<ApiHealthResponse> => {
    if (!pingDatabase(database)) {
      throw new Error('Database health check failed');
    }

    return {
      status: 'ok',
      service: 'ollama-remote-control-api',
      version: '0.0.0',
      database: {
        status: 'ok',
        schemaVersion: getSchemaVersion(database),
      },
    };
  });

  app.get('/api/v1/setup/status', async () => ({
    requiresAdminBootstrap: auth.requiresBootstrap(),
  }));

  app.post<{ Body: CredentialsBody }>('/api/v1/setup/admin', async (request, reply) => {
    try {
      const input = credentials(request.body);
      const user = await auth.bootstrapAdmin(input.username, input.password);
      return reply.code(201).send({ user });
    } catch (error) {
      return sendApiError(reply, error);
    }
  });

  app.post<{ Body: CredentialsBody }>('/api/v1/session', async (request, reply) => {
    const limiterKey = request.ip;
    try {
      loginLimiter.assertAllowed(limiterKey, now().getTime());
      const input = credentials(request.body);
      const session = await auth.login(input.username, input.password);
      loginLimiter.reset(limiterKey);
      const maxAgeSeconds = Math.ceil(sessionTtlMs / 1000);
      reply.header('set-cookie', [
        sessionCookie(session.token, maxAgeSeconds),
        csrfCookie(session.csrfToken, maxAgeSeconds),
      ]);
      return reply.send({ user: session.user, expiresAt: session.expiresAt });
    } catch (error) {
      if (error instanceof AuthError && error.code === 'INVALID_CREDENTIALS') {
        loginLimiter.recordFailure(limiterKey, now().getTime());
      }
      return sendApiError(reply, error);
    }
  });

  app.get('/api/v1/session', async (request, reply) => {
    const cookies = parseCookies(request.headers.cookie);
    const session = auth.getSession(cookies[SESSION_COOKIE]);
    if (!session) {
      return reply.code(401).send({ error: { code: 'UNAUTHENTICATED' } });
    }
    return reply.send(publicSession(session));
  });

  app.delete('/api/v1/session', async (request, reply) => {
    try {
      const session = requireAuthenticatedMutation(request);
      auth.logout(session);
      reply.header('set-cookie', clearSessionCookies());
      return reply.code(204).send();
    } catch (error) {
      return sendApiError(reply, error);
    }
  });

  app.post<{ Body: HostProbeBody }>('/api/v1/hosts/probe', async (request, reply) => {
    try {
      requireAuthenticatedMutation(request);
      const observed = await hosts.probe(hostProbeInput(request.body));
      return reply.send(observed);
    } catch (error) {
      return sendApiError(reply, error);
    }
  });

  app.post<{ Body: HostCreateBody }>('/api/v1/hosts', async (request, reply) => {
    try {
      requireAuthenticatedMutation(request);
      const host = await hosts.create(hostCreateInput(request.body));
      return reply.code(201).send({ host });
    } catch (error) {
      return sendApiError(reply, error);
    }
  });

  app.addHook('onClose', async () => {
    database.close();
  });

  return app;
}

async function main(): Promise<void> {
  const app = buildServer({
    databasePath: process.env.ORC_DATABASE_PATH ?? '/data/ollama-remote-control.sqlite',
    environment: process.env,
  });
  const port = Number(process.env.PORT ?? 3000);
  const host = process.env.HOST ?? '0.0.0.0';
  await app.listen({ host, port });
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  await main();
}
