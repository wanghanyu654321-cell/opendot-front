import type { SqlClient } from '../role-eval/performance-postgres.js';

type Environment = Readonly<Record<string, string | undefined>>;
const schema = 'front_claw_perf';
const quote = (value: string) => '"' + value.replaceAll('"', '""') + '"';
const literal = (value: string) => "'" + value.replaceAll("'", "''") + "'";

/** Run with the migration identity in a transaction; never seed business records. */
export async function provisionAccounts(query: SqlClient['query'], env: Environment): Promise<void> {
  const database = decodeURIComponent(new URL(env.DATABASE_ADMIN_URL ?? '').pathname.slice(1));
  if (!database) throw Error('database_required');
  const roles = [['front_app', env.APP_DB_PASSWORD], ['front_readonly', env.READONLY_DB_PASSWORD]] as const;
  for (const [, password] of roles) {
    if (typeof password !== 'string' || password.length < 24 || /[\u0000-\u001f]/.test(password)) throw Error('password_policy');
  }
  for (const [role, password] of roles) {
    const existing = await query('SELECT rolname FROM pg_roles WHERE rolname=$1', [role]);
    // Refuse inherited rights left by earlier manual provisioning.
    const memberships = await query('SELECT 1 FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname=$1)', [role]);
    if (memberships.rows.length) throw Error('account_membership_requires_review');
    await query(`${existing.rows.length ? 'ALTER' : 'CREATE'} ROLE ${quote(role)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD ${literal(password!)}`);
  }
  await query(`REVOKE ALL ON DATABASE ${quote(database)} FROM PUBLIC, front_app, front_readonly`);
  await query(`GRANT CONNECT ON DATABASE ${quote(database)} TO front_app, front_readonly`);
  await query('REVOKE CREATE ON SCHEMA public FROM PUBLIC, front_app, front_readonly');
  await query(`REVOKE ALL ON SCHEMA ${schema} FROM PUBLIC, front_app, front_readonly`);
  await query(`GRANT USAGE ON SCHEMA ${schema} TO front_app, front_readonly`);
  await query(`REVOKE ALL ON ALL TABLES IN SCHEMA ${schema} FROM PUBLIC, front_app, front_readonly`);
  await query(`REVOKE ALL ON ALL SEQUENCES IN SCHEMA ${schema} FROM PUBLIC, front_app, front_readonly`);
  const tables = await query<{ tablename: string }>('SELECT tablename FROM pg_tables WHERE schemaname=$1', [schema]);
  for (const { tablename } of tables.rows) {
    await query(`GRANT SELECT ON ${schema}.${quote(tablename)} TO front_app, front_readonly`);
    if (!['schema_migrations', 'migration_runs', 'migration_import_rows'].includes(tablename)) {
      await query(`GRANT INSERT, UPDATE, DELETE ON ${schema}.${quote(tablename)} TO front_app`);
    }
  }
  await query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ${schema} TO front_app`);
}
