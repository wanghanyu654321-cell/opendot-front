/**
 * R10：归属、复合、客套在同一份语法里剥离；剩下的才走 D130。
 * 自编句子（钱姐、周老师、李小雪），不取留出集原句。
 */
import { writeFileSync, mkdtempSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, afterEach } from 'vitest';
import {
  interpretStandardTail, ownershipConflictDetail, classifyStandardRemark,
  tryStandardReport, parseStandardLine,
} from '../../src/role-eval/standard-line.js';
import {
  loadRemarkCourtesyConfig, stripTrailingCourtesy, REMARK_COURTESY_CONFIG_PATH,
} from '../../src/role-eval/remark-courtesy.js';
import { isWhitelistedRemark } from '../../src/role-eval/remark-whitelist.js';

const DAY = '2026-11-12';

afterEach(() => {
  loadRemarkCourtesyConfig();
});

describe('D135 行尾致谢是可配置的一类，不是同义词路由', () => {
  it('默认从 config/remark-courtesy.json 加载；只有整段都是客套才剥', () => {
    expect(existsSync(REMARK_COURTESY_CONFIG_PATH)).toBe(true);
    expect(stripTrailingCourtesy('谢啦').rest).toBe('');
    expect(stripTrailingCourtesy('谢谢').courtesy).toMatch(/谢谢/);
    expect(stripTrailingCourtesy('辛苦了').rest).toBe('');
    expect(stripTrailingCourtesy('麻烦了').rest).toBe('');
    // 整段不是客套：一处都不剥（「不错谢谢」「谢谢，不过没做」）
    expect(stripTrailingCourtesy('不错谢谢').rest).toBe('不错谢谢');
    expect(stripTrailingCourtesy('谢谢，不过没做').rest).toMatch(/不过没做/);
    expect(stripTrailingCourtesy('谢谢，不过没做').courtesy).toBeNull();
    expect(stripTrailingCourtesy('谢谢才没做').rest).toBe('谢谢才没做');
    const dir = mkdtempSync(join(tmpdir(), 'r10-c-'));
    const path = join(dir, 'c.json');
    writeFileSync(path, JSON.stringify({ courtesy: ['费心了'] }));
    loadRemarkCourtesyConfig(path);
    expect(stripTrailingCourtesy('费心了').rest).toBe('');
    expect(stripTrailingCourtesy('谢啦').rest).toBe('谢啦'); // 不再用默认表，说明读配置而不是代码同义词
    loadRemarkCourtesyConfig();
    expect(stripTrailingCourtesy('谢啦').rest).toBe('');
  });
});

describe('D133–D135 interpretStandardTail：先剥再走白名单', () => {
  it('归属说法不进备注：算我的、报我今天的、帮他报、这单不是我的', () => {
    const a = interpretStandardTail('算我的');
    expect(a).toMatchObject({ ownership: 'self', ownershipText: '算我的', remark: '' });
    const b = interpretStandardTail('报我今天的');
    expect(b.ownership).toBe('self');
    expect(b.remark).toBe('');
    const c = interpretStandardTail('帮他报一下');
    expect(c).toMatchObject({ ownership: 'other', remark: '' });
    const d = interpretStandardTail('替同店的他报');
    expect(d.ownership).toBe('other');
    const e = interpretStandardTail('这单不是我的哈');
    expect(e).toMatchObject({ ownership: 'not_self', remark: '' });
    const f = interpretStandardTail('记我名下');
    expect(f.ownership).toBe('self');
    const g = interpretStandardTail('今天我的单');
    expect(g.ownership).toBe('self');
    const parsed = parseStandardLine('钱姐：680（小赵）算我的');
    expect(parsed.status).toBe('ok');
    if (parsed.status === 'ok') {
      expect(parsed.entries[0]!.note).toBe('');
      expect(parsed.entries[0]!.ownership).toBe('self');
    }
  });

  it('复合后半句拆开，头里的归属剥掉，剩下的才是备注', () => {
    const t = interpretStandardTail('记我今天的，再查下我本月进度');
    expect(t.ownership).toBe('self');
    expect(t.compound).toMatch(/查下我本月进度/);
    expect(t.remark).toBe('');
    const poster = interpretStandardTail('报我名下，另外帮做一张开业海报');
    expect(poster.ownership).toBe('self');
    expect(poster.compound).toMatch(/海报/);
    expect(poster.remark).toBe('');
    const vent = interpretStandardTail('算我的，磨了半天嘴皮子都干了');
    expect(vent.ownership).toBe('self');
    expect(vent.compound).toBeNull();
    expect(vent.remark).toMatch(/磨了半天/);
    expect(classifyStandardRemark(vent.remark)).toBe('model');
  });

  it('行尾谢啦剥掉后备注为空，标准行完整；不错但没做仍是模型备注', () => {
    const c = interpretStandardTail('谢啦');
    expect(c.remark).toBe('');
    expect(c.courtesy).toMatch(/谢啦/);
    const r = tryStandardReport('周老师：680（小赵）谢啦', DAY);
    expect(r.status).toBe('complete');
    if (r.status === 'complete') expect(r.report.entries[0]!.note).toBe('');
    expect(classifyStandardRemark('不错但没做')).toBe('model');
    expect(isWhitelistedRemark('不错但没做')).toBe(false);
    const mixed = tryStandardReport('周老师：680（小赵）不错但没做', DAY);
    expect(mixed.status).toBe('complete');
    if (mixed.status === 'complete') expect(mixed.report.entries[0]!.note).toBe('不错但没做');
  });
});

describe('D133 归属与括号员工核对', () => {
  it('算我的与括号是自己：一致；与括号是别人：冲突；这单不是我的配别人：互补', () => {
    expect(ownershipConflictDetail({
      ownership: 'self', ownershipText: '算我的', employeeName: '小赵',
      employeeIsReporter: true, hasExplicitEmployee: true,
    })).toBeNull();
    const clash = ownershipConflictDetail({
      ownership: 'self', ownershipText: '算我的', employeeName: '小王',
      employeeIsReporter: false, hasExplicitEmployee: true,
    });
    expect(clash).toMatch(/小王/);
    expect(clash).toMatch(/算我的/);
    expect(ownershipConflictDetail({
      ownership: 'not_self', ownershipText: '这单不是我的', employeeName: '小王',
      employeeIsReporter: false, hasExplicitEmployee: true,
    })).toBeNull();
    expect(ownershipConflictDetail({
      ownership: 'other', ownershipText: '帮他报', employeeName: '小王',
      employeeIsReporter: false, hasExplicitEmployee: true,
    })).toBeNull();
    expect(ownershipConflictDetail({
      ownership: 'other', ownershipText: '帮他报', employeeName: '小赵',
      employeeIsReporter: true, hasExplicitEmployee: true,
    })).toMatch(/冲突|自己/);
    expect(ownershipConflictDetail({
      ownership: 'other', ownershipText: '帮他报', employeeName: '',
      employeeIsReporter: true, hasExplicitEmployee: false,
    })).toMatch(/哪位同事/);
  });
});
