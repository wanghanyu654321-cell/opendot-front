// R3（问题 4/5/6，端到端；只用回复文本断言、不引用 R3 新模块，便于在修复前的树上跑出「修前失败」）：越权/跨店直接「不能做」+原因；复合句两件都办或明说没办；D81 非今天单固定一句；客套话短答；D85 见 r2-d5。
// 用例句子均为本文件新写的说法（不取盲测语料原句），验证的是通用规则。
import { describe, expect, it } from 'vitest';
import { CAPABILITIES } from '../../src/role-eval/access-policy.js';
import type { Person } from '../../src/role-eval/performance-store.js';
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

describe('R3 端到端：越权/跨店、复合句、D81、客套话', () => {
  it('越权/跨店 → 「不能做——原因」，零读写；店长查同事不被拦', async () => {
    const { w, snap } = await make();
    const before = await snap();
    for (const [text, reason] of [
      ['帮我看看A店小雪本周的业绩', /只能办本店/],
      ['A店小陈今天不在，孙姐900我从这边替他报了', /跨店不能代报/],
      ['我想瞅瞅小美这个月业绩怎么样', /需要店长来查/],
      ['本店大家今天的排行发我看看', /需要店长来/],
    ] as const) {
      const reply = await w.call('m-zhao', text);
      expect(reply, text).toMatch(/^Front Claw：不能做——/);
      expect(reply, text).toMatch(reason);
    }
    expect(await snap()).toEqual(before);
    expect(await w.call('m-bm', '我想瞅瞅小美这个月业绩怎么样')).not.toMatch(/不能做/);
  });
  it('报数 + 查本人进度 / 查询残片：非整句纯标准行，离线整句先问、不出可确认草稿（D144 / D145 撤销）', async () => {
    const { w, snap } = await make();
    const before = await snap();
    const reply = await w.call('m-zhao', '孙姐980，然后查一下我今天的业绩');
    expect(reply).not.toContain('还没入账');
    expect(reply).toMatch(/没有写入任何账目|行尾备注|说不清|没太明白/);
    expect((await snap()).entries).toBe(before.entries);
    expect((await w.base.listDrafts({ status: 'pending' })).length).toBe(0);
    const q = await w.call('m-zhao', '周姐560，顺便算下这周还差几单');
    expect(q).not.toContain('还没入账');
    expect(q).toMatch(/没有写入任何账目|行尾备注|说不清|没太明白/);
    expect((await snap()).entries).toBe(before.entries);
  });
  it('D81：非今天的单 → 「目前只能报今天的单，补报请找店长」；客套话 → 一句短答', async () => {
    const { w, snap } = await make();
    const before = await snap();
    expect(await w.call('m-zhao', '前天李姐有一单880帮我补上')).toBe('Front Claw：目前只能报今天的单，补报请找店长。');
    expect(await w.call('m-zhao', '10号测试B店\n300（小赵）')).toBe('Front Claw：目前只能报今天的单，补报请找店长。');
    expect(await w.call('m-zhao', '谢谢啦')).toBe('Front Claw：不客气，有事随时找我。');
    expect(await w.call('m-zhao', '晚安呀')).toBe('Front Claw：辛苦了，明天见～');
    expect(await snap()).toEqual(before);
  });
});
