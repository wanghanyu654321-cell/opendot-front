import { readFileSync } from 'node:fs';
import { MemoryPerformanceStore, type PerformanceStore } from './performance-store.js';
import { PERFORMANCE_MIGRATION_PATH, PERFORMANCE_MIGRATION_SQL } from './performance-migration.js';
import { createPostgresPerformanceStore, migratePerformance, type SqlClient } from './performance-postgres.js';
import { createMemoryBindingStore, createPostgresBindingStore, type WecomBotBindingStore } from './directory-store.js';
import { loadPgPool } from './pg-pool.js';
import { schemaVersion } from './schema-migrations.js';
import { resolveBusinessDatabaseUrl, type CredentialDeps } from './credential-file.js';

/** Set this to the legacy-shared-pg connection string. Unset uses the in-memory store. */
export const FRONT_CLAW_DATABASE_URL = 'FRONT_CLAW_DATABASE_URL';
/** Optional hostname override, for example the Postgres container name legacy-shared-pg. */
export const FRONT_CLAW_DATABASE_HOST = 'FRONT_CLAW_DATABASE_HOST';

export interface OpenedPerformanceStore {
  store: PerformanceStore;
  bindings: WecomBotBindingStore;
  driver: 'memory' | 'postgres';
  /** M08：打开时探测到的 front_claw_perf 版本（内存 = 0）。 */
  schemaVersion?: number;
  close(): Promise<void>;
}

/** Replace only the URL host. The secret stays in the original string and is not logged. */
export function applyDatabaseHost(url: string, host: string | undefined): string {
  const name = host?.trim() ?? '';
  if (!name) return url;
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/.test(name)) throw Error('FRONT_CLAW_DATABASE_UNAVAILABLE_HOST');
  let parsed: URL;
  try { parsed = new URL(url); }
  catch { throw Error('FRONT_CLAW_DATABASE_UNAVAILABLE_HOST'); }
  parsed.hostname = name;
  return parsed.href;
}

/** Prefer the checked-in migration file, which startup applies as-is. */
export function readPerformanceMigration(): string {
  try {
    return readFileSync(PERFORMANCE_MIGRATION_PATH, 'utf8');
  } catch {
    return PERFORMANCE_MIGRATION_SQL;
  }
}

/**
 * Startup entry for the performance store.
 * When FRONT_CLAW_DATABASE_URL is set, opens Postgres and applies migration 007.
 * When it is missing or blank, returns the in-memory store.
 */
export function maskedDatabaseFailure(error: unknown): Error {
  const code = error && typeof error === 'object' && 'code' in error && typeof (error as { code?: unknown }).code === 'string' ? (error as { code: string }).code : '';
  const safe = /^[A-Z0-9_]{1,48}$/.test(code) ? code : 'UNKNOWN';
  return Error(`FRONT_CLAW_DATABASE_UNAVAILABLE_${safe}`);
}

export async function openPerformanceStore(env: Record<string, string | undefined> = process.env, options: { requirePostgres?: boolean; credentials?: CredentialDeps } = {}): Promise<OpenedPerformanceStore> {
  // R2（D46）：优先仓库外凭据文件（启动读一次）；生产拒绝直接 env 连接串。
  const resolved = resolveBusinessDatabaseUrl(env, options.credentials);
  const rawUrl = resolved.url;
  if (!rawUrl && options.requirePostgres) throw Error('FRONT_CLAW_DATABASE_UNAVAILABLE_URL');
  if (!rawUrl) return { store: new MemoryPerformanceStore(), bindings: createMemoryBindingStore(), driver: 'memory', async close() {} };
  const url = applyDatabaseHost(rawUrl, env[FRONT_CLAW_DATABASE_HOST]);
  // ESM `import('pg')` puts Pool on default. CJS `require('pg')` puts Pool on the module. Accept either.
  const Pool = await loadPgPool();
  const pool = new Pool({ connectionString: url });
  const client: SqlClient = {
    async query<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]) {
      const result = await pool.query(sql, params ? [...params] : []);
      return { rows: result.rows as T[] };
    },
    async transaction<T>(work: (query: SqlClient['query']) => Promise<T>): Promise<T> {
      const held = await pool.connect();
      const query: SqlClient['query'] = async <Row = Record<string, unknown>>(sql: string, params?: readonly unknown[]) => {
        const result = await held.query(sql, params ? [...params] : []);
        return { rows: result.rows as Row[] };
      };
      try {
        await held.query('BEGIN');
        const result = await work(query);
        await held.query('COMMIT');
        return result;
      } catch (error) {
        await held.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        held.release();
      }
    },
  };
  let version: number;
  try {
    // R2（D46）：凭据文件 = 最小权限业务账号，不跑任何 DDL，只核对 schema 版本（建表/升级由迁移账号显式执行）。
    if (resolved.source !== 'file') await migratePerformance(client, readPerformanceMigration());
    // M08：只探测，不自动升到 008（生产迁移显式执行）。
    version = await schemaVersion(client.query.bind(client));
    if (resolved.source === 'file' && version < 7) throw Object.assign(Error('schema_too_old'), { code: 'SCHEMA_TOO_OLD' });
  } catch (error) {
    await pool.end().catch(() => {});
    throw maskedDatabaseFailure(error);
  }
  let ended: Promise<void> | undefined;
  return {
    store: createPostgresPerformanceStore(client, { deliveryColumns: version >= 8 }),
    schemaVersion: version,
    bindings: createPostgresBindingStore(client),
    driver: 'postgres',
    async close() { await (ended ??= pool.end()); },
  };
}
