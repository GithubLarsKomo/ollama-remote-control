import assert from 'node:assert/strict';
import test from 'node:test';
import { buildModelProvenanceGraph } from '../dist/model-provenance-graph.js';

const DIGEST = 'd'.repeat(64);
const REVISION_SHA = 'a'.repeat(64);

function store() {
  return {
    listImports(targetId, digest) {
      assert.equal(targetId, 'target-1');
      assert.equal(digest, DIGEST);
      return [
        {
          revisionId: 'revision-import', modelfileId: 'artifact-import', revisionNumber: 1,
          revisionSha256: 'b'.repeat(64), displayName: 'Imported snapshot',
          importedModel: 'custom:latest', importedDigest: DIGEST,
          createdAt: '2026-08-10T01:00:00.000Z',
        },
        {
          revisionId: 'revision-wrong-model', modelfileId: 'artifact-wrong', revisionNumber: 1,
          revisionSha256: 'c'.repeat(64), displayName: 'Wrong model',
          importedModel: 'other:latest', importedDigest: DIGEST,
          createdAt: '2026-08-10T01:01:00.000Z',
        },
      ];
    },
    listSuccessfulCreates(targetId) {
      assert.equal(targetId, 'target-1');
      return [
        {
          jobId: 'job-good',
          finishedAt: '2026-08-10T01:10:00.000Z',
          resultJson: JSON.stringify({
            verified: true,
            outputModel: 'custom',
            baseModel: 'hf.co/example/base:Q4_K_M',
            digest: DIGEST,
            modelfileId: 'artifact-create',
            revisionId: 'revision-create',
            revisionSha256: REVISION_SHA,
            system: 'SECRET-MUST-NOT-LEAK',
          }),
        },
        {
          jobId: 'job-stale-digest',
          finishedAt: '2026-08-10T01:11:00.000Z',
          resultJson: JSON.stringify({
            verified: true,
            outputModel: 'custom:latest',
            baseModel: 'base:latest',
            digest: 'e'.repeat(64),
            modelfileId: 'artifact-create',
            revisionId: 'revision-create',
            revisionSha256: REVISION_SHA,
          }),
        },
        {
          jobId: 'job-unverified',
          finishedAt: '2026-08-10T01:12:00.000Z',
          resultJson: JSON.stringify({
            verified: false,
            outputModel: 'custom:latest',
            baseModel: 'base:latest',
            digest: DIGEST,
            modelfileId: 'artifact-create',
            revisionId: 'revision-create',
            revisionSha256: REVISION_SHA,
          }),
        },
      ];
    },
    findRevision(revisionId, modelfileId, revisionSha256) {
      if (revisionId !== 'revision-create' || modelfileId !== 'artifact-create' || revisionSha256 !== REVISION_SHA) return null;
      return {
        revisionId,
        modelfileId,
        revisionNumber: 3,
        revisionSha256,
        displayName: 'Create source',
      };
    },
  };
}

test('graph binds import/create evidence to current target model and digest only', () => {
  const graph = buildModelProvenanceGraph(store(), {
    targetId: 'target-1',
    model: 'custom:latest',
    digest: DIGEST,
  });

  assert.equal(graph.currentNodeId, `installed:${DIGEST}`);
  assert.deepEqual(graph.edges.map((edge) => ({ relation: edge.relation, evidence: edge.evidence, jobId: edge.jobId })), [
    { relation: 'captured-as-revision', evidence: 'persisted-import', jobId: null },
    { relation: 'created-from-revision', evidence: 'verified-create', jobId: 'job-good' },
    { relation: 'base-model', evidence: 'verified-create', jobId: 'job-good' },
  ]);
  assert.equal(graph.nodes.some((node) => node.kind === 'modelfile-revision' && node.revisionId === 'revision-wrong-model'), false);
  assert.equal(graph.nodes.some((node) => node.kind === 'modelfile-revision' && node.revisionId === 'revision-import'), true);
  assert.equal(graph.nodes.some((node) => node.kind === 'modelfile-revision' && node.revisionId === 'revision-create' && node.revisionSha256 === REVISION_SHA), true);
  assert.equal(graph.nodes.some((node) => node.kind === 'model-reference' && node.model === 'hf.co/example/base:Q4_K_M'), true);
  assert.equal(JSON.stringify(graph).includes('SECRET-MUST-NOT-LEAK'), false);
  assert.equal(JSON.stringify(graph).includes('job-stale-digest'), false);
  assert.equal(JSON.stringify(graph).includes('job-unverified'), false);
});

test('invalid current digest is rejected rather than producing weak provenance', () => {
  assert.throws(
    () => buildModelProvenanceGraph(store(), { targetId: 'target-1', model: 'custom:latest', digest: 'not-a-digest' }),
    /digest/u,
  );
});
