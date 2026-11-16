import { describe, expect, it } from 'vitest';
import { ACCESS_AUDIT_PREFIX, ACCESS_POLICY_HIGH_WATER_KEY, ACCESS_POLICY_KEY, decideAccess, parseAccessPolicy, standing, updateAccessPolicy } from '../../src/role-eval/access-policy.js';
import { MemoryPerformanceStore } from '../../src/role-eval/performance-store.js';
import { basePeople, baseMembers, NOW, policy } from './access-fixture-m03.js';

const person = (id: string) => basePeople.find(row => row.personId === id)!;
const raw = (value: unknown) => JSON.stringify(value);

describe('M03 策略解析：严格、拒绝优先', () => {
  it('缺失与损坏区分开，都不能放行', () => {
    expect(parseAccessPolicy(null)).toBe('missing');
    for (const bad of ['{', '[]', 'null', raw({ ...policy(1), extra: 1 }), raw({ ...policy(1), version: 0 }), raw({ ...policy(1), version: 1.5 }),
      raw({ ...policy(1), enterprise: ['report_self', 'god_mode'] }), raw({ ...policy(1), roles: { employee: [], manager: [] } }),
      raw({ ...policy(1), members: { 'p-lin': { role: 'boss', storeIds: ['s-a'], status: 'active' } } }),
      raw({ ...policy(1), members: { 'p-lin': { role: 'employee', storeIds: 's-a', status: 'active' } } }),
      raw({ ...policy(1), members: { 'p-lin': { role: 'employee', storeIds: ['s-a', 's-a'], status: 'active' } } }),
      raw({ ...policy(1), members: { 'p-lin': { role: 'employee', storeIds: ['s-a'], status: 'active', admin: true } } })]) {
      expect(parseAccessPolicy(bad)).toBeNull();
      expect(decideAccess(bad, person('p-lin'), 'progress_self', 's-a')).toEqual({ allowed: false, reason: 'broken_policy' });
    }
    expect(decideAccess(null, person('p-lin'), 'progress_self', 's-a')).toEqual({ allowed: false, reason: 'no_policy' });
  });
});

describe('M03 判定：角色、门店、状态、能力交集', () => {
  const p = raw(policy(3));
  it('三档基本矩阵', () => {
    expect(decideAccess(p, person('p-lin'), 'progress_self', 's-a').allowed).toBe(true);
    expect(decideAccess(p, person('p-lin'), 'progress_other', 's-a')).toMatchObject({ allowed: false, reason: 'capability_denied' });
    expect(decideAccess(p, person('p-zhou'), 'store_summary', 's-a').allowed).toBe(true);
    expect(decideAccess(p, person('p-zhou'), 'store_summary', 's-b')).toMatchObject({ allowed: false, reason: 'store_out_of_scope' });
    expect(decideAccess(p, person('p-zhou'), 'stores_ranking', 's-a')).toMatchObject({ allowed: false, reason: 'capability_denied' });
    expect(decideAccess(p, person('p-boss'), 'stores_ranking', 's-a').allowed).toBe(true);
    expect(decideAccess(p, person('p-boss'), 'store_summary', 's-b')).toMatchObject({ allowed: false, reason: 'store_out_of_scope' });
  });
  it('老板空门店集合 = 无门店，不是全部', () => {
    const members = { ...baseMembers(), 'p-boss': { role: 'owner' as const, storeIds: [], status: 'active' as const } };
    for (const storeId of ['s-a', 's-b']) expect(decideAccess(raw(policy(4, members)), person('p-boss'), 'stores_ranking', storeId)).toMatchObject({ allowed: false, reason: 'store_out_of_scope' });
  });
  it('员工/店长授权门店必须正好是本人所在店', () => {
    const members = { ...baseMembers(), 'p-zhou': { role: 'manager' as const, storeIds: ['s-a', 's-b'], status: 'active' as const } };
    expect(decideAccess(raw(policy(4, members)), person('p-zhou'), 'store_summary', 's-a')).toMatchObject({ allowed: false, reason: 'store_out_of_scope' });
  });
  it('显式空列表就是空：企业层、门店层、角色层、成员收窄、平台层任一缺能力即拒绝', () => {
    const lin = person('p-lin');
    expect(decideAccess(raw(policy(5, baseMembers(), { enterprise: [] })), lin, 'progress_self', 's-a').allowed).toBe(false);
    expect(decideAccess(raw(policy(5, baseMembers(), { stores: { 's-a': [] } })), lin, 'progress_self', 's-a').allowed).toBe(false);
    expect(decideAccess(raw(policy(5, baseMembers(), { stores: {} })), lin, 'progress_self', 's-a').allowed).toBe(false);
    expect(decideAccess(raw(policy(5, baseMembers(), { roles: { employee: [], manager: [], owner: [] } })), lin, 'progress_self', 's-a').allowed).toBe(false);
    expect(decideAccess(raw(policy(5, { ...baseMembers(), 'p-lin': { role: 'employee', storeIds: ['s-a'], status: 'active', capabilities: [] } })), lin, 'progress_self', 's-a').allowed).toBe(false);
    expect(decideAccess(raw(policy(5)), lin, 'progress_self', 's-a', []).allowed).toBe(false);
    expect(decideAccess(raw(policy(5)), lin, 'progress_self', 's-a', ['progress_self']).allowed).toBe(true);
    // 成员收窄不能放大：员工列出 store_summary 仍被角色层拒绝。
    expect(decideAccess(raw(policy(5, { ...baseMembers(), 'p-lin': { role: 'employee', storeIds: ['s-a'], status: 'active', capabilities: ['store_summary'] } })), lin, 'store_summary', 's-a').allowed).toBe(false);
  });
  it('伪造老板：档案 tier 或岗位角色写成 owner，但授权不是 owner → role_mismatch；停用/撤销 → inactive；无授权 → no_grant', () => {
    const forged = { ...person('p-lin'), tier: 'owner' as const, roles: ['manager' as const] };
    expect(decideAccess(p, forged, 'stores_ranking', 's-a')).toMatchObject({ allowed: false, reason: 'role_mismatch' });
    expect(standing(p, forged)).toMatchObject({ allowed: false, reason: 'role_mismatch' });
    for (const status of ['suspended', 'revoked'] as const)
      expect(decideAccess(raw(policy(6, { ...baseMembers(), 'p-lin': { role: 'employee', storeIds: ['s-a'], status } })), person('p-lin'), 'progress_self', 's-a')).toMatchObject({ allowed: false, reason: 'inactive' });
    expect(decideAccess(p, { ...person('p-lin'), personId: 'p-ghost' }, 'progress_self', 's-a')).toMatchObject({ allowed: false, reason: 'no_grant' });
    expect(decideAccess(p, { ...person('p-lin'), active: false }, 'progress_self', 's-a')).toMatchObject({ allowed: false, reason: 'inactive' });
  });
});

describe('M03 版本化变更与审计', () => {
  it('期望版本冲突、版本不递增、回写旧配置都被拒；成功写入策略+高水位+审计', async () => {
    const store = new MemoryPerformanceStore();
    const at = NOW.toISOString();
    expect(await updateAccessPolicy(store, { expectedVersion: null, next: policy(2), actor: 'admin', reason: 'init', at })).toEqual({ ok: true, version: 2 });
    expect(await updateAccessPolicy(store, { expectedVersion: null, next: policy(3), actor: 'admin', reason: 'stale', at })).toEqual({ ok: false, reason: 'version_conflict' });
    expect(await updateAccessPolicy(store, { expectedVersion: 2, next: policy(2), actor: 'admin', reason: 'same', at })).toEqual({ ok: false, reason: 'version_not_increasing' });
    const demoted = { ...baseMembers(), 'p-wang-yj': { role: 'employee' as const, storeIds: ['s-b'], status: 'active' as const } };
    expect(await updateAccessPolicy(store, { expectedVersion: 2, next: policy(3, demoted), actor: 'admin', reason: '降级', at })).toEqual({ ok: true, version: 3 });
    // 有人绕过接口把策略原文改回旧版本 2：高水位 3 仍在，后续以 v3 为期望也不能写入 ≤3 的版本。
    // R1：setConfig 已拒写策略键；用锁内写模拟绕过。
    await expect(store.setConfig(ACCESS_POLICY_KEY, JSON.stringify(policy(2)))).rejects.toThrow('protected_config_key');
    await store.updateConfigLocked(ACCESS_POLICY_KEY, [], () => ({ [ACCESS_POLICY_KEY]: JSON.stringify(policy(2)) }));
    expect(await updateAccessPolicy(store, { expectedVersion: 2, next: policy(3), actor: 'admin', reason: 'resurrect', at })).toEqual({ ok: false, reason: 'version_not_increasing' });
    expect(await store.getConfig(ACCESS_POLICY_HIGH_WATER_KEY)).toBe('3');
    const audit = JSON.parse((await store.getConfig(`${ACCESS_AUDIT_PREFIX}3`))!);
    expect(audit).toMatchObject({ version: 3, previousVersion: 2, actor: 'admin', reason: '降级' });
    expect(audit.members['p-wang-yj']).toEqual({ role: 'employee', storeIds: ['s-b'], status: 'active' });
    // 非法策略不写入。
    expect(await updateAccessPolicy(store, { expectedVersion: 2, next: { ...policy(9), enterprise: ['x' as never] }, actor: 'admin', reason: 'bad', at })).toEqual({ ok: false, reason: 'invalid' });
  });
});
