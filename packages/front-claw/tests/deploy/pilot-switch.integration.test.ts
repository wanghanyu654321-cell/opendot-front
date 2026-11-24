import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import type pg from 'pg';
import { randomUUID } from 'node:crypto';
import { dropIdleDatabase } from './isolated-database.js';
import {
  createDatabasePool,
  sqlClient,
} from '../../src/standalone/database.js';
import {
  runPilotSwitch,
  runPilotSwitchCli,
  type PilotSwitchRequest,
} from '../../src/standalone/pilot-switch.js';
import { seedIdentity } from '../../src/standalone/seed.js';
import { migrateUp } from '../../src/role-eval/schema-migrations.js';
import { createPostgresPerformanceStore } from '../../src/role-eval/performance-postgres.js';
import { createPostgresBindingStore } from '../../src/role-eval/directory-store.js';
import {
  CAPABILITIES,
  decideAccess,
  readPolicy,
} from '../../src/role-eval/access-policy.js';

let pool: pg.Pool;
let control: pg.Pool;
let created = false;
let testUrl: string;
const database = 'synthetic_pilot_switch_' + randomUUID().replaceAll('-', '');
const input: PilotSwitchRequest = {
  personId: 'pilot-person',
  accountId: 'pilot-account',
  storeId: 'store-b',
  tier: 'manager',
  expectedVersion: 2,
  actor: 'pilot-admin',
  reason: 'isolated synthetic tier acceptance',
  at: '2026-11-22T10:00:00.000Z',
};
const employee = [
  'report_self',
  'progress_self',
  'marketing',
  'correct_own',
  'appointment_submit',
] as const;
const person = {
  personId: 'pilot-person',
  accountId: 'pilot-account',
  memberId: 'pilot-member',
  displayName: '合成员工',
  storeId: 'store-b',
  storeName: '合成B店',
  tier: 'employee' as const,
  roles: ['marketing' as const],
  active: true,
};

beforeAll(async () => {
  expect(process.env.AUDIT_PG_ALLOW).toBe('isolated-synthetic');
  const url = new URL(process.env.AUDIT_PG_URL!);
  expect(['127.0.0.1', 'localhost', '[::1]']).toContain(url.hostname);
  expect(['postgres:', 'postgresql:']).toContain(url.protocol);
  expect(url.search).toBe('');
  control = createDatabasePool(url.href, 1);
  await control.query(`CREATE DATABASE "${database}"`);
  created = true;
  url.pathname = '/' + database;
  testUrl = url.href;
  pool = createDatabasePool(testUrl, 4);
  await migrateUp(sqlClient(pool), { apply: true });
});
afterAll(async () => {
  try {
    await pool?.end();
    if (created) await dropIdleDatabase(control, database);
  } finally {
    await control?.end();
  }
});
beforeEach(async () => {
  await pool.query(
    'ALTER TABLE front_claw_perf.performance_people DROP CONSTRAINT IF EXISTS synthetic_employee_only',
  );
  await pool.query(
    'TRUNCATE front_claw_perf.performance_people, front_claw_perf.wecom_bot_bindings, front_claw_perf.performance_config',
  );
  const client = sqlClient(pool),
    store = createPostgresPerformanceStore(client, { deliveryColumns: true });
  await seedIdentity(
    { store, bindings: createPostgresBindingStore(client) },
    {
      person,
      binding: {
        botId: 'pilot-bot',
        corpId: 'pilot-corp',
        memberId: 'pilot-member',
        accountId: 'pilot-account',
        version: 1,
        active: true,
      },
      actor: 'synthetic-initializer',
      at: input.at,
    },
    {
      enterprise: [...CAPABILITIES],
      roles: {
        employee: [...employee],
        manager: [...CAPABILITIES],
        owner: [...CAPABILITIES],
      },
    },
  );
  // A complete initial member grant matches the current deployed pilot fixture at version 2.
  await pool.query(
    'UPDATE front_claw_perf.performance_config SET value=jsonb_set(jsonb_set(value::jsonb,$1,$2::jsonb),$3,$4::jsonb)::text WHERE key=$5',
    [
      ['version'],
      '2',
      ['members', 'pilot-person', 'capabilities'],
      JSON.stringify(employee),
      'front-claw-access',
    ],
  );
  await pool.query(
    'UPDATE front_claw_perf.performance_config SET value=$1 WHERE key=$2',
    ['2', 'front-claw-access:high-water'],
  );
});

async function snapshot() {
  const result: Record<string, unknown> = {};
  for (const table of [
    'performance_people',
    'wecom_bot_bindings',
    'performance_config',
    'performance_entries',
    'performance_drafts',
    'performance_appointments',
    'performance_notifications',
  ]) {
    // Only identifiers from this constant list, in the guarded disposable database above.
    result[table] = (
      await pool.query(
        `SELECT to_jsonb(t) AS row FROM front_claw_perf.${table} t ORDER BY to_jsonb(t)::text`,
      )
    ).rows;
  }
  return result;
}

it('preview leaves every directory, config and business row unchanged in real PG', async () => {
  const before = await snapshot();
  const plan = await runPilotSwitch(sqlClient(pool), input);
  expect(plan.person.tier).toBe('manager');
  expect(plan.effective).toContain('store_summary');
  expect(await snapshot()).toEqual(before);
});

it('commits manager -> employee -> owner atomically with monotonic audit and no business writes', async () => {
  const before = await snapshot(),
    client = sqlClient(pool);
  for (const [tier, version] of [
    ['manager', 2],
    ['employee', 3],
    ['owner', 4],
  ] as const) {
    await runPilotSwitch(
      client,
      { ...input, tier, expectedVersion: version },
      true,
    );
    const store = createPostgresPerformanceStore(client),
      current = (await store.getPerson('pilot-person'))!;
    const raw = await readPolicy(store),
      policy = JSON.parse(raw.policy!);
    expect(current.tier).toBe(tier);
    expect(policy.members['pilot-person'].role).toBe(tier);
    expect(policy.version).toBe(version + 1);
    expect(raw.highWater).toBe(String(version + 1));
    expect(decideAccess(raw, current, 'store_summary', 'store-b').allowed).toBe(
      tier !== 'employee',
    );
    expect(decideAccess(raw, current, 'report_self', 'store-b').allowed).toBe(
      tier !== 'owner',
    );
    expect(decideAccess(raw, current, 'store_summary', 'store-a').allowed).toBe(
      false,
    );
  }
  const after = await snapshot();
  for (const table of [
    'wecom_bot_bindings',
    'performance_entries',
    'performance_drafts',
    'performance_appointments',
    'performance_notifications',
  ]) {
    expect(after[table]).toEqual(before[table]);
  }
  const audit = (
    await pool.query(
      'SELECT key,value FROM front_claw_perf.performance_config WHERE key LIKE $1 ORDER BY key',
      ['front-claw-access:audit:%'],
    )
  ).rows;
  expect(audit.map((row) => JSON.parse(row.value).version)).toEqual([
    1, 3, 4, 5,
  ]);
  const stable = await snapshot();
  expect(
    (
      await runPilotSwitch(
        client,
        { ...input, tier: 'owner', expectedVersion: 5 },
        true,
      )
    ).changed,
  ).toBe(false);
  expect(await snapshot()).toEqual(stable);
});

it('rolls back person, policy, high-water and audit together when the person write fails', async () => {
  await pool.query(
    "ALTER TABLE front_claw_perf.performance_people ADD CONSTRAINT synthetic_employee_only CHECK (tier='employee')",
  );
  const before = await snapshot();
  await expect(
    runPilotSwitch(sqlClient(pool), input, true),
  ).rejects.toMatchObject({ code: '23514' });
  expect(await snapshot()).toEqual(before);
});

it('lets exactly one same-version concurrent switch commit and refuses the stale writer', async () => {
  const outcomes = await Promise.allSettled([
    runPilotSwitch(sqlClient(pool), input, true),
    runPilotSwitch(sqlClient(pool), { ...input, tier: 'owner' }, true),
  ]);
  expect(
    outcomes.filter((result) => result.status === 'fulfilled'),
  ).toHaveLength(1);
  const failed = outcomes.find(
    (result) => result.status === 'rejected',
  ) as PromiseRejectedResult;
  expect(failed.reason.message).toBe('pilot_version_conflict');
  const store = createPostgresPerformanceStore(sqlClient(pool)),
    current = (await store.getPerson('pilot-person'))!;
  const raw = await readPolicy(store),
    policy = JSON.parse(raw.policy!);
  expect(policy.version).toBe(3);
  expect(raw.highWater).toBe('3');
  expect(policy.members['pilot-person'].role).toBe(current.tier);
});

it('preserves another account during a formal change and refuses to reset its shared policy', async () => {
  await createPostgresPerformanceStore(sqlClient(pool)).savePerson({
    ...person,
    personId: 'other-person',
    accountId: 'other-account',
    memberId: 'other-member',
  });
  const before = await snapshot();
  await expect(resetBaseline()).rejects.toThrow('pilot_scope_not_single');
  expect(await snapshot()).toEqual(before);
  await runPilotSwitch(sqlClient(pool), input, true);
  expect(
    await createPostgresPerformanceStore(sqlClient(pool)).getPerson(
      'other-person',
    ),
  ).toMatchObject({ tier: 'employee', accountId: 'other-account' });
});

function resetBaseline(tier = 'manager', version = '2') {
  return runPilotSwitchCli(
    [
      'apply-synthetic-baseline',
      input.personId,
      input.accountId,
      input.storeId,
      tier,
      version,
    ],
    { AUDIT_PG_ALLOW: 'isolated-synthetic', AUDIT_PG_URL: testUrl },
  );
}

it('rebuilds the single synthetic baseline without retaining older enterprise or store capabilities', async () => {
  await resetBaseline();
  await resetBaseline('employee', '3');
  const raw = await readPolicy(createPostgresPerformanceStore(sqlClient(pool)));
  const policy = JSON.parse(raw.policy!);
  expect(policy.enterprise.sort()).toEqual([...employee].sort());
  expect(policy.stores[input.storeId].sort()).toEqual([...employee].sort());
  expect(policy.version).toBe(4);
});

it('allows the child database owner with a session-specific equality operator', async () => {
  await pool.query('CREATE SCHEMA synthetic_operator_test');
  try {
    await pool.query(
      'CREATE FUNCTION synthetic_operator_test.different_oid(pg_catalog.oid, pg_catalog.oid) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$ SELECT false $$',
    );
    await pool.query(
      'CREATE OPERATOR synthetic_operator_test.= (LEFTARG = pg_catalog.oid, RIGHTARG = pg_catalog.oid, FUNCTION = synthetic_operator_test.different_oid)',
    );
    await control.query(
      `ALTER DATABASE "${database}" SET search_path TO synthetic_operator_test, pg_catalog, public`,
    );
    await expect(resetBaseline()).resolves.toMatchObject({
      changed: true,
      after: { tier: 'manager', version: 3 },
    });
  } finally {
    await control.query(`ALTER DATABASE "${database}" RESET search_path`);
    await pool.query('DROP OPERATOR IF EXISTS synthetic_operator_test.= (pg_catalog.oid, pg_catalog.oid)');
    await pool.query('DROP FUNCTION IF EXISTS synthetic_operator_test.different_oid(pg_catalog.oid, pg_catalog.oid)');
    await pool.query('DROP SCHEMA synthetic_operator_test');
  }
});

it.each([
  'postgresql://127.0.0.1/postgres',
  'postgresql://db.example/synthetic_pilot_switch_test',
  'postgresql://localhost/synthetic_pilot_switch_test?host=db.example',
])('rejects unsuitable reset target before opening it', async (url) => {
  await expect(
    runPilotSwitchCli(
      [
        'apply-synthetic-baseline',
        input.personId,
        input.accountId,
        input.storeId,
        'employee',
        '2',
      ],
      { AUDIT_PG_ALLOW: 'isolated-synthetic', AUDIT_PG_URL: url },
    ),
  ).rejects.toThrow('pilot_isolated_database_required');
});

it.each([false, true])('refuses synthetic reset by a role that does not own the child database (shadow catalog: %s)', async (shadowCatalog) => {
  const owner = 'reset_owner_' + randomUUID().replaceAll('-', '');
  const { rows } = await control.query<{ role: string }>(
    'SELECT current_user AS role',
  );
  const original = rows[0]!.role.replaceAll('"', '""');
  await control.query(`CREATE ROLE "${owner}" NOLOGIN`);
  try {
    if (shadowCatalog) {
      await pool.query('CREATE SCHEMA synthetic_catalog_test');
      await pool.query(
        'CREATE TABLE synthetic_catalog_test.pg_database AS SELECT datname, datdba FROM pg_catalog.pg_database WHERE datname = pg_catalog.current_database()',
      );
      await control.query(`ALTER DATABASE "${database}" SET search_path TO synthetic_catalog_test, pg_catalog, public`);
    }
    await control.query(`ALTER DATABASE "${database}" OWNER TO "${owner}"`);
    const before = await snapshot();
    await expect(resetBaseline()).rejects.toThrow(
      'pilot_isolated_database_required',
    );
    expect(await snapshot()).toEqual(before);
  } finally {
    await control.query(`ALTER DATABASE "${database}" OWNER TO "${original}"`);
    if (shadowCatalog) {
      await control.query(`ALTER DATABASE "${database}" RESET search_path`);
      await pool.query('DROP TABLE IF EXISTS synthetic_catalog_test.pg_database');
      await pool.query('DROP SCHEMA IF EXISTS synthetic_catalog_test');
    }
    await control.query(`DROP ROLE "${owner}"`);
  }
});
