// R5（D105）：金额精确到 0.01 元，应用层整数分；D80 整数元、D84 100 万上限已撤。
import { describe, expect, it } from 'vitest';
import { amountValue, MAX_ENTRY_AMOUNT, MAX_TARGET_AMOUNT } from '../../src/role-eval/amounts.js';
import { parseAmount, parseTargetCommand } from '../../src/role-eval/ledger-commands.js';
import { worldM04 } from '../role-eval/ledger-fixture-m04.js';
import { MAX_NUMERIC_CENTS, MAX_NUMERIC_YUAN, formatYuan } from '../../src/role-eval/money.js';

describe('R5 amountValue（纯函数，整数分）', () => {
  it('合法换算：1.25k=125000 分、0.5w=500000 分、680.00=68000、680.5=68050、99.99=9999', () => {
    expect(amountValue('1.25k')).toMatchObject({ ok: true, amount: 125000 });
    expect(amountValue('0.5w')).toMatchObject({ ok: true, amount: 500000 });
    expect(amountValue('1.2345w')).toMatchObject({ ok: true, amount: 1234500 });
    expect(amountValue('680.00元')).toMatchObject({ ok: true, amount: 68000 });
    expect(amountValue('680.5元')).toMatchObject({ ok: true, amount: 68050 });
    expect(amountValue('1.2')).toMatchObject({ ok: true, amount: 120 });
    expect(amountValue('99.99')).toMatchObject({ ok: true, amount: 9999 });
    expect(amountValue('1.2345k')).toMatchObject({ ok: true, amount: 123450 });
    expect(amountValue('0.00001w')).toMatchObject({ ok: true, amount: 10 });
    expect(amountValue('¥880')).toMatchObject({ ok: true, amount: 88000 });
    expect(amountValue('2万')).toMatchObject({ ok: true, amount: 2_000_000 });
    expect(amountValue('0.001w')).toMatchObject({ ok: true, amount: 1000 });
    expect(amountValue('¥1,2k')).toMatchObject({ ok: false, issue: 'bad' });
    expect(amountValue('1,2k')).toMatchObject({ ok: false, issue: 'bad' });
  });
  it('超过两位小数不取整：680.555、1.234、0.001 → fraction', () => {
    for (const raw of ['680.555元', '1.234', '0.001', '1.234567k']) expect(amountValue(raw), raw).toMatchObject({ ok: false, issue: 'fraction' });
  });
  it('0 / 负数 / 技术上界（numeric(14,2)）', () => {
    for (const raw of ['0', '0.0k', '0元']) expect(amountValue(raw), raw).toMatchObject({ ok: false, issue: 'zero' });
    for (const raw of ['-680', '－680', '负680', '-1.2k']) expect(amountValue(raw), raw).toMatchObject({ ok: false, issue: 'negative' });
    expect(MAX_ENTRY_AMOUNT).toBe(MAX_NUMERIC_CENTS);
    expect(MAX_TARGET_AMOUNT).toBe(MAX_NUMERIC_CENTS);
    expect(amountValue(MAX_NUMERIC_YUAN)).toMatchObject({ ok: true, amount: MAX_NUMERIC_CENTS });
    expect(amountValue('1000000000000')).toMatchObject({ ok: false, issue: 'too_large' });
    expect(amountValue('9'.repeat(30))).toMatchObject({ ok: false, issue: 'too_large' });
    expect(amountValue('9007199254740993')).toMatchObject({ ok: false, issue: 'too_large' });
    expect(amountValue('101w')).toMatchObject({ ok: true, amount: 101_000_000 }); // 101 万 = 1,010,000 元
    expect(amountValue('2亿')).toMatchObject({ ok: false, issue: 'bad' });
  });
  it('账本指令同一规则：680.5 合法；超过两位小数仍拒；1.25 元合法', () => {
    expect(parseAmount('1.25k')).toBe(125000);
    expect(parseAmount('3.5万')).toBe(3500000);
    expect(parseAmount('680.5元')).toBe(68050);
    expect(parseAmount('1.5')).toBe(150);
    expect(parseAmount('0')).toBeNull();
    expect(parseAmount('680.555')).toBeNull();
    expect(parseAmount('1000000000000')).toBeNull();
    expect(parseAmount('2000000', MAX_ENTRY_AMOUNT)).toBe(2000000 * 100);
    expect(parseTargetCommand('本月目标1.25k', '2026-11-12')).toMatchObject({ amount: 125000 });
    expect(parseTargetCommand('本月目标1.25元', '2026-11-12')).toMatchObject({ amount: 125 });
  });
  it('回显：分 → 元字符串，不经浮点', () => {
    expect(formatYuan(68000)).toBe('680');
    expect(formatYuan(68050)).toBe('680.5');
    expect(formatYuan(68005)).toBe('680.05');
  });
});

describe('R5 报数入口：合法角分入账，超两位小数/0/负/上界澄清、零写入', () => {
  const ok: [string, string][] = [
    ['张姐1.25k（小王）', '1250元'],
    ['张姐0.5w', '5000元'],
    ['张姐680.00元（小王）', '680元'],
    ['张姐680.5元（小王）', '680.5元'],
  ];
  // R18 / D155：自然句报单不算纯标准行，离线先问、不出可确认草稿（原来这里期望 1200 元草稿）。
  it('R18 / D155：自然句「…消费一千二，算我的」离线先问，零草稿', async () => {
    const w = await worldM04();
    const reply = await w.call('m-zhao', '李阿姨今天消费一千二，算我的哦');
    expect(reply).not.toContain('还没入账');
    expect(reply).toContain('没有写入');
    expect((await w.snapshot()).drafts).toHaveLength(0);
  });
  for (const [text, shown] of ok) it(`合法：${text} → 待确认 ${shown}`, async () => {
    const w = await worldM04();
    const reply = await w.call('m-zhao', text);
    expect(reply).toContain('还没入账'); expect(reply).toContain(shown);
    expect((await w.snapshot()).drafts).toHaveLength(1);
  });
  const bad: [string, string][] = [
    ['李姐1.2（小王）', '是 1.2 万吗'], // D122（PM 21:30）：整数部分 < 100 的无单位小数追问是不是万，不再按 1.2 元收
    ['张姐680.555元', '两位小数'], ['张姐1.234（小王）', '两位小数'],
    ['张姐-680（小王）', '负数'], ['张姐 －680（小王）', '负数'],
    ['张姐0（小王）', '是 0'], ['今天张姐做了0元', '是 0'],
    ['张姐1000000000000（小王）', '上限'],
  ];
  for (const [text, hint] of bad) it(`澄清：${text}`, async () => {
    const w = await worldM04();
    const before = await w.snapshot();
    const reply = await w.call('m-zhao', text);
    expect(reply).toContain(hint); expect(reply).toContain('没有写入任何账目');
    expect(await w.call('m-zhao', '对')).not.toContain('已入账');
    expect(await w.snapshot()).toEqual(before);
  });
  it('目标超过技术上界 → 目标无效，零写入；1.2345k 现已合法', async () => {
    const w = await worldM04();
    const before = await w.snapshot();
    expect(await w.call('m-wang-yj', '本月目标1000000000000')).toContain('没有写入');
    expect(await w.snapshot()).toEqual(before);
    const reply = await w.call('m-wang-yj', '本月目标1.2345k');
    expect(reply).toContain('还没');
    expect(reply).toContain('1234.5元');
  });
});
