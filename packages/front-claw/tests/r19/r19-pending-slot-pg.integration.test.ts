/** 20:12 评测计划第 1 条：合成多轮脚本，只判最终账本；隔离临时 PG 集群，不连接常驻库。 */
import { expect, it } from 'vitest';
import { freshDatabase, openLatest, useCluster } from '../migration/pg-harness-m08.js';
import type { Person } from '../../src/role-eval/performance-store.js';
import { createWecomBotHandler } from '../../src/role-eval/wecom-bot-unified-handler.js';

useCluster();
const person: Person = {
  personId: 'p-r19-cen', accountId: 'a-r19-cen', memberId: 'm-r19-cen', displayName: '小岑',
  storeId: 's-r19', storeName: '栖鹭店', tier: 'employee', roles: [], active: true,
};
const firstAsk = '郗蘅：1437（小岑）';
const firstDraft = '郗姨：1437（小岑）';
const nextDraft = '逯姨：1873（小岑）';
const nextAsk = '逯霁：2693（小岑）';
type Step = string | { advanceDays: number };
type Script = { title: string; steps: Step[]; amounts: number[]; names: string[] };
const scripts: Script[] = [
  { title: '追问 × 是 × 对', steps: [firstAsk, '是', '对'], amounts: [143700], names: ['郗蘅'] },
  { title: '追问 × 对 × 对', steps: [firstAsk, '对', '对'], amounts: [143700], names: ['郗蘅'] },
  { title: '追问 × 不是 × 对', steps: [firstAsk, '不是', '对'], amounts: [], names: [] },
  { title: '追问 × 取消 × 是 × 对', steps: [firstAsk, '取消', '是', '对'], amounts: [], names: [] },
  { title: '追问 × 新标准行 × 对', steps: [firstAsk, nextDraft, '对'], amounts: [187300], names: ['逯姨'] },
  { title: '追问 × 新追问 × 是 × 对', steps: [firstAsk, nextAsk, '是', '对'], amounts: [269300], names: ['逯霁'] },
  { title: '追问 × 过期 × 是 × 对', steps: [firstAsk, { advanceDays: 1 }, '是', '对'], amounts: [], names: [] },
  { title: '草稿 × 新标准行 × 对', steps: [firstDraft, nextDraft, '对'], amounts: [187300], names: ['逯姨'] },
  { title: '草稿 × 新追问 × 对 × 对', steps: [firstDraft, nextAsk, '对', '对'], amounts: [269300], names: ['逯霁'] },
  { title: '草稿 × 对 × 重复对', steps: [firstDraft, '对', '对'], amounts: [143700], names: ['郗姨'] },
  // D175 白名单：D171 没过单闸，不替换草稿。
  { title: '草稿 × D171 先问 × 对仍确认原项', steps: [firstDraft, '累计：1873（小岑）', '对'], amounts: [143700], names: ['郗姨'] },
  { title: '草稿 × 过期 × 对', steps: [firstDraft, { advanceDays: 1 }, '对'], amounts: [], names: [] },
];
// R20：同一入口会话走完所有步骤，只判最终账本；不把不同 suite 拼成端到端。
for (const kind of ['草稿', '追问'] as const) {
  const start = kind === '草稿' ? '訾姨：3917（小岑）' : '郗澄：3917（小岑）';
  const confirm = kind === '草稿' ? ['对', '对'] : ['是', '对', '对'];
  for (const message of ['我的进度', '辛苦了', '入账结果', '【11月15日】逯姨：2869（小岑）',
    '【栖鹭西店】逯姨：2869（小岑）', '逯姨：28.69（小岑）', '整单：2869（小岑）']) {
    scripts.push({ title: `R20 ${kind} × ${message} × 确认`, steps: [start, message, ...confirm],
      amounts: [391700], names: [kind === '草稿' ? '訾姨' : '郗澄'] });
  }
  for (const replacement of ['草稿', '追问'] as const) {
    scripts.push({ title: `R20 过期${kind} × 新${replacement} × 确认`,
      steps: [start, { advanceDays: 1 }, replacement === '草稿' ? '逯姨：2869（小岑）' : '逯澄：2869（小岑）',
        ...(replacement === '草稿' ? ['对', '对'] : ['是', '对', '对'])],
      amounts: [286900], names: [replacement === '草稿' ? '逯姨' : '逯澄'] });
  }
  scripts.push({ title: `R20 过期${kind} × 查询 × 迟到肯定不入账`,
    steps: [start, { advanceDays: 1 }, '入账结果', ...confirm], amounts: [], names: [] });
}
for (const script of scripts) it(`R19 PG 最终账本：${script.title}`, async () => {
  const db = await openLatest(await freshDatabase());
  try {
    await db.store.savePerson(person);
    await db.store.setConfig('employee-loop:m01', JSON.stringify({ enabled: true, storeId: person.storeId, memberIds: [person.memberId] }));
    let at = Date.parse('2026-11-16T02:00:00Z');
    const handler = createWecomBotHandler({
      mode: 'isolated-synthetic', store: db.store, now: () => new Date(at), employeeLoop: true,
      resolve: id => db.store.getPersonByMember(id), send: async () => 'sent',
      model: { complete: async () => ({ type: 'chat', text: '离线桩' }) },
    });
    for (const [index, step] of script.steps.entries()) {
      if (typeof step !== 'string') { at += step.advanceDays * 86_400_000; continue; }
      // D183：「对」须晚于草稿出现；每条消息前推进时钟，模拟员工看清新草稿后再回复。
      at += 1000;
      await handler.handleMessage({ memberId: person.memberId, text: step, messageId: `r19-step-${index}`,
        sessionId: 'r19-pg-session', bindingVersion: 1 });
    }
    const entries = await db.store.listEntries({ storeId: person.storeId, status: 'confirmed' });
    expect({ count: entries.length, total: entries.reduce((sum, e) => sum + e.amount, 0), names: entries.map(e => e.customerName).sort() })
      .toEqual({ count: script.amounts.length, total: script.amounts.reduce((sum, amount) => sum + amount, 0), names: script.names.slice().sort() });
  } finally { await db.close(); }
});
