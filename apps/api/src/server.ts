import { pathToFileURL } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import type { ApiHealthResponse } from '@orc/core';
import {
  applyMigrations,
  getSchemaVersion,
  openDatabase,
  pingDatabase,
} from '@orc/db';

export interface BuildServerOptions {
  readonly databasePath?: string;
}

export function buildServer(options: BuildServerOptions = {}): FastifyInstance {
  const database = openDatabase(options.databasePath ?? ':memory:');
  applyMigrations(database);

  const app = Fastify({ logger: false });

  app.get('/api/v1/health', async (): Promise<ApiHealthResponse> => {
    if (!pingDatabase(database)) {
      throw new Error('Database health check failed');
    }

    return {
      status: 'ok',
      service: 'ollama-remote-control-api',
      version: '0.0.0',
      database: {
        status: 'ok',
        schemaVersion: getSchemaVersion(database),
      },
    };
  });

  app.addHook('onClose', async () => {
    database.close();
  });

  return app;
}

async function main(): Promise<void> {
  const app = buildServer({
    databasePath: process.env.ORC_DATABASE_PATH ?? '/data/ollama-remote-control.sqlite',
  });
  const port = Number(process.env.PORT ?? 3000);
  const host = process.env.HOST ?? '0.0.0.0';
  await app.listen({ host, port });
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  await main();
}
