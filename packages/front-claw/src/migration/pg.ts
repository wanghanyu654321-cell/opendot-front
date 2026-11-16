import { loadPgPool } from '../role-eval/pg-pool.js';
import type { SqlClient } from '../role-eval/performance-postgres.js';

export interface OpenedSql { client: SqlClient; close(): Promise<void> }

export interface OpenSqlOptions {
  readOnly?: boolean;
  /** 源库：连接后校验当前角色没有任何写权限，否则拒绝运行。目标库不要开。 */
  requireReadonlyRole?: boolean;
  max?: number;
}

/**
 * 迁移工具的连接。
 * readOnly：会话 default_transaction_read_only=on，且事务以 BEGIN TRANSACTION READ ONLY 开启（第二层）。
 * requireReadonlyRole：连接后校验当前角色非超级用户、对业务表无 INSERT/UPDATE/DELETE/TRUNCATE、无 CREATE，否则拒绝。
 * 连接串只来自调用方（CLI 从固定配置重建），不打印、不落盘。
 */
export async function assertReadonlyRole(query: SqlClient['query']): Promise<void> {
  const role = await query<{ rolsuper: boolean; rolname: string }>(
    'SELECT rolsuper, rolname FROM pg_roles WHERE rolname = current_user');
  const row = role.rows[0];
  if (!row) throw Error('source_role_unknown');
  if (row.rolsuper) throw Error('source_role_is_superuser');
  const writes = await query<{ has_write: boolean }>(`
    SELECT EXISTS (
      SELECT 1
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
        AND c.relkind IN ('r', 'p')
        AND (
          has_table_privilege(current_user, c.oid, 'INSERT')
          OR has_table_privilege(current_user, c.oid, 'UPDATE')
          OR has_table_privilege(current_user, c.oid, 'DELETE')
          OR has_table_privilege(current_user, c.oid, 'TRUNCATE')
        )
    ) AS has_write`);
  if (writes.rows[0]?.has_write) throw Error('source_role_has_write');
  const ddl = await query<{ has_ddl: boolean }>(`
    SELECT EXISTS (
      SELECT 1 FROM pg_namespace
      WHERE nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
        AND has_schema_privilege(current_user, oid, 'CREATE')
    ) AS has_ddl`);
  if (ddl.rows[0]?.has_ddl) throw Error('source_role_has_ddl');
}

export async function openSql(url: string, options: OpenSqlOptions = {}): Promise<OpenedSql> {
  const Pool = await loadPgPool() as unknown as new (config: Record<string, unknown>) => {
    query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
    connect(): Promise<{ query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>; release(): void }>;
    end(): Promise<void>;
  };
  const pool = new Pool({
    connectionString: url,
    max: options.max ?? 4,
    ...(options.readOnly ? { options: '-c default_transaction_read_only=on' } : {}),
  });
  const begin = options.readOnly ? 'BEGIN TRANSACTION READ ONLY' : 'BEGIN';
  const client: SqlClient = {
    async query<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]) {
      return { rows: (await pool.query(sql, params ? [...params] : [])).rows as T[] };
    },
    async transaction<T>(work: (query: SqlClient['query']) => Promise<T>): Promise<T> {
      const held = await pool.connect();
      const query: SqlClient['query'] = async <R = Record<string, unknown>>(sql: string, params?: readonly unknown[]) =>
        ({ rows: (await held.query(sql, params ? [...params] : [])).rows as R[] });
      try {
        await held.query(begin);
        const result = await work(query);
        await held.query('COMMIT');
        return result;
      } catch (error) {
        await held.query('ROLLBACK').catch(() => {});
        throw error;
      } finally { held.release(); }
    },
  };
  try {
    if (options.requireReadonlyRole) await assertReadonlyRole(client.query.bind(client));
  } catch (error) {
    await pool.end().catch(() => {});
    throw error;
  }
  let ended: Promise<void> | undefined;
  return { client, close: () => (ended ??= pool.end()) };
}
