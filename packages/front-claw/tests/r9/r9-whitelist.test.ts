/**
 * R9 D130：行尾备注白名单。词表在配置里，整条备注必须由白名单词组成。
 * 自编句子，不取留出集原句。
 */
import { writeFileSync, mkdtempSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, afterEach } from 'vitest';
import {
  isWhitelistedRemark,
  loadRemarkWhitelistConfig,
  remarkWhitelistConfig,
  setProjectNameSource,
  projectNamesForStore,
  allWhitelistPhrases,
  REMARK_DRAFT_POLICY,
  REMARK_WHITELIST_CONFIG_PATH,
} from '../../src/role-eval/remark-whitelist.js';
import { classifyStandardRemark, tryStandardReport } from '../../src/role-eval/standard-line.js';

const DAY = '2026-11-12';

afterEach(() => {
  setProjectNameSource(null);
  loadRemarkWhitelistConfig();
});

describe('D130 白名单在配置里，不写死在匹配逻辑', () => {
  it('默认从 config/remark-whitelist.json 按类别加载，匹配源码不含词条硬编码表', () => {
    expect(existsSync(REMARK_WHITELIST_CONFIG_PATH)).toBe(true);
    expect(REMARK_DRAFT_POLICY).toBe('whitelist');
    const cfg = remarkWhitelistConfig();
    expect(cfg.customerType).toEqual(expect.arrayContaining(['老客', '新客', '转介绍', '朋友带来的']));
    expect(cfg.payment).toEqual(expect.arrayContaining(['微信', '支付宝', '刷卡', '现金', '办卡', '充值', '补差价']));
    expect(cfg.praise).toEqual(expect.arrayContaining(['不错', '满意', '不用找']));
    expect(cfg.project.length).toBeGreaterThan(0);
    // 换一份临时配置后，「光子」才放行，说明判断读配置而不是代码里的死表。
    const dir = mkdtempSync(join(tmpdir(), 'r9-wl-'));
    const path = join(dir, 'wl.json');
    writeFileSync(path, JSON.stringify({
      customerType: ['熟客'],
      payment: ['转账'],
      praise: ['很好'],
      project: [],
    }));
    loadRemarkWhitelistConfig(path);
    expect(isWhitelistedRemark('熟客转账')).toBe(true);
    expect(isWhitelistedRemark('很好')).toBe(true);
    expect(isWhitelistedRemark('不错')).toBe(false);
    expect(isWhitelistedRemark('老客')).toBe(false);
    loadRemarkWhitelistConfig();
    expect(isWhitelistedRemark('不错')).toBe(true);
  });

  it('项目名一类通过 ProjectNameSource 接口注入，缺省退回配置；出错不抛', () => {
    expect(projectNamesForStore().length).toBeGreaterThan(0);
    setProjectNameSource(({ storeId } = {}) => (storeId === 's-b' ? ['光子嫩肤', '氨基酸洁面'] : []));
    expect(projectNamesForStore({ storeId: 's-b' })).toEqual(['光子嫩肤', '氨基酸洁面']);
    expect(isWhitelistedRemark('光子嫩肤', { storeId: 's-b' })).toBe(true);
    expect(isWhitelistedRemark('光子嫩肤', { storeId: 's-a' })).toBe(false);
    expect(isWhitelistedRemark('不错光子嫩肤', { storeId: 's-b' })).toBe(true);
    setProjectNameSource(() => { throw new Error('store table down'); });
    expect(isWhitelistedRemark('水光')).toBe(true);
    expect(projectNamesForStore({ storeId: 's-b' }).length).toBeGreaterThan(0);
  });
});

describe('D130 整条备注都由白名单词组成才放行', () => {
  it('单类、跨类拼接、夹标点空白都放行', () => {
    for (const note of ['不错', '满意', '不用找', '老客', '新客', '转介绍', '朋友带来的', '微信', '支付宝', '刷卡', '现金', '办卡', '充值', '补差价', '水光', '皮肤管理']) {
      expect(isWhitelistedRemark(note), note).toBe(true);
      expect(classifyStandardRemark(note), note).toBe('allow');
    }
    expect(isWhitelistedRemark('不错😊')).toBe(true);
    expect(isWhitelistedRemark('😊')).toBe(true);
    expect(classifyStandardRemark('😊')).toBe('allow');
    expect(classifyStandardRemark('不错😊')).toBe('allow');
    expect(isWhitelistedRemark('老客微信')).toBe(true);
    expect(isWhitelistedRemark('新客，支付宝')).toBe(true);
    expect(isWhitelistedRemark('不错 水光')).toBe(true);
    expect(isWhitelistedRemark('转介绍、不用找')).toBe(true);
    expect(classifyStandardRemark('老客微信')).toBe('allow');
    const ok = tryStandardReport('周老师：680（小赵）老客微信', DAY);
    expect(ok.status).toBe('complete');
    if (ok.status === 'complete') expect(ok.report.entries[0]!.note).toContain('老客微信');
  });

  it('只是包含白名单词的不能放行：「不错但没做」以及否定、其它夹杂', () => {
    expect(isWhitelistedRemark('不错但没做')).toBe(false);
    expect(classifyStandardRemark('不错但没做')).toBe('model');
    expect(isWhitelistedRemark('没做')).toBe(false);
    expect(isWhitelistedRemark('不错啊但是没做成')).toBe(false);
    expect(isWhitelistedRemark('微信转给别人了')).toBe(false);
    expect(isWhitelistedRemark('还不错')).toBe(false); // 剩余「还」或前缀对不上整词贪心
    expect(isWhitelistedRemark('第三个成就')).toBe(false);
    expect(classifyStandardRemark('最后没做')).toBe('model');
    expect(classifyStandardRemark('退卡')).toBe('model');
    // 解析层仍完整，挡在入口（历史清单不被解析层打成 ask）
    expect(tryStandardReport('周老师：680（小赵）不错但没做', DAY).status).toBe('complete');
    expect(tryStandardReport('钱姐：880（小王）最后没做', DAY).status).toBe('complete');
  });

  it('出头 / 左右 仍是约数，不因白名单改成放行或模型', () => {
    expect(classifyStandardRemark('出头')).toBe('hedge');
    expect(classifyStandardRemark('左右')).toBe('hedge');
    expect(tryStandardReport('周老师：680（小赵）出头', DAY).status).toBe('ask');
  });

  it('短语按最长优先：不会把「朋友带来的」拆残', () => {
    const phrases = allWhitelistPhrases();
    const idx = phrases.indexOf('朋友带来的');
    expect(idx).toBeGreaterThanOrEqual(0);
    if (phrases.includes('朋友')) expect(phrases.indexOf('朋友')).toBeGreaterThan(idx);
    expect(isWhitelistedRemark('朋友带来的')).toBe(true);
    expect(isWhitelistedRemark('朋友带来')).toBe(false);
  });
});
