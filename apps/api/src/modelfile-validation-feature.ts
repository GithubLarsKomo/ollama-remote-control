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
  type DatabaseConnection,
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
  ModelfileValidationError,
  ModelfileValidationService,
  type DeployPlanEvidenceReader,
  type StoredDeployPlanEvidence,
} from './modelfile-validation.js';

interface ModelfileRevisionParams {
  readonly modelfileId: string;
  readonly revisionId: string;
}
interface ValidationQuery {
  readonly targetId?: unknown;
  readonly model?: unknown;
}

export interface RegisterModelfileValidationFeatureOptions {
  readonly databasePath: string;
  readonly now?: () => Date;
  readonly sessionTtlMs?: number;
}

class SqliteDeployPlanEvidenceReader implements DeployPlanEvidenceReader {
  constructor(private readonly database: DatabaseConnection) {}

  latestForRevisionTargetModel(
    modelfileId: string,
    revisionId: string,
    revisionSha256: string,
    targetId: string,
    outputModel: string,
  ): StoredDeployPlanEvidence | null {
    const row = this.database.prepare(`
      SELECT id, target_id, modelfile_id, revision_id, revision_sha256,
             selected_container_id, output_model, base_model, created_at, expires_at, consumed_at
      FROM modelfile_deploy_plans
      WHERE modelfile_id = ?
        AND revision_id = ?
        AND revision_sha256 = ?
        AND target_id = ?
        AND output_model = ?
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `).get(modelfileId, revisionId, revisionSha256, targetId, outputModel) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: String(row.id),
      targetId: String(row.target_id),
      modelfileId: String(row.modelfile_id),
      revisionId: String(row.revision_id),
      revisionSha256: String(row.revision_sha256),
      selectedContainerId: String(row.selected_container_id),
      outputModel: String(row.output_model),
      baseModel: String(row.base_model),
      createdAt: String(row.created_at),
      expiresAt: String(row.expires_at),
      consumedAt: row.consumed_at === null ? null : String(row.consumed_at),
    };
  }
}

function sendFeatureError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof AuthError || error instanceof ModelfileValidationError) {
    return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } });
  }
  throw error;
}

export function registerModelfileValidationFeature(
  app: FastifyInstance,
  options: RegisterModelfileValidationFeatureOptions,
): void {
  if (!options.databasePath || options.databasePath === ':memory:') {
    throw new Error('Modelfile validation feature requires a persistent SQLite database path shared with the core server.');
  }

  const database = openDatabase(options.databasePath);
  applyMigrations(database);
  const now = options.now ?? (() => new Date());
  const auth = new AuthService(
    new SqliteAuthRepository(database),
    now,
    options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS,
  );
  const validation = new ModelfileValidationService(
    new SqliteModelfileRepository(database),
    new SqliteDeployPlanEvidenceReader(database),
    new SqliteModelfileDeploymentRepository(database),
    new SqliteOllamaTargetRepository(database),
    now,
  );

  function requireAuthenticated(request: FastifyRequest): void {
    const session = auth.getSession(parseCookies(request.headers.cookie)[SESSION_COOKIE]);
    if (!session) throw new AuthError('UNAUTHENTICATED', 401, 'Authentication is required.');
  }

  app.get<{ Params: ModelfileRevisionParams; Querystring: ValidationQuery }>(
    '/api/v1/modelfiles/:modelfileId/revisions/:revisionId/validation',
    async (request, reply) => {
      try {
        requireAuthenticated(request);
        return reply.send({
          validation: validation.read(
            request.params.modelfileId,
            request.params.revisionId,
            request.query?.targetId,
            request.query?.model,
          ),
        });
      } catch (error) {
        return sendFeatureError(reply, error);
      }
    },
  );

  app.addHook('onClose', async () => {
    database.close();
  });
}
