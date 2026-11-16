/**
 * R7 金额唯一收口（自编用例，不取留出集原句）。
 * 根因：脏词被剥离后，干净数字经旧路径进了草稿。本文件验证统一校验函数与绕过失败。
 */
import { describe, expect, it } from 'vitest';
import {
  guardUtteranceAmounts, guardAmountTerm, sealDraftAmounts, UnvalidatedAmountError,
  isStandardAmountLine, centsFromModelSlot, guardIssueToReason,
} from '../../src/role-eval/amount-guard.js';
import { extractReport } from '../../src/role-eval/report-extract.js';
import { parseEntryLine, parseLooseReport } from '../../src/role-eval/report-parse.js';
import { parseAmount } from '../../src/role-eval/ledger-commands.js';
import { worldM05 } from '../role-eval/appointment-fixture-m05.js';
import { clarifyQuestion } from '../../src/role-eval/clarify.js';

describe('R7 标准行纯数字按元直接收（不伤门①）', () => {
  it('「张三：680（李四）」是标准行，680 按元收', () => {
    expect(isStandardAmountLine('张三：680（李四）')).toBe(true);
    const g = guardUtteranceAmounts('张三：680（李四）', 'standard-line');
    expect(g).toMatchObject({ ok: true, cents: 68000 });
    const line = parseEntryLine('张三：680（李四）');
    expect(line).toMatchObject([{ customer: '张三', amount: 68000, employeeName: '李四' }]);
    expect(parseLooseReport('张三：680（李四）', '2026-11-12').status).toBe('complete');
  });
  it('标准行里整数部分≥100的小数和带单位金额都收下；0.33 按 D122 追问是不是万', () => {
    expect(guardUtteranceAmounts('张三：680.5（李四）', 'standard-line')).toMatchObject({ ok: true, cents: 68050 });
    // D122（PM 21:30）：标准行无单位小数整数部分 < 100 追问「是 X 万吗」，不再按 0.33 元收下。
    expect(guardUtteranceAmounts('张三：0.33（李四）', 'standard-line')).toMatchObject({ ok: false, issue: 'ask_wan' });
    expect(guardUtteranceAmounts('张姐：0.33w（小王）', 'standard-line')).toMatchObject({ ok: true, cents: 330000 });
    expect(guardUtteranceAmounts('张姐 3k（小王）', 'standard-line')).toMatchObject({ ok: true, cents: 300000 });
  });
  it('自由句「张姐680」仍是明确报单，整数按元收', () => {
    expect(extractReport('张姐680').status).toBe('complete');
    expect(extractReport('张姐680')).toMatchObject({ entries: [expect.objectContaining({ amount: 68000 })] });
    expect(guardUtteranceAmounts('张姐680', 'free')).toMatchObject({ ok: true, cents: 68000 });
  });
});

describe('R7 约数/方向词与无单位歧义小数一律追问，不改符号', () => {
  it('「出头」不能剥掉后收下数字', () => {
    for (const t of ['张姐2000出头', '张姐 2000出头', '张姐两千出头', '张姐2000出头（小王）', '张姐：2000出头（李四）']) {
      const g = guardUtteranceAmounts(t, 'free');
      expect(g.ok, t).toBe(false);
      if (!g.ok) expect(g.issue, t).toBe('vague_amount');
      expect(extractReport(t).status, t).not.toBe('complete');
      expect(parseEntryLine(t), t).toBeNull();
    }
  });
  it('「亏了 / 赔了」不能收成正数，也不改符号后入账', () => {
    for (const t of ['张姐亏了800', '张姐赔了200', '张姐 亏了 200']) {
      const g = guardUtteranceAmounts(t, 'free');
      expect(g.ok, t).toBe(false);
      if (!g.ok) expect(['negative', 'vague_amount']).toContain(g.issue);
      const ex = extractReport(t);
      expect(ex.status, t).not.toBe('complete');
    }
  });
  it('「多 / 左右」仍追问', () => {
    expect(guardUtteranceAmounts('680多', 'free').ok).toBe(false);
    expect(guardUtteranceAmounts('张姐680左右', 'free').ok).toBe(false);
    expect(extractReport('张姐680左右').status).toBe('unclear');
  });
  it('自由句无单位小数 0.33 追问；带单位的 0.33w / 3k / 1.2万 直接解析', () => {
    expect(guardAmountTerm('0.33', 'free')).toMatchObject({ ok: false, issue: 'bare_ambiguous' });
    expect(extractReport('张姐 0.33').status).not.toBe('complete');
    expect(guardAmountTerm('0.33w', 'free')).toMatchObject({ ok: true, cents: 330000 });
    expect(guardAmountTerm('3k', 'free')).toMatchObject({ ok: true, cents: 300000 });
    expect(guardAmountTerm('1.2万', 'free')).toMatchObject({ ok: true, cents: 1_200_000 });
    expect(extractReport('张姐 0.33w')).toMatchObject({ status: 'complete', entries: [expect.objectContaining({ amount: 330000 })] });
    expect(extractReport('张姐 3k')).toMatchObject({ status: 'complete', entries: [expect.objectContaining({ amount: 300000 })] });
    expect(extractReport('张姐 1.2万')).toMatchObject({ status: 'complete', entries: [expect.objectContaining({ amount: 1_200_000 })] });
    expect(parseAmount('0.33w')).toBe(330000);
    expect(parseAmount('3k')).toBe(300000);
    expect(parseAmount('1.2万')).toBe(1_200_000);
    expect(parseAmount('2000出头')).toBeNull();
  });
  it('既有改口说法（其实是 / 弄成）金额干净时仍能抽取，以便数据兜底', () => {
    expect(extractReport('张姐其实是880').status).toBe('complete');
    expect(extractReport('张姐金额弄成880')).toMatchObject({ entries: [expect.objectContaining({ amount: 88000 })] });
  });
});

describe('R7 绕过校验函数的金额不能进入草稿', () => {
  it('源句有「出头」时，即使条目只带干净的 2000，seal 也失败', () => {
    expect(() => sealDraftAmounts({
      utterance: '张姐2000出头',
      items: [{ amount: 200000, amountText: '2000' }],
      context: 'free',
    })).toThrow(UnvalidatedAmountError);
    try {
      sealDraftAmounts({ utterance: '张姐2000出头', items: [{ amount: 200000, amountText: '2000' }], context: 'free' });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(UnvalidatedAmountError);
      expect((e as Error).message).toBe('unvalidated_amount');
    }
  });
  it('没有源、分值也对不上句中已校验金额 → 失败', () => {
    expect(() => sealDraftAmounts({ utterance: '张姐680', items: [{ amount: 999_000_00 }], context: 'free' })).toThrow(UnvalidatedAmountError);
    expect(() => sealDraftAmounts({ utterance: '你好', items: [{ amount: 68000 }], context: 'free' })).toThrow(UnvalidatedAmountError);
    expect(() => sealDraftAmounts({ utterance: '张姐680', items: [], context: 'free' })).toThrow(UnvalidatedAmountError);
  });
  it('合法标准行与「张姐680」可以通过 seal', () => {
    expect(() => sealDraftAmounts({ utterance: '张三：680（李四）', items: [{ amount: 68000 }], context: 'standard-line' })).not.toThrow();
    expect(() => sealDraftAmounts({ utterance: '张姐680', items: [{ amount: 68000 }], context: 'free' })).not.toThrow();
    expect(() => sealDraftAmounts({ utterance: '张姐 0.33w', items: [{ amount: 330000, amountText: '0.33w' }], context: 'free' })).not.toThrow();
  });
  it('模型槽位不得直接给分；原始字符串必须过同一函数', () => {
    expect(centsFromModelSlot(200000)).toMatchObject({ ok: false, issue: 'unvalidated' });
    expect(centsFromModelSlot('2000出头')).toMatchObject({ ok: false });
    expect(centsFromModelSlot('0.33w')).toMatchObject({ ok: true, cents: 330000 });
  });
  it('入口：脏金额不出「还没入账」草稿，零写入', async () => {
    const w = await worldM05();
    for (const text of ['周姐三千出头', '周姐亏了五百', '周姐 0.33', '周姐 880 左右']) {
      const reply = await w.call('m-zhao', text);
      expect(reply, text).not.toMatch(/还没入账/);
      expect(reply, text).not.toMatch(/已入账/);
    }
    expect((await w.base.listDrafts()).filter(d => d.status === 'pending')).toEqual([]);
    expect((await w.base.listEntries()).filter(e => e.customerName === '周姐')).toEqual([]);
  });
  it('入口：标准行与 0.33w / 3k 能出草稿（门①）', async () => {
    const w = await worldM05();
    // D165/D139：未知全名先确认名字，金额口径不变。
    expect(await w.call('m-zhao', '张三：680（小赵）')).toContain('是新客户');
    const a = await w.call('m-zhao', '是');
    expect(a).toMatch(/还没入账/);
    expect(await w.call('m-zhao', '取消')).toMatch(/取消|关闭/);
    const b = await w.call('m-zhao', '钱姐 0.33w');
    expect(b).toMatch(/还没入账/);
    expect(b).toMatch(/3300/);
    expect(await w.call('m-zhao', '对')).toContain('已入账');
    const rows = (await w.base.listEntries()).filter(e => e.customerName === '钱姐' && e.status === 'confirmed');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.amount).toBe(330000);
  });
  it('clarify 原因映射可用', () => {
    expect(guardIssueToReason('bare_ambiguous')).toBe('vague_amount');
    expect(clarifyQuestion('vague_amount')).toMatch(/最多两位小数/);
    expect(clarifyQuestion('negative')).toMatch(/负/);
  });
});

describe('R7 金额收口不伤门①：客人名、日期标题、预约钟点', () => {
  it('无称谓客人名 + 整数、以及「付了1.6k」按元/单位收', () => {
    expect(guardUtteranceAmounts('林倩 10000', 'free')).toMatchObject({ ok: true, cents: 1_000_000 });
    expect(extractReport('今天严阿姨付了1.6k，记我名下')).toMatchObject({ status: 'complete', entries: [expect.objectContaining({ amount: 160000 })] });
  });
  it('日期标题和预约钟点不是金额，不拦截清单或预约', () => {
    expect(guardUtteranceAmounts('11.12 B店\n680（小赵）', 'standard-line')).toMatchObject({ ok: true, cents: 68000 });
    expect(parseEntryLine('林倩 10000（小卿）')).toMatchObject([{ customer: '林倩', amount: 1_000_000 }]);
    expect(guardUtteranceAmounts('明天 15:00 李女士 来做美甲', 'free').ok === false
      && (guardUtteranceAmounts('明天 15:00 李女士 来做美甲', 'free') as { issue?: string }).issue === 'bad'
      || guardUtteranceAmounts('明天 15:00 李女士 来做美甲', 'free').ok).toBeTruthy();
    const g = guardUtteranceAmounts('明天 15:00 李女士 来做美甲', 'free');
    // 钟点被跳过：无金额跨度（issue=bad）或没有把 00 当金额。
    expect(g.ok || ('issue' in g && g.issue === 'bad')).toBe(true);
    expect(JSON.stringify(g)).not.toMatch(/00李女士/);
  });
  it('金额后的短称呼是归属，不是约数；出头仍追问', () => {
    expect(guardUtteranceAmounts('760钱阿姨', 'free')).toMatchObject({ ok: true, cents: 76000 });
    expect(guardUtteranceAmounts('990何姐', 'free')).toMatchObject({ ok: true, cents: 99000 });
    expect(guardUtteranceAmounts('880归我', 'free')).toMatchObject({ ok: true, cents: 88000 });
    expect(extractReport('今天严阿姨付了1.6k，记我名下').status).toBe('complete');
    expect(guardUtteranceAmounts('760出头', 'free').ok).toBe(false);
    expect(guardUtteranceAmounts('990左右', 'free').ok).toBe(false);
  });
});
