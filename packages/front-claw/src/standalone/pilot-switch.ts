import { isDeepStrictEqual } from 'node:util';
import { pathToFileURL } from 'node:url';
import {
  ACCESS_POLICY_KEY,
  ACCESS_POLICY_HIGH_WATER_KEY,
  CAPABILITIES,
  decideAccess,
  parseAccessPolicy,
  standing,
  updateAccessPolicy,
  type AccessPolicy,
  type Capability,
} from '../role-eval/access-policy.js';
import type { Person, Tier } from '../role-eval/performance-store.js';
import {
  snapshotBinding,
  type WecomBotBinding,
} from '../role-eval/wecom-bot-bindings.js';
import {
  createPostgresPerformanceStore,
  type SqlClient,
} from '../role-eval/performance-postgres.js';
import { createPostgresBindingStore } from '../role-eval/directory-store.js';
import { EMPLOYEE_LOOP_CONFIG } from '../role-eval/employee-loop.js';
import { resolveBusinessDatabaseUrl } from '../role-eval/credential-file.js';
import { applyDatabaseHost } from '../role-eval/performance-open.js';
import { createDatabasePool, sqlClient } from './database.js';

export interface PilotSwitchRequest {
  personId: string;
  accountId: string;
  storeId: string;
  tier: Tier;
  expectedVersion: number;
  actor: string;
  reason: string;
  at: string;
}
export interface PilotSwitchSnapshot {
  people: Person[];
  bindings: WecomBotBinding[];
  rawPolicy: { policy: string | null; highWater: string | null };
  loopRaw: string | null;
}
export interface PilotSwitchPlan {
  changed: boolean;
  before: { tier: Tier; version: number; capabilities: Capability[] };
  person: Person;
  policy: AccessPolicy;
  effective: Capability[];
}
const PILOT_CAPABILITIES: Record<Tier, readonly Capability[]> = {
  employee: [
    'report_self',
    'progress_self',
    'marketing',
    'correct_own',
    'appointment_submit',
  ],
  manager: [
    'report_self',
    'report_proxy',
    'progress_self',
    'progress_other',
    'store_summary',
    'unreported',
    'marketing',
    'target_set',
    'correct_own',
    'correct_store',
    'appointment_submit',
    'appointment_receive',
  ],
  owner: [
    'progress_self',
    'progress_other',
    'store_summary',
    'unreported',
    'stores_ranking',
    'marketing',
    'target_set',
    'correct_own',
    'correct_store',
    'appointment_submit',
    'appointment_receive',
  ],
};
const identifier = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[a-zA-Z0-9_.@:-]{1,120}$/.test(value) &&
  !['__proto__', 'constructor', 'prototype'].includes(value);
function validateRequest(input: PilotSwitchRequest): void {
  if (
    ![input.personId, input.accountId, input.storeId, input.actor].every(
      identifier,
    ) ||
    !Object.hasOwn(PILOT_CAPABILITIES, input.tier) ||
    !Number.isSafeInteger(input.expectedVersion) ||
    input.expectedVersion < 1 ||
    typeof input.reason !== 'string' ||
    !input.reason.trim() ||
    input.reason.length > 300 ||
    /[\u0000-\u001f]/.test(input.reason) ||
    typeof input.at !== 'string' ||
    !Number.isFinite(Date.parse(input.at))
  )
    throw Error('pilot_invalid_request');
}
const sorted = (capabilities: readonly Capability[]) =>
  [...capabilities].sort();

/** Formal changes touch one directory entry and one member grant. */
export function planPilotSwitch(
  supplied: PilotSwitchSnapshot,
  request: PilotSwitchRequest,
  baseline = false,
): PilotSwitchPlan {
  const snapshot = structuredClone(supplied),
    input = structuredClone(request);
  validateRequest(input);
  const policy = parseAccessPolicy(snapshot.rawPolicy.policy);
  if (
    !policy ||
    policy === 'missing' ||
    snapshot.rawPolicy.highWater !== String(policy.version)
  )
    throw Error('pilot_policy_invalid');
  if (policy.version !== input.expectedVersion)
    throw Error('pilot_version_conflict');
  if (
    baseline &&
    (snapshot.people.length !== 1 ||
      snapshot.bindings.length !== 1 ||
      Object.keys(policy.members).length !== 1 ||
      Object.keys(policy.stores).length !== 1)
  )
    throw Error('pilot_scope_not_single');
  const matches = snapshot.people.filter(
    (row) =>
      row.personId === input.personId || row.accountId === input.accountId,
  );
  const person = matches[0];
  if (
    matches.length !== 1 ||
    !person ||
    person.personId !== input.personId ||
    person.accountId !== input.accountId ||
    person.storeId !== input.storeId ||
    !Object.hasOwn(policy.stores, input.storeId) ||
    !Object.hasOwn(policy.members, input.personId)
  )
    throw Error('pilot_identity_mismatch');
  if (!person.active) throw Error('pilot_identity_inactive');
  let binding: WecomBotBinding;
  try {
    const matches = snapshot.bindings.filter(
      (row) =>
        row.accountId === person.accountId || row.memberId === person.memberId,
    );
    if (matches.length !== 1) throw Error('pilot_binding_invalid');
    binding = snapshotBinding(matches[0]);
  } catch {
    throw Error('pilot_binding_invalid');
  }
  if (
    !binding.active ||
    binding.accountId !== person.accountId ||
    binding.memberId !== person.memberId
  )
    throw Error('pilot_binding_invalid');
  const grant = policy.members[person.personId]!;
  if (
    !standing(snapshot.rawPolicy, person).allowed ||
    grant.capabilities?.length === 0 ||
    policy.enterprise.length === 0 ||
    policy.stores[person.storeId]!.length === 0 ||
    policy.roles[person.tier].length === 0 ||
    policy.roles[input.tier].length === 0
  )
    throw Error('pilot_grant_inactive');
  if (grant.storeIds.length !== 1 || grant.storeIds[0] !== person.storeId)
    throw Error('pilot_scope_not_single');
  let loop: {
    enabled?: unknown;
    storeId?: unknown;
    memberIds?: unknown;
  } | null;
  try {
    loop = JSON.parse(snapshot.loopRaw ?? 'null');
  } catch {
    throw Error('pilot_entry_invalid');
  }
  if (
    !loop ||
    loop.enabled !== true ||
    loop.storeId !== person.storeId ||
    !Array.isArray(loop.memberIds) ||
    (baseline && loop.memberIds.length !== 1) ||
    !loop.memberIds.includes(person.memberId)
  )
    throw Error('pilot_entry_invalid');
  const capabilities = [...PILOT_CAPABILITIES[input.tier]];
  if (
    !baseline &&
    capabilities.some(
      (cap) =>
        !policy.enterprise.includes(cap) ||
        !policy.stores[person.storeId]!.includes(cap) ||
        !policy.roles[input.tier].includes(cap),
    )
  )
    throw Error('pilot_ceiling_insufficient');
  const nextPerson: Person = {
    ...person,
    tier: input.tier,
  };
  const next: AccessPolicy = {
    ...policy,
    ...(baseline
      ? {
          enterprise: capabilities,
          stores: { [person.storeId]: capabilities },
          roles: {
            employee: [...PILOT_CAPABILITIES.employee],
            manager: [...PILOT_CAPABILITIES.manager],
            owner: [...PILOT_CAPABILITIES.owner],
          },
        }
      : {}),
    members: {
      ...policy.members,
      [person.personId]: {
        ...grant,
        role: input.tier,
        storeIds: [person.storeId],
        capabilities,
      },
    },
  };
  // Capability lists are sets; differing order alone must not create another audit/version.
  const normalized = (p: AccessPolicy) => ({
    ...p,
    enterprise: sorted(p.enterprise),
    stores: Object.fromEntries(
      Object.entries(p.stores).map(([k, v]) => [k, sorted(v)]),
    ),
    roles: Object.fromEntries(
      Object.entries(p.roles).map(([k, v]) => [k, sorted(v)]),
    ),
    members: Object.fromEntries(
      Object.entries(p.members).map(([k, v]) => [
        k,
        { ...v, capabilities: v.capabilities && sorted(v.capabilities) },
      ]),
    ),
  });
  const changed =
    !isDeepStrictEqual(nextPerson, person) ||
    !isDeepStrictEqual(normalized(next), normalized(policy));
  next.version = changed ? policy.version + 1 : policy.version;
  if (!Number.isSafeInteger(next.version)) throw Error('pilot_policy_invalid');
  const before = {
    tier: person.tier,
    version: policy.version,
    capabilities: CAPABILITIES.filter(
      (cap) =>
        decideAccess(snapshot.rawPolicy, person, cap, person.storeId).allowed,
    ),
  };
  const effective = CAPABILITIES.filter(
    (cap) =>
      decideAccess(JSON.stringify(next), nextPerson, cap, person.storeId)
        .allowed,
  );
  if (!isDeepStrictEqual(sorted(effective), sorted(capabilities)))
    throw Error('pilot_effective_mismatch');
  return { changed, before, person: nextPerson, policy: next, effective };
}

/** Never opens/migrates a database or starts a channel; all mutations share the caller's PG transaction. */
export async function runPilotSwitch(
  client: SqlClient,
  request: PilotSwitchRequest,
  apply = false,
): Promise<PilotSwitchPlan> {
  return executePilotSwitch(client, request, apply, false);
}

async function executePilotSwitch(
  client: SqlClient,
  request: PilotSwitchRequest,
  apply: boolean,
  baseline: boolean,
): Promise<PilotSwitchPlan> {
  const input = structuredClone(request);
  validateRequest(input);
  return client.transaction(async (query) => {
    if (!apply)
      await query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await query("SET LOCAL lock_timeout = '3s'");
    await query("SET LOCAL statement_timeout = '10s'");
    if (baseline) {
      const { rows } = await query<{ name: string; owned: boolean }>(
        `SELECT datname AS name,
                datdba OPERATOR(pg_catalog.=) (
                  SELECT oid FROM pg_catalog.pg_roles
                  WHERE rolname OPERATOR(pg_catalog.=) current_user
                ) AS owned
         FROM pg_catalog.pg_database
         WHERE datname OPERATOR(pg_catalog.=) pg_catalog.current_database()`,
      );
      if (
        !rows[0]?.owned ||
        !/^synthetic_pilot_switch_[a-z0-9_]+$/.test(rows[0].name)
      )
        throw Error('pilot_isolated_database_required');
    }
    const config: Record<string, string | null> = {};
    for (const key of [
      ACCESS_POLICY_HIGH_WATER_KEY,
      ACCESS_POLICY_KEY,
      EMPLOYEE_LOOP_CONFIG,
    ]) {
      const { rows } = await query<{ value: string }>(
        `SELECT value FROM front_claw_perf.performance_config WHERE key=$1${apply ? ' FOR UPDATE' : ''}`,
        [key],
      );
      config[key] = rows[0]?.value ?? null;
    }
    // Freeze the tiny pilot directory, including inserts, while establishing the single-account boundary.
    // This short lock is after policy locks, following the existing config -> directory order.
    if (apply)
      await query(
        'LOCK TABLE front_claw_perf.performance_people, front_claw_perf.wecom_bot_bindings IN SHARE ROW EXCLUSIVE MODE',
      );
    const held: SqlClient = { query, transaction: (work) => work(query) };
    const store = createPostgresPerformanceStore(held, {
      deliveryColumns: true,
    });
    const plan = planPilotSwitch(
      {
        people: await store.listPeople(),
        bindings: await createPostgresBindingStore(held).listBindings(),
        rawPolicy: {
          policy: config[ACCESS_POLICY_KEY] ?? null,
          highWater: config[ACCESS_POLICY_HIGH_WATER_KEY] ?? null,
        },
        loopRaw: config[EMPLOYEE_LOOP_CONFIG] ?? null,
      },
      input,
      baseline,
    );
    if (apply && plan.changed) {
      const updated = await updateAccessPolicy(store, {
        expectedVersion: input.expectedVersion,
        next: plan.policy,
        actor: input.actor,
        reason: input.reason,
        at: input.at,
      });
      if (!updated.ok) throw Error('pilot_version_conflict');
      await store.savePerson(plan.person);
    }
    return plan;
  });
}

export async function runPilotSwitchCli(
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>> = process.env,
) {
  const [mode, personId, accountId, storeId, tier, version] = args;
  if (
    args.length !== 6 ||
    ![
      'preview',
      'apply',
      'preview-synthetic-baseline',
      'apply-synthetic-baseline',
    ].includes(mode ?? '') ||
    !/^\d+$/.test(version ?? '')
  )
    throw Error('pilot_invalid_request');
  const input = {
    personId,
    accountId,
    storeId,
    tier,
    expectedVersion: Number(version),
    actor: 'pilot-admin',
    reason: `${mode} pilot tier ${tier}`,
    at: new Date().toISOString(),
  } as PilotSwitchRequest;
  validateRequest(input);
  const baseline = mode!.endsWith('-synthetic-baseline');
  let databaseUrl: string;
  if (baseline) {
    if (env.AUDIT_PG_ALLOW !== 'isolated-synthetic' || !env.AUDIT_PG_URL)
      throw Error('pilot_isolated_database_required');
    const target = new URL(env.AUDIT_PG_URL);
    if (
      !['postgres:', 'postgresql:'].includes(target.protocol) ||
      !['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname) ||
      target.search ||
      !/^\/synthetic_pilot_switch_[a-z0-9_]+$/.test(target.pathname)
    )
      throw Error('pilot_isolated_database_required');
    databaseUrl = target.href;
  } else {
    const resolved = resolveBusinessDatabaseUrl(env);
    if (!resolved.url) throw Error('pilot_database_required');
    databaseUrl = applyDatabaseHost(resolved.url, env.FRONT_CLAW_DATABASE_HOST);
  }
  const pool = createDatabasePool(databaseUrl, 1);
  try {
    const plan = await executePilotSwitch(
      sqlClient(pool),
      input,
      mode!.startsWith('apply'),
      baseline,
    );
    return {
      mode,
      changed: plan.changed,
      personId,
      accountId,
      storeId,
      before: plan.before,
      after: {
        tier: plan.person.tier,
        version: plan.policy.version,
        capabilities: plan.effective,
      },
    };
  } finally {
    await pool.end();
  }
}

// stdin execution resolves relative imports against the existing dist/standalone cwd: no image rebuild/restart.
if (
  process.argv[1] === '-' ||
  (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
) {
  runPilotSwitchCli(process.argv.slice(2))
    .then((result) => process.stdout.write(JSON.stringify(result) + '\n'))
    .catch((error) => {
      const message =
        error instanceof Error && /^pilot_[a-z_]+$/.test(error.message)
          ? error.message
          : 'pilot_switch_failed';
      process.stderr.write(message + '\n');
      process.exitCode = 2;
    });
}
