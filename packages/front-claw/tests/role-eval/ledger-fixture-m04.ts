import type { AccessPolicy, Capability, MemberGrant } from '../../src/role-eval/access-policy.js';
import type { Person, Tier } from '../../src/role-eval/performance-store.js';
import { basePeople, baseMembers, NOW, policy, ROLE_CAPS, world, type SeedOptions } from './access-fixture-m03.js';
import type { EmployeeRouterOptions } from '../../src/role-eval/employee-entry.js';
import type { PerformanceStore } from '../../src/role-eval/performance-store.js';

/**
 * M04 合成世界：在 M03 世界上加 B 店员工“小王”（PM 例句「张姐 680（小王）」），并给角色补 M04 能力（测试用，非真实配置）：
 * 员工 +correct_own；店长 +correct_own/correct_store/target_set；老板 +target_set/correct_store。
 */
export const xiaoWang: Person = { personId: 'p-xw', accountId: 'a-xw', memberId: 'm-xw', displayName: '小王', storeId: 's-b', storeName: '测试B店', tier: 'employee', roles: [], active: true };
export const peopleM04: Person[] = [...basePeople, xiaoWang];
export const ROLE_CAPS_M04: Record<Tier, Capability[]> = {
  employee: [...ROLE_CAPS.employee, 'correct_own'],
  manager: [...ROLE_CAPS.manager, 'correct_own', 'correct_store', 'target_set'],
  owner: [...ROLE_CAPS.owner, 'target_set', 'correct_store'],
};
export const membersM04 = (): Record<string, MemberGrant> => ({ ...baseMembers(), 'p-xw': { role: 'employee', storeIds: ['s-b'], status: 'active' } });
export function policyM04(version: number, members = membersM04(), patch: Partial<AccessPolicy> = {}): AccessPolicy {
  return policy(version, members, { roles: structuredClone(ROLE_CAPS_M04), ...patch });
}
/** 走动时钟：每次读时间前进 1 秒（同一营业日内），让“刚才/最近一笔”有真实先后；固定时钟下多批同刻会被判为不唯一。 */
export function ticking(start = NOW.getTime(), stepMs = 1000): () => Date { let t = start; return () => new Date(t += stepMs); }
export function worldM04(options: SeedOptions & { router?: EmployeeRouterOptions; accessPolicy?: boolean; store?: PerformanceStore; now?: () => Date } = {}) {
  return world({ people: peopleM04, policy: policyM04(1), now: ticking(), ...options });
}
