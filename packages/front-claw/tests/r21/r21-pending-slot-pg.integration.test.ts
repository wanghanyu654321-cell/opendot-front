/** R21：同一请求链实际经过员工入口、循环与 PG。只判最终账本；审查方运行。 */
import { expect, it } from 'vitest';
import { freshDatabase, openLatest, useCluster } from '../migration/pg-harness-m08.js';
import { CAPABILITIES, updateAccessPolicy } from '../../src/role-eval/access-policy.js';
import type { Person } from '../../src/role-eval/performance-store.js';
import { createWecomBotHandler } from '../../src/role-eval/wecom-bot-unified-handler.js';

useCluster();
const person: Person = {
  personId: 'p-r21-ji', accountId: 'a-r21-ji', memberId: 'm-r21-ji', displayName: '小嵇',
  storeId: 's-r21', storeName: '栖霞南店', tier: 'employee', roles: [], active: true,
};
const draft = '郗姨：3947（小嵇）'; const ask = '郗霁：3947（小嵇）'; const next = '逯姨：2873（小嵇）';
type Step = string | { expire: true } | { confirmTogether: true };
const scripts: { title: string; steps: Step[]; ledger: [string, number][] }[] = [
  { title: '并发两次对仍只入一笔', steps: [draft, { confirmTogether: true }], ledger: [['郗姨', 394700]] },
  { title: 'D178 草稿 → D153 → 对', steps: [draft, '檀霁：2873（小嵇）', '对', '对'], ledger: [['郗姨', 394700]] },
  { title: 'D178 追问 → D171 → 是 → 对', steps: [ask, '共计：2873（小嵇）', '是', '对'], ledger: [['郗霁', 394700]] },
  { title: 'D180 过期预约不改变账本', steps: ['后天下午两点郗女士来做护理', { expire: true }, '辛苦了', '对'], ledger: [] },
  { title: 'D180 过期改单保留原账', steps: [draft, '对', '把刚才那笔改成2873', { expire: true }, '入账结果', '对'], ledger: [['郗姨', 394700]] },
];
for (const initial of [draft, ask]) for (const message of ['入账结果', '辛苦了']) scripts.push({
  title: `D179 ${initial === draft ? '草稿' : '追问'}过期 → ${message} → 再报`,
  steps: [initial, { expire: true }, message, '对', next, '对', '对'], ledger: [['逯姨', 287300]],
});
for (const script of scripts) it(`R21 PG 最终账本：${script.title}`, async () => {
  const db = await openLatest(await freshDatabase());
  try {
    await db.store.savePerson(person);
    await db.store.setConfig('employee-loop:m01', JSON.stringify({ enabled: true, storeId: person.storeId, memberIds: [person.memberId] }));
    await updateAccessPolicy(db.store, { expectedVersion: null, actor: 'r21-synthetic-admin', reason: '合成多轮用例', at: '2026-11-16T02:00:00Z', next: {
      version: 1, enterprise: [...CAPABILITIES], stores: { [person.storeId]: [...CAPABILITIES] },
      roles: { employee: ['report_self', 'progress_self', 'appointment_submit', 'correct_own'], manager: [], owner: [] },
      members: { [person.personId]: { role: 'employee', storeIds: [person.storeId], status: 'active' } },
    } });
    let at = Date.parse('2026-11-16T02:00:00Z');
    const handler = createWecomBotHandler({
      mode: 'isolated-synthetic', employeeLoop: true, accessPolicy: true, store: db.store,
      now: () => new Date(at), resolve: id => db.store.getPersonByMember(id), send: async () => 'sent',
      model: { complete: async () => ({ type: 'chat', text: '离线桩' }) },
    });
    for (const [index, step] of script.steps.entries()) {
      at++; // D183：正常确认必须晚于草稿保存。
      if (typeof step !== 'string') {
        if ('expire' in step) at += 86_400_000;
        else await Promise.all([0, 1].map(n => handler.handleMessage({ memberId: person.memberId, text: '对',
          messageId: `r21-step-${index}-concurrent-${n}`, sessionId: 'r21-pg-session', bindingVersion: 1 })));
        continue;
      }
      await handler.handleMessage({ memberId: person.memberId, text: step, messageId: `r21-step-${index}`, sessionId: 'r21-pg-session', bindingVersion: 1 });
    }
    const entries = await db.store.listEntries({ storeId: person.storeId, status: 'confirmed' });
    expect(entries.map(e => [e.customerName, e.amount]).sort()).toEqual(script.ledger.slice().sort());
  } finally { await db.close(); }
});
