import pg from 'pg';
import { createPostgresPerformanceStore, type SqlClient } from '../role-eval/performance-postgres.js';
import { createPostgresBindingStore } from '../role-eval/directory-store.js';
import { schemaVersion } from '../role-eval/schema-migrations.js';
import type { OpenedPerformanceStore } from '../role-eval/performance-open.js';
import { createStandaloneLogger } from './diagnostics.js';

/** Idle backend failures discard that connection; later queries can open a replacement. */
export function createDatabasePool(databaseUrl: string, max = 4): pg.Pool {
  const pool = new pg.Pool({ connectionString: databaseUrl, max, connectionTimeoutMillis: 5000 });
  const logger = createStandaloneLogger();
  pool.on('error', error => logger.warn({ event: 'database_pool_error', error }));
  return pool;
}

export function sqlClient(pool: pg.Pool): SqlClient {
  return {
    async query<T>(sql: string, params?: readonly unknown[]) {
      return { rows: (await pool.query(sql, params ? [...params] : [])).rows as T[] };
    },
    async transaction<T>(work: (query: SqlClient['query']) => Promise<T>) {
      const connection = await pool.connect();
      const query: SqlClient['query'] = async <Row>(sql: string, params?: readonly unknown[]) => ({ rows: (await connection.query(sql, params ? [...params] : [])).rows as Row[] });
      try {
        await connection.query('BEGIN');
        const result = await work(query);
        await connection.query('COMMIT');
        return result;
      } catch (error) {
        await connection.query('ROLLBACK');
        throw error;
      } finally { connection.release(); }
    },
  };
}

/** No startup migrations: the runtime identity has no schema ownership. */
export async function openRuntimeDatabase(databaseUrl: string): Promise<OpenedPerformanceStore> {
  const pool = createDatabasePool(databaseUrl);
  const client = sqlClient(pool);
  try {
    const version = await schemaVersion(client.query);
    if (version !== 11) throw Error('schema_not_latest');
    return { driver: 'postgres', schemaVersion: version,
      store: createPostgresPerformanceStore(client, { deliveryColumns: true }),
      bindings: createPostgresBindingStore(client), close: () => pool.end() };
  } catch (error) { await pool.end(); throw error; }
}
