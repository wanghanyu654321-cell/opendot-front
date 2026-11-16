import { isDeepStrictEqual } from 'node:util';
import { parseAccessPolicy, readPolicy, updateAccessPolicy, type AccessPolicy } from '../role-eval/access-policy.js';
import { EMPLOYEE_LOOP_CONFIG } from '../role-eval/employee-loop.js';
import type { OpenedPerformanceStore } from '../role-eval/performance-open.js';
import type { Person } from '../role-eval/performance-store.js';
import type { WecomBotBinding } from '../role-eval/wecom-bot-bindings.js';

export type SeedDatabase = Pick<OpenedPerformanceStore, 'store' | 'bindings'>;
export interface IdentitySeed { person: Person; binding: WecomBotBinding; actor: string; at: string; }
const same = isDeepStrictEqual;

/** Shared explicit initializer. Existing grants and unrelated allow-list members are preserved. */
export async function seedIdentity(db: SeedDatabase, supplied: IdentitySeed, defaults: Pick<AccessPolicy, 'enterprise' | 'roles'> = {
  enterprise: ['report_self', 'progress_self'], roles: { employee: ['report_self', 'progress_self'], manager: ['report_self', 'progress_self'], owner: ['progress_self'] },
}): Promise<void> {
  const { person, binding, actor, at } = structuredClone(supplied);
  const people = await db.store.listPeople();
  const existing = people.find(row => row.personId === person.personId);
  if (people.some(row => (row.memberId === person.memberId || row.accountId === person.accountId) && row.personId !== person.personId)
    || (existing && !same(existing, person))) throw Error('seed_identity_conflict');
  const previousBinding = (await db.bindings.listBindings()).find(row => row.botId === binding.botId && row.memberId === binding.memberId);
  if (previousBinding && !same(previousBinding, binding)) throw Error('seed_binding_conflict');

  const loopRaw = await db.store.getConfig(EMPLOYEE_LOOP_CONFIG);
  let members: string[] = [];
  if (loopRaw !== null) {
    let loop: Record<string, unknown>;
    try { loop = JSON.parse(loopRaw); } catch { throw Error('seed_loop_conflict'); }
    if (!loop || loop.enabled !== true || loop.storeId !== person.storeId || !Array.isArray(loop.memberIds)
      || !loop.memberIds.every(id => typeof id === 'string' && !!id.trim())) throw Error('seed_loop_conflict');
    members = loop.memberIds as string[];
  }
  const loopNext = JSON.stringify({ enabled: true, storeId: person.storeId, memberIds: [...new Set([...members, person.memberId])] });
  const raw = await readPolicy(db.store);
  const parsed = parseAccessPolicy(raw.policy);
  if (parsed === null || (parsed !== 'missing' && (raw.highWater === null || !/^\d+$/.test(raw.highWater) || Number(raw.highWater) !== parsed.version))) throw Error('seed_policy_conflict');
  const policy: AccessPolicy = parsed === 'missing'
    ? { version: 1, ...structuredClone(defaults), stores: {}, members: {} }
    : structuredClone(parsed);
  const grant = { role: person.tier, storeIds: [person.storeId], status: 'active' as const };
  if (policy.members[person.personId] && !same(policy.members[person.personId], grant)) throw Error('seed_policy_conflict');
  const needsPolicy = !Object.hasOwn(policy.members, person.personId) || !Object.hasOwn(policy.stores, person.storeId);
  if (needsPolicy) {
    if (!Object.hasOwn(policy.stores, person.storeId)) policy.stores[person.storeId] = [...defaults.enterprise];
    policy.members[person.personId] = grant;
    policy.version = parsed === 'missing' ? Math.max(0, Number(raw.highWater ?? '0')) + 1 : parsed.version + 1;
  }
  // Preflight completes before writes. The admin command wraps this entire operation in one PG transaction.
  if (!existing) await db.store.savePerson(person);
  if (needsPolicy && !(await updateAccessPolicy(db.store, { expectedVersion: parsed === 'missing' ? null : parsed.version, next: policy, actor, reason: 'explicit identity initialization', at })).ok) throw Error('seed_policy_conflict');
  if (loopNext !== loopRaw) await db.store.setConfig(EMPLOYEE_LOOP_CONFIG, loopNext);
  if (!previousBinding) await db.bindings.saveBinding(binding);
}
