import type { AccessPolicy, Capability, MemberGrant } from '../../src/role-eval/access-policy.js';
import type { PerformanceStore, Tier } from '../../src/role-eval/performance-store.js';
import { APPOINTMENT_RECIPIENTS_KEY } from '../../src/role-eval/appointments.js';
import { createPostgresPerformanceStore, migratePerformance } from '../../src/role-eval/performance-postgres.js';
import type { EmployeeRouterOptions } from '../../src/role-eval/employee-entry.js';
import type { SeedOptions } from './access-fixture-m03.js';
import { membersM04, peopleM04, policyM04, ROLE_CAPS_M04, ticking } from './ledger-fixture-m04.js';
import { world } from './access-fixture-m03.js';
import { MemorySql } from './sql-fixture.js';

/**
 * M05 合成世界（全部为合成数据）：在 M04 世界上给角色补预约能力（测试用，非真实配置）：
 * 员工 +appointment_submit；店长 +appointment_submit/appointment_receive；老板 +appointment_receive。
 * 指定店长：B 店 = 苏晓禾（测试账号合成占位），A 店 = 老周。时钟 2026-11-12 10:00（北京时间，周四）起每次 +1 秒。
 */
export const ROLE_CAPS_M05: Record<Tier, Capability[]> = {
  employee: [...ROLE_CAPS_M04.employee, 'appointment_submit'],
  manager: [...ROLE_CAPS_M04.manager, 'appointment_submit', 'appointment_receive'],
  owner: [...ROLE_CAPS_M04.owner, 'appointment_receive'],
};
export const membersM05 = membersM04;
export function policyM05(version: number, members: Record<string, MemberGrant> = membersM05(), patch: Partial<AccessPolicy> = {}): AccessPolicy {
  return policyM04(version, members, { roles: structuredClone(ROLE_CAPS_M05), ...patch });
}
export const RECIPIENTS = JSON.stringify({ version: 1, stores: { 's-b': 'p-wang-yj', 's-a': 'p-zhou' } });

/** 可注入故障的 MemorySql：匹配的语句抛错（模拟写提醒失败等）。 */
export class FaultySql extends MemorySql {
  failOn: RegExp | null = null;
  override async query<T = Record<string, unknown>>(sql: string, params: readonly unknown[] = []): Promise<{ rows: T[] }> {
    if (this.failOn?.test(sql.replace(/\s+/g, ' '))) throw Error('injected_failure');
    return super.query<T>(sql, params);
  }
}
export async function faultyStore(): Promise<{ sql: FaultySql; store: PerformanceStore }> {
  const sql = new FaultySql(); await migratePerformance(sql);
  return { sql, store: createPostgresPerformanceStore(sql) };
}

export async function worldM05(options: SeedOptions & { router?: EmployeeRouterOptions; accessPolicy?: boolean; store?: PerformanceStore; now?: () => Date; recipients?: string | null } = {}) {
  const w = await world({ people: peopleM04, policy: policyM05(1), now: ticking(), ...options });
  if (options.recipients !== null) await w.base.setConfig(APPOINTMENT_RECIPIENTS_KEY, options.recipients ?? RECIPIENTS);
  return w;
}

/** R6 D104：没写称呼的预约先问客人。测试助手在被问到时自动回「没留名」，走到原来的「预约还没登记」草稿。无权/未开放的回复原样返回。 */
export async function registerUnnamedAppointment(
  w: { call: (member: string, text: string) => Promise<string> },
  member: string,
  text: string,
): Promise<string> {
  const first = await w.call(member, text);
  if (/请问是哪位客人/.test(first)) return w.call(member, '没留名');
  return first;
}
