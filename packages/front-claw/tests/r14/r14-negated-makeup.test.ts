/**
 * R14 R13-01：否定补报短语在客户名抽取前剥离。
 * 自编句子（许姨、周老师、钱姐），不取留出集原句。
 */
import { describe, expect, it } from 'vitest';
import {
  parseStandardLine, tryStandardReport, stripNegatedMakeupPhrases,
} from '../../src/role-eval/standard-line.js';
import { worldM05 } from '../role-eval/appointment-fixture-m05.js';

const DAY = '2026-11-12';

describe('R14 否定补报短语剥离（抽取前）', () => {
  it('不是补报 / 不是在补 / 不是补的 从原文剥离，不留在客户位', () => {
    expect(stripNegatedMakeupPhrases('不是补报许姨：720（小赵）')).toMatch(/^许姨：720（小赵）$/);
    expect(stripNegatedMakeupPhrases('不是在补周老师 880')).toMatch(/^周老师 880$/);
    expect(stripNegatedMakeupPhrases('不是补的钱姐：680')).toMatch(/^钱姐：680$/);
    expect(stripNegatedMakeupPhrases('不是补报，许姨：720')).toMatch(/^许姨：720$/);
  });

  it('「不用补水」不误伤', () => {
    expect(stripNegatedMakeupPhrases('许姨：720不用补水')).toMatch(/不用补水/);
  });

  it('带括号标准行：客户是许姨，不是「不是补报许姨」', () => {
    const p = parseStandardLine('不是补报许姨：720（小赵）');
    expect(p.status).toBe('ok');
    if (p.status === 'ok') {
      expect(p.entries[0]!.customer).toBe('许姨');
      expect(p.entries[0]!.amount).toBe(72000);
      expect(p.entries[0]!.customer).not.toMatch(/不是补报/);
    }
  });

  it('不带括号：不是在补 + 姓称谓，客户是周老师', () => {
    const r = tryStandardReport('不是在补周老师 880', DAY);
    expect(r.status).toBe('complete');
    if (r.status === 'complete') {
      expect(r.report.entries[0]!.customer).toBe('周老师');
      expect(r.report.entries[0]!.amount).toBe(88000);
    }
  });

  it('不是补的钱姐：680 解析客户为钱姐', () => {
    const r = tryStandardReport('不是补的钱姐：680', DAY);
    expect(r.status).toBe('complete');
    if (r.status === 'complete') {
      expect(r.report.entries[0]!.customer).toBe('钱姐');
      expect(r.report.entries[0]!.customer).not.toMatch(/不是补/);
    }
  });
});

describe('R14 员工入口：否定补报不进客户名、能出草稿', () => {
  it('「不是补报许姨：720（小赵）」草稿客户行是许姨', async () => {
    const w = await worldM05();
    const r = await w.call('m-zhao', '不是补报许姨：720（小赵）');
    expect(r).toMatch(/还没入账/);
    expect(r).toMatch(/\n客户：许姨\n/);
    expect(r).not.toMatch(/客户：不是补报/);
    const draft = (await w.base.listDrafts({ status: 'pending' }))[0];
    if (draft?.payload.type === 'report') {
      expect(draft.payload.added[0]!.customer).toBe('许姨');
    }
    await w.call('m-zhao', '取消');
  });

  it('「不是在补周老师 880」草稿客户是周老师', async () => {
    const w = await worldM05();
    const r = await w.call('m-zhao', '不是在补周老师 880');
    expect(r).toMatch(/还没入账/);
    expect(r).toMatch(/\n客户：周老师\n/);
    expect(r).not.toMatch(/客户：不是在补/);
    await w.call('m-zhao', '取消');
  });
});
