import { expect, it, vi } from 'vitest';
import type { SqlClient } from '../../src/role-eval/performance-postgres.js';

it('provisions and rotates least privilege accounts idempotently without synthetic business writes', async () => {
  const { provisionAccounts } = await import('../../src/standalone/provision.js');
  const roles = new Set<string>();
  const sql: string[] = [];
  const query = vi.fn(async (text: string, params?: readonly unknown[]) => {
    sql.push(text);
    if (text.startsWith('SELECT rolname FROM pg_roles')) return { rows: roles.has(String(params?.[0])) ? [{ rolname: params?.[0] }] : [] };
    if (text.startsWith('CREATE ROLE')) roles.add(text.split('"')[1]!);
    if (text.includes('FROM pg_tables')) return { rows: ['performance_entries', 'schema_migrations', 'migration_runs', 'migration_import_rows'].map(tablename => ({ tablename })) };
    return { rows: [] };
  });
  const env = { DATABASE_ADMIN_URL: 'postgresql://pg/front_dot', APP_DB_PASSWORD: 'a'.repeat(24), READONLY_DB_PASSWORD: 'b'.repeat(24) };
  await provisionAccounts(query as SqlClient['query'], env);
  await provisionAccounts(query as SqlClient['query'], { ...env, APP_DB_PASSWORD: 'c'.repeat(24) });
  expect(sql.filter(text => text.startsWith('CREATE ROLE'))).toHaveLength(2);
  expect(sql.filter(text => text.startsWith('ALTER ROLE'))).toHaveLength(2);
  expect(sql.join('\n')).toContain('REVOKE ALL ON ALL TABLES');
  expect(sql.join('\n')).toContain('GRANT INSERT, UPDATE, DELETE ON front_claw_perf."performance_entries" TO front_app');
  expect(sql.join('\n')).not.toMatch(/GRANT (?:INSERT|UPDATE|DELETE)[^\n]+(?:front_readonly|schema_migrations|migration_runs|migration_import_rows)/);
  expect(sql.join('\n')).not.toMatch(/(?:INSERT INTO|UPDATE |DELETE FROM|seedSynthetic|savePerson)/);
  expect(sql.join('\n')).toContain('REVOKE ALL ON SCHEMA');
});
it('validates all account passwords before any provisioning writes', async () => {
  const { provisionAccounts } = await import('../../src/standalone/provision.js');
  const query = vi.fn();
  await expect(provisionAccounts(query, { DATABASE_ADMIN_URL: 'postgresql://pg/front_dot', APP_DB_PASSWORD: 'a'.repeat(24), READONLY_DB_PASSWORD: '' })).rejects.toThrow('password_policy');
  expect(query).not.toHaveBeenCalled();
});
it('uses the existing migration implementation before provisioning and consumer verification without an offline approval', async () => {
  const { runAdmin } = await import('../../src/standalone/admin.js');
  const order: string[] = [];
  const query = vi.fn(async (text: string) => {
    order.push('sql');
    return { rows: text.includes('FROM pg_tables') ? [{ tablename: 'performance_entries' }] : [] };
  });
  const client = { query, transaction: async (work: (query: SqlClient['query']) => Promise<unknown>) => work(query as SqlClient['query']) } as SqlClient;
  const close = vi.fn(async () => { order.push('close'); });
  const migrate = vi.fn(async () => { order.push('migrate'); return { from: 0, to: 11, applied: true, dryRun: false }; });
  const env = { DATABASE_ADMIN_URL: 'postgresql://pg/front_dot', APP_DB_PASSWORD: 'a'.repeat(24), READONLY_DB_PASSWORD: 'b'.repeat(24) };
  await expect(runAdmin('migrate', env, { open: async () => ({ client, close }), migrate })).resolves.toMatchObject({ schemaVersion: 11 });
  expect(order[0]).toBe('migrate');
  expect(close).toHaveBeenCalledOnce();
  await expect(runAdmin('verify-consumer', env, { open: async () => ({ client, close }), migrate })).resolves.toEqual({ consumerAbsent: true });
  expect(migrate).toHaveBeenCalledOnce();
});
