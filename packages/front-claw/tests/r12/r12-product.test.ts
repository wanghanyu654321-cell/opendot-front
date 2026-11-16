/**
 * R12 端到端：开票白名单出草稿；「先记着回头给票」追问不执行；
 * 汇总/目标/时段类句子追问或不执行，不成标准行、零写入。
 * 自编句子（周老师、钱姐、孙姨），不取留出集。
 */
import { describe, expect, it } from 'vitest';
import { worldM05 } from '../role-eval/appointment-fixture-m05.js';
import { isStandardAmountLine, tryStandardReport } from '../../src/role-eval/standard-line.js';

const DAY = '2026-11-12';

describe('D130 开票类三词：标准行加括号员工直接出草稿', () => {
  it('「回头给票」「要开票」「开发票」各出草稿且不提行尾备注；「先记着回头给票」追问零写入', async () => {
    const w = await worldM05();
    const a = await w.call('m-zhao', '周老师：680（小赵）回头给票');
    expect(a).toMatch(/还没入账/);
    expect(a).not.toMatch(/行尾备注/);
    await w.call('m-zhao', '取消');
    const b = await w.call('m-zhao', '钱姐：880（小王）要开票');
    expect(b).toMatch(/还没入账/);
    expect(b).not.toMatch(/行尾备注/);
    await w.call('m-zhao', '取消');
    const c = await w.call('m-zhao', '孙姨：760（小赵）开发票');
    expect(c).toMatch(/还没入账/);
    expect(c).not.toMatch(/行尾备注/);
    await w.call('m-zhao', '取消');
    const before = JSON.stringify(await w.snapshot());
    const ask = await w.call('m-zhao', '钱姐：440（小王）先记着回头给票');
    expect(ask).toMatch(/需要确认|没有写入|行尾备注/);
    expect(ask).not.toMatch(/还没入账，回「对」/);
    expect(JSON.stringify(await w.snapshot())).toBe(before);
  });
});

describe('客户名边界：汇总/目标/时段句子追问或不执行，不能成标准行', () => {
  it('「今天一共 3000」「本月目标 5万」及同类句子不成标准行、不入账', async () => {
    const w = await worldM05();
    const phrases = [
      '今天一共 3000',
      '本月目标 5万',
      '一共 2000',
      '总共 1500',
      '这周 800',
      '刚才 600',
      '合计 2200',
      '本周 900',
      '全部 800',
      '今天一共 3000（小赵）',
      '本月目标 5万（小王）',
      '一共 2000（小赵）',
      '这周 800（小赵）',
      '刚才 600（小王）',
    ];
    const before = JSON.stringify(await w.snapshot());
    for (const t of phrases) {
      expect(isStandardAmountLine(t), t).toBe(false);
      expect(tryStandardReport(t, DAY).status, t).toBe('none');
      const r = await w.call('m-zhao', t);
      expect(r, t).not.toMatch(/还没入账/);
      expect(r, t).toMatch(/需要确认|没有写入|没太明白|权限|不能做|没有读取或写入/);
      if (/还没入账|还没登记|还没改/.test(r)) await w.call('m-zhao', '取消').catch(() => {});
    }
    expect(JSON.stringify(await w.snapshot())).toBe(before);
  });
});
