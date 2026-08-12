import type {
  ModelfileDeployPlanRepository,
  StoredModelfileDeployPlan,
} from '@orc/core/modelfile-deploy-plans';
import type { DatabaseConnection } from './index.js';

function mapPlan(row: Record<string, unknown> | undefined): StoredModelfileDeployPlan | null {
  if (!row) return null;
  return {
    id: String(row.id),
    targetId: String(row.target_id),
    modelfileId: String(row.modelfile_id),
    revisionId: String(row.revision_id),
    revisionSha256: String(row.revision_sha256),
    actorUserId: String(row.actor_user_id),
    selectedContainerId: String(row.selected_container_id),
    outputModel: String(row.output_model),
    baseModel: String(row.base_model),
    payloadSha256: String(row.payload_sha256),
    confirmationTokenHash: String(row.confirmation_token_hash),
    createdAt: String(row.created_at),
    expiresAt: String(row.expires_at),
    consumedAt: row.consumed_at === null ? null : String(row.consumed_at),
  };
}

export class SqliteModelfileDeployPlanRepository implements ModelfileDeployPlanRepository {
  constructor(private readonly database: DatabaseConnection) {}

  create(plan: StoredModelfileDeployPlan): boolean {
    return this.database.prepare(`
      INSERT OR IGNORE INTO modelfile_deploy_plans(
        id, target_id, modelfile_id, revision_id, revision_sha256,
        actor_user_id, selected_container_id, output_model, base_model,
        payload_sha256, confirmation_token_hash, created_at, expires_at, consumed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
    `).run(
      plan.id,
      plan.targetId,
      plan.modelfileId,
      plan.revisionId,
      plan.revisionSha256,
      plan.actorUserId,
      plan.selectedContainerId,
      plan.outputModel,
      plan.baseModel,
      plan.payloadSha256,
      plan.confirmationTokenHash,
      plan.createdAt,
      plan.expiresAt,
    ).changes === 1;
  }

  findById(planId: string): StoredModelfileDeployPlan | null {
    return mapPlan(this.database.prepare(`
      SELECT id, target_id, modelfile_id, revision_id, revision_sha256,
             actor_user_id, selected_container_id, output_model, base_model,
             payload_sha256, confirmation_token_hash, created_at, expires_at, consumed_at
      FROM modelfile_deploy_plans
      WHERE id = ?
    `).get(planId));
  }

  consumeIfUsable(
    planId: string,
    actorUserId: string,
    confirmationTokenHash: string,
    nowIso: string,
    consumedAt: string,
  ): StoredModelfileDeployPlan | null {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const before = mapPlan(this.database.prepare(`
        SELECT id, target_id, modelfile_id, revision_id, revision_sha256,
               actor_user_id, selected_container_id, output_model, base_model,
               payload_sha256, confirmation_token_hash, created_at, expires_at, consumed_at
        FROM modelfile_deploy_plans
        WHERE id = ?
          AND actor_user_id = ?
          AND confirmation_token_hash = ?
          AND consumed_at IS NULL
          AND expires_at > ?
      `).get(planId, actorUserId, confirmationTokenHash, nowIso));
      if (!before) {
        this.database.exec('ROLLBACK');
        return null;
      }
      const changed = this.database.prepare(`
        UPDATE modelfile_deploy_plans
        SET consumed_at = ?
        WHERE id = ?
          AND actor_user_id = ?
          AND confirmation_token_hash = ?
          AND consumed_at IS NULL
          AND expires_at > ?
      `).run(consumedAt, planId, actorUserId, confirmationTokenHash, nowIso);
      if (changed.changes !== 1) {
        this.database.exec('ROLLBACK');
        return null;
      }
      this.database.exec('COMMIT');
      return { ...before, consumedAt };
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }
}
