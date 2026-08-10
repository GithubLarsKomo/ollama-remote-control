import { pathToFileURL } from 'node:url';
import { registerAuditFeature } from './audit-feature.js';
import { registerManualRollbackFeature } from './manual-rollback-feature.js';
import { registerModelCreateFeature } from './model-create-feature.js';
import { registerModelSmokeFeature } from './model-smoke-feature.js';
import { registerModelSourceFeature } from './model-source-feature.js';
import { registerModelUnloadFeature } from './model-unload-feature.js';
import { registerModelfileDeploymentFeature } from './modelfile-deployment-feature.js';
import { registerModelfilePortabilityFeature } from './modelfile-portability-feature.js';
import { registerModelfileValidationFeature } from './modelfile-validation-feature.js';
import { buildServer } from './server.js';
import { registerWebAssets } from './web-assets.js';

export function buildProductionServer(environment: NodeJS.ProcessEnv = process.env) {
  const databasePath = environment.ORC_DATABASE_PATH ?? '/data/ollama-remote-control.sqlite';
  const app = buildServer({
    databasePath,
    environment,
  });
  registerAuditFeature(app, {
    databasePath,
  });
  registerManualRollbackFeature(app, {
    databasePath,
    environment,
  });
  registerModelCreateFeature(app, {
    databasePath,
    environment,
  });
  registerModelSmokeFeature(app, {
    databasePath,
    environment,
  });
  registerModelSourceFeature(app, {
    databasePath,
    environment,
  });
  registerModelUnloadFeature(app, {
    databasePath,
    environment,
  });
  registerModelfileDeploymentFeature(app, {
    databasePath,
  });
  registerModelfilePortabilityFeature(app, {
    databasePath,
  });
  registerModelfileValidationFeature(app, {
    databasePath,
  });
  registerWebAssets(app, environment.ORC_WEB_DIST_PATH ?? null);
  return app;
}

async function main(): Promise<void> {
  const app = buildProductionServer(process.env);
  await app.listen({
    host: process.env.HOST ?? '0.0.0.0',
    port: Number(process.env.PORT ?? 3000),
  });
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) await main();
