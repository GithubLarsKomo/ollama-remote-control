export interface StoredModelfileDeployment {
  readonly id: string;
  readonly targetId: string;
  readonly modelfileId: string;
  readonly revisionId: string;
  readonly revisionSha256: string;
  readonly outputModel: string;
  readonly modelDigest: string;
  readonly sizeBytes: number;
  readonly baseModel: string;
  readonly sourceCreateJobId: string;
  readonly actorUserId: string;
  readonly selectedContainerId: string;
  readonly verifiedAt: string;
}

export interface ModelfileDeploymentRepository {
  recordVerified(deployment: StoredModelfileDeployment): StoredModelfileDeployment;
  findBySourceCreateJobId(sourceCreateJobId: string): StoredModelfileDeployment | null;
  listForRevision(revisionId: string): readonly StoredModelfileDeployment[];
  listForModelfile(modelfileId: string): readonly StoredModelfileDeployment[];
  latestForTargetModel(targetId: string, outputModel: string): StoredModelfileDeployment | null;
}
