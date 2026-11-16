/**
 * R14：复合请求里的进度/查询不进备注，拆分后走查询（延续 D134 / R11-03）。
 * 自编句子（许姨、周老师），不取留出集原句。
 */
import { describe, expect, it } from 'vitest';
import { interpretStandardTail, tryStandardReport, classifyStandardRemark } from '../../src/role-eval/standard-line.js';
import { worldM05 } from '../role-eval/appointment-fixture-m05.js';

const DAY = '2026-11-12';

describe('R14 复合报单＋本人进度：进度不进备注', () => {
  it('行尾「报一下」加「再看下我本月完成了多少」：备注空，后半是进度复合', () => {
    const t = interpretStandardTail('报一下，再看下我本月完成了多少');
    expect(t.remark, JSON.stringify(t)).toBe('');
    expect(t.compound, JSON.stringify(t)).toMatch(/看下我本月完成了多少/);
    const parsed = tryStandardReport('许姨：720报一下，再看下我本月完成了多少', DAY);
    expect(parsed.status).toBe('complete');
    if (parsed.status === 'complete') {
      const e = parsed.report.entries[0]!;
      expect(e.customer).toBe('许姨');
      expect(e.amount).toBe(72000);
      expect(e.note).toBe('');
      expect(e.compound).toMatch(/看下我本月完成了多少/);
    }
  });

  it('无逗号的「给我报一下再查一下我今天的进度」同样不把进度留在备注', () => {
    const t = interpretStandardTail('给我报一下再查一下我今天的进度');
    expect(t.remark, JSON.stringify(t)).toBe('');
    expect(t.compound, JSON.stringify(t)).toMatch(/查一下我今天的进度/);
  });

  it('真正的非白名单备注仍走 D130，不因本轮剥离被掏空', () => {
    const t = interpretStandardTail('不错但没做');
    expect(t.compound).toBeNull();
    expect(t.remark).toMatch(/不错但没做/);
    expect(classifyStandardRemark(t.remark)).toBe('model');
  });
});

describe('R16：D141 原固定说法也归模型路径，入口先问不出草稿', () => {
  it('「许姨：720报一下，再看下我本月完成了多少」先问，无可确认草稿', async () => {
    const w = await worldM05();
    const r = await w.call('m-zhao', '许姨：720报一下，再看下我本月完成了多少');
    expect(r).toMatch(/没有写入任何账目|行尾备注|说不清|没太明白/);
    expect(r).not.toMatch(/还没入账/);
    expect((await w.base.listDrafts({ status: 'pending' })).length).toBe(0);
  });

  it('「周老师 880 给我报一下，另外查一下我今天的进度」先问，无可确认草稿', async () => {
    const w = await worldM05();
    const r = await w.call('m-zhao', '周老师 880 给我报一下，另外查一下我今天的进度');
    expect(r).toMatch(/没有写入任何账目|行尾备注|说不清|没太明白/);
    expect(r).not.toMatch(/还没入账/);
    expect((await w.base.listDrafts({ status: 'pending' })).length).toBe(0);
  });
});
