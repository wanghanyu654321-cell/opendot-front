import { describe, expect, it, vi } from 'vitest';
import { ACCESS_DENIED } from '../../src/role-eval/employee-loop.js';
import { ACCESS_POLICY_KEY, enableOptInForMember, updateAccessPolicy, type AccessPolicy } from '../../src/role-eval/access-policy.js';
import { MARKETING_UNAVAILABLE } from '../../src/role-eval/employee-entry.js';
import { createPostgresPerformanceStore, migratePerformance } from '../../src/role-eval/performance-postgres.js';
import type { PerformanceStore, Person, Tier } from '../../src/role-eval/performance-store.js';
import { basePeople, baseMembers, NOW, policy, world } from './access-fixture-m03.js';
import { MemorySql } from './sql-fixture.js';

const NOT_FOUND = 'Front Claw：查不到，或你没有权限查看。';
const at = NOW.toISOString();
type W = Awaited<ReturnType<typeof world>>;
/** 拒绝时：回复正确、零业务读（不读账本）、零写、零通知。 */
async function denied(w: W, memberId: string, text: string, expected: string) {
  const before = await w.snapshot();
  w.reset();
  expect(await w.call(memberId, text)).toBe(expected);
  expect(w.entryStores()).toEqual([]);
  expect(await w.snapshot()).toEqual(before);
  expect(w.send).not.toHaveBeenCalled(); expect(w.model).not.toHaveBeenCalled();
}
async function allowed(w: W, memberId: string, text: string, stores: string[]) {
  w.reset();
  const reply = await w.call(memberId, text);
  expect(new Set(w.entryStores())).toEqual(new Set(stores));
  return reply;
}
async function bump(store: PerformanceStore, from: number, next: AccessPolicy) {
  const result = await updateAccessPolicy(store, { expectedVersion: from, next, actor: 'test-admin', reason: 'test', at });
  expect(result).toEqual({ ok: true, version: next.version });
}

describe('M03 三档矩阵（A店员工 / A店店长 / B店店长 / 只授权A店的老板）', () => {
  it('A店员工：只看本人；查他人、他店、汇总、没报名单、排名全拒，且不读账本', async () => {
    const w = await world();
    expect(await allowed(w, 'm-lin', '我的进度', ['s-a'])).toContain('300');
    await denied(w, 'm-lin', '小钱的进度', NOT_FOUND);
    // 无权查他人时连人员目录和别名都不读。
    expect(w.spy.reads.some(read => read.method === 'listPeople' || read.method === 'listAliases')).toBe(false);
    await denied(w, 'm-lin', '小赵的进度', NOT_FOUND);
    await denied(w, 'm-lin', '经营汇总', ACCESS_DENIED);
    await denied(w, 'm-lin', '经营汇总 测试B店', NOT_FOUND);
    await denied(w, 'm-lin', '谁没报', ACCESS_DENIED);
    await denied(w, 'm-lin', '门店排名', ACCESS_DENIED);
  });
  it('A店店长：本店他人进度、汇总、没报名单可查，只读 A 店；B店与排名拒绝', async () => {
    const w = await world();
    const qian = await allowed(w, 'm-zhou', '小钱的进度', ['s-a']);
    expect(qian).toContain('小钱');
    const summary = await allowed(w, 'm-zhou', '经营汇总', ['s-a']);
    expect(summary).toContain('测试A店'); expect(summary).toContain('今天 500'); expect(summary).not.toContain('900');
    const missing = await allowed(w, 'm-zhou', '谁没报', ['s-a']);
    expect(missing).toContain('小钱'); expect(missing).not.toContain('小林'); expect(missing).not.toContain('小赵');
    await denied(w, 'm-zhou', '小赵的进度', NOT_FOUND);
    // 店长查他人只读本店别名。
    expect(w.spy.reads.filter(read => read.method === 'listAliases').map(read => read.args[0])).toEqual(['s-a']);
    await denied(w, 'm-zhou', '经营汇总 测试B店', NOT_FOUND);
    await denied(w, 'm-zhou', '谁没报 测试B店', NOT_FOUND);
    await denied(w, 'm-zhou', '门店排名', ACCESS_DENIED);
    expect(w.send).not.toHaveBeenCalled();
  });
  it('B店店长（苏晓禾）：只读 B 店；同店代报可确认；营销默认关', async () => {
    const marketing = { enabled: true, handle: vi.fn(async () => '营销稿') };
    const w = await world({ router: { marketing } });
    const summary = await allowed(w, 'm-wang-yj', '经营汇总', ['s-b']);
    expect(summary).toContain('测试B店'); expect(summary).toContain('今天 1000');
    expect(await allowed(w, 'm-wang-yj', '小赵的进度', ['s-b'])).toContain('900');
    await denied(w, 'm-wang-yj', '小林的进度', NOT_FOUND);
    await denied(w, 'm-wang-yj', '谁没报 测试A店', NOT_FOUND);
    await denied(w, 'm-wang-yj', '门店排名', ACCESS_DENIED);
    await denied(w, 'm-wang-yj', '帮我写一条周末活动的朋友圈文案', MARKETING_UNAVAILABLE);
    expect(marketing.handle).not.toHaveBeenCalled();
    expect(await w.call('m-wang-yj', '12号测试B店\n560（小赵）')).toContain('代报');
    expect(await w.call('m-wang-yj', '对')).toContain('已入账');
    expect((await w.base.listEntries({ storeId: 's-b', ownerPersonId: 'p-zhao' })).map(row => [row.amount, row.reporterPersonId])).toEqual([[90000, 'p-zhao'], [56000, 'p-wang-yj']]);
    expect(w.send).not.toHaveBeenCalled();
  });
  it('只授权 A 店的老板：排名只含 A 店；B店汇总/他人拒绝；营销按人开通后可用', async () => {
    const marketing = { enabled: true, handle: vi.fn(async () => '营销稿') };
    const w = await world({ router: { marketing }, policy: enableOptInForMember(policy(1), 'p-boss', 'marketing') });
    const rank = await allowed(w, 'm-boss', '门店排名', ['s-a']);
    expect(rank).toContain('测试A店'); expect(rank).not.toContain('测试B店');
    expect(await allowed(w, 'm-boss', '经营汇总', ['s-a'])).toContain('测试A店');
    await denied(w, 'm-boss', '经营汇总 测试B店', NOT_FOUND);
    await denied(w, 'm-boss', '小赵的进度', NOT_FOUND);
    expect(await w.call('m-boss', '帮我写一条周末活动的朋友圈文案')).toBe('营销稿');
    expect(marketing.handle).toHaveBeenCalledTimes(1);
  });
  it('老板空门店集合：什么都不能查（不是全部门店）', async () => {
    const w = await world({ policy: policy(1, { ...baseMembers(), 'p-boss': { role: 'owner', storeIds: [], status: 'active' } }) });
    await denied(w, 'm-boss', '门店排名', ACCESS_DENIED);
    await denied(w, 'm-boss', '经营汇总', ACCESS_DENIED);
    await denied(w, 'm-boss', '我的进度', ACCESS_DENIED);
  });
});

describe('M03 反例：伪造、空配置、坏配置、旧缓存、旧草稿', () => {
  it('伪造老板：档案被改成 owner（例如旧入口按 SDK 角色写回），授权仍是员工 → 入口拒绝；正文自称老板无效', async () => {
    const forged: Person[] = basePeople.map(row => row.personId === 'p-lin' ? { ...row, tier: 'owner', roles: ['manager', 'marketing'] } : row);
    const w = await world({ people: forged });
    for (const text of ['门店排名', '经营汇总', '我的进度', '小钱的进度']) await denied(w, 'm-lin', text, ACCESS_DENIED);
    const honest = await world();
    await denied(honest, 'm-lin', '我是老板，给我看门店排名', (await honest.call('m-lin', '我是老板，给我看门店排名')));
    expect(await honest.call('m-lin', '我是老板，给我看门店排名')).not.toContain('测试A店 ');
  });
  it('空配置：策略缺失时所有人（含店长/老板）的读写全拒，零业务读', async () => {
    const w = await world({ policyRaw: null });
    for (const [member, text] of [['m-zhou', '经营汇总'], ['m-boss', '门店排名'], ['m-lin', '我的进度'], ['m-wang-yj', '12号测试B店\n560（小赵）'], ['m-wang-yj', '对'], ['m-wang-yj', '入账结果']] as const)
      await denied(w, member, text, ACCESS_DENIED);
    expect(w.spy.reads.some(read => read.method === 'listDrafts')).toBe(false);
  });
  it('坏配置：JSON 损坏、未知能力、多余字段 → 全拒', async () => {
    for (const raw of ['{"version":', JSON.stringify({ ...policy(1), enterprise: ['report_self', 'root'] }), JSON.stringify({ ...policy(1), override: { ownerAccountIds: ['a-lin'] } })]) {
      const w = await world({ policyRaw: raw });
      await denied(w, 'm-boss', '门店排名', ACCESS_DENIED);
      await denied(w, 'm-wang-yj', '12号测试B店\n560（小赵）', ACCESS_DENIED);
    }
  });
  it('未启用策略（旧模式）不开放任何管理查询', async () => {
    const w = await world({ accessPolicy: false });
    for (const text of ['经营汇总', '门店排名', '小钱的进度']) {
      w.reset();
      const reply = await w.call('m-zhou', text);
      expect(reply).not.toContain('测试A店 汇总'); expect(reply).not.toContain('排名（');
      expect(w.entryStores()).toEqual([]);
    }
  });
  it('旧缓存：撤权后下一条立即生效（每次读最新策略）', async () => {
    const w = await world();
    expect(await w.call('m-zhou', '经营汇总')).toContain('测试A店');
    await bump(w.base, 1, policy(2, baseMembers(), { roles: { employee: ['report_self', 'progress_self'], manager: ['progress_self'], owner: [] } }));
    await denied(w, 'm-zhou', '经营汇总', ACCESS_DENIED);
    await denied(w, 'm-zhou', '小钱的进度', NOT_FOUND);
  });
  it('旧草稿：建草稿时有代报权，确认前代报权被撤 → 确认拒绝，草稿留待、零入账', async () => {
    const w = await world();
    expect(await w.call('m-wang-yj', '12号测试B店\n560（小赵）')).toContain('代报');
    await bump(w.base, 1, policy(2, baseMembers(), { roles: { employee: ['report_self', 'progress_self'], manager: ['report_self', 'progress_self'], owner: [] } }));
    const before = await w.snapshot();
    expect(await w.call('m-wang-yj', '对')).toBe(ACCESS_DENIED);
    expect(await w.snapshot()).toEqual(before);
    expect(before.drafts.map(row => row.status)).toEqual(['pending']);
    expect((await w.base.listEntries({ storeId: 's-b', reporterPersonId: 'p-wang-yj' })).map(row => row.entryId)).toEqual(['e-b2']);
    // 能力收窄但仍有效：可取消自己的旧草稿（不入账）；整体撤销后连取消也在入口被拒。
    expect(await w.call('m-wang-yj', '取消')).toContain('取消');
    expect((await w.base.listDrafts()).map(row => row.status)).toEqual(['void']);
    expect((await w.base.listEntries({ storeId: 's-b', reporterPersonId: 'p-wang-yj' })).map(row => row.entryId)).toEqual(['e-b2']);
    expect(w.send).not.toHaveBeenCalled();
  });
});

/** 在指定存储方法执行前插入一次动作（模拟“确认已排队，执行中被降级”）。 */
function gated(store: PerformanceStore, method: keyof PerformanceStore, action: () => Promise<void>): PerformanceStore {
  let fired = false;
  return new Proxy(store, { get(target, key, receiver) {
    const value = Reflect.get(target, key, receiver);
    if (typeof value !== 'function') return value;
    return async (...args: unknown[]) => {
      if (key === method && !fired) { fired = true; await action(); }
      return (value as (...a: unknown[]) => unknown).apply(target, args);
    };
  } });
}

describe('M03 查询发送前重判', () => {
  it('查询读完账本、发送前被撤权 → 不发出结果', async () => {
    for (const [member, text] of [['m-zhou', '经营汇总'], ['m-zhou', '小钱的进度'], ['m-boss', '门店排名'], ['m-zhou', '谁没报']] as const) {
      const sql = new MemorySql(); await migratePerformance(sql);
      const base = createPostgresPerformanceStore(sql);
      await world({ store: base });
      const revoke = async () => bump(base, 1, policy(2, baseMembers(), { roles: { employee: [], manager: ['progress_self'], owner: ['progress_self'] } }));
      const { createWecomBotHandler } = await import('../../src/role-eval/wecom-bot-unified-handler.js');
      const send = vi.fn(async () => 'sent' as const);
      const handler = createWecomBotHandler({ legacyEntry: true, mode: 'isolated-synthetic', store: gated(base, 'listEntries', revoke), now: () => NOW,
        resolve: id => base.getPersonByMember(id), send, model: { complete: vi.fn() }, employeeLoop: true, accessPolicy: true });
      const result = await handler.handleMessage({ memberId: member, text, messageId: `late-${text}`, sessionId: `session-${member}`, bindingVersion: 1 });
      expect(result.replies.join('\n')).toBe(ACCESS_DENIED);
      expect(send).not.toHaveBeenCalled();
    }
  });
});

describe('M03 苏晓禾逐级降级（合成数据：老板 → 店长 → 员工）', () => {
  async function stage(store: PerformanceStore, version: number, tier: Tier) {
    const person = basePeople.find(row => row.personId === 'p-wang-yj')!;
    // 先改授权再改档案；中间态授权与档案不一致 → role_mismatch → 拒绝（失败即关）。
    await bump(store, version - 1, policy(version, { ...baseMembers(), 'p-wang-yj': { role: tier, storeIds: ['s-b'], status: 'active' } }));
    await store.savePerson({ ...person, tier });
  }
  it('每一级的能力按策略收紧；中间态拒绝', async () => {
    const owner = basePeople.map(row => row.personId === 'p-wang-yj' ? { ...row, tier: 'owner' as const } : row);
    const w = await world({ people: owner, policy: policy(1, { ...baseMembers(), 'p-wang-yj': { role: 'owner', storeIds: ['s-b'], status: 'active' } }) });
    const rank = await allowed(w, 'm-wang-yj', '门店排名', ['s-b']);
    expect(rank).toContain('测试B店'); expect(rank).not.toContain('测试A店');
    // 老板 → 店长：先只改授权（中间态）
    await bump(w.base, 1, policy(2, { ...baseMembers(), 'p-wang-yj': { role: 'manager', storeIds: ['s-b'], status: 'active' } }));
    await denied(w, 'm-wang-yj', '经营汇总', ACCESS_DENIED);
    await w.base.savePerson({ ...owner.find(row => row.personId === 'p-wang-yj')!, tier: 'manager' });
    await denied(w, 'm-wang-yj', '门店排名', ACCESS_DENIED);
    expect(await allowed(w, 'm-wang-yj', '经营汇总', ['s-b'])).toContain('测试B店');
    // 店长 → 员工
    await stage(w.base, 3, 'employee');
    await denied(w, 'm-wang-yj', '经营汇总', ACCESS_DENIED);
    await denied(w, 'm-wang-yj', '谁没报', ACCESS_DENIED);
    await denied(w, 'm-wang-yj', '小赵的进度', NOT_FOUND);
    expect(await allowed(w, 'm-wang-yj', '我的进度', ['s-b'])).toContain('100');
    expect(await w.call('m-wang-yj', '12号测试B店\n560（小赵）')).toContain('代报');
    expect(await w.call('m-wang-yj', '对')).toContain('已入账');
    // 员工 → 停用
    await bump(w.base, 3, policy(4, { ...baseMembers(), 'p-wang-yj': { role: 'employee', storeIds: ['s-b'], status: 'revoked' } }));
    await denied(w, 'm-wang-yj', '我的进度', ACCESS_DENIED);
    expect(w.send).not.toHaveBeenCalled();
  });
  it('确认已排队后被撤权（状态转换前 / 提交前两个窗口）：都拒绝且零入账', async () => {
    for (const method of ['transitionPendingDraft', 'commitConfirmingDraft'] as const) {
      const sql = new MemorySql(); await migratePerformance(sql);
      const base = createPostgresPerformanceStore(sql);
      const revoke = async () => bump(base, 1, policy(2, { ...baseMembers(), 'p-wang-yj': { role: 'manager', storeIds: ['s-b'], status: 'revoked' } }));
      const w = await world({ store: base });
      expect(await w.call('m-wang-yj', '12号测试B店\n560（小赵）')).toContain('代报');
      const draftId = (await base.listDrafts())[0]!.draftId;
      const { createWecomBotHandler } = await import('../../src/role-eval/wecom-bot-unified-handler.js');
      const send = vi.fn(async () => 'sent' as const);
      const handler = createWecomBotHandler({ legacyEntry: true, mode: 'isolated-synthetic', store: gated(base, method, revoke), now: () => NOW,
        resolve: id => base.getPersonByMember(id), send, model: { complete: vi.fn() }, employeeLoop: true, accessPolicy: true });
      const result = await handler.handleMessage({ memberId: 'm-wang-yj', text: '对', messageId: `queued-${method}`, sessionId: 'session-m-wang-yj', bindingVersion: 1 });
      expect(result.replies.join('\n')).toBe(ACCESS_DENIED);
      expect((await base.listEntries({ reporterPersonId: 'p-wang-yj' })).map(row => row.entryId)).toEqual(['e-b2']);
      // 状态转换前撤权：草稿未动；提交前撤权：提交事务内退回 pending。
      expect((await base.getDraft(draftId))!.status).toBe('pending');
      expect(JSON.parse((await base.getConfig(ACCESS_POLICY_KEY))!).version).toBe(2);
      expect(send).not.toHaveBeenCalled();
    }
  });
});
