export type ModelfileSourceKind = 'manual' | 'installed-model-import';

export interface StoredModelfileArtifact {
  readonly id: string;
  readonly displayName: string;
  readonly description: string | null;
  readonly currentRevisionId: string;
  readonly createdByUserId: string;
  readonly updatedByUserId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface StoredModelfileRevision {
  readonly id: string;
  readonly modelfileId: string;
  readonly revisionNumber: number;
  readonly parentRevisionId: string | null;
  readonly rawText: string;
  readonly contentSha256: string;
  readonly sourceKind: ModelfileSourceKind;
  readonly importedTargetId: string | null;
  readonly importedModel: string | null;
  readonly importedDigest: string | null;
  readonly createdByUserId: string;
  readonly createdAt: string;
}

export interface ModelfileRepository {
  createWithInitialRevision(
    artifact: StoredModelfileArtifact,
    revision: StoredModelfileRevision,
  ): boolean;

  appendRevision(
    modelfileId: string,
    expectedCurrentRevisionId: string,
    revision: StoredModelfileRevision,
    updatedAt: string,
    updatedByUserId: string,
  ): boolean;

  findById(modelfileId: string): StoredModelfileArtifact | null;
  list(): readonly StoredModelfileArtifact[];
  findRevisionById(revisionId: string): StoredModelfileRevision | null;
  listRevisions(modelfileId: string): readonly StoredModelfileRevision[];
}
