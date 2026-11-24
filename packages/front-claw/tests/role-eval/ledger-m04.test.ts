import { describe, expect, it } from 'vitest';
import { ACCESS_DENIED } from '../../src/role-eval/employee-loop.js';
import { CLARIFY_REPLY } from '../../src/role-eval/employee-entry.js';
import { updateAccessPolicy } from '../../src/role-eval/access-policy.js';
import { createWecomBotHandler } from '../../src/role-eval/wecom-bot-unified-handler.js';
import { MemoryPerformanceStore, type PerformanceStore } from '../../src/role-eval/performance-store.js';
import { NOW, entry } from './access-fixture-m03.js';
import { membersM04, peopleM04, policyM04, worldM04 } from './ledger-fixture-m04.js';

const NOT_FOUND = 'Front Claw：查不到，或你没有权限查看。';
const CONFLICT = 'Front Claw：对象在你确认前已被改动（可能别人刚改过或刚入账），这次没有写入，请重新发起。';
const NO_DRAFT = 'Front Claw：没有待确认的本人草稿，请先发送报数清单。';
const at = NOW.toISOString();
type W = Awaited<ReturnType<typeof worldM04>>;
const newEntries = async (w: W) => (await w.base.listEntries()).filter(row => !row.entryId.startsWith('e-'));
const pending = async (w: W) => w.base.listDrafts({ status: 'pending' });
async function bump(store: PerformanceStore, from: number, next: ReturnType<typeof policyM04>) {
  expect(await updateAccessPolicy(store, { expectedVersion: from, next, actor: 'test-admin', reason: 'test', at })).toEqual({ ok: true, version: next.version });
}
/** 拒绝：回复正确、账目/草稿/目标/修订/通知都不变、未发送。 */
async function unchanged(w: W, memberId: string, text: string, expected: string | RegExp) {
  const before = { s: await w.snapshot(), t: await w.base.listTargets(), n: await w.base.listNotifications() };
  const reply = await w.call(memberId, text);
  if (typeof expected === 'string') expect(reply).toBe(expected); else expect(reply).toMatch(expected);
  expect({ s: await w.snapshot(), t: await w.base.listTargets(), n: await w.base.listNotifications() }).toEqual(before);
  expect(w.send).not.toHaveBeenCalled();
  return reply;
}

it.each([
  ['correction', '改 9', false, /没有第9笔/],
  ['correction', '改 9', true, ACCESS_DENIED],
  ['correction', '改 1', false, /在你指定前已被改动/],
  ['correction', '改 1', true, ACCESS_DENIED],
  ['report', '改 1', false, /在你指定前已被改动/],
  ['report', '改 1', true, ACCESS_DENIED],
] as const)('checks authority before disclosing selection state (%s, %s, revoked=%s)', async (kind, selection, revoked, expected) => {
  const w = await worldM04({ store: new MemoryPerformanceStore() });
  const member = 'm-wang-yj';
  const reporter = peopleM04.find(person => person.memberId === member)!;
  const ids = kind === 'correction' ? ['selection-a', 'selection-b'] : ['selection-a'];
  await w.base.insertEntries(ids.map(id => ({ ...entry(id, 's-b', reporter, 68000), customerName: '许姐' })));
  const command = kind === 'correction' ? '把许姐那笔改成860' : '许姐 860';
  expect(await w.call(member, command)).toContain('改 1');
  expect((await pending(w))[0]?.kind).toBe(kind);
  if (selection === '改 1') {
    await w.base.reviseEntry('selection-a', { amount: 71000 }, {
      editorPersonId: reporter.personId, reason: 'changed after listing', createdAt: at, revisionId: 'selection-revision',
    });
  }
  if (revoked) {
    const members = membersM04();
    members[reporter.personId]!.capabilities = ['report_self', 'progress_self'];
    await bump(w.base, 1, policyM04(2, members));
  }
  await unchanged(w, member, selection, expected);
});

describe('M04 PM 例句：无标题清单直接待确认；「把刚才那笔改成600」「撤回刚才的报数」进更正流程', () => {
  it('同店代报「张姐 680（小王）」→ 待确认 → 对 → 记给小王；改成600 → 对 → 一条修订+改账通知意图；撤回 → 对 → 作废且汇总不再计入', async () => {
    const w = await worldM04();
    const echo = await w.call('m-zhao', '张姐 680（小王）');
    expect(echo).toContain('还没入账（同店代报'); expect(echo).toContain('小王 680元'); expect(echo).toContain('2026-11-12');
    expect(await newEntries(w)).toEqual([]);
    expect(await w.call('m-zhao', '对')).toContain('已入账 1 笔，共 680元');
    const [recorded] = await newEntries(w);
    expect(recorded).toMatchObject({ ownerPersonId: 'p-xw', ownerName: '小王', reporterPersonId: 'p-zhao', customerName: '张姐', amount: 68000, storeId: 's-b' });

    const amend = await w.call('m-zhao', '把刚才那笔改成600');
    expect(amend).not.toBe(CLARIFY_REPLY);
    expect(amend).toContain('还没改账'); expect(amend).toContain('680元 → 600元');
    expect((await w.base.getEntry(recorded!.entryId))!.amount).toBe(68000);
    expect(await w.call('m-zhao', '对')).toContain('已改账');
    expect((await w.base.getEntry(recorded!.entryId))!.amount).toBe(60000);
    const revisions = await w.base.listRevisions(recorded!.entryId);
    expect(revisions).toHaveLength(1);
    expect(JSON.parse(revisions[0]!.beforeJson).amount).toBe(68000); expect(JSON.parse(revisions[0]!.afterJson).amount).toBe(60000);
    expect(revisions[0]!.editorPersonId).toBe('p-zhao');
    const notices = await w.base.listNotifications();
    expect(notices.map(n => [n.kind, n.recipientPersonId, n.status])).toEqual([['correction', 'p-xw', 'pending']]);

    const withdraw = await w.call('m-zhao', '撤回刚才的报数');
    expect(withdraw).not.toBe(CLARIFY_REPLY); expect(withdraw).toContain('还没撤回');
    expect(await w.call('m-zhao', '对')).toContain('已撤回 1 笔');
    expect((await w.base.getEntry(recorded!.entryId))!.status).toBe('voided');
    expect(await w.base.listRevisions(recorded!.entryId)).toHaveLength(2);
    const summary = await w.call('m-wang-yj', '经营汇总');
    expect(summary).not.toContain('小王'); expect(summary).toContain('今天 1000');
    // 已撤回后再撤回：没有可更正账目，零写。
    await unchanged(w, 'm-zhao', '撤回刚才的报数', /已经没有可更正的账目/);
    expect(w.send).not.toHaveBeenCalled(); expect(w.model).not.toHaveBeenCalled();
  });
  it('多行无标题清单进同一张待确认；含非标准行时不猜（回标准格式提示），零写', async () => {
    const w = await worldM04();
    expect(await w.call('m-zhao', '王女士 1200（小赵）\n陈姐 300（小赵）')).toMatch(/客户：王女士\n小赵 1200元\n客户：陈姐\n小赵 300元/);
    expect(await pending(w)).toHaveLength(1);
    expect(await w.call('m-zhao', '取消')).toContain('取消');
    await unchanged(w, 'm-zhao', '王女士 1200（小赵）\n还有一笔明天再说', /请发标准清单/);
  });
  it('跨店代报仍拒绝（括号里是A店员工），零写', async () => {
    const w = await worldM04();
    await unchanged(w, 'm-zhao', '张姐 680（小林）', /跨店不能代报/);
  });
});

describe('M04 目标：先回显后确认，取消不写、重复确认只写一次、范围受策略约束', () => {
  it('店长给本店员工定目标：回显（门店/姓名/周期/金额/原值）→ 取消零写 → 再发 → 对 → 写一次；重放与再「对」都不再写', async () => {
    const w = await worldM04();
    const echo = await w.call('m-wang-yj', '给小赵定本月目标3万');
    expect(echo).toContain('目标还没生效：测试B店 小赵 2026-11 月目标 30000元（原未设置）');
    expect(await w.base.getTarget('s-b', 'p-zhao', '2026-11')).toBeNull();
    expect(await w.call('m-wang-yj', '取消')).toContain('已取消，没有写入');
    expect(await w.base.listTargets()).toEqual([]);
    await w.call('m-wang-yj', '给小赵定本月目标3万');
    expect(await w.call('m-wang-yj', '对', 'confirm-target')).toContain('已设目标');
    expect(await w.base.getTarget('s-b', 'p-zhao', '2026-11')).toMatchObject({ amount: 3000000, updatedBy: 'p-wang-yj' });
    expect(await w.call('m-wang-yj', '对', 'confirm-target')).toContain('已设目标');
    expect(await w.call('m-wang-yj', '对')).toBe(NO_DRAFT);
    expect(await w.base.listTargets()).toHaveLength(1);
    // 改目标：回显原值；进度按新目标算。
    expect(await w.call('m-wang-yj', '把小赵本月目标改成4万')).toContain('原 30000元');
    await w.call('m-wang-yj', '对');
    expect((await w.base.getTarget('s-b', 'p-zhao', '2026-11'))!.amount).toBe(4000000);
    expect(await w.call('m-wang-yj', '本月目标 5w')).toContain('测试B店 苏晓禾 2026-11 月目标 50000元');
    await w.call('m-wang-yj', '对');
    expect((await w.base.getTarget('s-b', 'p-wang-yj', '2026-11'))!.amount).toBe(5000000);
    expect(w.send).not.toHaveBeenCalled();
  });
  it('员工无 target_set；店长不能给他店定；老板只在授权门店（A店）；名字查不到与无权同一句话', async () => {
    const w = await worldM04();
    await unchanged(w, 'm-zhao', '本月目标 5w', ACCESS_DENIED);
    await unchanged(w, 'm-zhao', '给小王定本月目标3万', /不能做——你没有权限设或改目标|当前权限不允许这项操作/);
    w.reset();
    await unchanged(w, 'm-wang-yj', '给小林定本月目标3万', NOT_FOUND);
    expect(w.spy.reads.filter(read => read.method === 'listAliases').map(read => read.args[0])).toEqual(['s-b']);
    await w.base.setConfig('employee-loop:m01', JSON.stringify({ enabled: true, storeId: 's-a', memberIds: ['m-boss', 'm-zhou'] }));
    await unchanged(w, 'm-boss', '给小赵定本月目标3万', NOT_FOUND);
    expect(await w.call('m-boss', '给小林定本月目标3万')).toContain('测试A店 小林');
    await w.call('m-boss', '对');
    expect((await w.base.getTarget('s-a', 'p-lin', '2026-11'))!.amount).toBe(3000000);
  });
  it('回显后目标被别人改了 → 确认作废、不覆盖；有待确认草稿时不能再起新草稿；过期草稿不确认', async () => {
    const w = await worldM04();
    await w.call('m-wang-yj', '给小赵定本月目标3万');
    await unchanged(w, 'm-wang-yj', '给小赵定本月目标2万', /请先确认或取消当前草稿/);
    await w.base.saveTarget({ storeId: 's-b', personId: 'p-zhao', periodMonth: '2026-11', amount: 12345, updatedBy: 'someone', updatedAt: 'x' });
    expect(await w.call('m-wang-yj', '对')).toBe(CONFLICT);
    expect((await w.base.getTarget('s-b', 'p-zhao', '2026-11'))!.amount).toBe(12345);
    expect((await w.base.listDrafts({ kind: 'target' }))[0]).toMatchObject({ status: 'void', payload: { outcome: 'conflict' } });
    await w.call('m-wang-yj', '给小赵定本月目标2万');
    const draft = (await pending(w))[0]!;
    await w.base.saveDraft({ ...draft, expiresAt: '2026-11-01T00:00:00.000Z' });
    expect(await w.call('m-wang-yj', '对')).toContain('这笔已过期，请重新报');
    expect((await w.base.getTarget('s-b', 'p-zhao', '2026-11'))!.amount).toBe(12345);
  });
  it('回显后目标对象离职 → 确认拒绝、零写', async () => {
    const w = await worldM04();
    await w.call('m-wang-yj', '给小赵定本月目标3万');
    const zhao = (await w.base.getPerson('p-zhao'))!;
    await w.base.savePerson({ ...zhao, active: false });
    expect(await w.call('m-wang-yj', '对')).toMatch(/当前身份或对象不符合要求/);
    expect(await w.base.listTargets()).toEqual([]);
  });
  it('确认后提交前崩溃：结果未知；重启（新 handler、同库）后草稿仍在、目标未写；重发原确认只写一次', async () => {
    const w = await worldM04();
    await w.call('m-wang-yj', '给小赵定本月目标3万');
    let crash = true;
    const flaky = new Proxy(w.base, { get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver);
      if (key === 'commitConfirmingTarget' && crash) return async () => { crash = false; throw Error('connection lost'); };
      return typeof value === 'function' ? value.bind(target) : value;
    } }) as PerformanceStore;
    const make = (store: PerformanceStore) => createWecomBotHandler({ legacyEntry: true, mode: 'isolated-synthetic', store, now: () => NOW, resolve: id => w.base.getPersonByMember(id),
      send: async () => 'sent', model: { complete: async () => { throw Error('不应调用模型'); } }, employeeLoop: true, accessPolicy: true });
    const say = async (h: ReturnType<typeof make>, text: string, messageId: string) => (await h.handleMessage({ memberId: 'm-wang-yj', text, messageId, sessionId: 'session-m-wang-yj', bindingVersion: 1 })).replies.join('\n');
    expect(await say(make(flaky), '对', 'crash-confirm')).toMatch(/结果未知/);
    expect(await w.base.listTargets()).toEqual([]);
    const restarted = make(w.base);
    expect(await say(restarted, '入账结果', 'q1')).toMatch(/结果未知/);
    expect(await say(restarted, '对', 'crash-confirm')).toContain('已设目标');
    expect(await say(restarted, '对', 'crash-confirm')).toContain('已设目标');
    expect(await w.base.listTargets()).toHaveLength(1);
  });
});

describe('M04 更正：授权范围、撤权、并发冲突、非策略模式', () => {
  it('员工不能指名改别人；店长指名改本店员工最近一笔（改账通知给归属人）；他店查不到', async () => {
    const w = await worldM04();
    await unchanged(w, 'm-zhao', '把小王刚才那笔改成1', ACCESS_DENIED);
    expect(await w.call('m-wang-yj', '把小赵刚才那笔改成800')).toContain('小赵（2026-11-12）900元 → 800元');
    expect(await w.call('m-wang-yj', '对')).toContain('已改账');
    expect((await w.base.getEntry('e-b1'))!.amount).toBe(80000);
    expect((await w.base.listNotifications()).map(n => n.recipientPersonId)).toEqual(['p-zhao']);
    await unchanged(w, 'm-wang-yj', '把小林刚才那笔改成1', NOT_FOUND);
  });
  it('本人非当日批次需要 correct_store：员工撤回昨天的报数被拒', async () => {
    // R3（D81）：入口不再收非今天的清单 → 改为今天报、过了营业日再撤回（同一条「本人非当日批次」规则）。
    let at = NOW.getTime();
    const w = await worldM04({ now: () => new Date(at) });
    await w.call('m-zhao', '12号测试B店\n260（小赵）');
    expect(await w.call('m-zhao', '对')).toContain('已入账');
    at += 24 * 3600_000;
    await unchanged(w, 'm-zhao', '撤回刚才的报数', ACCESS_DENIED);
  });
  it('多笔批次改金额要指明第几笔；撤回整批', async () => {
    const w = await worldM04();
    await w.call('m-zhao', '12号测试B店\n111（小赵）\n222（小王）'); await w.call('m-zhao', '对');
    await unchanged(w, 'm-zhao', '把刚才那笔改成600', /请说「把刚才第2笔改成600」/);
    expect(await w.call('m-zhao', '把刚才第2笔改成250')).toContain('小王（2026-11-12）222元 → 250元');
    await w.call('m-zhao', '对');
    expect((await newEntries(w)).map(e => e.amount).sort()).toEqual([11100, 25000]);
    expect(await w.call('m-zhao', '撤回刚才的报数')).toContain('将作废以下 2 笔');
    await w.call('m-zhao', '对');
    expect((await newEntries(w)).every(e => e.status === 'voided')).toBe(true);
  });
  it('确认前撤权 → 拒绝；提交事务内撤权（guard）→ 拒绝、草稿退回待确认、零修订', async () => {
    const w = await worldM04();
    await w.call('m-zhao', '880（小赵）'); await w.call('m-zhao', '对');
    const [entry] = await newEntries(w);
    await w.call('m-zhao', '把刚才那笔改成800');
    await bump(w.base, 1, policyM04(2, membersM04(), { roles: { employee: ['report_self', 'report_proxy', 'progress_self'], manager: [], owner: [] } }));
    await unchanged(w, 'm-zhao', '对', ACCESS_DENIED);
    await bump(w.base, 2, policyM04(3));
    let fired = false;
    const store = new Proxy(w.base, { get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver);
      if (typeof value !== 'function') return value;
      return async (...args: unknown[]) => {
        if (key === 'commitConfirmingCorrection' && !fired) { fired = true; await bump(target, 3, policyM04(4, { ...membersM04(), 'p-zhao': { role: 'employee', storeIds: ['s-b'], status: 'revoked' } })); }
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    } }) as PerformanceStore;
    const handler = createWecomBotHandler({ legacyEntry: true, mode: 'isolated-synthetic', store, now: () => NOW, resolve: id => w.base.getPersonByMember(id),
      send: async () => 'sent', model: { complete: async () => { throw Error('x'); } }, employeeLoop: true, accessPolicy: true });
    const reply = (await handler.handleMessage({ memberId: 'm-zhao', text: '对', messageId: 'late', sessionId: 'session-m-zhao', bindingVersion: 1 })).replies.join('\n');
    expect(fired).toBe(true); expect(reply).toBe(ACCESS_DENIED);
    expect((await w.base.getEntry(entry!.entryId))!.amount).toBe(88000);
    expect(await w.base.listRevisions(entry!.entryId)).toEqual([]);
    expect((await w.base.listDrafts({ kind: 'correction' }))[0]!.status).toBe('pending');
  });
  it('两份更正同一笔：先确认者生效，后确认者作废（不丢更新、不叠加）', async () => {
    const w = await worldM04();
    await w.call('m-zhao', '300（小赵）'); await w.call('m-zhao', '对');
    const [entry] = await newEntries(w);
    expect(await w.call('m-zhao', '把刚才那笔改成350')).toContain('300元 → 350元');
    expect(await w.call('m-wang-yj', '把小赵刚才那笔改成320')).toContain('300元 → 320元');
    expect(await w.call('m-wang-yj', '对')).toContain('已改账');
    expect(await w.call('m-zhao', '对')).toBe(CONFLICT);
    expect((await w.base.getEntry(entry!.entryId))!.amount).toBe(32000);
    expect(await w.base.listRevisions(entry!.entryId)).toHaveLength(1);
  });
  it('无更正能力者：拒绝且不读本人批次与账本', async () => {
    const w = await worldM04();
    await w.call('m-zhao', '880（小赵）'); await w.call('m-zhao', '对');
    await bump(w.base, 1, policyM04(2, membersM04(), { roles: { employee: ['report_self', 'report_proxy', 'progress_self'], manager: [], owner: [] } }));
    w.reset();
    await unchanged(w, 'm-zhao', '撤回刚才的报数', ACCESS_DENIED);
    expect(w.spy.reads.filter(read => ['listEntries', 'getEntry', 'listDrafts'].includes(read.method) && (read.method !== 'listDrafts' || (read.args[0] as { kind?: string } | undefined)?.kind === 'report'))).toEqual([]);
  });
  it('“刚才那笔”不唯一（固定时钟下两批同刻）→ 不猜、零写', async () => {
    const w = await worldM04({ now: () => NOW });
    await w.call('m-zhao', '101（小赵）'); await w.call('m-zhao', '对');
    await w.call('m-zhao', '102（小赵）'); await w.call('m-zhao', '对');
    await unchanged(w, 'm-zhao', '撤回刚才的报数', /不唯一/);
    await unchanged(w, 'm-wang-yj', '把小赵刚才那笔改成1', /不唯一/);
  });
  it('目标提交事务内撤权（guard）→ 拒绝、目标不写、草稿退回待确认', async () => {
    const w = await worldM04();
    await w.call('m-wang-yj', '给小赵定本月目标3万');
    let fired = false;
    const store = new Proxy(w.base, { get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver);
      if (typeof value !== 'function') return value;
      return async (...args: unknown[]) => {
        if (key === 'commitConfirmingTarget' && !fired) { fired = true; await bump(target, 1, policyM04(2, membersM04(), { roles: { employee: [], manager: ['report_self', 'progress_self'], owner: [] } })); }
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    } }) as PerformanceStore;
    const handler = createWecomBotHandler({ legacyEntry: true, mode: 'isolated-synthetic', store, now: () => NOW, resolve: id => w.base.getPersonByMember(id),
      send: async () => 'sent', model: { complete: async () => { throw Error('x'); } }, employeeLoop: true, accessPolicy: true });
    const reply = (await handler.handleMessage({ memberId: 'm-wang-yj', text: '对', messageId: 'late-target', sessionId: 'session-m-wang-yj', bindingVersion: 1 })).replies.join('\n');
    expect(fired).toBe(true); expect(reply).toBe(ACCESS_DENIED);
    expect(await w.base.listTargets()).toEqual([]);
    expect((await w.base.listDrafts({ kind: 'target' }))[0]!.status).toBe('pending');
  });
  it('非策略模式：目标与改账不开放，零写', async () => {
    const w = await worldM04({ accessPolicy: false });
    await unchanged(w, 'm-zhao', '把刚才那笔改成600', /未开放/);
    await unchanged(w, 'm-wang-yj', '给小赵定本月目标3万', /未开放/);
  });
  it('单独「撤回」「改成600」没有指向 → 澄清，零写', async () => {
    const w = await worldM04();
    await unchanged(w, 'm-zhao', '撤回', CLARIFY_REPLY);
    await unchanged(w, 'm-zhao', '改成600', CLARIFY_REPLY);
  });
});

describe('M04 增量报数：重发不增、追加只记新增、同金额两笔都保留', () => {
  it('同金额两笔都记；整份重发不增；追加只记新行；已撤回的不算重复', async () => {
    const w = await worldM04();
    expect(await w.call('m-zhao', '12号测试B店\n500（小赵）\n500（小赵）')).toMatch(/客户：（未写）\n小赵 500元\n客户：（未写）\n小赵 500元/);
    await w.call('m-zhao', '对');
    expect((await newEntries(w)).map(e => e.amount)).toEqual([50000, 50000]);
    await unchanged(w, 'm-zhao', '12号测试B店\n500（小赵）\n500（小赵）', /2 笔今天都已入账，没有新增/);
    const append = await w.call('m-zhao', '12号测试B店\n500（小赵）\n500（小赵）\n张姐 300（小赵）');
    expect(append).toContain('小赵 300元'); expect(append).toContain('另有 2 笔与今天已入账相同，已跳过');
    expect((await pending(w))[0]!.payload).toMatchObject({ skipped: 2, added: [{ amount: 30000, customer: '张姐' }] });
    await w.call('m-zhao', '对');
    expect((await newEntries(w)).map(e => e.amount).sort()).toEqual([30000, 50000, 50000]);
    await unchanged(w, 'm-zhao', '900（小赵）', /今天都已入账/);
    await w.call('m-zhao', '撤回刚才的报数'); await w.call('m-zhao', '对');
    expect(await w.call('m-zhao', '张姐 300（小赵）')).toContain('小赵 300元');
  });
  it('回显后同样内容被别人先入账 → 确认作废、零重复入账', async () => {
    const w = await worldM04();
    await w.call('m-zhao', '410（小赵）');
    await w.call('m-wang-yj', '410（小赵）');
    expect(await w.call('m-wang-yj', '对')).toContain('已入账');
    expect(await w.call('m-zhao', '对')).toBe(CONFLICT);
    expect((await newEntries(w)).filter(e => e.amount === 41000)).toHaveLength(1);
  });
});

describe('M04 旧入口：不能确认、取消或绕过目标/更正草稿；不直接写目标', () => {
  it('非 employeeLoop 旧入口遇到本人目标草稿：对/取消/报数都让回本人入口，目标与草稿不变', async () => {
    const w = await worldM04();
    await w.call('m-wang-yj', '给小赵定本月目标3万');
    const legacy = createWecomBotHandler({ legacyEntry: true, mode: 'isolated-synthetic', store: w.base, now: () => NOW, resolve: id => w.base.getPersonByMember(id),
      send: async () => 'sent', model: { complete: async () => ({ type: 'chat' as const, text: '旧入口模型' }) } });
    for (const text of ['对', '取消', '12号测试B店\n100（小赵）']) {
      const reply = (await legacy.handleMessage({ memberId: 'm-wang-yj', text })).replies.join('\n');
      expect(reply).toContain('请从本人报数入口处理草稿');
    }
    expect(await w.base.listTargets()).toEqual([]);
    expect((await pending(w)).map(d => d.kind)).toEqual(['target']);
    expect(await newEntries(w)).toEqual([]);
  });
});

describe('M04 内存实现（MemoryPerformanceStore）与 PG 实现同语义', () => {
  it('更正冲突、重复确认、目标冲突、提交拒绝退回待确认', async () => {
    const w = await worldM04({ store: new MemoryPerformanceStore() });
    await w.call('m-zhao', '300（小赵）'); await w.call('m-zhao', '对');
    const [entry] = await newEntries(w);
    await w.call('m-zhao', '把刚才那笔改成350'); await w.call('m-wang-yj', '把小赵刚才那笔改成320');
    expect(await w.call('m-wang-yj', '对', 'mem-confirm')).toContain('已改账');
    expect(await w.call('m-wang-yj', '对', 'mem-confirm')).toContain('已改账');
    expect(await w.call('m-zhao', '对')).toBe(CONFLICT);
    expect((await w.base.getEntry(entry!.entryId))!.amount).toBe(32000);
    expect(await w.base.listRevisions(entry!.entryId)).toHaveLength(1);
    await w.call('m-wang-yj', '给小赵定本月目标3万');
    await w.base.saveTarget({ storeId: 's-b', personId: 'p-zhao', periodMonth: '2026-11', amount: 1, updatedBy: 'x', updatedAt: 'y' });
    expect(await w.call('m-wang-yj', '对')).toBe(CONFLICT);
    expect((await w.base.getTarget('s-b', 'p-zhao', '2026-11'))!.amount).toBe(1);
    await w.call('m-wang-yj', '给小赵定本月目标3万');
    await bump(w.base, 1, policyM04(2, membersM04(), { roles: { employee: [], manager: ['progress_self'], owner: [] } }));
    expect(await w.call('m-wang-yj', '对')).toBe(ACCESS_DENIED);
    expect((await w.base.getTarget('s-b', 'p-zhao', '2026-11'))!.amount).toBe(1);
  });
});

it.each(['progress_self', 'correct_store', null] as const)('缓存入账候选结果重验两个独立权限 revoked=%s', async revoked => {
  const w = await worldM04({store: new MemoryPerformanceStore()});
  const reporter = peopleM04.find(p => p.memberId === 'm-wang-yj')!;
  await w.base.insertEntries(['composite-a','composite-b'].map(id => ({...entry(id,'s-b',reporter,68000),customerName:'许姐'})));
  const handler = createWecomBotHandler({legacyEntry:true,mode:'isolated-synthetic',resolve:id=>w.base.getPersonByMember(id),store:w.base,now:() => NOW,send:w.send,model:{complete:w.model},employeeLoop:true,accessPolicy:true});
  const say = (text:string,messageId:string) => handler.handleMessage({memberId:'m-wang-yj',text,messageId,sessionId:'composite',bindingVersion:1});
  expect((await say('把许姐那笔改成860','composite-create')).replies.join('')).toContain('改 1');
  const first = await say('入账结果','composite-query');
  expect(first.replies.join('')).toContain('改 1');

  if (revoked) {
    const members = membersM04();
    members[reporter.personId]!.capabilities = ['report_self','report_proxy','progress_self','correct_store','correct_own'].filter(c => c !== revoked) as NonNullable<typeof members[typeof reporter.personId]['capabilities']>;
    await bump(w.base,1,policyM04(2,members));
  }
  const replay = await say('入账结果','composite-query');
  expect(replay.duplicate).toBe(true);
  if (revoked) expect(replay.replies).toEqual([ACCESS_DENIED]);
  else expect(replay.replies).toEqual(first.replies);
});
