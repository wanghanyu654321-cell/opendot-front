import { vi } from 'vitest';
import { createWecomBotHandler } from '../../src/role-eval/wecom-bot-unified-handler.js';
import { createPostgresPerformanceStore, migratePerformance } from '../../src/role-eval/performance-postgres.js';
import type { LedgerEntry, PerformanceStore, Person, Tier } from '../../src/role-eval/performance-store.js';
import { ACCESS_POLICY_KEY, CAPABILITIES, updateAccessPolicy, type AccessPolicy, type Capability, type MemberGrant } from '../../src/role-eval/access-policy.js';
import type { EmployeeRouterOptions } from '../../src/role-eval/employee-entry.js';
import { applyMemoryR5, MemorySql } from './sql-fixture.js';

/**
 * M03 合成世界（全部为合成数据，不含真实标识或真实配置）：
 * 测试A店：小林（员工）、小钱（员工）、老周（店长）；测试B店：苏晓禾（测试账号的合成占位，默认店长）、小赵（员工）；
 * 老板：档案挂 A 店，授权只含 A 店。营销默认关，按企微成员 ID 在成员 capabilities 里开通（R5）。
 */
export const NOW = new Date('2026-11-12T02:00:00Z');
export const DAY = '2026-11-12';
export const basePeople: Person[] = [
  { personId: 'p-lin', accountId: 'a-lin', memberId: 'm-lin', displayName: '小林', storeId: 's-a', storeName: '测试A店', tier: 'employee', roles: [], active: true },
  { personId: 'p-qian', accountId: 'a-qian', memberId: 'm-qian', displayName: '小钱', storeId: 's-a', storeName: '测试A店', tier: 'employee', roles: [], active: true },
  { personId: 'p-zhou', accountId: 'a-zhou', memberId: 'm-zhou', displayName: '老周', storeId: 's-a', storeName: '测试A店', tier: 'manager', roles: ['manager'], active: true },
  { personId: 'p-wang-yj', accountId: 'a-wang-yj', memberId: 'm-wang-yj', displayName: '苏晓禾', storeId: 's-b', storeName: '测试B店', tier: 'manager', roles: ['manager', 'marketing'], active: true },
  { personId: 'p-zhao', accountId: 'a-zhao', memberId: 'm-zhao', displayName: '小赵', storeId: 's-b', storeName: '测试B店', tier: 'employee', roles: [], active: true },
  { personId: 'p-boss', accountId: 'a-boss', memberId: 'm-boss', displayName: '老板', storeId: 's-a', storeName: '测试A店', tier: 'owner', roles: ['manager', 'marketing'], active: true },
];
export const ROLE_CAPS: Record<Tier, Capability[]> = {
  employee: ['report_self', 'report_proxy', 'progress_self', 'marketing'],
  manager: ['report_self', 'report_proxy', 'progress_self', 'progress_other', 'store_summary', 'unreported', 'marketing'],
  owner: ['progress_self', 'progress_other', 'store_summary', 'unreported', 'stores_ranking', 'marketing'],
};
export const baseMembers = (): Record<string, MemberGrant> => ({
  'p-lin': { role: 'employee', storeIds: ['s-a'], status: 'active' },
  'p-qian': { role: 'employee', storeIds: ['s-a'], status: 'active' },
  'p-zhou': { role: 'manager', storeIds: ['s-a'], status: 'active' },
  'p-wang-yj': { role: 'manager', storeIds: ['s-b'], status: 'active' },
  'p-zhao': { role: 'employee', storeIds: ['s-b'], status: 'active' },
  'p-boss': { role: 'owner', storeIds: ['s-a'], status: 'active' },
});
export function policy(version: number, members = baseMembers(), patch: Partial<AccessPolicy> = {}): AccessPolicy {
  return {
    version, enterprise: [...CAPABILITIES],
    stores: { 's-a': [...CAPABILITIES], 's-b': [...CAPABILITIES] },
    roles: structuredClone(ROLE_CAPS), members, ...patch,
  };
}
export const entry = (id: string, storeId: string, owner: Person, amount: number, businessDay = DAY): LedgerEntry => ({
  entryId: id, storeId, businessDay, customerName: null, amount, amountType: 'consultant', ownerPersonId: owner.personId, ownerName: owner.displayName,
  reporterPersonId: owner.personId, note: '', status: 'confirmed', disputed: false, createdAt: `${businessDay}T01:00:00.000Z`,
});

/** M05：含函数的参数（如提交选项里的 guard）记为 '[fn]'，不影响被调用方。 */
const safeClone = (arg: unknown) => { try { return structuredClone(arg); } catch { return '[uncloneable]'; } };
export interface Spy { reads: { method: string; args: unknown[] }[] }
/** 记录所有读写调用的门店参数，用于断言“越界零读”。不改变任何行为。 */
export function spyStore(store: PerformanceStore, spy: Spy): PerformanceStore {
  return new Proxy(store, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => { spy.reads.push({ method: String(key), args: args.map(arg => typeof arg === 'function' || (arg && typeof arg === 'object' && 'check' in arg) ? '[fn]' : safeClone(arg)) }); return (value as (...a: unknown[]) => unknown).apply(target, args); };
    },
  });
}

export interface SeedOptions { people?: Person[]; policyRaw?: string | null; policy?: AccessPolicy }
export async function seed(store: PerformanceStore, options: SeedOptions = {}) {
  for (const person of options.people ?? basePeople) await store.savePerson(person);
  await store.saveAlias({ storeId: 's-b', alias: '赵赵', personId: 'p-zhao' });
  // M01 受控写入开关仍只开 B 店（首批试用门店），写入以此为外层门槛。
  await store.setConfig('employee-loop:m01', JSON.stringify({ enabled: true, storeId: 's-b', memberIds: ['m-wang-yj', 'm-zhao'] }));
  const [lin, qian, zhou, wang, zhao] = (options.people ?? basePeople);
  await store.insertEntries([entry('e-a1', 's-a', lin!, 30000), entry('e-a2', 's-a', zhou!, 20000), entry('e-b1', 's-b', zhao!, 90000), entry('e-b2', 's-b', wang!, 10000)]);
  void qian;
  // R1：策略键受保护（setConfig 拒写）；测试用锁内写模拟“原文被写坏/绕过接口”。
  if (options.policyRaw !== undefined) { if (options.policyRaw !== null) await store.updateConfigLocked(ACCESS_POLICY_KEY, [], () => ({ [ACCESS_POLICY_KEY]: options.policyRaw! })); }
  else {
    const result = await updateAccessPolicy(store, { expectedVersion: null, next: options.policy ?? policy(1), actor: 'test-admin', reason: 'seed', at: NOW.toISOString() });
    if (!result.ok) throw Error(`seed policy ${result.reason}`);
  }
}

export async function world(options: SeedOptions & { router?: EmployeeRouterOptions; accessPolicy?: boolean; store?: PerformanceStore; now?: () => Date } = {}) {
  const base = options.store ?? createPostgresPerformanceStore((await (async () => { const sql = new MemorySql(); await migratePerformance(sql); await applyMemoryR5(sql); return sql; })()));
  await seed(base, options);
  const spy: Spy = { reads: [] };
  const store = spyStore(base, spy);
  const model = vi.fn(async () => ({ type: 'chat' as const, text: '不应进入模型' }));
  const send = vi.fn(async (_input: { toPersonId: string; text: string }) => 'sent' as const);
  const outbound: string[] = [];
  const handler = createWecomBotHandler({
    legacyEntry: true, mode: 'isolated-synthetic', store, now: options.now ?? (() => NOW), // M04：可传走动时钟
    resolve: id => base.getPersonByMember(id), send, model: { complete: model },
    employeeLoop: true, accessPolicy: options.accessPolicy ?? true, onOutbound: text => outbound.push(text),
    ...(options.router ? { router: options.router } : {}),
  });
  let seq = 0;
  const call = async (memberId: string, text: string, messageId = `msg-${++seq}`) =>
    (await handler.handleMessage({ memberId, text, messageId, sessionId: `session-${memberId}`, bindingVersion: 1 })).replies.join('\n');
  const snapshot = async () => ({ entries: await base.listEntries(), drafts: await base.listDrafts() });
  /** 本次调用期间所有 listEntries 读取的门店集合（undefined 表示未按店过滤）。 */
  const entryStores = () => spy.reads.filter(read => read.method === 'listEntries').map(read => (read.args[0] as { storeId?: string } | undefined)?.storeId);
  return { base, store, spy, model, send, outbound, call, snapshot, entryStores, reset: () => { spy.reads.length = 0; } };
}
