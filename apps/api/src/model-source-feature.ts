import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from 'fastify';
import { resolveModelSourceReference } from '@orc/core/model-source';
import {
  applyMigrations,
  openDatabase,
  SqliteAuditRepository,
  SqliteAuthRepository,
  SqliteHostOnboardingRepository,
  SqliteOllamaTargetRepository,
  SqliteSshCredentialRepository,
} from '@orc/db';
import {
  backfillVerifiedProvenanceEvidence,
  readPersistedProvenanceGraph,
} from '@orc/db/provenance-backfill';
import { SqliteProvenanceRepository } from '@orc/db/provenance';
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
import {
  OllamaModelDetailError,
  OllamaModelDetailService,
} from './ollama-model-details.js';
import {
  buildModelProvenanceGraph,
  SqliteModelProvenanceEvidenceStore,
} from './model-provenance-graph.js';
import {
  ProvenanceSourceCorrectionError,
  ProvenanceSourceCorrectionService,
  type ProvenanceSourceCorrectionInput,
} from './provenance-source-correction.js';

interface TargetParams { readonly targetId: string; }
interface ModelQuery { readonly model?: unknown; }
interface ProvenanceNodeParams { readonly nodeId: string; }

export interface RegisterModelSourceFeatureOptions {
  readonly databasePath: string;
  readonly now?: () => Date;
  readonly sessionTtlMs?: number;
  readonly environment?: MasterKeyEnvironment;
}

function csrfHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function sendFeatureError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof AuthError || error instanceof OllamaModelDetailError || error instanceof ProvenanceSourceCorrectionError) {
    return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } });
  }
  throw error;
}

export function registerModelSourceFeature(
  app: FastifyInstance,
  options: RegisterModelSourceFeatureOptions,
): void {
  if (!options.databasePath || options.databasePath === ':memory:') {
    throw new Error('Model-source feature requires a persistent SQLite database path shared with the core server.');
  }

  const database = openDatabase(options.databasePath);
  applyMigrations(database);
  backfillVerifiedProvenanceEvidence(database);
  const now = options.now ?? (() => new Date());
  const auth = new AuthService(
    new SqliteAuthRepository(database),
    now,
    options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS,
  );
  const details = new OllamaModelDetailService(
    new SqliteHostOnboardingRepository(database),
    new SqliteSshCredentialRepository(database),
    new SqliteOllamaTargetRepository(database),
    loadConfiguredMasterKey(options.environment ?? process.env),
  );
  const provenance = new SqliteModelProvenanceEvidenceStore(database);
  const persistedProvenance = new SqliteProvenanceRepository(database);
  const corrections = new ProvenanceSourceCorrectionService(
    database,
    new AuditService(new SqliteAuditRepository(database), now),
    now,
  );

  function requireAuthenticated(request: FastifyRequest) {
    const session = auth.getSession(parseCookies(request.headers.cookie)[SESSION_COOKIE]);
    if (!session) throw new AuthError('UNAUTHENTICATED', 401, 'Authentication is required.');
    return session;
  }

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

  app.get<{ Params: TargetParams; Querystring: ModelQuery }>(
    '/api/v1/targets/:targetId/model-sources',
    async (request, reply) => {
      try {
        requireAuthenticated(request);
        const detail = await details.read(request.params.targetId, request.query?.model);
        backfillVerifiedProvenanceEvidence(database);
        const graphInput = {
          targetId: detail.targetId,
          model: detail.identity.model,
          digest: detail.identity.digest,
        };
        const from = detail.provenancePreview.from;
        return reply.send({
          targetId: detail.targetId,
          model: detail.identity.model,
          sources: {
            model: resolveModelSourceReference(detail.identity.model),
            from: from ? resolveModelSourceReference(from.reference) : null,
            adapters: detail.provenancePreview.adapters.map((adapter) => resolveModelSourceReference(adapter.reference)),
          },
          graph: buildModelProvenanceGraph(provenance, graphInput),
          persistedGraph: readPersistedProvenanceGraph(database, graphInput),
          persistedSources: persistedProvenance.listSourcesForInstalledModel(
            graphInput.targetId,
            graphInput.model,
            graphInput.digest,
          ),
        });
      } catch (error) {
        return sendFeatureError(reply, error);
      }
    },
  );

  app.post<{ Params: ProvenanceNodeParams; Body: ProvenanceSourceCorrectionInput }>(
    '/api/v1/provenance/nodes/:nodeId/source-corrections',
    async (request, reply) => {
      try {
        const session = requireAuthenticatedMutation(request);
        const source = corrections.correct(session.userId, request.params.nodeId, request.body ?? {});
        return reply.code(201).send({ source });
      } catch (error) {
        return sendFeatureError(reply, error);
      }
    },
  );

  app.addHook('onClose', async () => {
    database.close();
  });
}
