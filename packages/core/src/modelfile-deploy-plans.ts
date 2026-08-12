export interface StoredModelfileDeployPlan {
  readonly id: string;
  readonly targetId: string;
  readonly modelfileId: string;
  readonly revisionId: string;
  readonly revisionSha256: string;
  readonly actorUserId: string;
  readonly selectedContainerId: string;
  readonly outputModel: string;
  readonly baseModel: string;
  readonly payloadSha256: string;
  readonly replaceExisting: boolean;
  readonly existingDestinationDigest: string | null;
  readonly existingDestinationSizeBytes: number | null;
  readonly confirmationTokenHash: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly consumedAt: string | null;
}

export interface ModelfileDeployPlanRepository {
  create(plan: StoredModelfileDeployPlan): boolean;
  findById(planId: string): StoredModelfileDeployPlan | null;
  consumeIfUsable(
    planId: string,
    actorUserId: string,
    confirmationTokenHash: string,
    nowIso: string,
    consumedAt: string,
  ): StoredModelfileDeployPlan | null;
}
