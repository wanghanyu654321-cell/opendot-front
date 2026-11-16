/**
 * R8 标准行语法（D125）与 D122/D123/D124：自编句子，不取留出集原句。
 */
import { describe, expect, it } from 'vitest';
import {
  applyStandardDecimalPolicy, classifyStandardRemark, hasUnnegatedNonToday,
  isStandardAmountLine, parseStandardLine, tryStandardReport, STANDARD_DECIMAL_POLICY,
} from '../../src/role-eval/standard-line.js';
import { guardUtteranceAmounts, guardAmountTerm, sealDraftAmounts } from '../../src/role-eval/amount-guard.js';
import { extractReport } from '../../src/role-eval/report-extract.js';
import { parseLooseReport, parseEntryLine } from '../../src/role-eval/report-parse.js';
import { DEFAULT_MODEL_TIMEOUT_MS, loadModelRuntimeConfig } from '../../src/role-eval/model-classify.js';
import { parseAddNewChoice } from '../../src/role-eval/ledger-commands.js';
import { looksLikeAppointment, parseAppointmentRequest } from '../../src/role-eval/appointments.js';

const DAY = '2026-11-12';

function cents(r: ReturnType<typeof tryStandardReport>, i = 0): number {
  expect(r.status, JSON.stringify(r)).toBe('complete');
  if (r.status !== 'complete') return -1;
  return r.report.entries[i]!.amount;
}

describe('D125 一份语法：X姐 + 中文万/千', () => {
  it('称呼行里的 1.2万 / 3千 由同一函数算出正确分数，抽取不再把「万」「千」当不确定金额', () => {
    const wan = tryStandardReport('钱姐：1.2万（小赵）', DAY);
    expect(cents(wan)).toBe(1_200_000);
    const qian = tryStandardReport('周老师：3千（小王）', DAY);
    expect(cents(qian)).toBe(300_000);
    const tight = tryStandardReport('赵哥1.2万（小美）', DAY);
    expect(cents(tight)).toBe(1_200_000);
    const extractWan = extractReport('钱姐：1.2万（小赵）');
    expect(extractWan).toMatchObject({ status: 'complete', entries: [{ amount: 1_200_000, customer: '钱姐' }] });
    const extractQian = extractReport('周老师：3千（小王）');
    expect(extractQian).toMatchObject({ status: 'complete', entries: [{ amount: 300_000 }] });
    expect(parseLooseReport('钱姐：1.2万（小赵）', DAY)).toMatchObject({
      status: 'complete', report: { entries: [{ amount: 1_200_000 }] },
    });
    expect(guardUtteranceAmounts('钱姐：1.2万（小赵）', 'standard-line')).toMatchObject({ ok: true, cents: 1_200_000 });
  });

  it('中文整数无「块」、一万二、全半角冒号括号、空格、序号与【今日报数】前缀都能走快通道', () => {
    expect(cents(tryStandardReport('赵哥：六百八十（小赵）', DAY))).toBe(68_000);
    expect(cents(tryStandardReport('钱姐：一万二（小王）', DAY))).toBe(12_000_00);
    expect(cents(tryStandardReport('周老师:680(小美)', DAY))).toBe(68_000);
    expect(cents(tryStandardReport('周老师  680  （小美）', DAY))).toBe(68_000);
    expect(cents(tryStandardReport('【今日报数】周老师：680（小赵）', DAY))).toBe(68_000);
    expect(cents(tryStandardReport('1. 周老师：680（小赵）', DAY))).toBe(68_000);
    expect(cents(tryStandardReport('- 周老师：680（小赵）', DAY))).toBe(68_000);
    expect(cents(tryStandardReport('周老师：680块（小赵）', DAY))).toBe(68_000);
    expect(isStandardAmountLine('【今日报数】周老师：680（小赵）')).toBe(true);
    expect(isStandardAmountLine('1、钱姐 1.2万（小王）')).toBe(true);
  });

  it('多行：上一行金额不得把下一行称呼（含「来」「多」）当成约数后缀', () => {
    const multi = '钱姐：680（小赵）\n来姐：980（小王）';
    const r = tryStandardReport(multi, DAY);
    expect(r.status, JSON.stringify(r)).toBe('complete');
    if (r.status === 'complete') {
      expect(r.report.entries).toHaveLength(2);
      expect(r.report.entries.map(e => [e.customer, e.amount])).toEqual([
        ['钱姐', 68_000], ['来姐', 98_000],
      ]);
    }
    expect(guardUtteranceAmounts(multi, 'standard-line')).toMatchObject({ ok: true });
    expect(extractReport(multi)).toMatchObject({ status: 'complete' });
    const duo = '周老师：880（小赵）\n多哥：1200（小王）';
    const r2 = tryStandardReport(duo, DAY);
    expect(r2.status, JSON.stringify(r2)).toBe('complete');
    if (r2.status === 'complete') {
      expect(r2.report.entries.map(e => e.customer)).toEqual(['周老师', '多哥']);
      expect(r2.report.entries.map(e => e.amount)).toEqual([88_000, 120_000]);
    }
    expect(guardUtteranceAmounts(duo)).toMatchObject({ ok: true });

    // 金额在行尾、下一行是称呼：seal 必须收下两笔（跨度不得把换行后的名字当约数）。
    const tail = '周老师 680\n来姐 980';
    const r3 = tryStandardReport(tail, DAY);
    expect(r3.status, JSON.stringify(r3)).toBe('complete');
    if (r3.status === 'complete') {
      expect(r3.report.entries.map(e => [e.customer, e.amount])).toEqual([
        ['周老师', 68_000], ['来姐', 98_000],
      ]);
      expect(() => sealDraftAmounts({
        utterance: tail,
        items: r3.report.entries.map(e => ({ amount: e.amount, ...(e.amountText ? { amountText: e.amountText } : {}) })),
        context: 'standard-line',
      })).not.toThrow();
    }
    expect(guardUtteranceAmounts(tail)).toMatchObject({ ok: true });
  });

  // R18 / D158：原用表外前缀「报个数」；改用表内「报个单 」（带空白分隔），其余断言不变。
  it('表内前缀「报个单」、全角数字、行尾表情仍走快通道，草稿可封口', () => {
    const t = '报个单 钱姐６８０元😊';
    const r = tryStandardReport(t, DAY);
    expect(r.status, JSON.stringify(r)).toBe('complete');
    if (r.status === 'complete') {
      expect(r.report.entries[0]).toMatchObject({ customer: '钱姐', amount: 68_000 });
      expect(() => sealDraftAmounts({
        utterance: t,
        items: r.report.entries.map(e => ({ amount: e.amount, ...(e.amountText ? { amountText: e.amountText } : {}) })),
        context: 'standard-line',
      })).not.toThrow();
    }
    expect(guardUtteranceAmounts(t)).toMatchObject({ ok: true, cents: 68_000 });
    expect(extractReport(t)).toMatchObject({ status: 'complete', entries: [{ amount: 68_000, customer: '钱姐' }] });
    expect(isStandardAmountLine(t)).toBe(true);
  });
});

describe('D122 标准行无单位小数（PM 已定）', () => {
  it('政策常量集中在一处：整数部分 < 100 追问「是 X 万吗」，≥100 按元，超过两位小数追问，整数按元', () => {
    expect(STANDARD_DECIMAL_POLICY.askIfIntegerPartBelow).toBe(100);
    expect(STANDARD_DECIMAL_POLICY.maxFractionDigits).toBe(2);
    expect(applyStandardDecimalPolicy('1.8')).toMatchObject({ ok: false, issue: 'ask_wan', askWan: '1.8' });
    expect(applyStandardDecimalPolicy('0.33')).toMatchObject({ ok: false, issue: 'ask_wan', askWan: '0.33' });
    expect(applyStandardDecimalPolicy('68.5')).toMatchObject({ ok: false, issue: 'ask_wan' });
    expect(applyStandardDecimalPolicy('680.5')).toMatchObject({ ok: true, cents: 68_050 });
    expect(applyStandardDecimalPolicy('680')).toMatchObject({ ok: true, cents: 68_000 });
    expect(applyStandardDecimalPolicy('680.555')).toMatchObject({ ok: false, issue: 'fraction' });
    expect(applyStandardDecimalPolicy('1.2万')).toMatchObject({ ok: true, cents: 1_200_000 });
    expect(tryStandardReport('周老师：1.8（小赵）', DAY)).toMatchObject({ status: 'ask', reason: 'ask_wan', detail: '1.8' });
    expect(tryStandardReport('周老师：680.5（小赵）', DAY)).toMatchObject({ status: 'complete' });
    expect(cents(tryStandardReport('周老师：680.5（小赵）', DAY))).toBe(68_050);
    expect(guardAmountTerm('1.8', 'standard-line')).toMatchObject({ ok: false, issue: 'ask_wan' });
    expect(guardAmountTerm('680.5', 'standard-line')).toMatchObject({ ok: true, cents: 68_050 });
  });
});

describe('D123 行尾否定按词组，不按单字「不」', () => {
  it('没做/未到/不做了/取消/退款/退卡/不对/先别记 归模型备注；解析层仍完整（历史清单）', () => {
    for (const tail of ['最后没做', '未到', '不做了', '取消', '退款', '退卡', '不对', '先别记']) {
      const kind = classifyStandardRemark(tail);
      const r = parseStandardLine(`周老师：680（小赵）${tail}`);
      // 「先别记」仍按约数词走解析层追问（REMARK_HEDGE）；其余非白名单归模型，解析层完整、入口拦。
      if (tail === '先别记') {
        expect(kind, tail).toBe('hedge');
        expect(r.status, tail).toBe('ask');
      } else {
        expect(kind, tail).toBe('model');
        expect(r.status, tail).toBe('ok');
      }
    }
    expect(classifyStandardRemark('不错但没做')).toBe('model');
    expect(tryStandardReport('周老师：680（小赵）最后没做', DAY).status).toBe('complete');
  });

  it('「不错」「不用找」不拦，照常出草稿并附原文', () => {
    expect(classifyStandardRemark('不错')).toBe('allow');
    expect(classifyStandardRemark('不用找')).toBe('allow');
    const ok = tryStandardReport('周老师：680（小赵）不错', DAY);
    expect(ok.status, JSON.stringify(ok)).toBe('complete');
    if (ok.status === 'complete') expect(ok.report.entries[0]!.note).toContain('不错');
    const ok2 = tryStandardReport('钱姐：880（小王）不用找', DAY);
    expect(ok2.status).toBe('complete');
    if (ok2.status === 'complete') expect(ok2.report.entries[0]!.note).toContain('不用找');
  });
});

describe('D124 非今天日期按 D81 拒，否定补报不误拒', () => {
  it('昨天/前天或标题非今天 → not_today；不是补报、今天的 → 完整', () => {
    // 解析层仍给出完整行（标题日可以不是参考日）；非今天由入口按 D81 拒。
    expect(hasUnnegatedNonToday('昨天周老师：680（小赵）', DAY)).toBe(true);
    expect(hasUnnegatedNonToday('前天钱姐：880（小王）', DAY)).toBe(true);
    const dated = tryStandardReport('11月10日 测试B店\n周老师：680（小赵）', DAY);
    expect(dated.status).toBe('complete');
    if (dated.status === 'complete') expect(dated.report.businessDay).toBe('2026-11-10');
    expect(hasUnnegatedNonToday('昨天周老师：680（小赵）', DAY)).toBe(true);
    expect(tryStandardReport('不是补报，周老师：680（小赵）', DAY).status).toBe('complete');
    expect(tryStandardReport('不是补昨天，周老师：680（小赵）', DAY).status).toBe('complete');
    expect(tryStandardReport('今天的周老师：680（小赵）', DAY).status).toBe('complete');
    expect(hasUnnegatedNonToday('不是补昨天，周老师：680（小赵）', DAY)).toBe(false);
    expect(cents(tryStandardReport('不是补报，周老师：680（小赵）', DAY))).toBe(68_000);
  });
});

describe('D126 / D127 / 超时默认', () => {
  it('再记一笔、另记一笔，含从句，识别为新增', () => {
    expect(parseAddNewChoice('再记一笔')).toBe(true);
    expect(parseAddNewChoice('另记一笔')).toBe(true);
    expect(parseAddNewChoice('那就再记一笔吧')).toBe(true);
    expect(parseAddNewChoice('那就另记一笔，谢谢')).toBe(true);
    expect(parseAddNewChoice('周老师：680（小赵）再记一笔')).toBe(false);
  });

  it('预约只认标准格式；今天+客人问句不当预约', () => {
    expect(looksLikeAppointment('今天客人来吗')).toBe(false);
    expect(parseAppointmentRequest('今天客人来吗', new Date('2026-11-12T10:00:00+08:00'), 'Asia/Singapore')).toBeNull();
    expect(looksLikeAppointment('今天周老师来不来')).toBe(false);
    expect(parseAppointmentUtteranceOrRequest()).toBeTruthy();
    function parseAppointmentUtteranceOrRequest() {
      const r = parseAppointmentRequest('预约 周老师 15:00', new Date('2026-11-12T10:00:00+08:00'), 'Asia/Singapore');
      expect(r, JSON.stringify(r)).not.toBeNull();
      return r;
    }
    const needTime = parseAppointmentRequest('预约周老师', new Date('2026-11-12T10:00:00+08:00'), 'Asia/Singapore');
    expect(needTime?.kind).toBe('needs_time');
  });

  it('模型超时默认 8000ms，配置读取同一常量', () => {
    expect(DEFAULT_MODEL_TIMEOUT_MS).toBe(8000);
    expect(loadModelRuntimeConfig().timeoutMs).toBe(8000);
  });
});

describe('备注不得吞掉第二笔金额', () => {
  it('行内第二笔金额（无称谓的「名字+数字」）不进备注，语法让出给抽取', () => {
    const r = tryStandardReport('周老师680，钱姐980，都记小赵', DAY);
    expect(r.status, JSON.stringify(r)).not.toBe('complete');
    const r2 = parseStandardLine('周老师680，钱姐980，都记小赵');
    expect(r2.status).toBe('none');
  });
});

describe('既有标准行不退化', () => {
  it('张三：680（李四）仍按元直接收', () => {
    expect(cents(tryStandardReport('张三：680（李四）', DAY))).toBe(68_000);
    expect(parseEntryLine('张三：680（李四）')).toMatchObject([{ customer: '张三', amount: 68_000, employeeName: '李四' }]);
  });
});
