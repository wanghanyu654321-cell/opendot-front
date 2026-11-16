import { expect, it, vi } from 'vitest';
import { world, policy, baseMembers, NOW } from '../role-eval/access-fixture-m03.js';
import { ACCESS_POLICY_HIGH_WATER_KEY, ACCESS_POLICY_KEY, authorize, enableOptInForMember, updateAccessPolicy } from '../../src/role-eval/access-policy.js';
import { createEmployeeLoop } from '../../src/role-eval/employee-loop.js';
import { MemorySql } from '../role-eval/sql-fixture.js';
import { createPostgresPerformanceStore, migratePerformance } from '../../src/role-eval/performance-postgres.js';
import { MemoryPerformanceStore } from '../../src/role-eval/performance-store.js';

/** R1 复现测试（由 助手B audit-m03-revocation 反例取反）：修前失败、修后通过。 */
type W = Awaited<ReturnType<typeof world>>;
const revoke = async (w: W, id: string) => {
  const next = policy(2); next.members[id]!.status = 'revoked';
  expect(await updateAccessPolicy(w.base, { expectedVersion: 1, next, actor: 'r1', reason: 'revoke', at: NOW.toISOString() })).toEqual({ ok: true, version: 2 });
};
const loopFor = (w: W) => createEmployeeLoop({
  mode: 'isolated-synthetic', store: w.base, resolve: id => w.base.getPersonByMember(id), now: () => NOW,
  send: async () => 'sent', model: { complete: async () => ({ type: 'chat', text: '' }) }, employeeLoop: true, accessPolicy: true,
});
const input = (text: string, messageId: string) => ({ memberId: 'm-wang-yj', text, messageId, sessionId: 'session-m-wang-yj', bindingVersion: 1 });
const amounts = async (w: W) => (await w.base.listEntries()).map(e => e.amount);

it('R1-M03-P0-1a: 通用 setConfig 不能回写访问策略/高水位', async () => {
  const w = await world(); await revoke(w, 'p-wang-yj');
  await expect(w.base.setConfig(ACCESS_POLICY_KEY, JSON.stringify(policy(1)))).rejects.toThrow('protected_config_key');
  await expect(w.base.setConfig(ACCESS_POLICY_HIGH_WATER_KEY, '1')).rejects.toThrow('protected_config_key');
});

it('R1-M03-P0-1b: 绕过 API 把旧版本原文写回（版本 < 高水位）后，鉴权与提交都拒绝，不复活', async () => {
  const w = await world(); await revoke(w, 'p-wang-yj');
  // 模拟配置回退/直接改库：用无版本校验的底层锁写把 v1 原文写回，高水位仍为 2。
  await w.base.updateConfigLocked(ACCESS_POLICY_KEY, [], () => ({ [ACCESS_POLICY_KEY]: JSON.stringify(policy(1)) }));
  expect(await w.base.getConfig(ACCESS_POLICY_HIGH_WATER_KEY)).toBe('2');
  const person = await w.base.getPersonByMember('m-wang-yj');
  expect((await authorize(w.base, person, 'report_proxy', 's-b')).allowed).toBe(false);
  expect(await w.call('m-wang-yj', '12号测试B店\n560（小赵）')).not.toContain('还没入账');
  expect(await w.call('m-wang-yj', '对')).not.toContain('已入账');
  expect(await amounts(w)).not.toContain(560);
});

it('R1-M03-P0-1c: 版本必须单调递增：写入版本 ≤ 当前版本直接拒绝', async () => {
  const w = await world(); await revoke(w, 'p-wang-yj');
  expect(await updateAccessPolicy(w.base, { expectedVersion: 2, next: policy(2), actor: 'r1', reason: 'same', at: NOW.toISOString() })).toEqual({ ok: false, reason: 'version_not_increasing' });
  expect(await updateAccessPolicy(w.base, { expectedVersion: 2, next: policy(1), actor: 'r1', reason: 'older', at: NOW.toISOString() })).toEqual({ ok: false, reason: 'version_not_increasing' });
});

it('R1-M03-P0-2: 提交前提交人被停用 → 入账门按当前人员行拒绝，零入账', async () => {
  const w = await world(); await w.call('m-wang-yj', '12号测试B店\n560（小赵）');
  const original = w.base.commitConfirmingDraft.bind(w.base);
  vi.spyOn(w.base, 'commitConfirmingDraft').mockImplementationOnce(async (...args) => {
    await w.base.savePerson({ ...(await w.base.getPersonByMember('m-wang-yj'))!, active: false });
    return original(...args);
  });
  expect(await w.call('m-wang-yj', '对')).not.toContain('已入账');
  expect(await amounts(w)).not.toContain(560);
});

it('R1-M03-P0-2b: 提交前提交人被降级（tier 变化）→ 拒绝', async () => {
  const w = await world(); await w.call('m-wang-yj', '12号测试B店\n560（小赵）');
  const original = w.base.commitConfirmingDraft.bind(w.base);
  vi.spyOn(w.base, 'commitConfirmingDraft').mockImplementationOnce(async (...args) => {
    await w.base.savePerson({ ...(await w.base.getPersonByMember('m-wang-yj'))!, tier: 'employee' });
    return original(...args);
  });
  expect(await w.call('m-wang-yj', '对')).not.toContain('已入账');
  expect(await amounts(w)).not.toContain(560);
});

it('R1-M03-P0-2c: 提交前提交人换绑企微成员（策略按 personId 授权、看不出变化）→ 入账门按当前人员行拒绝', async () => {
  const w = await world(); await w.call('m-wang-yj', '12号测试B店\n560（小赵）');
  const original = w.base.commitConfirmingDraft.bind(w.base);
  vi.spyOn(w.base, 'commitConfirmingDraft').mockImplementationOnce(async (...args) => {
    await w.base.savePerson({ ...(await w.base.getPersonByMember('m-wang-yj'))!, memberId: 'm-wang-yj-rebound' });
    return original(...args);
  });
  expect(await w.call('m-wang-yj', '对')).not.toContain('已入账');
  expect(await amounts(w)).not.toContain(560);
});

it('R1-M03-P0-2d: 未启用访问策略（M01 受控模式）时，提交前本人被停用 → 同一入账门仍拒绝', async () => {
  const w = await world({ accessPolicy: false }); expect(await w.call('m-zhao', '12号测试B店\n560（小赵）')).toContain('还没入账');
  const original = w.base.commitConfirmingDraft.bind(w.base);
  vi.spyOn(w.base, 'commitConfirmingDraft').mockImplementationOnce(async (...args) => {
    await w.base.savePerson({ ...(await w.base.getPersonByMember('m-zhao'))!, active: false });
    return original(...args);
  });
  expect(await w.call('m-zhao', '对')).not.toContain('已入账');
  expect(await amounts(w)).not.toContain(560);
});

it('R1-M03-P0-3: confirming 恢复分支：被代报员工调店后重发原确认 → 拒绝，不跨店入账', async () => {
  const w = await world(); await w.call('m-wang-yj', '12号测试B店\n560（小赵）');
  const original = w.base.commitConfirmingDraft.bind(w.base);
  const spy = vi.spyOn(w.base, 'commitConfirmingDraft').mockRejectedValueOnce(Error('simulate crash before commit'));
  await loopFor(w)(input('对', 'recover-confirm'));
  expect((await w.base.listDrafts())[0]!.status).toBe('confirming');
  spy.mockImplementation(original);
  await w.base.savePerson({ ...(await w.base.getPersonByMember('m-zhao'))!, storeId: 's-a', storeName: '测试A店' });
  expect((await loopFor(w)(input('对', 'recover-confirm'))).replies.join('')).not.toContain('已入账');
  expect(await amounts(w)).not.toContain(560);
});

it('R1-M03-P0-3b: 调店发生在恢复复核之后、提交事务之前 → 入账门拒绝', async () => {
  const w = await world(); await w.call('m-wang-yj', '12号测试B店\n560（小赵）');
  const original = w.base.commitConfirmingDraft.bind(w.base);
  vi.spyOn(w.base, 'commitConfirmingDraft').mockImplementationOnce(async (...args) => {
    await w.base.savePerson({ ...(await w.base.getPersonByMember('m-zhao'))!, storeId: 's-a', storeName: '测试A店' });
    return original(...args);
  });
  expect(await w.call('m-wang-yj', '对')).not.toContain('已入账');
  expect(await amounts(w)).not.toContain(560);
});

it('R1-M03-P1-1a: 能力全收后重放旧草稿原消息 → 不返回金额明细', async () => {
  const w = await world(); const text = '12号测试B店\n560（小赵）';
  await w.call('m-wang-yj', text, 'report-old');
  const next = policy(2, { ...baseMembers(), 'p-wang-yj': { role: 'manager', storeIds: ['s-b'], status: 'active', capabilities: [] } });
  await updateAccessPolicy(w.base, { expectedVersion: 1, next, actor: 'r1', reason: 'narrow', at: NOW.toISOString() });
  expect((await loopFor(w)(input(text, 'report-old'))).replies.join('')).not.toContain('560元');
});

it('R1-M03-P1-1b: 同 messageId 缓存命中时按当前权限复核，撤权后不再返回旧排名', async () => {
  const w = await world(); const before = await w.call('m-boss', '门店排名', 'cached');
  expect(before).toContain('排名');
  await revoke(w, 'p-boss');
  const after = await w.call('m-boss', '门店排名', 'cached');
  expect(after).not.toBe(before);
  expect(after).toContain('权限');
});

it('R1-M03-P1-2: 营销生成期间撤权 → 结果不发出、不返回', async () => {
  let w: W;
  w = await world({ policy: enableOptInForMember(policy(1), 'p-boss', 'marketing'), router: { marketing: { enabled: true, handle: async () => { await revoke(w, 'p-boss'); return 'R1_MARKETING_RESULT'; } } } });
  const reply = await w.call('m-boss', '写一段朋友圈营销文案');
  expect(reply).not.toContain('R1_MARKETING_RESULT');
  expect(w.outbound.join('\n')).not.toContain('R1_MARKETING_RESULT');
});

// memory-sql 替身不实现 FOR UPDATE/SHARE，并发首次初始化在真 PG17 上验证（tests/r1/r1-pg.integration.test.ts）。
it('R1-M03-P1-3: 空库并发首次初始化只有一个成功（memory-store）', async () => {
  const store = new MemoryPerformanceStore();
  const a = policy(1); const b = policy(1, { ...baseMembers(), 'p-zhao': { role: 'employee', storeIds: ['s-b'], status: 'revoked' } });
  const results = await Promise.all([a, b].map(next => updateAccessPolicy(store, { expectedVersion: null, next, actor: 'r1', reason: 'init', at: NOW.toISOString() })));
  expect(results.filter(r => r.ok)).toHaveLength(1);
  expect(await store.getConfig(ACCESS_POLICY_HIGH_WATER_KEY)).toBe('1');
});
