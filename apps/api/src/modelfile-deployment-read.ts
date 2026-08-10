import type {
  ModelfileDeploymentRepository,
  StoredModelfileDeployment,
} from '@orc/core/modelfile-deployments';
import type { ModelfileRepository } from '@orc/core/modelfiles';
import type { OllamaTargetRepository } from '@orc/core';

const MODEL_MAX_LENGTH = 512;

export class ModelfileDeploymentReadError extends Error {
  constructor(
    readonly code: string,
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

export interface ModelfileDeploymentView extends StoredModelfileDeployment {
  readonly libraryCurrentRevisionId: string;
  readonly producingRevisionIsLibraryCurrent: boolean;
}

function requiredModel(value: unknown): string {
  if (typeof value !== 'string') {
    throw new ModelfileDeploymentReadError('MODEL_REQUIRED', 400, 'Model is required.');
  }
  const model = value.trim();
  if (!model || model.length > MODEL_MAX_LENGTH) {
    throw new ModelfileDeploymentReadError('MODEL_INVALID', 400, 'Model must be between 1 and 512 characters.');
  }
  return model;
}

export class ModelfileDeploymentReadService {
  constructor(
    private readonly modelfiles: ModelfileRepository,
    private readonly deployments: ModelfileDeploymentRepository,
    private readonly targets: OllamaTargetRepository,
  ) {}

  forModelfile(modelfileId: string): readonly ModelfileDeploymentView[] {
    const artifact = this.modelfiles.findArtifactById(modelfileId);
    if (!artifact) {
      throw new ModelfileDeploymentReadError('MODELFILE_NOT_FOUND', 404, 'Modelfile was not found.');
    }
    return this.deployments.listForModelfile(artifact.id).map((deployment) => this.view(deployment, artifact.currentRevisionId));
  }

  forRevision(modelfileId: string, revisionId: string): readonly ModelfileDeploymentView[] {
    const artifact = this.modelfiles.findArtifactById(modelfileId);
    if (!artifact) {
      throw new ModelfileDeploymentReadError('MODELFILE_NOT_FOUND', 404, 'Modelfile was not found.');
    }
    const revision = this.modelfiles.findRevisionById(revisionId);
    if (!revision || revision.modelfileId !== artifact.id) {
      throw new ModelfileDeploymentReadError('MODELFILE_REVISION_NOT_FOUND', 404, 'Modelfile revision was not found.');
    }
    return this.deployments.listForRevision(revision.id).map((deployment) => this.view(deployment, artifact.currentRevisionId));
  }

  currentProducing(targetId: string, modelInput: unknown): ModelfileDeploymentView | null {
    const target = this.targets.findById(targetId);
    if (!target || !target.enabled) {
      throw new ModelfileDeploymentReadError('TARGET_NOT_FOUND', 404, 'Ollama target was not found or is disabled.');
    }
    const model = requiredModel(modelInput);
    const deployment = this.deployments.latestForTargetModel(target.id, model);
    if (!deployment) return null;
    const artifact = this.modelfiles.findArtifactById(deployment.modelfileId);
    if (!artifact) {
      throw new ModelfileDeploymentReadError(
        'DEPLOYMENT_EVIDENCE_INVALID',
        409,
        'Verified deployment references a missing Modelfile artifact.',
      );
    }
    return this.view(deployment, artifact.currentRevisionId);
  }

  private view(deployment: StoredModelfileDeployment, libraryCurrentRevisionId: string): ModelfileDeploymentView {
    return {
      ...deployment,
      libraryCurrentRevisionId,
      producingRevisionIsLibraryCurrent: deployment.revisionId === libraryCurrentRevisionId,
    };
  }
}
