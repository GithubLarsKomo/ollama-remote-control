import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from 'fastify';
import {
  applyMigrations,
  openDatabase,
  SqliteAuthRepository,
} from '@orc/db';
import { SqliteAuditQueryRepository } from '@orc/db/audit-query';
import {
  AuditReadError,
  AuditReadService,
  type AuditHttpQuery,
} from './audit-read.js';
import {
  AuthError,
  AuthService,
  DEFAULT_SESSION_TTL_MS,
} from './auth.js';
import {
  parseCookies,
  SESSION_COOKIE,
} from './cookies.js';

export interface RegisterAuditFeatureOptions {
  readonly databasePath: string;
  readonly now?: () => Date;
  readonly sessionTtlMs?: number;
  readonly retentionDays?: number;
  readonly retentionBatchSize?: number;
  readonly retentionMaxBatches?: number;
}

function sendFeatureError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof AuthError || error instanceof AuditReadError) {
    return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } });
  }
  throw error;
}

export function registerAuditFeature(
  app: FastifyInstance,
  options: RegisterAuditFeatureOptions,
): void {
  if (!options.databasePath || options.databasePath === ':memory:') {
    throw new Error('Audit feature requires a persistent SQLite database path shared with the core server.');
  }

  const database = openDatabase(options.databasePath);
  applyMigrations(database);
  const now = options.now ?? (() => new Date());
  const auth = new AuthService(
    new SqliteAuthRepository(database),
    now,
    options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS,
  );
  const audit = new AuditReadService(
    new SqliteAuditQueryRepository(database),
    now,
    {
      retentionDays: options.retentionDays,
      retentionBatchSize: options.retentionBatchSize,
      retentionMaxBatches: options.retentionMaxBatches,
    },
  );

  function requireAuthenticated(request: FastifyRequest) {
    const session = auth.getSession(parseCookies(request.headers.cookie)[SESSION_COOKIE]);
    if (!session) throw new AuthError('UNAUTHENTICATED', 401, 'Authentication is required.');
    return session;
  }

  app.addHook('onReady', async () => {
    try {
      audit.purgeExpired();
    } catch (error) {
      app.log.warn({ error }, 'Audit retention maintenance failed; application readiness continues.');
    }
  });

  app.get<{ Querystring: AuditHttpQuery }>('/api/v1/audit', async (request, reply) => {
    try {
      requireAuthenticated(request);
      return reply.send(audit.history(request.query ?? {}));
    } catch (error) {
      return sendFeatureError(reply, error);
    }
  });

  app.get<{ Querystring: AuditHttpQuery }>('/api/v1/audit/export.json', async (request, reply) => {
    try {
      requireAuthenticated(request);
      const body = audit.exportJson(request.query ?? {});
      reply.header('content-disposition', 'attachment; filename="ollama-remote-control-audit.json"');
      reply.header('x-content-type-options', 'nosniff');
      return reply.type('application/json; charset=utf-8').send(body);
    } catch (error) {
      return sendFeatureError(reply, error);
    }
  });

  app.get<{ Querystring: AuditHttpQuery }>('/api/v1/audit/export.csv', async (request, reply) => {
    try {
      requireAuthenticated(request);
      const body = audit.exportCsv(request.query ?? {});
      reply.header('content-disposition', 'attachment; filename="ollama-remote-control-audit.csv"');
      reply.header('x-content-type-options', 'nosniff');
      return reply.type('text/csv; charset=utf-8').send(body);
    } catch (error) {
      return sendFeatureError(reply, error);
    }
  });

  app.addHook('onClose', async () => {
    database.close();
  });
}
