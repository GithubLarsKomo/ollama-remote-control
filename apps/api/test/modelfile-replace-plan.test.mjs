import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { AuditService } from '../dist/audit.js';
import { parseDeployConfirmationToken } from '../dist/deploy-confirmation-authority.js';
import { ModelfileDeployPlanError, ModelfileDeployPlanService } from '../dist/modelfile-deploy-plan.js';

const REVISION_SHA = 'a'.repeat(64);
const BASE_DIGEST = 'b'.repeat(64);
const DEST_DIGEST = 'c'.repeat(64);
const RAW = 'FROM base:latest\nPARAMETER temperature 0.7\n';

function model(name, digest, sizeBytes) {
  return { name, model: name, modifiedAt: null, sizeBytes, digest, details: { format: 'gguf', family: null, families: [], parameterSize: null, quantizationLevel: null } };
}
function fixture(installed) {
  const plans = [];
  const audits = [];
  let reads = 0;
  const service = new ModelfileDeployPlanService(
    {
      findById: () => ({ id: 'mf-1', displayName: 'MF', description: null, currentRevisionId: 'rev-1', createdByUserId: 'user-1', updatedByUserId: 'user-1', createdAt: '2026-08-12T00:00:00.000Z', updatedAt: '2026-08-12T00:00:00.000Z' }),
      findRevisionById: () => ({ id: 'rev-1', modelfileId: 'mf-1', revisionNumber: 1, parentRevisionId: null, rawText: RAW, contentSha256: REVISION_SHA, sourceKind: 'manual', importedTargetId: null, importedModel: null, importedDigest: null, createdByUserId: 'user-1', createdAt: '2026-08-12T00:00:00.000Z' }),
      list: () => [], listRevisions: () => [], createWithInitialRevision: () => false, appendRevision: () => false,
    },
    { create: (plan) => { plans.push(plan); return true; }, findById: () => null, consumeIfUsable: () => null },
    {
      findById: () => ({ id: 'target-1', hostId: 'host-1', displayName: 'Ollama', selectedContainerId: 'container-1', containerNameOverride: null, enabled: true, createdAt: '2026-08-12T00:00:00.000Z', updatedAt: '2026-08-12T00:00:00.000Z' }),
      findByHostId: () => [], saveSelection: () => {},
    },
    { read: async () => ({ targetId: 'target-1', status: 'healthy', container: { running: true }, ollama: { cliVersion: '0.32.5', apiReachable: true, apiVersion: '0.32.5', versionMatch: true }, transport: { mode: 'published-binding' } }) },
    { read: async () => { reads += 1; return { targetId: 'target-1', transport: { mode: 'published-binding' }, running: [], installed }; } },
    new AuditService({ append: (event) => audits.push(event), listByTarget: () => [] }, () => new Date('2026-08-12T00:00:00.000Z')),
    () => new Date('2026-08-12T00:00:00.000Z'),
  );
  return { service, plans, audits, reads: () => reads };
}
async function code(promise) {
  try { await promise; } catch (error) { assert(error instanceof ModelfileDeployPlanError); return error.code; }
  assert.fail('Expected plan error');
}

test('normal create still rejects an existing destination', async () => {
  const f = fixture([model('base:latest', BASE_DIGEST, 10), model('custom:latest', DEST_DIGEST, 42)]);
  assert.equal(await code(f.service.create('target-1', 'mf-1', 'rev-1', 'user-1', { outputModel: 'custom' })), 'DEPLOY_DESTINATION_EXISTS');
});

test('replace plan binds exact observed destination evidence into the hashed capability token', async () => {
  const f = fixture([model('base:latest', BASE_DIGEST, 10), model('custom:latest', DEST_DIGEST, 42)]);
  const view = await f.service.create('target-1', 'mf-1', 'rev-1', 'user-1', { outputModel: 'custom', replaceExisting: true });
  assert.equal(view.operation, 'replace');
  assert.deepEqual(view.existingDestination, { digest: DEST_DIGEST, sizeBytes: 42 });
  assert.equal(f.plans.length, 1);
  assert.equal(f.plans[0].confirmationTokenHash, createHash('sha256').update(view.confirmationToken, 'utf8').digest('hex'));
  assert.deepEqual(parseDeployConfirmationToken(view.confirmationToken), { replaceExisting: true, existingDestinationDigest: DEST_DIGEST, existingDestinationSizeBytes: 42 });
  const audit = JSON.parse(f.audits[0].parametersRedactedJson);
  assert.equal(audit.operation, 'replace');
  assert.equal(audit.existingDestinationDigest, DEST_DIGEST);
  assert.equal(audit.existingDestinationSizeBytes, 42);
});

test('replace intent fails closed when the destination is absent', async () => {
  const f = fixture([model('base:latest', BASE_DIGEST, 10)]);
  assert.equal(await code(f.service.create('target-1', 'mf-1', 'rev-1', 'user-1', { outputModel: 'custom', replaceExisting: true })), 'DEPLOY_REPLACEMENT_TARGET_MISSING');
});

test('replace intent must be a literal boolean before remote reads', async () => {
  const f = fixture([model('base:latest', BASE_DIGEST, 10)]);
  assert.equal(await code(f.service.create('target-1', 'mf-1', 'rev-1', 'user-1', { outputModel: 'custom', replaceExisting: 'true' })), 'DEPLOY_REPLACE_INTENT_INVALID');
  assert.equal(f.reads(), 0);
});
