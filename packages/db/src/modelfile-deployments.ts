import type {
  ModelfileDeploymentRepository,
  StoredModelfileDeployment,
} from '@orc/core/modelfile-deployments';
import type { DatabaseConnection } from './index.js';

function mapDeployment(row: Record<string, unknown> | undefined): StoredModelfileDeployment | null {
  if (!row) return null;
  return {
    id: String(row.id),
    targetId: String(row.target_id),
    modelfileId: String(row.modelfile_id),
    revisionId: String(row.revision_id),
    revisionSha256: String(row.revision_sha256),
    outputModel: String(row.output_model),
    modelDigest: String(row.model_digest),
    sizeBytes: Number(row.size_bytes),
    baseModel: String(row.base_model),
    sourceCreateJobId: String(row.source_create_job_id),
    actorUserId: String(row.actor_user_id),
    selectedContainerId: String(row.selected_container_id),
    verifiedAt: String(row.verified_at),
  };
}

function sameDeployment(left: StoredModelfileDeployment, right: StoredModelfileDeployment): boolean {
  return left.id === right.id
    && left.targetId === right.targetId
    && left.modelfileId === right.modelfileId
    && left.revisionId === right.revisionId
    && left.revisionSha256 === right.revisionSha256
    && left.outputModel === right.outputModel
    && left.modelDigest === right.modelDigest
    && left.sizeBytes === right.sizeBytes
    && left.baseModel === right.baseModel
    && left.sourceCreateJobId === right.sourceCreateJobId
    && left.actorUserId === right.actorUserId
    && left.selectedContainerId === right.selectedContainerId
    && left.verifiedAt === right.verifiedAt;
}

export class SqliteModelfileDeploymentRepository implements ModelfileDeploymentRepository {
  constructor(private readonly database: DatabaseConnection) {}

  recordVerified(deployment: StoredModelfileDeployment): StoredModelfileDeployment {
    const existing = this.findBySourceCreateJobId(deployment.sourceCreateJobId);
    if (existing) {
      if (!sameDeployment(existing, deployment)) {
        throw new Error('Verified Modelfile deployment source job is already bound to different immutable evidence.');
      }
      return existing;
    }

    const inserted = this.database.prepare(`
      INSERT OR IGNORE INTO modelfile_deployments(
        id, target_id, modelfile_id, revision_id, revision_sha256,
        output_model, model_digest, size_bytes, base_model,
        source_create_job_id, actor_user_id, selected_container_id, verified_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      deployment.id,
      deployment.targetId,
      deployment.modelfileId,
      deployment.revisionId,
      deployment.revisionSha256,
      deployment.outputModel,
      deployment.modelDigest,
      deployment.sizeBytes,
      deployment.baseModel,
      deployment.sourceCreateJobId,
      deployment.actorUserId,
      deployment.selectedContainerId,
      deployment.verifiedAt,
    );

    const stored = this.findBySourceCreateJobId(deployment.sourceCreateJobId);
    if (!stored || !sameDeployment(stored, deployment)) {
      throw new Error(inserted.changes === 0
        ? 'Verified Modelfile deployment could not be recorded idempotently.'
        : 'Verified Modelfile deployment persistence verification failed.');
    }
    return stored;
  }

  findBySourceCreateJobId(sourceCreateJobId: string): StoredModelfileDeployment | null {
    return mapDeployment(this.database.prepare(`
      SELECT id, target_id, modelfile_id, revision_id, revision_sha256,
             output_model, model_digest, size_bytes, base_model,
             source_create_job_id, actor_user_id, selected_container_id, verified_at
      FROM modelfile_deployments
      WHERE source_create_job_id = ?
    `).get(sourceCreateJobId));
  }

  listForRevision(revisionId: string): readonly StoredModelfileDeployment[] {
    return this.database.prepare(`
      SELECT id, target_id, modelfile_id, revision_id, revision_sha256,
             output_model, model_digest, size_bytes, base_model,
             source_create_job_id, actor_user_id, selected_container_id, verified_at
      FROM modelfile_deployments
      WHERE revision_id = ?
      ORDER BY verified_at DESC, id DESC
    `).all(revisionId).map((row) => mapDeployment(row)!).filter(Boolean);
  }

  listForModelfile(modelfileId: string): readonly StoredModelfileDeployment[] {
    return this.database.prepare(`
      SELECT id, target_id, modelfile_id, revision_id, revision_sha256,
             output_model, model_digest, size_bytes, base_model,
             source_create_job_id, actor_user_id, selected_container_id, verified_at
      FROM modelfile_deployments
      WHERE modelfile_id = ?
      ORDER BY verified_at DESC, id DESC
    `).all(modelfileId).map((row) => mapDeployment(row)!).filter(Boolean);
  }

  latestForTargetModel(targetId: string, outputModel: string): StoredModelfileDeployment | null {
    return mapDeployment(this.database.prepare(`
      SELECT id, target_id, modelfile_id, revision_id, revision_sha256,
             output_model, model_digest, size_bytes, base_model,
             source_create_job_id, actor_user_id, selected_container_id, verified_at
      FROM modelfile_deployments
      WHERE target_id = ? AND output_model = ?
      ORDER BY verified_at DESC, id DESC
      LIMIT 1
    `).get(targetId, outputModel));
  }
}
