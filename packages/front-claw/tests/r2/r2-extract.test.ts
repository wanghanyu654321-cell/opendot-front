// R2-2：自然句报数抽取（泛化语法：客人=姓+称谓 / 项目词，金额可带 ¥、k/w/千/万、元/块，括号=员工，无括号=本人）。例句均为本文件新写。
import { describe, expect, it } from 'vitest';
import { ambiguityOf, extractReport, splitStore } from '../../src/role-eval/report-extract.js';
import { worldM04 } from '../role-eval/ledger-fixture-m04.js';

describe('R2 extractReport（纯函数）', () => {
  it('本人 / 代报 / 多笔 / 中文数字 / 单位', () => {
    expect(extractReport('今天严阿姨付了1.6k，记我名下')).toMatchObject({ status: 'complete', entries: [{ customer: '严阿姨', amount: 160000, self: true }] });
    expect(extractReport('孔姐 750（小王）')).toMatchObject({ status: 'complete', entries: [{ customer: '孔姐', amount: 75000, employeeName: '小王', self: false }] });
    expect(extractReport('今天两单：薛姐 300块，秦姐 0.45w')).toMatchObject({ status: 'complete', entries: [{ amount: 30000 }, { amount: 450000 }] });
    expect(extractReport('邱姐今天消费三千二百，记我的')).toMatchObject({ status: 'complete', entries: [{ amount: 320000 }] });
    expect(extractReport('江姐 ¥990（B店小王）')).toMatchObject({ status: 'complete', entries: [{ amount: 99000 }] });
    expect(splitStore('B店小王')).toEqual({ storeName: 'B店', employeeName: '小王' });
  });
  it('不是报数：提问、目标、引用价格、营销、其他日期', () => {
    for (const text of ['尹姐上次是不是付了680？', '本月目标设成3万', '帮我写个“980元护理套餐”的朋友圈', '昨天薛姐付了500，帮我记上']) {
      expect(extractReport(text).status, text).not.toBe('complete');
    }
  });
  it('歧义：备选 / 多位员工 / 指代不明 / 含糊词 / 笔数或合计对不上', () => {
    expect(ambiguityOf('孔姐 600 或者 650，记我的')).toBe('alternatives');
    expect(extractReport('孔姐 600（小王、小赵）')).toMatchObject({ status: 'unclear', reason: 'multi_employee' });
    expect(extractReport('孔姐的单帮她记上，600块')).toMatchObject({ status: 'unclear', reason: 'pronoun_beneficiary' });
    expect(ambiguityOf('孔姐差不多600吧，先记')).toBe('hedged');
    expect(extractReport('今天三笔：孔姐200，严姐300')).toMatchObject({ status: 'unclear', reason: 'count_mismatch' });
    expect(extractReport('孔姐200、严姐300，一共600')).toMatchObject({ status: 'unclear', reason: 'total_mismatch' });
  });
});

describe('R2 员工入口：一行两笔不再被吞成一笔', () => {
  it('「孔姐300（小王）；严姐500（赵赵）」→ 两笔都进待确认，记给各自员工', async () => {
    const w = await worldM04();
    const reply = await w.call('m-zhao', '孔姐300（小王）；严姐500（赵赵）');
    expect(reply).toContain('小王 300元'); expect(reply).toContain('小赵 500元');
    expect(await w.call('m-zhao', '对')).toContain('已入账');
    const added = (await w.base.listEntries()).filter(e => e.customerName === '孔姐' || e.customerName === '严姐').map(e => [e.ownerName, e.amount]);
    expect(added.sort()).toEqual([['小王', 30000], ['小赵', 50000]]);
  });
  it('第二笔抽不清 → 澄清，零写入（不是只记第一笔）', async () => {
    const w = await worldM04();
    const before = await w.snapshot();
    expect(await w.call('m-zhao', '孔姐300（小王）；严姐500（小王/赵赵）')).toContain('没有写入任何账目');
    expect(await w.snapshot()).toEqual(before);
  });
});
