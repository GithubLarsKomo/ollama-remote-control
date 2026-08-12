import { describe, expect, it } from 'vitest';
import { summarizeModelfileLibraryEvidence } from './ModelfileLibrarySummaryPanel.js';
import type { ModelfileDeploymentView, ModelfileValidationView } from './modelfile-lifecycle.js';

const validation = {
  modelfileId: 'mf-1',
  revisionId: 'rev-2',
  revisionSha256: 'a'.repeat(64),
  local: {
    state: 'passed',
    revisionSha256: 'a'.repeat(64),
    baseModel: 'llama3.2:latest',
    expectedFields: ['model'],
    directiveCounts: { FROM: 1 },
  },
  preflight: { state: 'not-requested' },
  targetVerification: { state: 'not-requested' },
} satisfies ModelfileValidationView;

function deployment(id: string, verifiedAt: string, targetId: string, outputModel: string): ModelfileDeploymentView {
  return {
    id,
    targetId,
    modelfileId: 'mf-1',
    revisionId: 'rev-2',
    revisionSha256: 'a'.repeat(64),
    outputModel,
    modelDigest: 'sha256:' + 'b'.repeat(64),
    sizeBytes: 42,
    baseModel: 'llama3.2:latest',
    sourceCreateJobId: `job-${id}`,
    selectedContainerId: 'container-1',
    verifiedAt,
    libraryCurrentRevisionId: 'rev-2',
    producingRevisionIsLibraryCurrent: true,
  };
}

describe('Modelfile library evidence summary', () => {
  it('uses local validation and the most recent verified deployment only', () => {
    const summary = summarizeModelfileLibraryEvidence(validation, [
      deployment('old', '2026-08-10T10:00:00.000Z', 'target-old', 'older:model'),
      deployment('new', '2026-08-11T10:00:00.000Z', 'target-current', 'current:model'),
    ]);

    expect(summary).toEqual({
      validationLabel: 'Passed',
      lastDeploymentAt: '2026-08-11T10:00:00.000Z',
      deploymentTargetId: 'target-current',
      deploymentModel: 'current:model',
    });
  });

  it('keeps absence of deployment evidence explicit', () => {
    expect(summarizeModelfileLibraryEvidence(validation, [])).toEqual({
      validationLabel: 'Passed',
      lastDeploymentAt: null,
      deploymentTargetId: null,
      deploymentModel: null,
    });
  });
});
