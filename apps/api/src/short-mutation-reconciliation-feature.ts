import type { FastifyInstance } from 'fastify';
import {
  applyMigrations,
  openDatabase,
  SqliteAuditRepository,
  SqliteHostOnboardingRepository,
  SqliteJobRepository,
  SqliteOllamaTargetRepository,
  SqliteSshCredentialRepository,
} from '@orc/db';
import { inspectDockerContainer } from '@orc/docker';
import {
  loadConfiguredMasterKey,
  SecretCipher,
  type MasterKeyEnvironment,
} from '@orc/security';
import { execPrivateKey } from '@orc/ssh';
import { AuditService } from './audit.js';
import { JobService } from './jobs.js';
import { OllamaModelInventoryService } from './ollama-models.js';
import {
  ShortMutationReconciliationService,
  type ContainerObserver,
} from './short-mutation-reconciliation.js';

export interface RegisterShortMutationReconciliationOptions {
  readonly databasePath: string;
  readonly now?: () => Date;
  readonly environment?: MasterKeyEnvironment;
}

export function registerShortMutationReconciliationFeature(
  app: FastifyInstance,
  options: RegisterShortMutationReconciliationOptions,
): void {
  if (!options.databasePath || options.databasePath === ':memory:') {
    throw new Error('Short-mutation reconciliation requires the persistent SQLite database path shared with the core server.');
  }

  const database = openDatabase(options.databasePath);
  applyMigrations(database);
  const now = options.now ?? (() => new Date());
  const hosts = new SqliteHostOnboardingRepository(database);
  const credentials = new SqliteSshCredentialRepository(database);
  const targets = new SqliteOllamaTargetRepository(database);
  const masterKey = loadConfiguredMasterKey(options.environment ?? process.env);
  const jobs = new JobService(new SqliteJobRepository(database), now);
  const audit = new AuditService(new SqliteAuditRepository(database), now);
  const inventory = new OllamaModelInventoryService(hosts, credentials, targets, masterKey);

  const containers: ContainerObserver = {
    async observe(targetId, expectedContainerId) {
      if (!masterKey) throw new Error('External master key is required.');
      const target = targets.findById(targetId);
      if (!target?.enabled || target.selectedContainerId !== expectedContainerId) {
        throw new Error('Target binding is unavailable or changed.');
      }
      const host = hosts.findHostById(target.hostId);
      if (!host?.enabled) throw new Error('Host is unavailable.');
      const credential = credentials.findByHostId(host.id);
      if (!credential) throw new Error('SSH credential is unavailable.');
      const privateKey = new SecretCipher(masterKey).decrypt(
        { credentialId: credential.id, hostId: host.id },
        credential.encryptedPrivateKey,
      );
      const executor = {
        exec: (argv: readonly string[]) => execPrivateKey(
          {
            hostname: host.hostname,
            port: host.port,
            username: host.username,
            privateKey,
            expectedFingerprint: host.hostKeyFingerprint,
          },
          argv,
          { timeoutMs: 10_000, maxOutputBytes: 2 * 1024 * 1024 },
        ),
      };
      return inspectDockerContainer(executor, expectedContainerId);
    },
  };

  const reconciliation = new ShortMutationReconciliationService(
    jobs,
    audit,
    targets,
    inventory,
    containers,
  );

  app.addHook('onReady', async () => {
    await reconciliation.reconcile();
  });

  app.addHook('onClose', async () => {
    database.close();
  });
}
