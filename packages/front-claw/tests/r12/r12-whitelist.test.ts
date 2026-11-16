/**
 * R12：D130 白名单补充开票类「回头给票」「要开票」「开发票」；「先记着回头给票」仍追问。
 * 自编句子（周老师、钱姐、孙姨），不取留出集原句。
 */
import { describe, expect, it } from 'vitest';
import {
  isWhitelistedRemark,
  remarkWhitelistConfig,
  allWhitelistPhrases,
} from '../../src/role-eval/remark-whitelist.js';
import { classifyStandardRemark, tryStandardReport, isStandardAmountLine } from '../../src/role-eval/standard-line.js';

const DAY = '2026-11-12';
const INVOICE = ['回头给票', '要开票', '开发票'] as const;

describe('D130 开票类补进付款白名单，不改匹配逻辑', () => {
  it('配置 payment 含三词；isWhitelistedRemark 整词放行，组合「先记着回头给票」不放行', () => {
    const payment = remarkWhitelistConfig().payment;
    for (const w of INVOICE) {
      expect(payment, w).toContain(w);
      expect(isWhitelistedRemark(w), w).toBe(true);
      expect(classifyStandardRemark(w), w).toBe('allow');
    }
    expect(allWhitelistPhrases().some(p => INVOICE.includes(p as typeof INVOICE[number]))).toBe(true);
    expect(isWhitelistedRemark('先记着回头给票')).toBe(false);
    expect(classifyStandardRemark('先记着回头给票')).toBe('model');
  });

  it('标准行加括号员工加三词各出完整稿；「先记着回头给票」追问、不是完整稿', () => {
    const ok = [
      '周老师：680（小赵）回头给票',
      '钱姐：880（小王）要开票',
      '孙姨：760（小赵）开发票',
    ];
    for (const t of ok) {
      const r = tryStandardReport(t, DAY);
      expect(r.status, t).toBe('complete');
      expect(isStandardAmountLine(t), t).toBe(true);
    }
    // 解析层仍完整（与「不错但没做」同一口径），备注不在白名单，classify 走模型，入口追问。
    const leftover = tryStandardReport('钱姐：440（小王）先记着回头给票', DAY);
    expect(leftover.status).toBe('complete');
    if (leftover.status === 'complete') expect(leftover.report.entries[0]!.note).toBe('先记着回头给票');
    expect(classifyStandardRemark('先记着回头给票')).toBe('model');
    expect(isWhitelistedRemark('先记着回头给票')).toBe(false);
  });
});
