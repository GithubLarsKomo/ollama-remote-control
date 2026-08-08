import { pathToFileURL } from 'node:url';
import { buildServer } from './server.js';
import { registerWebAssets } from './web-assets.js';

export function buildProductionServer(environment: NodeJS.ProcessEnv = process.env) {
  const app = buildServer({
    databasePath: environment.ORC_DATABASE_PATH ?? '/data/ollama-remote-control.sqlite',
    environment,
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
