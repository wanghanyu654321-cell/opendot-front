/**
 * R12 D138：不带括号的 2–4 字全名/昵称走快通道，没写员工就记给报单人（D102）。
 * 自编句子（苏晓禾、小雪、阿玲、李小雪、周老师），不取留出集原句。
 */
import { describe, expect, it } from 'vitest';
import {
  parseStandardLine,
  tryStandardReport,
  isStandardAmountLine,
  isOpenedSelfCustomerName,
  NOT_CUSTOMER_NAME,
} from '../../src/role-eval/standard-line.js';
import { worldM05 } from '../role-eval/appointment-fixture-m05.js';
import { seedProductNamedCustomers } from '../r13/historical-seed.js';

const DAY = '2026-11-12';

const SELF_LINES: [string, string, number][] = [
  ['苏晓禾：680', '苏晓禾', 68000],
  ['苏晓禾 680', '苏晓禾', 68000],
  ['苏晓禾680', '苏晓禾', 68000],
  ['小雪：1280', '小雪', 128000],
  ['小雪 1280', '小雪', 128000],
  ['阿玲 980', '阿玲', 98000],
  ['李小雪：680', '李小雪', 68000],
];

const HONORIFIC_SELF = [
  '周老师 680',
  '周老师：680',
  '周老师680',
  '钱姐 880',
];

const MUST_REJECT = [
  '今天一共 3000',
  '本月目标 5万',
  '一共 2000',
  '总共 1500',
  '这周 800',
  '刚才 600',
  '退款 500',
  '改成 800',
  '多少 300',
  '大概 2000',
  '我 680',
];

describe('D138 不带括号的 2–4 字名字走快通道，记给报单人', () => {
  it('指定全名和昵称（冒号/空格/紧贴）都是完整自报行，self、无员工名', () => {
    for (const [t, customer, cents] of SELF_LINES) {
      expect(isOpenedSelfCustomerName(customer), customer).toBe(true);
      const p = parseStandardLine(t);
      expect(p.status, t).toBe('ok');
      if (p.status === 'ok') {
        const e = p.entries[0]!;
        expect(e.customer, t).toBe(customer);
        expect(e.amount, t).toBe(cents);
        expect(e.employeeName, t).toBe('');
        expect(e.self, t).toBe(true);
      }
      const r = tryStandardReport(t, DAY);
      expect(r.status, t).toBe('complete');
      expect(isStandardAmountLine(t), t).toBe(true);
    }
  });

  it('带白名单备注「小雪 1280 老客 微信」仍是完整自报行', () => {
    const t = '小雪 1280 老客 微信';
    const r = tryStandardReport(t, DAY);
    expect(r.status).toBe('complete');
    if (r.status === 'complete') {
      const e = r.report.entries[0]!;
      expect(e.customer).toBe('小雪');
      expect(e.amount).toBe(128000);
      expect(e.self).toBe(true);
      expect(e.employeeName).toBe('');
      expect(e.note).toMatch(/老客/);
      expect(e.note).toMatch(/微信/);
    }
  });

  it('姓+称谓「周老师 680」等不退化，仍是完整自报行', () => {
    for (const t of HONORIFIC_SELF) {
      const r = tryStandardReport(t, DAY);
      expect(r.status, t).toBe('complete');
      if (r.status === 'complete') {
        expect(r.report.entries[0]!.self, t).toBe(true);
        expect(r.report.entries[0]!.employeeName, t).toBe('');
        expect(r.report.entries[0]!.customer, t).toMatch(/周老师|钱姐/);
      }
    }
  });

  it('指定反例不成标准行', () => {
    for (const t of MUST_REJECT) {
      expect(parseStandardLine(t).status, t).toBe('none');
      expect(tryStandardReport(t, DAY).status, t).toBe('none');
      expect(isStandardAmountLine(t), t).toBe(false);
    }
    for (const w of ['退款', '改成', '多少', '大概', '我', '一共', '总共', '合计', '目标', '本月', '本周', '这周', '刚才', '全部']) {
      expect(isOpenedSelfCustomerName(w), w).toBe(false);
    }
    expect(NOT_CUSTOMER_NAME.source).toMatch(/退款|改成|大概/);
  });

  it('「苏晓禾680算我的」仍按 D137：ownership=self，出完整行', () => {
    const p = parseStandardLine('苏晓禾680算我的');
    expect(p.status).toBe('ok');
    if (p.status === 'ok') {
      const e = p.entries[0]!;
      expect(e.customer).toBe('苏晓禾');
      expect(e.amount).toBe(68000);
      expect(e.ownership).toBe('self');
      expect(e.self).toBe(true);
      expect(e.note).toBe('');
    }
    const other = parseStandardLine('苏晓禾680报小王的');
    expect(other.status).toBe('ok');
    if (other.status === 'ok') {
      const e = other.entries[0]!;
      expect(e.customer).toBe('苏晓禾');
      expect(e.ownership).toBe('other');
      expect(e.employeeName).toBe('小王');
      expect(e.self).toBeFalsy();
    }
  });
});

describe('D138 端到端：不带括号出草稿，员工=报单人', () => {
  it('苏晓禾/小雪/阿玲/李小雪 各写法出草稿且记给小赵；白名单备注不拦；周老师不退化', async () => {
    const w = await worldM05();
    await seedProductNamedCustomers(w.base);
    const cases = [
      '苏晓禾：680',
      '苏晓禾 680',
      '苏晓禾680',
      '小雪：1280',
      '小雪 1280',
      '阿玲 980',
      '李小雪：680',
      '小雪 1280 老客 微信',
      '周老师 680',
    ];
    for (const t of cases) {
      const r = await w.call('m-zhao', t);
      expect(r, t).toMatch(/还没入账/);
      expect(r, t).toMatch(/小赵/);
      expect(r, t).not.toMatch(/行尾备注/);
      await w.call('m-zhao', '取消');
    }
  });

  it('反例追问或不执行、零写入', async () => {
    const w = await worldM05();
    const before = JSON.stringify(await w.snapshot());
    for (const t of MUST_REJECT) {
      const r = await w.call('m-zhao', t);
      expect(r, t).not.toMatch(/还没入账/);
      expect(r, t).toMatch(/需要确认|没有写入|没太明白|权限|不能做|没有读取或写入/);
      if (/还没入账|还没登记|还没改/.test(r)) await w.call('m-zhao', '取消').catch(() => {});
    }
    expect(JSON.stringify(await w.snapshot())).toBe(before);
  });

  it('「苏晓禾680算我的」按 D137 出自己的草稿；「苏晓禾680报小王的」记给小王', async () => {
    const w = await worldM05();
    await seedProductNamedCustomers(w.base);
    const a = await w.call('m-zhao', '苏晓禾680算我的');
    expect(a).toMatch(/还没入账/);
    expect(a).toMatch(/小赵/);
    expect(a).toMatch(/680/);
    expect(a).not.toMatch(/行尾备注|确认这笔记给谁/);
    await w.call('m-zhao', '取消');
    const b = await w.call('m-zhao', '苏晓禾680报小王的');
    expect(b).toMatch(/还没入账/);
    expect(b).toMatch(/小王|代报/);
    expect(b).toMatch(/680/);
    await w.call('m-zhao', '取消');
  });

  it('D131：已确认「李小雪」后再发不带括号的「李小雪：880」进二选一，不出新草稿', async () => {
    const w = await worldM05();
    const first = await w.call('m-zhao', '李小雪：680（小赵）');
    // D165/D139：括号未知客户也先确认名字，再确认入账。
    expect(first).toContain('是新客户');
    expect(await w.call('m-zhao', '是')).toMatch(/还没入账/);
    expect(await w.call('m-zhao', '对')).toMatch(/已入账/);
    const beforeEntries = JSON.stringify((await w.snapshot()).entries);
    const again = await w.call('m-zhao', '李小雪：880');
    expect(again).toMatch(/今天已经有|已有/);
    expect(again).toMatch(/李小雪/);
    expect(again).not.toMatch(/还没入账，回「对」/);
    // 二选一会挂待确认草稿，但已入账行不变、没有直接写入 880。
    expect(JSON.stringify((await w.snapshot()).entries)).toBe(beforeEntries);
    expect(again).not.toMatch(/已入账/);
  });
});
