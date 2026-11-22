import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import type pg from 'pg';
import {
  createDatabasePool,
  sqlClient,
} from '../../src/standalone/database.js';
import {
  runPilotSwitch,
  type PilotSwitchRequest,
} from '../../src/standalone/pilot-switch.js';
import { seedIdentity } from '../../src/standalone/seed.js';
import { migrateUp } from '../../src/role-eval/schema-migrations.js';
import { createPostgresPerformanceStore } from '../../src/role-eval/performance-postgres.js';
import { createPostgresBindingStore } from '../../src/role-eval/directory-store.js';
import { decideAccess, readPolicy } from '../../src/role-eval/access-policy.js';

let pool: pg.Pool;
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
  expect(url.pathname).toMatch(/^\/synthetic_pilot_switch_[a-zA-Z0-9_]+$/);
  pool = createDatabasePool(url.href, 4);
  await migrateUp(sqlClient(pool), { apply: true });
});
afterAll(async () => {
  await pool?.end();
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
      enterprise: [...employee],
      roles: {
        employee: [...employee],
        manager: ['report_self', 'progress_self'],
        owner: ['progress_self'],
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

it('refuses another account without altering any row', async () => {
  await createPostgresPerformanceStore(sqlClient(pool)).savePerson({
    ...person,
    personId: 'other-person',
    accountId: 'other-account',
    memberId: 'other-member',
  });
  const before = await snapshot();
  await expect(runPilotSwitch(sqlClient(pool), input, true)).rejects.toThrow(
    'pilot_scope_not_single',
  );
  expect(await snapshot()).toEqual(before);
});
