/**
 * R18 / D158：行首前缀只认 config/line-prefix-fixed.json 的两张固定表（标签、寒暄＋D135 客套）。
 * 表内前缀剥掉后按标准行出草稿；表外前缀、相近错字一律先问；客户名开头的行不会被误剥。句子均为自编。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { worldM05 } from '../role-eval/appointment-fixture-m05.js';
import { tryStandardReport, LINE_PREFIX_LABELS, LINE_PREFIX_GREETINGS } from '../../src/role-eval/standard-line.js';

const DAY = '2026-11-12';
const customerOf = (t: string) => { const r = tryStandardReport(t, DAY); return r.status === 'complete' ? r.report.entries.map(e => e.customer).join('|') : `(${r.status})`; };

describe('R18 / D158 固定表（配置冻结、不泛化）', () => {
  it('标签表恰为 11 个词，错字只收「报惮」；寒暄表 6 个词＋D135 客套', () => {
    const cfg = JSON.parse(readFileSync(resolve(__dirname, '../../config/line-prefix-fixed.json'), 'utf8'));
    expect(cfg.frozen).toBe(true);
    // D164：四个报数标签正式收入 frozen 表。
    expect([...cfg.labels].sort()).toEqual(['今日报单', '开单', '报一下', '报业绩', '报个单', '报单', '报惮', '报数', '报个数', '今日报数', '今天报数'].sort());
    expect([...cfg.greetings].sort()).toEqual(['大家好', '店长好', '早', '早上好', '晚上好', '老板好'].sort());
    expect(LINE_PREFIX_LABELS).toEqual(cfg.labels);
    const courtesy = JSON.parse(readFileSync(resolve(__dirname, '../../config/remark-courtesy.json'), 'utf8')).courtesy as string[];
    expect(LINE_PREFIX_GREETINGS).toEqual([...cfg.greetings, ...courtesy]);
  });

  it('表内标签（冒号或空白分隔）剥掉后客户干净', () => {
    expect(customerOf('报惮：柏姨 615（小赵）')).toBe('柏姨');
    expect(customerOf('报单：柏姨 615（小赵）')).toBe('柏姨');
    expect(customerOf('报个单 柏姨 615（小赵）')).toBe('柏姨');
    expect(customerOf('报一下：柏姨 615（小赵）')).toBe('柏姨');
    expect(customerOf('报业绩：柏姨 615（小赵）')).toBe('柏姨');
    expect(customerOf('今日报单：柏姨 615（小赵）')).toBe('柏姨');
    expect(customerOf('【今日报单】柏姨：615（小赵）')).toBe('柏姨');
    expect(customerOf('开单 柏姨 615（小赵）')).toBe('柏姨');
  });

  it('表内寒暄/客套整段在句首、后跟标点或空白时剥掉', () => {
    // D165：分隔限于冒号、逗号、空白（含换行）。
    for (const g of ['老板好，', '店长好 ', '大家好，', '早，', '早上好，', '晚上好：', '辛苦了，', '收到，']) {
      expect(customerOf(`${g}柏姨 615（小赵）`), g).toBe('柏姨');
    }
  });

  it('反例：客户名开头的行不被误剥（标签/寒暄后没有分隔就不剥）', () => {
    expect(customerOf('开单姐：615（小赵）')).toBe('开单姐');
    expect(customerOf('早姐：615（小赵）')).toBe('早姐');
    expect(customerOf('报单子：柏姨 615（小赵）')).not.toBe('柏姨');
  });
});

describe('R18 / D158 入口：表内出草稿，表外与相近错字先问', () => {
  it('行首错字标签「报惮」在表里：出草稿，客户干净', async () => {
    const w = await worldM05();
    const r = await w.call('m-zhao', '报惮：柏姨 615（小赵）');
    expect(r).toMatch(/还没入账/);
    expect(r).toContain('客户：柏姨');
  });
  it('寒暄＋标准行出草稿', async () => {
    const w = await worldM05();
    const r = await w.call('m-zhao', '早上好，柏姨 615（小赵）');
    expect(r).toMatch(/还没入账/);
    expect(r).toContain('客户：柏姨');
  });
  const outside = [
    '报但：柏姨 615（小赵）', '包单：柏姨 615（小赵）', '报弹：柏姨 615（小赵）', '抱单：柏姨 615（小赵）',
    // D164：三个原报数反例移入 R18b 的正例；表外标签仍先问。
    '交单：柏姨 615（小赵）',
    '忙疯了，柏姨 615（小赵）', '烦死，柏姨 615（小赵）', '午安，柏姨 615（小赵）',
  ];
  for (const t of outside) it(`表外前缀先问、零草稿：${t}`, async () => {
    const w = await worldM05();
    const r = await w.call('m-zhao', t);
    expect(r).not.toMatch(/还没入账/);
    expect((await w.base.listDrafts({ status: 'pending' })).length).toBe(0);
  });
});
