/**
 * R12 产品边界：放开的客户名只认 2–4 个汉字名字/昵称，后接冒号、空格或金额；
 * 片段含时间词、动词、查询词、汇总词即不认，不能成标准行。
 * 自编句子，不取留出集原句。
 */
import { describe, expect, it } from 'vitest';
import {
  parseStandardLine,
  tryStandardReport,
  isStandardAmountLine,
  isAcceptableCustomerLabel,
  NOT_CUSTOMER_NAME,
} from '../../src/role-eval/standard-line.js';
import { extractReport } from '../../src/role-eval/report-extract.js';
import { parseLooseReport } from '../../src/role-eval/report-parse.js';

const DAY = '2026-11-12';

/** 产品指定必须覆盖的非名字词，再加几条同类反例。 */
const REQUIRED_WORDS = ['一共', '总共', '合计', '目标', '本月', '本周', '这周', '刚才', '全部'] as const;

const MUST_REJECT = [
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
  '总共 1500（小王）',
  '这周 800（小赵）',
  '刚才 600（小王）',
  '今天一共：3000（小赵）',
  '本月目标：5万（小王）',
  '一共2000（小赵）',
  '刚才600（小赵）',
];

const STILL_ACCEPT = [
  '李小雪：680（小赵）',
  '李小雪 680（小赵）',
  '李小雪680（小赵）',
  '周老师：680（小赵）',
  '周老师：680',
  '钱姐 880',
  '丽：200（小赵）',
  '客户李小雪：880（小赵）',
  '这次是李小雪：990（小赵）',
  '今天的钱姐：880（小王）',
];

function notAStandardLine(text: string) {
  expect(parseStandardLine(text).status, text).toBe('none');
  expect(tryStandardReport(text, DAY).status, text).toBe('none');
  expect(isStandardAmountLine(text), text).toBe(false);
}

describe('非名字词表覆盖指定词，含这些词的片段不当客户名', () => {
  it('词表覆盖一共/总共/合计/目标/本月/本周/这周/刚才/全部', () => {
    for (const w of REQUIRED_WORDS) {
      expect(NOT_CUSTOMER_NAME.source, w).toContain(w);
      expect(isAcceptableCustomerLabel(w), w).toBe(false);
      expect(isAcceptableCustomerLabel(`今天${w}`), `今天${w}`).toBe(false);
    }
  });

  it('指定反例及同类写法都不是标准行，抽取和宽松解析也不出完整稿', () => {
    for (const t of MUST_REJECT) {
      notAStandardLine(t);
      const ex = extractReport(t);
      expect(ex.status, `extract:${t}`).not.toBe('complete');
      const loose = parseLooseReport(t, DAY);
      expect(loose.status, `loose:${t}`).not.toBe('complete');
    }
  });

  it('2–4 字真名、称谓和既有前缀写法仍是标准行；今天的钱姐、昨天周老师走原口径', () => {
    for (const t of STILL_ACCEPT) {
      const r = tryStandardReport(t, DAY);
      expect(r.status, t).toBe('complete');
      expect(isStandardAmountLine(t), t).toBe(true);
    }
    expect(isAcceptableCustomerLabel('李小雪')).toBe(true);
    expect(isAcceptableCustomerLabel('周老师')).toBe(true);
    expect(isAcceptableCustomerLabel('今天的钱姐')).toBe(true);
    expect(isAcceptableCustomerLabel('昨天周老师')).toBe(true);
    expect(isAcceptableCustomerLabel('客户李小雪')).toBe(true);
    expect(isAcceptableCustomerLabel('丽')).toBe(true);
    const past = tryStandardReport('昨天周老师：680（小赵）', DAY);
    expect(past.status).toBe('complete');
  });
});
