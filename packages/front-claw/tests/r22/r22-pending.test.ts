import { describe, expect, it } from 'vitest';
import { MemoryPerformanceStore } from '../../src/role-eval/performance-store.js';
import { worldM05 } from '../role-eval/appointment-fixture-m05.js';
import { newCustomerAskKey } from '../../src/role-eval/customer-name-policy.js';
import { DRAFT_EXPIRED_REREPORT } from '../../src/role-eval/employee-loop.js';

const key = newCustomerAskKey('p-zhao', 'session-m-zhao');
async function setup() {
  let at = Date.parse('2026-11-18T02:00:00Z');
  const w = await worldM05({ store: new MemoryPerformanceStore(), now: () => new Date(at) });
  const call = (text: string) => { at += 1000; return w.call('m-zhao', text); };
  const expire = async () => { at = Date.parse((await w.base.listDrafts({ status: 'pending' }))[0]?.expiresAt ?? JSON.parse((await w.base.getConfig(key))!).expiresAt); };
  return { w, call, expire };
}
const questions = [
  ['D153 customer', '檀霁：2867（小赵）'],
  ['D153 modelAsk 老板', '郗姨：2867（老板）'],
  ['D153 modelAsk 下午', '郗姨：2867（下午）'],
  ['D171', '共计：2867（小赵）'],
  ['金额', '郗姨：六百多（小赵）'],
  ['备注', '郗姨：2867（小赵）先记着'],
  ['过去日期', '【11月16日】郗姨：2867（小赵）'],
  ['没太明白', '那件事情呢'],
  ['MULTI', '写护理营销文案，再报数'],
  ['decision.ask', '郗姨：28.67（小赵）'],
] as const;
describe('R22 D182 所有不占挂起位的追问走统一出口', () => {
  for (const ask of [false, true]) for (const [label, question] of questions) it(`${ask ? '追问' : '草稿'} × ${label}`, async () => {
    const { w, call } = await setup();
    const customer = ask ? '郗霁' : '郗姨';
    await call(`${customer}：3917（小赵）`);
    const before = await w.snapshot(); const raw = await w.base.getConfig(key);
    const reply = await call(question);
    if (label === 'MULTI') expect(reply).toContain('这条里有好几件事');
    expect(reply.endsWith(`上一笔「${customer} 3917元」还在等你回「对」确认。`)).toBe(true);
    expect(await w.snapshot()).toEqual(before); expect(await w.base.getConfig(key)).toBe(raw);
    if (ask) await call('是');
    await call('对');
    expect((await w.base.listEntries()).filter(e => e.customerName).map(e => [e.customerName, e.amount])).toEqual([[customer, 391700]]);
  });
  for (const [label, question] of questions) it(`无挂起项 × ${label}`, async () => {
    const { call } = await setup(); expect(await call(question)).not.toContain('还在等你回');
  });
  for (const text of ['逯姨：2867（小赵）', '郗霁：2867（小赵）']) it(`占挂起位 ${text}`, async () => {
    const { call } = await setup(); await call('郗姨：3917（小赵）'); expect(await call(text)).not.toContain('还在等你回');
  });
});
for (const ask of [false, true]) it(`R22 D181 过期${ask ? '追问' : '草稿'}回对只回 D143 且消费提醒`, async () => {
  const { call, expire } = await setup(); await call(`${ask ? '郗霁' : '郗姨'}：3917（小赵）`); await expire();
  // D185 覆盖过期追问；过期草稿继续按 D181-4。
  expect(await call('对')).toBe(ask ? '上一笔「郗霁」已过期，没有记，需要的话请重新报。' : DRAFT_EXPIRED_REREPORT); expect(await call('辛苦了')).not.toContain('已过期');
});
it('R22 D181 过期结果复用原结果句，再接 D176', async () => {
  const { call, expire } = await setup(); await call('郗姨：3917（小赵）'); await expire();
  expect(await call('入账结果')).toBe('Front Claw：这张本人草稿已取消，没有入账。\n上一笔「郗姨 3917元」已过期，没有记，需要的话请重新报。');
});

it('R22 D181-2 原消息没有金额时尾句只点名，有金额按 listed 取', async () => {
  const { pendingConfirmationReminder } = await import('../../src/role-eval/pending-slot.js');
  const saved = { names: ['郗霁'], listed: [], businessDay: '2026-11-18', expiresAt: '2026-11-19T00:00:00Z' };
  expect(pendingConfirmationReminder([], saved, new Date('2026-11-18T02:00:00Z'))).toBe('上一笔「郗霁」还在等你回「对」确认。');
});

for (const text of ['我的进度', '入账结果', '辛苦了', '逯姨：2867（小林）', '查小林的业绩']) it(`R22 查询、闲聊、D177 拒绝保留挂起项且不加尾句：${text}`, async () => {
  const { w, call } = await setup(); await call('郗姨：3917（小赵）');
  const before = await w.snapshot(); expect(await call(text)).not.toContain('还在等你回'); expect(await w.snapshot()).toEqual(before);
});
it('R22 正常回复 → D178 有效项尾句 → D179 另一过期项提醒，每项一行', async () => {
  const { w, call } = await setup(); await call('郗姨：3917（小赵）');
  const current = (await w.base.listDrafts({ status: 'pending' }))[0]!;
  const old = structuredClone(current); old.draftId += '-older'; old.expiresAt = '2026-11-18T01:00:00Z';
  // 模拟旧版遗留的第二项；无摘要时仍按原有本人条目校验。
  if (old.payload.type === 'report') { old.payload.added[0]!.customer = '訾姨'; delete old.payload.employeeContext!.itemsDigest; }
  // D174 的存储约束不再允许人工插入第二条 pending；用过期 config 覆盖多项出口。
  await w.base.setConfig(key, JSON.stringify({ names: ['訾姨 3917元'], listed: [{ customer: '訾姨', amount: 391700 }], businessDay: current.businessDay, expiresAt: old.expiresAt }));
  const reply = await call('郗姨：2867（下午）');
  expect(reply.endsWith('上一笔「郗姨 3917元」还在等你回「对」确认。\n上一笔「訾姨 3917元」已过期，没有记，需要的话请重新报。')).toBe(true);
});
