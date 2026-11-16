// R2-1：高风险意图（改账/查他人/跨店/删除/预约/报数）缺字段或有歧义 → 结构化澄清或拒绝，零写入、不起草稿。
// 例句为本文件新写的泛化说法，不是盲测原句。
import { describe, expect, it } from 'vitest';
import { classifyIntent, decideRoute } from '../../src/role-eval/intent-router.js';
import { worldM05 } from '../role-eval/appointment-fixture-m05.js';

const NO_WRITE = /没有写入|没有登记|查不到|没有权限|跨店不能代报|没有读取或写入/;
async function seeded() {
  const w = await worldM05();
  await w.call('m-zhao', '张姐 680（小王）'); await w.call('m-zhao', '对');
  return w;
}
const cases: [member: string, text: string, expect?: RegExp][] = [
  ['m-zhao', '把张姐那单改成980还是890'], ['m-zhao', '把其中一笔撤回'], ['m-zhao', '把刚才那笔改成多少来着，我忘了', /记不清/],
  ['m-zhao', '查下小王这个月业绩'], ['m-zhao', '看看本店今天谁还没报'], ['m-zhao', '查一下小林的进度'],
  ['m-wang-yj', '查测试A店今天汇总'], ['m-wang-yj', '把测试A店小林的账改成500'], ['m-wang-yj', '给测试A店定本月目标5万'],
  ['m-zhao', '把今天的账都删了'], ['m-zhao', '撤回'], ['m-wang-yj', '把小王今天那单撤了'], ['m-zhao', '他的那单帮我改一下'],
  ['m-zhao', '王姐明天3点或者4点来', /两个候选/], ['m-zhao', '明天下午两点来做头疗，帮我约上', /哪位客人/],
  ['m-zhao', '刘姐好像是560吧，先记上', /记不清/], ['m-zhao', '刘姐大概560，先记上', /记不清|金额不确定|准确/], ['m-wang-yj', '小王的目标改成3万还是4万'],
  ['m-zhao', '赵姐560（小王、小林）', /多位员工/], ['m-zhao', '郑姐680或者860，记小王', /两个候选/], ['m-zhao', '吴姐的单帮他报上，600块', /他\/她/],
];
describe('R2 该澄清/该拒绝的一律不办', () => {
  for (const [member, text, hint] of cases) it(`${member}：${text}`, async () => {
    const w = await seeded();
    const before = await w.snapshot();
    const reply = await w.call(member, text);
    expect(reply).toMatch(NO_WRITE);
    if (hint) expect(reply).toMatch(hint);
    expect(await w.snapshot()).toEqual(before);
    // 紧接着回「对」也不会落账（没有草稿可确认）
    await w.call(member, '对');
    expect((await w.snapshot()).entries).toEqual(before.entries);
  });
  it('路由层：歧义报数/预约 → clarify，带结构化提问', () => {
    for (const text of ['郑姐680或者860，记小王', '刘姐大概560，先记上', '王姐明天3点或者4点来']) {
      const c = classifyIntent(text, { businessDay: '2026-11-12' });
      expect(c.label, text).toBe('clarify');
      const d = decideRoute(c, { marketingEnabled: true, marketingGranted: true });
      expect(d.target).toBe('clarify'); expect(d.ask).toMatch(/没有(写入|登记)/);
    }
    // R4（D104）：没写客人称呼的预约仍分类为预约并进店务，由循环先问一次（不当澄清丢掉待答状态）。
    const unnamed = classifyIntent('明天下午两点来做头疗，帮我约上', { businessDay: '2026-11-12' });
    expect(unnamed.label).toBe('appointment');
    expect(decideRoute(unnamed, { marketingEnabled: true, marketingGranted: true }).target).toBe('store');
  });
  it('明确的高风险说法仍只起草稿，必须本人回「对」才生效（不是直接办）', async () => {
    const w = await seeded();
    const before = await w.snapshot();
    expect(await w.call('m-zhao', '把刚才那笔改成980')).toContain('还没改账');
    expect((await w.snapshot()).entries).toEqual(before.entries);
    expect(await w.call('m-zhao', '取消')).not.toContain('已改');
    expect((await w.snapshot()).entries).toEqual(before.entries);
  });
});
