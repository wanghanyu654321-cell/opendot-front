/**
 * R9 D131：已有客户名兜底匹配。去称谓后核心 ≥2 字才包含匹配，单字退回整词相等。
 * 自编客户名：丽、王姐、美丽、王丽、李小雪。不取留出集原句。
 */
import { describe, expect, it } from 'vitest';
import { customerCoreName, customerNameConflicts, normalizeCustomerName } from '../../src/role-eval/customer-conflict.js';

describe('D131 称谓剥离与核心名', () => {
  it('去掉一个尾部称谓：王姐→王、周老师→周、李小雪保持原样', () => {
    expect(customerCoreName('王姐')).toBe('王');
    expect(customerCoreName('周老师')).toBe('周');
    expect(customerCoreName('钱女士')).toBe('钱');
    expect(customerCoreName('李小雪')).toBe('李小雪');
    expect(customerCoreName('丽')).toBe('丽');
    expect(customerCoreName('王  姐')).toBe('王');
    expect(normalizeCustomerName('李 小 雪')).toBe('李小雪');
  });
});

describe('D131 包含匹配与单字整词相等', () => {
  it('已有「丽」时，「美丽」不触发；已有「王姐」时，「王丽」不触发', () => {
    expect(customerNameConflicts('美丽：200（小赵）', ['丽'], ['美丽'])).toEqual([]);
    expect(customerNameConflicts('王丽：880（小赵）', ['王姐'], ['王丽'])).toEqual([]);
    expect(customerNameConflicts('美丽今天来做水光：200（小赵）', ['丽', '王姐'], ['美丽'])).toEqual([]);
  });

  it('已有「丽」再报「丽」是整词相等，触发；已有「王姐」再报「王姐」或行里出现「王姐」触发', () => {
    expect(customerNameConflicts('丽：200（小赵）', ['丽'], ['丽'])).toEqual(['丽']);
    expect(customerNameConflicts('王姐：880（小赵）', ['王姐'], ['王姐'])).toEqual(['王姐']);
    expect(customerNameConflicts('这次王姐：880（小赵）', ['王姐'], ['王姐'])).toEqual(['王姐']);
    expect(customerNameConflicts('帮记王姐：880（小赵）', ['王姐'], ['王姐'])).toEqual(['王姐']);
  });

  it('已有「李小雪」时，「客户李小雪」包含核心名，触发；前缀加客户名也触发', () => {
    expect(customerNameConflicts('客户李小雪：880（小赵）', ['李小雪'], ['李小雪'])).toEqual(['李小雪']);
    expect(customerNameConflicts('这次是李小雪：880（小赵）', ['李小雪'], ['李小雪'])).toEqual(['李小雪']);
    expect(customerNameConflicts('帮记李小雪 880 元，小赵做的', ['李小雪'], [])).toEqual(['李小雪']);
  });

  it('核心名至少两字才对整行做包含：已有「林小雨」可命中行内子串；单字核心绝不以单字去套「美丽」', () => {
    expect(customerNameConflicts('今天林小雨来补水：680（小赵）', ['林小雨'], [])).toEqual(['林小雨']);
    expect(customerNameConflicts('美丽：200（小赵）', ['丽'], [])).toEqual([]);
    expect(customerNameConflicts('王丽：200（小赵）', ['王姐'], [])).toEqual([]);
  });
});
