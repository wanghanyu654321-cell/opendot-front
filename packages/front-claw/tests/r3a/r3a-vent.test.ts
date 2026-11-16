// R3a（第 2 项）：吐槽/情绪类与客套话同样处理——短答一句，不写账、不追问；带金额或店务信号的照常走原流程。说法均为本文件新写（不取盲测语料原句）。
// 用例句子均为本文件新写的说法（不取盲测语料原句），验证的是通用规则。
import { describe, expect, it } from 'vitest';
import { CAPABILITIES } from '../../src/role-eval/access-policy.js';
import type { Person } from '../../src/role-eval/performance-store.js';
import { COURTESY_VENT, isVent } from '../../src/role-eval/scope-refusal.js';
import { world } from '../role-eval/access-fixture-m03.js';
import { ROLE_CAPS_M05 } from '../role-eval/appointment-fixture-m05.js';
import { ticking } from '../role-eval/ledger-fixture-m04.js';

const P = (id: string, name: string, store: 'A' | 'B', tier: Person['tier']): Person => ({
  personId: `p-${id}`, accountId: `a-${id}`, memberId: `m-${id}`, displayName: name, storeId: store === 'A' ? 's-a' : 's-b', storeName: `${store}店`, tier, roles: tier === 'employee' ? [] : ['manager'], active: true,
});
const PEOPLE: Person[] = [P('chen', '小陈', 'A', 'employee'), P('xue', '小雪', 'A', 'employee'), P('am', '老周', 'A', 'manager'), P('bm', '王店长', 'B', 'manager'), P('zhao', '小赵', 'B', 'employee'),
  P('xw', '小王', 'B', 'employee'), P('mei', '小美', 'B', 'employee'), P('lin', '小林', 'B', 'employee'), P('boss-b', '老板甲', 'B', 'owner'), P('boss-a', '老板乙', 'A', 'owner')];
const members = () => Object.fromEntries(PEOPLE.map(p => [p.personId, { role: p.tier, storeIds: p.tier === 'owner' ? ['s-a', 's-b'] : [p.storeId], status: 'active' as const }]));
const policy = () => ({ version: 1, enterprise: [...CAPABILITIES], stores: { 's-a': [...CAPABILITIES], 's-b': [...CAPABILITIES] }, roles: structuredClone(ROLE_CAPS_M05), members: members() });
async function make() {
  const w = await world({ people: PEOPLE, policy: policy(), now: ticking() });
  for (const memberId of ['m-zhao', 'm-bm']) await w.base.setConfig('employee-loop:m01', JSON.stringify({ enabled: true, storeId: 's-b', memberIds: ['m-zhao', 'm-bm'] }));
  const snap = async () => ({ drafts: (await w.base.listDrafts()).filter(d => d.status !== 'void').length, entries: JSON.stringify(await w.base.listEntries({})) });
  return { w, snap };
}


describe('R3a 吐槽类', () => {
  it('纯函数：情绪词 + 无店务信号 → 吐槽；有金额/动作/客人/预约时间 → 不是', () => {
    for (const t of ['累鼠了', '今天好累', '烦死了烦死了', '腿都站酸了😭', '唉，心好累', '好困啊想睡觉', '今天忙得团团转', '压力好大顶不住了']) expect(isVent(t), t).toBe(true);
    for (const t of ['累死了，张姐680（小王）', '烦死了，帮我查下我的进度', '累了，明天下午3点王姐来做护理', '好累，刚开了3单', '困死了，0.5w记我名下', '好烦，这个月目标还差好多',
      '番茄炒蛋怎么做', '你好', '收到',
      // 只有金额、没有店务动作/客人称谓：也不能当吐槽（金额检查是独立护栏）。
      '好累啊680', '烦死了0.5w', '困死了花了980块']) expect(isVent(t), t).toBe(false);
  });
  it('端到端：吐槽 → 一句短答、零写入、不追问；带金额的照常出清单', async () => {
    const { w, snap } = await make();
    const before = await snap();
    for (const t of ['累鼠了', '今天好累', '烦死了', '腿都站酸了😭', '今天客人一个接一个，忙晕了']) {
      const reply = await w.call('m-zhao', t);
      expect(reply, t).toBe(COURTESY_VENT);
    }
    expect(COURTESY_VENT).not.toMatch(/[？?]|请/);
    expect(await snap()).toEqual(before);
    // R17 / D152 单闸：解析出的客户位是「累死了,张姐」（带残留），不是干净形态 → 先问、零可确认草稿。
    // 原期望「照常出清单」移交 Codex：需在解析层把句首吐槽从客户位剥掉后再过闸（见 REPORT 移交项）。
    const report = await w.call('m-zhao', '累死了，张姐680（小王）');
    expect(report).not.toContain('还没入账');
    expect(report).toMatch(/没有写入任何账目/);
    // 只有金额：不走吐槽短答。
    const onlyAmount = await w.call('m-zhao', '烦死了0.5w');
    expect(onlyAmount).not.toBe(COURTESY_VENT);
    expect(onlyAmount).not.toMatch(/有事随时找我/);
  });
});
