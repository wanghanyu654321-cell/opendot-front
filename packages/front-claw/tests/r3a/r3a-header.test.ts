// R3a（第 1 项）：今天日期的「日期+店名」标题清单（hanyu 11-02 批准的真实格式）在 D81 之后照常出清单、回「对」入账；昨天/明天的标题回固定句、零写入。
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


const NOT_TODAY = 'Front Claw：目前只能报今天的单，补报请找店长。';

describe('R3a 今天日期标题清单', () => {
  for (const header of ['12号B店', '11月12日B店', '11月12日 B店', '11.12 B店', '11/12B店']) {
    it(`单行清单「${header}」→ 出清单 → 「对」入账`, async () => {
      const { w } = await make();
      const before = (await w.base.listEntries({})).length;
      const reply = await w.call('m-zhao', `${header}\n680（小赵）`);
      expect(reply).toContain('还没入账，2026-11-12');
      expect(reply).toContain('小赵 680元');
      expect((await w.base.listEntries({})).length).toBe(before);
      expect(await w.call('m-zhao', '对')).toContain('已入账');
      const after = await w.base.listEntries({});
      expect(after.length).toBe(before + 1);
      expect(after.filter(e => e.businessDay === '2026-11-12' && e.amount === 68000)).toHaveLength(1);
    });
  }
  it('多行清单（本人 + 同店代报 + k/w 金额）→ 一次出清单 → 「对」全部入账', async () => {
    const { w } = await make();
    const before = (await w.base.listEntries({})).length;
    const reply = await w.call('m-zhao', '12号B店\n张姐 680（小赵）\n李姐 1.2k（小王）\n周姐 0.5w（小美）');
    expect(reply).toMatch(/还没入账[^\n]*，2026-11-12：\n客户：张姐\n小赵 680元\n客户：李姐\n小王 1200元（1\.2k → 1200）\n客户：周姐\n小美 5000元（0\.5w → 5000）/);
    expect(await w.call('m-zhao', '对')).toContain('已入账');
    const added = (await w.base.listEntries({})).slice(before);
    expect(added.map(e => [e.businessDay, e.amount]).sort()).toEqual([['2026-11-12', 120000], ['2026-11-12', 500000], ['2026-11-12', 68000]]);
  });
  for (const [label, header] of [['昨天', '11号B店'], ['昨天', '11月11日B店'], ['明天', '13号B店'], ['明天', '11月13日B店'], ['上月同日', '10月12日B店']] as const) {
    it(`${label}的标题「${header}」→ 固定句，不追问，零草稿零入账`, async () => {
      const { w, snap } = await make();
      const before = await snap();
      expect(await w.call('m-zhao', `${header}\n680（小赵）\n300（小王）`)).toBe(NOT_TODAY);
      expect(await snap()).toEqual(before);
    });
  }
});
