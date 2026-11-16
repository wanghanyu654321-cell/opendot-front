import { expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { MODEL_TOOL_NAMES } from '../../src/role-eval/assistant-skills.js';
import type { BotReportToolName } from '../../src/role-eval/wecom-bot-report-tools.js';
import { REPORT_NUMBERS_TOOL } from '../../src/role-eval/wecom-bot-report-model.js';
import { createWecomBotHandler } from '../../src/role-eval/wecom-bot-unified-handler.js';
import { MemoryPerformanceStore } from '../../src/role-eval/performance-store.js';

const read = (file: string) => readFileSync(file, 'utf8');
it('offers models only queries and pending drafts without ledger mutation handlers', () => {
  const reportNames: BotReportToolName[] = ['report_numbers', 'get_summary'];
  expect(reportNames).toContain(REPORT_NUMBERS_TOOL.name);
  expect(REPORT_NUMBERS_TOOL.description).toContain('需员工确认');
  expect(MODEL_TOOL_NAMES).toEqual(['report_numbers', 'get_summary', 'my_progress', 'unreported', 'stores_ranking', 'submit_appointment']);
  const source = ts.createSourceFile('handler.ts', read('src/role-eval/wecom-bot-unified-handler.ts'), ts.ScriptTarget.Latest, true);
  let checked = false;
  const visit = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === 'applyModel') {
      checked = true;
      expect(node.getText(source)).not.toMatch(/setTarget|confirmPending|commitConfirmingDraft|insertEntries|confirmAppointment|managerConfirm/);
      expect(node.getText(source)).toContain('toolsFor(current.tier).includes');
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  expect(checked).toBe(true);
});

it('keeps PG report commits inside confirmation functions and ingress before the model', () => {
  const callers: string[] = [];
  const scan = (directory: string) => {
    for (const item of readdirSync(directory, { withFileTypes: true })) {
      if (/blind|corpus|holdout|^\.env|gate1-lock-ids/.test(item.name)) continue;
      const file = path.join(directory, item.name);
      if (item.isDirectory()) { scan(file); continue; }
      if (!file.endsWith('.ts')) continue;
      const source = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true);
      const visit = (node: ts.Node) => {
        if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
          if (node.expression.name.text === 'insertEntries') callers.push('unguarded:' + file);
          if (node.expression.name.text === 'commitConfirmingDraft') {
            let parent: ts.Node | undefined = node.parent;
            while (parent && !ts.isFunctionDeclaration(parent)) parent = parent.parent;
            callers.push(path.basename(file) + ':' + (parent && ts.isFunctionDeclaration(parent) ? parent.name?.text : 'unknown'));
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
  };
  scan('src');
  expect(callers.sort()).toEqual(['employee-loop.ts:finishReport', 'wecom-bot-unified-handler.ts:finishClaimed'].sort());
  const adapter = read('src/opendot/adapter.ts');
  expect(adapter).toContain('boot.handler.handleMessage');
  expect(adapter).not.toMatch(/await\s+(?:modelClassify|modelClassifier)\(/);
  const loop = read('src/role-eval/employee-loop.ts');
  expect(loop).toContain("status: text === '取消' ? 'void' : 'confirming'");
  expect(read('src/role-eval/performance-postgres.ts')).toContain("'confirming'");
});

it('rejects model attempts to call commit or administrative mutation tools', async () => {
  for (const name of ['set_target', 'confirm_appointment', 'confirmPending', 'insertEntries', 'commitConfirmingDraft']) {
    const store = new MemoryPerformanceStore();
    await store.savePerson({ personId: 'synthetic', accountId: 'synthetic', memberId: 'synthetic', displayName: '小林', storeId: 'synthetic', storeName: '测试店', tier: 'owner', roles: ['manager'], active: true });
    const handler = createWecomBotHandler({ mode: 'isolated-synthetic', legacyEntry: true, onLegacyWarn() {}, store, now: () => new Date('2026-11-12T02:00:00Z'), resolve: member => store.getPersonByMember(member), send: async () => 'not_sent',
      model: { async complete(input) {
        expect(input.allowedTools).not.toContain(name);
        return { type: 'tool', name, fields: { personName: '小林', amount: 560, index: 1 } };
      } } });
    const result = await handler.handleMessage({ memberId: 'synthetic', text: '随意问候用于模型工具测试' });
    expect(result.replies.join('')).toContain('不能办');
    expect(await store.listEntries()).toHaveLength(0);
    expect(await store.listDrafts()).toHaveLength(0);
  }
});
