import assert from 'node:assert/strict';
import test from 'node:test';
import { AuditService } from '../dist/audit.js';
import {
  ModelfileDeployPlanError,
  ModelfileDeployPlanService,
} from '../dist/modelfile-deploy-plan.js';

const REVISION_SHA = 'a'.repeat(64);
const BASE_DIGEST = 'b'.repeat(64);
const RAW = [
  'FROM base:latest',
  'SYSTEM """secret system text"""',
  'TEMPLATE """secret template text"""',
  'PARAMETER temperature 0.7',
  'MESSAGE user secret message text',
  'LICENSE """secret license text"""',
  'RENDERER qwen3.5',
  'PARSER qwen3.5',
  '',
].join('\n');

function artifact() {
  return {
    id: 'modelfile-1', displayName: 'Source', description: null,
    currentRevisionId: 'revision-1', createdByUserId: 'user-1', updatedByUserId: 'user-1',
    createdAt: '2026-08-10T00:00:00.000Z', updatedAt: '2026-08-10T00:00:00.000Z',
  };
}
function revision(rawText = RAW) {
  return {
    id: 'revision-1', modelfileId: 'modelfile-1', revisionNumber: 1, parentRevisionId: null,
    rawText, contentSha256: REVISION_SHA, sourceKind: 'manual',
    importedTargetId: null, importedModel: null, importedDigest: null,
    createdByUserId: 'user-1', createdAt: '2026-08-10T00:00:00.000Z',
  };
}
function target(container = 'container-1') {
  return {
    id: 'target-1', hostId: 'host-1', displayName: 'Ollama', selectedContainerId: container,
    containerNameOverride: null, enabled: true,
    createdAt: '2026-08-10T00:00:00.000Z', updatedAt: '2026-08-10T00:00:00.000Z',
  };
}
function health(versionMatch = true) {
  return {
    targetId: 'target-1', status: versionMatch ? 'healthy' : 'degraded',
    container: { running: true },
    ollama: { cliVersion: '0.12.0', apiReachable: true, apiVersion: '0.12.0', versionMatch },
    transport: { mode: 'published-binding' },
  };
}
function inventory(models = ['base:latest']) {
  return {
    targetId: 'target-1', transport: { mode: 'published-binding' }, running: [],
    installed: models.map((model, index) => ({
      name: model, model, modifiedAt: null, sizeBytes: index === 0 ? 1 : 2_048,
      digest: index === 0 ? BASE_DIGEST : String(index).padStart(64, 'c').slice(0, 64),
      details: { format: 'gguf', family: null, families: [], parameterSize: null, quantizationLevel: null },
    })),
  };
}

function fixture(options = {}) {
  const storedPlans = [];
  const audits = [];
  let targetReads = 0;
  let healthReads = 0;
  let inventoryReads = 0;
  const service = new ModelfileDeployPlanService(
    {
      findById: () => options.artifact ?? artifact(),
      findRevisionById: () => options.revision ?? revision(),
      list: () => [], listRevisions: () => [],
      createWithInitialRevision: () => false, appendRevision: () => false,
    },
    {
      create: (plan) => { storedPlans.push(plan); return true; },
      findById: () => null,
      consumeIfUsable: () => null,
    },
    {
      findById: () => {
        targetReads += 1;
        if (options.rebind && targetReads > 1) return target('container-2');
        return options.target ?? target();
      },
      findByHostId: () => [], saveSelection: () => {},
    },
    { read: async () => { healthReads += 1; return options.health ?? health(); } },
    { read: async () => { inventoryReads += 1; return options.inventory ?? inventory(); } },
    new AuditService({
      append: (event) => audits.push(event),
      listByTarget: () => [],
    }, () => new Date('2026-08-10T00:00:00.000Z')),
    () => new Date('2026-08-10T00:00:00.000Z'),
  );
  return { service, storedPlans, audits, counters: () => ({ targetReads, healthReads, inventoryReads }) };
}

async function errorCode(promise) {
  try { await promise; }
  catch (error) {
    assert(error instanceof ModelfileDeployPlanError);
    return error.code;
  }
  assert.fail('Expected deploy plan error.');
}

test('creates a five-minute single-use authority without persisting sensitive Modelfile content', async () => {
  const { service, storedPlans, audits } = fixture();
  const view = await service.create('target-1', 'modelfile-1', 'revision-1', 'user-1', { outputModel: 'custom' });
  assert.equal(view.outputModel, 'custom:latest');
  assert.equal(view.baseModel, 'base:latest');
  assert.equal(view.replacement, null);
  assert.equal(view.apiVersion, '0.12.0');
  assert.equal(view.expiresAt, '2026-08-10T00:05:00.000Z');
  assert.equal(view.confirmationToken.length > 30, true);
  assert.deepEqual(view.expectedFields, ['from', 'template', 'system', 'license', 'parameters', 'messages', 'renderer', 'parser']);

  assert.equal(storedPlans.length, 1);
  const persisted = storedPlans[0];
  assert.equal(persisted.confirmationTokenHash.length, 64);
  assert.notEqual(persisted.confirmationTokenHash, view.confirmationToken);
  assert.equal(persisted.revisionSha256, REVISION_SHA);
  assert.equal(persisted.selectedContainerId, 'container-1');
  assert.equal(persisted.payloadSha256.length, 64);
  assert.equal('rawText' in persisted, false);
  assert.equal('payload' in persisted, false);

  const auditText = audits.map((event) => event.parametersRedactedJson).join('\n');
  for (const secret of ['secret system text', 'secret template text', 'secret message text', 'secret license text']) {
    assert.equal(auditText.includes(secret), false);
  }
  assert.equal(auditText.includes('revision-1'), true);
  assert.equal(auditText.includes('custom:latest'), true);
});

test('creates an explicit replacement authority bound to the observed destination digest and size', async () => {
  const destinationInventory = inventory(['base:latest', 'custom:latest']);
  const existing = destinationInventory.installed[1];
  const { service, storedPlans, audits } = fixture({ inventory: destinationInventory });
  const view = await service.create('target-1', 'modelfile-1', 'revision-1', 'user-1', {
    outputModel: 'custom',
    replaceExisting: true,
  });

  assert.deepEqual(view.replacement, {
    existingDigest: existing.digest,
    existingSizeBytes: existing.sizeBytes,
  });
  assert.equal(storedPlans.length, 1);
  assert.equal(storedPlans[0].payloadSha256.length, 64);
  const audit = JSON.parse(audits[0].parametersRedactedJson);
  assert.equal(audit.replacement.existingDigest, existing.digest);
  assert.equal(audit.replacement.existingSizeBytes, existing.sizeBytes);
});

test('rejects unsupported source before any remote read', async () => {
  const { service, counters } = fixture({ revision: revision('FROM ./model.gguf\n') });
  assert.equal(
    await errorCode(service.create('target-1', 'modelfile-1', 'revision-1', 'user-1', { outputModel: 'custom' })),
    'DEPLOY_FROM_UNSUPPORTED',
  );
  assert.deepEqual(counters(), { targetReads: 0, healthReads: 0, inventoryReads: 0 });
});

test('requires healthy version parity, installed base, explicit replacement intent and stable container binding', async () => {
  assert.equal(
    await errorCode(fixture({ health: health(false) }).service.create('target-1', 'modelfile-1', 'revision-1', 'user-1', { outputModel: 'custom' })),
    'OLLAMA_VERSION_MISMATCH',
  );
  assert.equal(
    await errorCode(fixture({ inventory: inventory(['other:latest']) }).service.create('target-1', 'modelfile-1', 'revision-1', 'user-1', { outputModel: 'custom' })),
    'DEPLOY_BASE_MODEL_NOT_INSTALLED',
  );
  assert.equal(
    await errorCode(fixture({ inventory: inventory(['base:latest', 'custom:latest']) }).service.create('target-1', 'modelfile-1', 'revision-1', 'user-1', { outputModel: 'custom' })),
    'DEPLOY_DESTINATION_EXISTS',
  );
  assert.equal(
    await errorCode(fixture().service.create('target-1', 'modelfile-1', 'revision-1', 'user-1', { outputModel: 'custom', replaceExisting: true })),
    'DEPLOY_REPLACE_TARGET_MISSING',
  );
  assert.equal(
    await errorCode(fixture({ rebind: true }).service.create('target-1', 'modelfile-1', 'revision-1', 'user-1', { outputModel: 'custom' })),
    'TARGET_BINDING_CHANGED',
  );
});

test('revision must belong to the selected local Modelfile', async () => {
  const badRevision = { ...revision(), modelfileId: 'other-modelfile' };
  const { service, counters } = fixture({ revision: badRevision });
  assert.equal(
    await errorCode(service.create('target-1', 'modelfile-1', 'revision-1', 'user-1', { outputModel: 'custom' })),
    'MODEFILE_REVISION_NOT_FOUND',
  );
  assert.deepEqual(counters(), { targetReads: 0, healthReads: 0, inventoryReads: 0 });
});