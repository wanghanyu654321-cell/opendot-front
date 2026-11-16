/**
 * R15 / D147：剥完/拆完后无法识别的碎片先问，不进客户名、不出可确认草稿。
 * 自编句子，训练 / 自留分开。
 */
import { describe, expect, it } from 'vitest';
import { tryStandardReport, isOpenedSelfCustomerName, isAcceptableCustomerLabel } from '../../src/role-eval/standard-line.js';
import { customerNameLooksContaminated, looksLikeContaminatedReportLine } from '../../src/role-eval/negated-makeup.js';
import { worldM05 } from '../role-eval/appointment-fixture-m05.js';

const DAY = '2026-11-12';

/** 客户位被残片污染的行（训练）。 */
export const LEFTOVER_TRAIN: string[] = [
  '后补许姨：720',
  '漏报周老师：880',
  '补录钱姐：680',
  '那个许姨：720',
  '这个周老师：880',
  '随便许姨：720',
  '并非补录许姨：720（小赵）',
  '后补的许姨：720',
  '漏记周老师：880',
  '补登钱姐：680',
  '那些许姨：720',
  '这些周老师：880',
  '什么许姨：720',
  '补单周老师：880',
  '漏登钱姐：680',
  '嗯嗯许姨：720',
  '后补周老师 440：720',
  '那个钱姐：680',
  '补报许姨：720',
  '漏报的周老师：880',
  '这个钱姐：545',
  '随便周老师：880',
  '补录的许姨：610',
  '后补钱姐：390',
  '那些周老师：315',
  '并非后补许姨：720',
  '漏了的补记周老师：880',
  '补单的钱姐：680',
  '嗯呐许姨：225',
  '这个后补周老师：880',
  '那个漏报许姨：720',
];

export const LEFTOVER_HELDOUT: string[] = [
  '后补那个许姨：560',
  '漏报这个周老师：405',
  '补录那些钱姐：835',
  '随便什么许姨：470',
  '这个补单周老师：715',
  '那个补登钱姐：355',
  '后补漏记许姨：275',
  '并非那种补报周老师：910',
  '漏登这个许姨：185',
  '补记那些周老师：625',
  '这个随便钱姐：455',
  '那个什么许姨：790',
  '后补这些周老师：330',
  '漏报随便许姨：510',
  '补录这个钱姐：860',
  '嗯嗯那个周老师：705',
  '补单那些许姨：240',
  '这个漏记钱姐：670',
  '后补什么周老师：425',
  '那个补报许姨：580',
  '漏登随便钱姐：160',
  '这些补录周老师：845',
  '并非漏报许姨：290',
  '这个后补的钱姐：735',
  '那个漏了的周老师：615',
  '补登上许姨：485',
  '随便后补周老师：955',
  '什么补单钱姐：205',
  '那些漏记许姨：365',
  '嗯嗯补报周老师：595',
  '这个并非补录许姨：445',
];

describe('R15 残片·客户名不认污染', () => {
  it('干净名字仍认：许姨、周老师、苏晓禾、李小雪', () => {
    for (const n of ['许姨', '周老师', '苏晓禾', '李小雪', '钱姐']) {
      expect(customerNameLooksContaminated(n), n).toBe(false);
      expect(isOpenedSelfCustomerName(n), n).toBe(true);
    }
  });

  it('训练组：客户位污染不认，解析不能给出带残片的 complete 客户', () => {
    expect(LEFTOVER_TRAIN.length).toBeGreaterThanOrEqual(30);
    const bad: string[] = [];
    for (const line of LEFTOVER_TRAIN) {
      expect(looksLikeContaminatedReportLine(line) || customerNameLooksContaminated(line), line).toBe(true);
      const r = tryStandardReport(line, DAY);
      if (r.status === 'complete') {
        const c = r.report.entries[0]!.customer ?? '';
        if (customerNameLooksContaminated(c) || /后补|漏报|补录|那个|这个|随便|补单|补登|漏记/.test(c)) {
          bad.push(`${line} → customer=${c}`);
        }
      }
    }
    expect(bad, bad.join('\n')).toEqual([]);
  });

  it('自留组：客户位污染不认', () => {
    expect(LEFTOVER_HELDOUT.length).toBeGreaterThanOrEqual(30);
    const bad: string[] = [];
    for (const line of LEFTOVER_HELDOUT) {
      const r = tryStandardReport(line, DAY);
      if (r.status === 'complete') {
        const c = r.report.entries[0]!.customer ?? '';
        if (customerNameLooksContaminated(c) || /后补|漏报|补录|那个|这个|随便|补单|补登|漏记|并非/.test(c)) {
          bad.push(`${line} → customer=${c}`);
        }
      }
    }
    expect(bad, bad.join('\n')).toEqual([]);
  });

  it('「别当漏报许姨」不能当作可接受客户标签', () => {
    expect(isAcceptableCustomerLabel('别当漏报许姨')).toBe(false);
    expect(isOpenedSelfCustomerName('后补许姨')).toBe(false);
    expect(isOpenedSelfCustomerName('那个许姨')).toBe(false);
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
    const dirty = /客户：(?:后补|漏报|补录|那个|这个|随便|补单|并非|漏记)/.test(r);
    const asked = /是不是要报|没看清|请.*再|没有写入任何账目|请说清楚|请问是哪位/.test(r);
    if (drafted || dirty || !asked) {
      failed.push(`${label} 「${line}」 drafted=${drafted} dirty=${dirty} asked=${asked} reply=${r.slice(0, 240)}`);
    }
    for (const d of after) {
      if (d.status === 'pending') await w.call('m-zhao', '取消');
    }
  }
  expect(failed, failed.join('\n')).toEqual([]);
}

describe('R15 残片·员工入口先问不出草稿', () => {
  it('训练组先问、无可确认草稿', async () => {
    await assertAskNoDraft(LEFTOVER_TRAIN, 'train');
  });

  it('自留组先问、无可确认草稿', async () => {
    await assertAskNoDraft(LEFTOVER_HELDOUT, 'held');
  });
});
