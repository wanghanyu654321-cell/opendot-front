/**
 * R15：纯标准行不退化；D143 过期口径不动。
 */
import { describe, expect, it } from 'vitest';
import { tryStandardReport, parseStandardLine } from '../../src/role-eval/standard-line.js';
import { DRAFT_EXPIRED_REREPORT } from '../../src/role-eval/employee-loop.js';
import { worldM05 } from '../role-eval/appointment-fixture-m05.js';

const DAY = '2026-11-12';

describe('R15 纯标准行不退化', () => {
  it('带括号姓＋称谓仍是完整标准行', () => {
    const r = tryStandardReport('许姨：720（小赵）', DAY);
    expect(r.status).toBe('complete');
    if (r.status === 'complete') {
      expect(r.report.entries[0]!.customer).toBe('许姨');
      expect(r.report.entries[0]!.amount).toBe(72000);
    }
  });

  it('双空格「周老师  680」仍能解析，不把空格收成逗号', () => {
    const p = parseStandardLine('周老师  680');
    expect(p.status, JSON.stringify(p)).toBe('ok');
    if (p.status === 'ok') {
      expect(p.entries[0]!.customer).toBe('周老师');
      expect(p.entries[0]!.amount).toBe(68000);
    }
  });

  it('员工入口：纯标准行仍出可确认草稿', async () => {
    const w = await worldM05();
    const r = await w.call('m-zhao', '许姨：720（小赵）');
    expect(r).toMatch(/还没入账/);
    expect(r).toMatch(/\n客户：许姨\n/);
    const drafts = await w.base.listDrafts({ status: 'pending' });
    expect(drafts.length).toBe(1);
    await w.call('m-zhao', '取消');
  });

  it('D143 过期回「对」的固定措辞未改', () => {
    expect(DRAFT_EXPIRED_REREPORT).toBe('Front Claw：这笔已过期，请重新报。（未入账）');
  });
});
