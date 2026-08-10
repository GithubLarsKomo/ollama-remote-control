export type ProvenanceSubjectKind = 'installed-model' | 'modelfile-revision';
export type ProvenanceSourceKind = 'huggingface' | 'ollama' | 'url' | 'unknown';
export type ProvenanceOrigin = 'observed' | 'operator';
export type ProvenanceConfidence = 'high' | 'medium' | 'low' | 'unknown';
export type ProvenanceNodeKind = 'installed-model' | 'model-reference' | 'modelfile-revision';
export type ProvenanceRelation =
  | 'base-model'
  | 'adapter'
  | 'quantized-from'
  | 'created-from-revision'
  | 'captured-as-revision';

export interface StoredProvenanceSource {
  readonly id: string;
  readonly subjectKind: ProvenanceSubjectKind;
  readonly targetId: string | null;
  readonly modelName: string | null;
  readonly modelDigest: string | null;
  readonly revisionId: string | null;
  readonly sourceKind: ProvenanceSourceKind;
  readonly sourceReference: string | null;
  readonly origin: ProvenanceOrigin;
  readonly confidence: ProvenanceConfidence;
  readonly actorUserId: string;
  readonly supersedesSourceId: string | null;
  readonly note: string | null;
  readonly createdAt: string;
}

export interface StoredProvenanceNode {
  readonly id: string;
  readonly identityKey: string;
  readonly kind: ProvenanceNodeKind;
  readonly targetId: string | null;
  readonly modelName: string | null;
  readonly modelDigest: string | null;
  readonly revisionId: string | null;
  readonly createdAt: string;
}

export interface StoredProvenanceEdge {
  readonly id: string;
  readonly fromNodeId: string;
  readonly toNodeId: string;
  readonly relation: ProvenanceRelation;
  readonly origin: ProvenanceOrigin;
  readonly confidence: ProvenanceConfidence;
  readonly sourceJobId: string | null;
  readonly actorUserId: string;
  readonly createdAt: string;
}

export interface ProvenanceRepository {
  appendSource(source: StoredProvenanceSource): void;
  findSourceById(sourceId: string): StoredProvenanceSource | null;
  listSourcesForInstalledModel(targetId: string, modelName: string, modelDigest: string): readonly StoredProvenanceSource[];
  listSourcesForRevision(revisionId: string): readonly StoredProvenanceSource[];
  ensureNode(node: StoredProvenanceNode): StoredProvenanceNode;
  findNodeByIdentityKey(identityKey: string): StoredProvenanceNode | null;
  appendEdge(edge: StoredProvenanceEdge): void;
  listEdgesForNode(nodeId: string): readonly StoredProvenanceEdge[];
}
