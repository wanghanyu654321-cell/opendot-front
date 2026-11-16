import { pathToFileURL } from 'node:url';
import { createDatabasePool, sqlClient } from './database.js';
import { provisionAccounts } from './provision.js';
import { migrateUp, LATEST_SCHEMA_VERSION } from '../role-eval/schema-migrations.js';
import type { SqlClient } from '../role-eval/performance-postgres.js';
import { CONSUMER_LEASE_KEY } from '../opendot/consumer-lease.js';
import { parseLeaseRecord } from '../role-eval/fencing.js';
import { parsePilotEnvironment, seedPilot } from './pilot.js';
import { createPostgresPerformanceStore } from '../role-eval/performance-postgres.js';
import { createPostgresBindingStore } from '../role-eval/directory-store.js';

export const CONSUMER_EXPIRY_GRACE_MS = 10_000;

type Environment = Readonly<Record<string, string | undefined>>;
interface AdminDeps {
  open(url: string): Promise<{ client: SqlClient; close(): Promise<void> }>;
  migrate: typeof migrateUp;
}
const defaults: AdminDeps = {
  async open(url) {
    const pool = createDatabasePool(url, 1);
    return { client: sqlClient(pool), close: () => pool.end() };
  },
  migrate: migrateUp,
};

/** Production maintenance never imports synthetic identities or offline message injection. */
export async function runAdmin(step: string, env: Environment, deps: AdminDeps = defaults) {
  if (!['migrate', 'verify-consumer', 'seed-pilot'].includes(step)) throw Error('unknown_admin_step');
  const pilot = step === 'seed-pilot' ? parsePilotEnvironment(env) : undefined;
  if (!env.DATABASE_ADMIN_URL) throw Error('admin_database_required');
  const db = await deps.open(env.DATABASE_ADMIN_URL);
  try {
    if (pilot) {
      await db.client.transaction(async query => {
        // Serialize explicit initializers; nested store transactions reuse this connection.
        await query('SELECT pg_advisory_xact_lock($1, $2)', [70861, 1]);
        const client: SqlClient = { query, transaction: work => work(query) };
        await seedPilot({ store: createPostgresPerformanceStore(client, { deliveryColumns: true }), bindings: createPostgresBindingStore(client) }, pilot);
      });
      return { pilotSeeded: true };
    }
    if (step === 'migrate') {
      const result = await deps.migrate(db.client, { apply: true });
      if (result.to !== LATEST_SCHEMA_VERSION) throw Error('schema_not_latest');
      await db.client.transaction(query => provisionAccounts(query, env));
      return { schemaVersion: result.to, accountsProvisioned: true };
    }
    const { rows } = await db.client.query<{ value: string }>('SELECT value FROM front_claw_perf.performance_config WHERE key=$1', [CONSUMER_LEASE_KEY]);
    if (rows.length) {
      const record = parseLeaseRecord(rows[0]!.value);
      if (!record || (record.owner !== null && record.until + CONSUMER_EXPIRY_GRACE_MS > Date.now())) throw Error('consumer_lease_not_released');
    }
    return { consumerAbsent: true };
  } finally { await db.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runAdmin(process.argv[2] ?? '', process.env).then(result => process.stdout.write(JSON.stringify(result) + '\n')).catch(() => {
    process.stderr.write('admin_step_failed: verify database access, schema, account policy and consumer lease\n');
    process.exitCode = 2;
  });
}
