/**
 * R18 / D152 结构性测试：员工循环里可确认报单草稿只有一个生成入口，而且必须出示单闸签发的通行证。
 * D146/D147 与括号非名字的「先问」结论只来自单闸模块；离线桩永远不开闸。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { evaluateConfirmableReportDraft, textLevelImpurity } from '../../src/role-eval/confirmable-draft-gate.js';

const src = (rel: string) => readFileSync(resolve(__dirname, '../../src/role-eval', rel), 'utf8');

describe('R18 单闸是可确认报单草稿的唯一出口', () => {
  const loop = src('employee-loop.ts');
  it('员工循环里组装报单草稿 payload 的地方只有一处，在 buildConfirmableReportDraft 里', () => {
    const hits = [...loop.matchAll(/type:\s*'report',\s*added/g)].map(m => m.index!);
    expect(hits).toHaveLength(1);
    const start = loop.indexOf('function buildConfirmableReportDraft(');
    const end = loop.indexOf('\n  }\n', start);
    expect(start).toBeGreaterThan(0);
    expect(hits[0]!).toBeGreaterThan(start);
    expect(hits[0]!).toBeLessThan(end);
    expect(loop.slice(start, start + 120)).toMatch(/pass:\s*ConfirmableDraftPass/);
  });
  it('每个 buildConfirmableReportDraft 调用都拿的是单闸结论的 pass', () => {
    const calls = [...loop.matchAll(/buildConfirmableReportDraft\((\w+)\.pass,/g)].map(m => m[1]);
    expect(calls.length).toBeGreaterThanOrEqual(4);
    for (const v of calls) expect(loop).toMatch(new RegExp(`const ${v} = evaluateConfirmableReportDraft\\(`));
    expect([...loop.matchAll(/buildConfirmableReportDraft\(/g)].length).toBe(calls.length + 1); // +1 为定义处
  });
  it('通行证只有单闸模块能签发；员工入口与循环从不声明线上模型放行', () => {
    const gate = src('confirmable-draft-gate.ts');
    expect(gate).toMatch(/declare const PASS_BRAND: unique symbol/);
    expect(gate).not.toMatch(/export\s+(?:function|const)\s+issuePass/);
    for (const f of ['employee-loop.ts', 'employee-entry.ts']) {
      expect(src(f), f).not.toMatch(/liveModelAllowsDraft:\s*true/);
      expect(src(f), f).not.toMatch(/issuePass|PASS_BRAND/);
    }
  });
  it('入口与循环不再自己判 D146/D147/括号非名字：不直接引用底层判断函数', () => {
    for (const f of ['employee-loop.ts', 'employee-entry.ts']) {
      const s = src(f);
      expect(s, f).not.toMatch(/\bhasUnseenNegatedMakeup\b/);
      expect(s, f).not.toMatch(/\blooksLikeContaminatedReportLine\b/);
      expect(s, f).not.toMatch(/\bisBracketNotName\b/);
    }
  });
  it('离线桩：不纯一律不开闸；纯标准行能开闸；自然句来源不开闸（D155）', () => {
    const base = { today: '2026-11-12', employeeNames: new Set(['小赵']) };
    expect(evaluateConfirmableReportDraft({ ...base, text: '阮姐：730（小赵）' }).ok).toBe(true);
    expect(evaluateConfirmableReportDraft({ ...base, text: '阮姐：730（小赵）', entries: [{ customer: '阮姐', employeeName: '小赵' }], source: 'natural' }).ok).toBe(false);
    expect(evaluateConfirmableReportDraft({ ...base, text: '阮姐：730（小赵），顺手把上午那笔改成830' }).ok).toBe(false);
    expect(evaluateConfirmableReportDraft({ ...base, text: '阮姐：730（夜班）' }).ok).toBe(false);
    expect(textLevelImpurity('阮姐：730（小赵）', base.today)).toBeNull();
  });
});
