/**
 * R15 / D146：否定补报。配置内固定说法仍剥完可出草稿；
 * 没见过的一律先问，不进客户名、不出可确认草稿。自编句子。
 */
import { describe, expect, it } from 'vitest';
import { parseStandardLine, tryStandardReport, stripNegatedMakeupPhrases } from '../../src/role-eval/standard-line.js';
import {
  hasUnseenNegatedMakeup, findNegatedMakeupSpans,
} from '../../src/role-eval/negated-makeup.js';
import { formatMaybeReportAsk, GENERIC_MODEL_ASK } from '../../src/role-eval/model-path-ask.js';
import { worldM05 } from '../role-eval/appointment-fixture-m05.js';

const DAY = '2026-11-12';

/** 没见过的否定补报说法（训练）。 */
export const MAKEUP_TRAIN: string[] = [
  '别当补报，许姨：720（小赵）',
  '不属于补单，周老师 880',
  '并非补录钱姐：680',
  '没有在补，许姨：720',
  '非后补周老师：880',
  '不算漏报，许姨：720',
  '别当成漏记周老师 880',
  '不用当补登，钱姐：680',
  '并非昨天那种后补，许姨：720',
  '没有在补上，周老师：880',
  '勿当补单，许姨：720（小赵）',
  '不属于那种后补，周老师：880',
  '别当昨天的漏报，许姨：720',
  '并非补上的，钱姐 680',
  '没有在补报，许姨：720',
  '非补录，周老师 880',
  '不算是漏登，许姨：720',
  '别算补记，周老师：880',
  '不要当后补，许姨 720',
  '并非那种补单，周老师：880（小赵）',
  '没有补录，许姨：720',
  '不属于补登，钱姐：680',
  '别当漏了的，许姨：720',
  '并非之前的那种补，周老师 880',
  '勿当昨天那种后补，许姨：720',
  '不是属于补单的，周老师 880',
  '并不是后补，许姨：720',
  '没在补单，周老师：880',
  '别当成是补报，许姨 720',
  '非那种漏记，周老师：880',
  '不算作补录，许姨：720（小赵）',
];

/** 自留组：词序、用词、标点不同。 */
export const MAKEUP_HELDOUT: string[] = [
  '别当那种补报啊，周老师：760',
  '并非是补录，许姨 900（小赵）',
  '不属于后补单，钱姐：610',
  '勿当成漏报，周老师 315',
  '没有在补记，许姨：405',
  '非昨天那种后补，钱姐：545',
  '不算漏了的，周老师：990',
  '别当之前的补登，许姨 225',
  '并不是补单哦，钱姐：835',
  '不要当漏记，周老师 470',
  '并非上周那种补报，许姨：390',
  '没有补上，周老师：715',
  '不属于那种漏登，钱姐 820（小赵）',
  '别算是后补，许姨：355',
  '非补记，周老师 275',
  '勿当补录了，许姨：910',
  '不算作漏报，钱姐 185',
  '没有在那种补单里，周老师：625',
  '别当成昨天的后补，许姨：455',
  '并非补登过，钱姐：790',
  '不要当那种漏报，周老师 330',
  '非属于补上，许姨：510',
  '并不是那种补记，钱姐 860',
  '没有在后补，周老师：705',
  '别当漏登了，许姨 240',
  '不属于昨天那种补录，钱姐：670',
  '勿算补报，周老师 425（小赵）',
  '并非是漏了的，许姨：580',
  '不算那种后补，钱姐：160',
  '没有补记过，周老师 845',
  '别当是补单，许姨：290',
];

const FIXED = [
  '不是补报许姨：720（小赵）',
  '不是在补周老师 880',
  '不是补的钱姐：680',
  '不是补报，许姨：720',
];

describe('R15 否定补报·结构检测与固定说法', () => {
  it('训练组每条都能检出未见过的否定补报跨度', () => {
    expect(MAKEUP_TRAIN.length).toBeGreaterThanOrEqual(30);
    const missed = MAKEUP_TRAIN.filter(s => !hasUnseenNegatedMakeup(s, stripNegatedMakeupPhrases));
    expect(missed, `未检出：${missed.join(' | ')}`).toEqual([]);
  });

  it('自留组每条都能检出未见过的否定补报跨度', () => {
    expect(MAKEUP_HELDOUT.length).toBeGreaterThanOrEqual(30);
    const missed = MAKEUP_HELDOUT.filter(s => !hasUnseenNegatedMakeup(s, stripNegatedMakeupPhrases));
    expect(missed, `未检出：${missed.join(' | ')}`).toEqual([]);
  });

  it('配置内固定说法剥完后不再算未见过，客户名干净', () => {
    for (const s of FIXED) {
      expect(hasUnseenNegatedMakeup(s, stripNegatedMakeupPhrases), s).toBe(false);
      const r = tryStandardReport(s, DAY);
      expect(r.status, s).toBe('complete');
      if (r.status === 'complete') {
        const c = r.report.entries[0]!.customer ?? '';
        expect(c, s).not.toMatch(/不是补|不是在补/);
        expect(c).toMatch(/许姨|周老师|钱姐/);
      }
    }
  });

  it('「不用补水」不误伤，跨度为 0', () => {
    expect(findNegatedMakeupSpans('许姨：720不用补水')).toEqual([]);
    expect(hasUnseenNegatedMakeup('许姨：720不用补水', stripNegatedMakeupPhrases)).toBe(false);
    expect(stripNegatedMakeupPhrases('许姨：720不用补水')).toMatch(/不用补水/);
    const p = parseStandardLine('许姨：720不用补水');
    expect(p.status).toBe('ok');
  });

  it('没有已确认名单时，即使句中有客户和金额，也只用通用追问（规则层不猜名）', () => {
    const line = '并非昨天那种后补，许姨：720';
    expect(formatMaybeReportAsk(line, new Set())).toBe(GENERIC_MODEL_ASK);
    expect(formatMaybeReportAsk(line, new Set())).not.toMatch(/是不是要报客户「许姨」/);
  });

  it('名单里有许姨且金额已确定，才问「是不是要报客户「许姨」720 元」', () => {
    const line = '并非昨天那种后补，许姨：720';
    const ask = formatMaybeReportAsk(line, new Set(['许姨']));
    expect(ask).toMatch(/是不是要报客户「许姨」720 元/);
    expect(ask).toMatch(/没有写入任何账目/);
  });
});

async function assertAskNoDraft(lines: string[], label: string) {
  const w = await worldM05();
  const failed: string[] = [];
  for (const line of lines) {
    const before = (await w.base.listDrafts({ status: 'pending' })).length;
    const r = await w.call('m-zhao', line);
    const after = await w.base.listDrafts({ status: 'pending' });
    const drafted = /还没入账/.test(r) || after.length > before;
    const dirty = /客户：(?:不是|并非|别当|后补|漏报|补录|没有在补|非)/.test(r);
    const asked = /是不是要报|请.*再.*发|说不清|没有写入任何账目/.test(r);
    if (drafted || dirty || !asked) {
      failed.push(`${label} 「${line}」 drafted=${drafted} dirty=${dirty} asked=${asked} reply=${r.slice(0, 220)}`);
    }
    for (const d of after) {
      if (d.status === 'pending') await w.call('m-zhao', '取消');
    }
  }
  expect(failed, failed.join('\n')).toEqual([]);
}

describe('R15 否定补报·员工入口（未见过先问，不出草稿）', () => {
  it('训练组：先问、无可确认草稿、客户名不含残片', async () => {
    await assertAskNoDraft(MAKEUP_TRAIN, 'train');
  });

  it('自留组：先问、无可确认草稿、客户名不含残片', async () => {
    await assertAskNoDraft(MAKEUP_HELDOUT, 'held');
  });

  it('第 2 档：未入账的名字只用通用追问，不出草稿（不从文本猜「许姨」）', async () => {
    const w = await worldM05();
    const r = await w.call('m-zhao', '并非昨天那种后补，许姨：720');
    expect(r).toMatch(/没有写入任何账目/);
    expect(r).not.toMatch(/是不是要报客户「许姨」/);
    expect(r).not.toMatch(/还没入账/);
    expect((await w.base.listDrafts({ status: 'pending' })).length).toBe(0);
  });

  it('固定说法「不是补报许姨：720（小赵）」仍出草稿，客户是许姨', async () => {
    const w = await worldM05();
    const r = await w.call('m-zhao', '不是补报许姨：720（小赵）');
    expect(r).toMatch(/还没入账/);
    expect(r).toMatch(/\n客户：许姨\n/);
    await w.call('m-zhao', '取消');
  });
});
