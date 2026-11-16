// R3（问题 4/5/6）：越权/跨店直接「不能做」+原因；复合句两件都办或明说没办；D81 非今天单固定一句；客套话短答；D85 见 r2-d5。
// 用例句子均为本文件新写的说法（不取盲测语料原句），验证的是通用规则。
import { describe, expect, it } from 'vitest';
import { CAPABILITIES } from '../../src/role-eval/access-policy.js';
import type { Person } from '../../src/role-eval/performance-store.js';
import { COURTESY_BYE, COURTESY_MORNING, COURTESY_OTHER, COURTESY_THANKS, NOT_TODAY_REPLY, compoundTail, courtesyKind, pastDayReportPhrase, scopeRefusal, selfProgressPhrase } from '../../src/role-eval/scope-refusal.js';
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
const zhao = PEOPLE.find(p => p.personId === 'p-zhao')!;

describe('R3 问题 4：越权/跨店 → 「不能做」+ 原因（通用规则，零读写）', () => {
  it('纯函数：跨店任何说法、查同事业绩（无 progress_other）、全店排名（无汇总/排名能力）', async () => {
    const deny = async () => false; const allow = async () => true;
    const ctx = (allowed: typeof deny) => ({ actor: zhao, people: PEOPLE, allowed });
    expect(await scopeRefusal('帮我看看A店小雪本周的业绩', ctx(allow))).toMatch(/^Front Claw：不能做——只能办本店（B店）的事，A店/);
    expect(await scopeRefusal('A店老周让我帮他记一笔，周姐300', ctx(allow))).toMatch(/不能做.*跨店不能代报/);
    expect(await scopeRefusal('小王这个月做了多少', ctx(deny))).toMatch(/不能做——你没有权限查同事（小王）的业绩，这个需要店长来查/);
    expect(await scopeRefusal('小王这个月做了多少', ctx(allow))).toBeNull();
    expect(await scopeRefusal('本店大家今天的排行发我看看', ctx(deny))).toMatch(/不能做——你没有权限看全店的排名和汇总，这个需要店长来/);
    expect(await scopeRefusal('本店大家今天的排行发我看看', ctx(allow))).toBeNull();
    // 不越权的说法不拦：本人进度、与同事无关的报数、闲聊
    expect(await scopeRefusal('我这周做了多少', ctx(deny))).toBeNull();
    expect(await scopeRefusal('张姐680（小王）', ctx(deny))).toBeNull();
    expect(await scopeRefusal('今天好累', ctx(deny))).toBeNull();
  });
  it('端到端（员工发件人）：回复「不能做」带原因，零草稿、账本不变；店长查同事不被这条规则拦', async () => {
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
      expect(reply, text).not.toMatch(/请问|请补|没太明白/);
    }
    expect(await snap()).toEqual(before);
    expect(await w.call('m-bm', '我想瞅瞅小美这个月业绩怎么样')).not.toMatch(/不能做/);
  });
});

describe('R3 问题 5：复合句（报数 + 第二件事）', () => {
  it('纯函数：后半句切分与「查本人进度」判定', () => {
    expect(compoundTail('孙姐980，然后查一下我今天的业绩')).toBe('查一下我今天的业绩');
    expect(compoundTail('孙姐980（小王）')).toBeNull();
    expect(selfProgressPhrase('查一下我今天的业绩')).toBe(true);
    expect(selfProgressPhrase('看下我今天已入账多少')).toBe(true);
    expect(selfProgressPhrase('查下我上个月的业绩')).toBe(false);
    expect(selfProgressPhrase('查下小王今天的业绩')).toBe(false);
  });
  it('报数 + 查本人今天进度：按 D144 归模型路径，离线先问，不出可确认草稿、零入账', async () => {
    const { w, snap } = await make();
    const before = await snap();
    const reply = await w.call('m-zhao', '孙姐980，然后查一下我今天的业绩');
    expect(reply).not.toContain('还没入账');
    expect(reply).toMatch(/没有写入任何账目|行尾备注|说不清|没太明白/);
    const after = await snap();
    expect(after.entries).toBe(before.entries);
    expect(after.drafts).toBe(before.drafts);
  });
  it('报数 + 另一件查询残片：整句先问，不出可确认草稿（不悄悄出草稿）', async () => {
    const { w } = await make();
    const reply = await w.call('m-zhao', '周姐560，顺便算下这周还差几单');
    expect(reply).not.toContain('还没入账');
    expect(reply).toMatch(/没有写入任何账目|行尾备注|说不清|没太明白/);
  });
});

describe('R3 问题 6：D81 非今天的单 / 客套话', () => {
  it('非今天的报数说法与带旧日期标题的清单 → 固定一句，不追问，零写入', async () => {
    const { w, snap } = await make();
    const before = await snap();
    expect(pastDayReportPhrase('前天李姐有一单880帮我补上')).toBe(true);
    expect(pastDayReportPhrase('查下我昨天的业绩')).toBe(false);
    expect(pastDayReportPhrase('周姐560，再把昨天那单改一下')).toBe(false);
    expect(await w.call('m-zhao', '前天李姐有一单880帮我补上')).toBe(NOT_TODAY_REPLY);
    expect(await w.call('m-zhao', '10号测试B店\n300（小赵）')).toBe(NOT_TODAY_REPLY);
    expect(NOT_TODAY_REPLY).toBe('Front Claw：目前只能报今天的单，补报请找店长。');
    expect(await snap()).toEqual(before);
  });
  it('客套话 → 一句短答，不写账、不追问；夹着店务的不算客套话', async () => {
    const { w, snap } = await make();
    const before = await snap();
    expect(courtesyKind('谢谢啦')).toBe('thanks');
    expect(courtesyKind('辛苦了哈～🙏')).toBe('thanks');
    expect(courtesyKind('晚安呀')).toBe('bye');
    expect(courtesyKind('早上好呀')).toBe('morning');
    expect(courtesyKind('好嘞')).toBeNull();
    expect(courtesyKind('谢谢，帮我查下我的进度')).toBeNull();
    expect(courtesyKind('谢谢张姐680')).toBeNull();
    expect(await w.call('m-zhao', '谢谢啦')).toBe(COURTESY_THANKS);
    expect(await w.call('m-zhao', '大家辛苦了，明天见👋')).toBe(COURTESY_THANKS);
    expect(await w.call('m-zhao', '晚安呀')).toBe(COURTESY_BYE);
    expect(await w.call('m-zhao', '早上好呀')).toBe(COURTESY_MORNING);
    for (const r of [COURTESY_THANKS, COURTESY_OTHER, COURTESY_BYE, COURTESY_MORNING]) expect(r).not.toMatch(/[？?]|请/);
    expect(await snap()).toEqual(before);
  });
});
