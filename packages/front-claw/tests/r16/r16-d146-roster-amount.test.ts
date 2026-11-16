/**
 * R16 / D146 / D148：具体追问的客户名只从本店已确认账本取（回「对」入账），
 * 金额只从 amount-guard 已确定的结果取。任一取不到 → 通用追问。规则层不猜名。
 */
import { describe, expect, it } from 'vitest';
import {
  formatMaybeReportAsk, rosterNameInUtterance, determinedAmountYuan,
  guessCustomerNameFromText, GENERIC_MODEL_ASK,
} from '../../src/role-eval/model-path-ask.js';
import { loadNegatedMakeupFixedConfig } from '../../src/role-eval/negated-makeup-fixed.js';
import { stripNegatedMakeupPhrases } from '../../src/role-eval/standard-line.js';
import { worldM05 } from '../role-eval/appointment-fixture-m05.js';

const LINE_BOTH = '并非昨天那种后补，许姨：720';
const LINE_UNKNOWN_NAME = '并非补录，赵美丽：720';
const LINE_VAGUE_AMOUNT = '并非后补，许姨：大约720';

describe('R16 D148：名单 + amount-guard 决定是否写具体追问', () => {
  it('两个都有：许姨在已确认名单、金额 720 已确定 → 是不是要报客户「许姨」720 元', () => {
    const ask = formatMaybeReportAsk(LINE_BOTH, new Set(['许姨']));
    expect(ask).toMatch(/是不是要报客户「许姨」720 元这一笔/);
    expect(ask).toMatch(/没有写入任何账目/);
    expect(determinedAmountYuan(LINE_BOTH)).toBe('720');
    expect(rosterNameInUtterance(LINE_BOTH, new Set(['许姨']))).toBe('许姨');
  });

  it('名字不在名单里：金额确定也不写「是不是要报客户「赵美丽」」，用通用追问', () => {
    expect(determinedAmountYuan(LINE_UNKNOWN_NAME)).toBe('720');
    expect(rosterNameInUtterance(LINE_UNKNOWN_NAME, new Set(['许姨']))).toBeNull();
    const ask = formatMaybeReportAsk(LINE_UNKNOWN_NAME, new Set(['许姨']));
    expect(ask).toBe(GENERIC_MODEL_ASK);
    expect(ask).not.toMatch(/赵美丽/);
    // 变异对照：从文本猜会把赵美丽问出来（本测试断言生产路径不猜）。
    expect(guessCustomerNameFromText(LINE_UNKNOWN_NAME)).toBe('赵美丽');
  });

  it('金额不确定：即使许姨在名单里，也用通用追问，不写出确定的元数', () => {
    expect(rosterNameInUtterance(LINE_VAGUE_AMOUNT, new Set(['许姨']))).toBe('许姨');
    expect(determinedAmountYuan(LINE_VAGUE_AMOUNT)).toBeNull();
    const ask = formatMaybeReportAsk(LINE_VAGUE_AMOUNT, new Set(['许姨']));
    expect(ask).toBe(GENERIC_MODEL_ASK);
    expect(ask).not.toMatch(/720 元/);
  });

  it('空名单时不从文本猜「许姨」', () => {
    expect(formatMaybeReportAsk(LINE_BOTH, new Set())).toBe(GENERIC_MODEL_ASK);
    expect(rosterNameInUtterance(LINE_BOTH, new Set())).toBeNull();
  });
});

describe('R16 D146 员工入口：三种情况', () => {
  async function seedXuYi(w: Awaited<ReturnType<typeof worldM05>>) {
    const r = await w.call('m-zhao', '许姨：720（小赵）');
    expect(r, r).toMatch(/还没入账/);
    const ok = await w.call('m-zhao', '对');
    expect(ok, ok).toMatch(/已入账/);
  }

  it('两个都有（先入账许姨）：追问写出许姨和 720，不出草稿', async () => {
    const w = await worldM05();
    await seedXuYi(w);
    const r = await w.call('m-zhao', LINE_BOTH);
    expect(r).toMatch(/是不是要报客户「许姨」720 元/);
    expect(r).toMatch(/没有写入任何账目/);
    expect(r).not.toMatch(/还没入账/);
    expect((await w.base.listDrafts({ status: 'pending' })).length).toBe(0);
  });

  it('名字不在名单里：通用追问，不出现「是不是要报客户「赵美丽」」，不出草稿', async () => {
    const w = await worldM05();
    await seedXuYi(w);
    const r = await w.call('m-zhao', LINE_UNKNOWN_NAME);
    expect(r).toMatch(/没有写入任何账目/);
    expect(r).not.toMatch(/是不是要报客户「赵美丽」/);
    expect(r).not.toMatch(/还没入账/);
    expect((await w.base.listDrafts({ status: 'pending' })).length).toBe(0);
  });

  it('金额不确定：通用追问，不把大约数当成已确定金额，不出草稿', async () => {
    const w = await worldM05();
    await seedXuYi(w);
    const r = await w.call('m-zhao', LINE_VAGUE_AMOUNT);
    expect(r).toMatch(/没有写入任何账目/);
    expect(r).not.toMatch(/是不是要报客户「许姨」720 元/);
    expect(r).not.toMatch(/还没入账/);
    expect((await w.base.listDrafts({ status: 'pending' })).length).toBe(0);
  });
});

describe('R16 D142 固定说法在配置里，不再扩充', () => {
  it('配置含 R15 收入的「不是补昨天」「不是昨天那种补报」，且仍能剥干净', () => {
    const c = loadNegatedMakeupFixedConfig();
    expect(c.r15Added).toEqual(['不是补昨天', '不是昨天那种补报']);
    expect(stripNegatedMakeupPhrases('不是补昨天，周老师：680（小赵）')).toMatch(/^周老师：680（小赵）$/);
    expect(stripNegatedMakeupPhrases('不是昨天那种补报，张姐680')).toMatch(/张姐680/);
    expect(stripNegatedMakeupPhrases('不是补报许姨：720（小赵）')).toMatch(/^许姨：720（小赵）$/);
  });
});
