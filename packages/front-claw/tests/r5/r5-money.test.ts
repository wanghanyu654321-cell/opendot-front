// R5（D105）：整数分端到端；PG numeric 以字符串进出；禁止 JS 浮点加总。
import { describe, expect, it } from 'vitest';
import {
  addCents, formatYuan, fromPgNumeric, sumCents, toPgNumeric, yuanStringToCents,
  MAX_NUMERIC_CENTS, CENTS_PER_YUAN,
} from '../../src/role-eval/money.js';
import { amountValue } from '../../src/role-eval/amounts.js';
import { formatAmount } from '../../src/role-eval/reply.js';
import { consultantEntries, isConsultantType, isConfirmedStatus, PERF_RULE_VERSION, storeCompletionRate, sumConsultantCents } from '../../src/role-eval/perf-rules.js';
import type { LedgerEntry } from '../../src/role-eval/performance-store.js';

function entry(partial: Partial<LedgerEntry> & Pick<LedgerEntry, 'amount' | 'amountType' | 'status'>): LedgerEntry {
  return {
    entryId: partial.entryId ?? 'e', storeId: partial.storeId ?? 's-b', businessDay: partial.businessDay ?? '2026-11-12',
    customerName: partial.customerName ?? '张姐', ownerPersonId: 'p-zhao', ownerName: '小赵',
    reporterPersonId: 'p-zhao', note: '', disputed: false, createdAt: '2026-11-12T02:00:00.000Z',
    ...partial,
  };
}

describe('R5 金钱：整数分、numeric 字符串、无浮点', () => {
  it('680.5 元 = 68050 分；toPgNumeric 角分两位、整元无小数；fromPgNumeric 吃字符串', () => {
    expect(amountValue('680.5元')).toMatchObject({ ok: true, amount: 68050 });
    expect(toPgNumeric(68050)).toBe('680.50');
    expect(toPgNumeric(68000)).toBe('680');
    expect(fromPgNumeric('680.50')).toBe(68050);
    expect(fromPgNumeric('680.5')).toBe(68050);
    expect(fromPgNumeric(680)).toBe(68000); // 007 整数列：按元解释
    expect(formatYuan(68050)).toBe('680.5');
    expect(formatAmount(68050)).toBe('680.5');
    expect(formatAmount(68000)).toBe('680');
  });
  it('0.1+0.2 类加总：10 分 + 20 分 = 30 分，不出现 0.3000…', () => {
    expect(addCents(10, 20)).toBe(30);
    expect(sumCents([10, 20, 1])).toBe(31);
    const a = yuanStringToCents('0.10')!;
    const b = yuanStringToCents('0.20')!;
    expect(a).toBe(10); expect(b).toBe(20);
    expect(sumCents([a, b])).toBe(30);
    expect(formatYuan(sumCents([a, b])!)).toBe('0.3');
    expect(toPgNumeric(sumCents([a, b])!)).toBe('0.30');
    // 对照：JS 浮点会踩到 0.30000000000000004
    expect(0.1 + 0.2 === 0.3).toBe(false);
  });
  it('多笔 680.5 + 0.1 精确', () => {
    const total = sumCents([68050, 10, 20]);
    expect(total).toBe(68080);
    expect(formatYuan(total!)).toBe('680.8');
    expect(toPgNumeric(total!)).toBe('680.80');
  });
  it('超出 numeric(14,2) 上界 → null / 抛错', () => {
    expect(addCents(MAX_NUMERIC_CENTS, 1)).toBeNull();
    expect(() => toPgNumeric(MAX_NUMERIC_CENTS + 1)).toThrow(/money_overflow/);
    expect(fromPgNumeric('999999999999.99')).toBe(MAX_NUMERIC_CENTS);
  });
  it('formatAmount 不再做 Math.round(value*100)/100 浮点四舍五入（入参是分）', () => {
    // 若误把「元」当浮点四舍五入，680.5 元写成 680.5 会显示成 680.5，但 0.1+0.2 会脏。
    // 本函数只接受整数分。
    expect(formatAmount(1)).toBe('0.01');
    expect(() => formatAmount(0.1 + 0.2)).toThrow(/money_not_integer_cents/);
  });
});

describe('R5 PERF_RULE_VERSION=1：只计 confirmed + consultant（含遗留「业绩」）', () => {
  it('版本钉死为 1', () => { expect(PERF_RULE_VERSION).toBe(1); });
  it('isConsultantType / isConfirmedStatus', () => {
    expect(isConsultantType('consultant')).toBe(true);
    expect(isConsultantType('业绩')).toBe(true);
    expect(isConsultantType('commission')).toBe(false);
    expect(isConfirmedStatus('confirmed')).toBe(true);
    expect(isConfirmedStatus('pending')).toBe(false);
    expect(isConfirmedStatus('voided')).toBe(false);
  });
  it('sumConsultantCents 忽略 voided；遗留 amount_type「业绩」仍计入；完成率用门店月目标', () => {
    const rows: LedgerEntry[] = [
      entry({ amount: 68050, amountType: 'consultant', status: 'confirmed' }),
      { ...entry({ entryId: 'e2', amount: 1000, amountType: 'consultant', status: 'confirmed' }), amountType: '业绩' } as unknown as LedgerEntry,
      entry({ entryId: 'e3', amount: 50000, amountType: 'consultant', status: 'voided' }),
    ];
    expect(sumConsultantCents(rows)).toBe(69050);
    expect(storeCompletionRate(50000, 100000)).toBe(0.5);
    expect(storeCompletionRate(69050, null)).toBeNull();
    expect(storeCompletionRate(69050, 0)).toBeNull();
  });
  it('缺个人目标不影响门店完成率（完成率只看门店目标）', () => {
    expect(storeCompletionRate(50000, 100000)).toBe(0.5);
  });
});
