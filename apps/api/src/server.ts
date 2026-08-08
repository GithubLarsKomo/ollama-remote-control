import { pathToFileURL } from 'node:url';
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
} from 'fastify';
import type { ApiHealthResponse, StoredSession } from '@orc/core';
import {
  applyMigrations,
  getSchemaVersion,
  openDatabase,
  pingDatabase,
  SqliteAuthRepository,
} from '@orc/db';
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

export interface BuildServerOptions {
  readonly databasePath?: string;
  readonly now?: () => Date;
  readonly sessionTtlMs?: number;
}

interface CredentialsBody {
  readonly username?: unknown;
  readonly password?: unknown;
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

function csrfHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function sendAuthError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof AuthError) {
    return reply.code(error.statusCode).send({
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
  const database = openDatabase(options.databasePath ?? ':memory:');
  applyMigrations(database);
  const now = options.now ?? (() => new Date());
  const sessionTtlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
  const auth = new AuthService(new SqliteAuthRepository(database), now, sessionTtlMs);
  const loginLimiter = new LoginLimiter();

  const app = Fastify({ logger: false });

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
      return sendAuthError(reply, error);
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
      return sendAuthError(reply, error);
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
      auth.logout(session);
      reply.header('set-cookie', clearSessionCookies());
      return reply.code(204).send();
    } catch (error) {
      return sendAuthError(reply, error);
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
  });
  const port = Number(process.env.PORT ?? 3000);
  const host = process.env.HOST ?? '0.0.0.0';
  await app.listen({ host, port });
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  await main();
}
