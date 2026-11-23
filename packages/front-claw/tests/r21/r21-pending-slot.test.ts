import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { createWecomBotHandler } from '../../src/role-eval/wecom-bot-unified-handler.js';
import { membersM05, policyM05, worldM05 } from '../role-eval/appointment-fixture-m05.js';
import { newCustomerAskKey } from '../../src/role-eval/customer-name-policy.js';
import { advancePendingSlot } from '../../src/role-eval/pending-slot.js';
import { DRAFT_EXPIRED_REREPORT } from '../../src/role-eval/employee-loop.js';
import type { Draft } from '../../src/role-eval/performance-store.js';

type Kind = '草稿' | '追问';
const key = newCustomerAskKey('p-zhao', 'session-m-zhao');
const name = (kind: Kind) => kind === '草稿' ? '郗姨 3947元' : '郗霁';
const start = (kind: Kind) => `${kind === '草稿' ? '郗姨' : '郗霁'}：3947（小赵）`;
const notice = (kind: Kind) => `上一笔「${name(kind)}」已过期，没有记，需要的话请重新报。`;
// D181-2：追问尾句从 listed 取金额；过期提醒继续复用原句。
const waiting = (kind: Kind) => `上一笔「${kind === '草稿' ? name(kind) : '郗霁 3947元'}」还在等你回「对」确认。`;
const questions = ['檀霁：2873（小赵）', '共计：2873（小赵）'];
async function setup(marketing = false) {
  let at = Date.parse('2026-11-16T02:00:00Z');
  const members = membersM05(); members['p-zhao']!.capabilities = ['marketing'];
  const w = await worldM05({ now: () => new Date(at), policy: policyM05(1, members),
    router: marketing ? { marketing: { enabled: true, handle: async () => '离线栖霞护理文案' } } : {} });
  for (const p of await w.base.listPeople()) {
    if (p.storeId === 's-a') await w.base.savePerson({ ...p, storeName: '栖霞北店' });
    if (marketing && p.personId === 'p-zhao') await w.base.savePerson({ ...p, roles: [...p.roles, 'marketing'] });
  }
  const expire = async () => {
    const draft = (await w.base.listDrafts({ status: 'pending' }))[0];
    at = Date.parse(draft?.expiresAt ?? JSON.parse((await w.base.getConfig(key))!).expiresAt);
  };
  const entries = async () => (await w.base.listEntries()).filter(e => e.customerName).map(e => [e.customerName, e.amount]);
  return { w, expire, entries, advance: () => { at += 1000; } };
}

describe('R21 D178 单闸先问保留唯一挂起项并在末尾点名', () => {
  for (const kind of ['草稿', '追问'] as const) for (const question of questions) {
    for (const action of ['确认原项', '新单替换'] as const) it(`${kind} × ${question} × ${action}`, async () => {
      const { w, entries, advance } = await setup();
      await w.call('m-zhao', start(kind));
      const drafts = await w.base.listDrafts(); const ask = await w.base.getConfig(key);
      expect((await w.call('m-zhao', question)).endsWith(waiting(kind))).toBe(true);
      expect(await w.base.listDrafts()).toEqual(drafts);
      expect(await w.base.getConfig(key)).toBe(ask);
      if (action === '新单替换') {
        const reply = await w.call('m-zhao', '逯姨：2873（小赵）');
        expect(reply).toContain(kind === '草稿' ? '上一笔「郗姨 3947元」没有确认，已作废，需要的话请重新报。' : '上一条「郗霁」没有记，需要的话请重新报。');
        // D183：本分支确实由 D174 替换，模拟看过新草稿后才到的确认；其他分支保持固定时钟。
        advance();
      } else if (kind === '追问') await w.call('m-zhao', '是');
      await w.call('m-zhao', '对');
      expect(await entries()).toEqual(action === '新单替换' ? [['逯姨', 287300]] : [[kind === '草稿' ? '郗姨' : '郗霁', 394700]]);
    });
  }
  for (const question of questions) it(`无挂起项 ${question} 不加提醒`, async () => {
    const { w } = await setup();
    expect(await w.call('m-zhao', question)).not.toContain('还在等你回');
  });
});

const messages = [
  ['新报单', '逯姨：2873（小赵）', '客户：逯姨'],
  ['查进度', '我的进度', '今天 已做'], ['闲聊', '辛苦了', ''],
  ['入账结果', '入账结果', ''], ['我的预约', '我的预约', '预约'],
  ['营销', '写一条栖霞护理营销文案', '营销内容功能当前未开放'],
  ['营销授权', '写一条栖霞护理营销文案', '离线栖霞护理文案'],
  ['过去日期', '【11月14日】逯姨：2873（小赵）', '只能报今天'],
  ['越权', '查小林的业绩', '不能'], ['代报', '逯姨：2873（小林）', '不能'],
  ['跨店', '【栖霞北店】逯姨：2873（小赵）', '不能'],
  ['D153', questions[0]!, ''], ['D171', questions[1]!, ''],
];
describe('R21 D179 任何下一条消息都在正常回复后消费过期项一次', () => {
  for (const kind of ['草稿', '追问'] as const) for (const [label, text, normal] of messages) it(`${kind} × ${label}`, async () => {
    const { w, expire } = await setup(label === '营销授权');
    await w.call('m-zhao', start(kind)); await expire();
    const drafts = await w.base.listDrafts();
    const ask = await w.base.getConfig(key);
    const reply = await w.call('m-zhao', text!);
    expect(reply.endsWith(notice(kind))).toBe(true);
    expect(reply.split(notice(kind))).toHaveLength(2);
    expect(reply.slice(0, -notice(kind).length).trim()).not.toBe('');
    if (normal) expect(reply.slice(0, -notice(kind).length)).toContain(normal);
    expect(reply).not.toContain('还在等你回');
    if (label === '入账结果') expect(reply).not.toMatch(/回复「对」|回复.*取消/);
    if (['查进度', '入账结果', '我的预约'].includes(label!)) {
      expect(await w.base.listDrafts()).toEqual(drafts);
      expect(await w.base.getConfig(key)).toBe(ask);
      expect(await w.call('m-zhao', '取消')).toContain(notice(kind));
    }
    expect((await w.base.listDrafts({ status: 'pending' })).map(d => d.payload.type)).toEqual(label === '新报单' ? ['report'] : []);
    expect((await w.base.getConfig(key)) || '').toBe('');
    expect(await w.call('m-zhao', '辛苦了')).not.toContain('已过期');
  });
  for (const kind of ['草稿', '追问'] as const) for (const reply of ['对', '是']) it(`${kind} 过期后 ${reply} 不入账`, async () => {
    const { w, expire, entries } = await setup();
    await w.call('m-zhao', start(kind)); await expire();
    // D181-4 只改「对」；「是」保留 R21 行为。
    const result = await w.call('m-zhao', reply);
    // D185：追问肯定答复只回 D176；D181-4 继续约束草稿。
    if (kind === '追问' && (reply === '对' || reply === '是')) expect(result).toBe(notice(kind));
    else if (reply === '对') expect(result).toBe(DRAFT_EXPIRED_REREPORT);
    else expect(result.endsWith(notice(kind))).toBe(true);
    expect(await w.call('m-zhao', '对')).not.toContain('已过期');
    expect(await entries()).toEqual([]);
  });
});

describe('R21 D180 类型文案及缺字段回退', () => {
  for (const kind of ['预约', '改单', '其他', '缺字段'] as const) it(kind, async () => {
    const { w, expire } = await setup();
    const member = kind === '其他' ? 'm-wang-yj' : 'm-zhao';
    if (kind === '预约') await w.call(member, '后天下午两点郗女士来做护理');
    else if (kind === '改单') {
      await w.call('m-zhao', start('草稿')); await w.call('m-zhao', '对');
      await w.call('m-zhao', '把刚才那笔改成2873');
    } else if (kind === '其他') await w.call(member, '给小赵定本月目标39473');
    else await w.call(member, '后天下午两点郗女士来做护理');
    const draft = (await w.base.listDrafts({ status: 'pending' }))[0]!;
    expect(draft).toBeTruthy();
    const before = await w.base.listEntries(); const appts = await w.base.listAppointments();
    if (kind === '缺字段') {
      // 验证未知内容的安全回退；直接走状态迁移，不伪造员工摘要。
      const malformed = structuredClone(draft);
      malformed.payload = { type: 'appointment', items: [{ customer: '郗姨' }] } as Draft['payload'];
      const result = await advancePendingSlot({ drafts: [malformed], askKey: key, text: '辛苦了', readAsk: async () => '',
        writes: { transitionPending: async () => true, compareAndSetPendingAsk: async () => true, putOperationRecord: async () => {}, createDraft: async () => {}, rewriteDraft: async () => {} },
        now: () => new Date(draft.expiresAt), active: () => true, expiredReply: '过期' });
      expect(result.expiredReminder).toBe('上一条操作已过期，没有生效，需要的话请重新发。');
    } else {
      await expire();
      const reply = await w.call(member, '辛苦了');
      const expected = kind === '其他' ? '上一条操作已过期，没有生效，需要的话请重新发。' : kind === '预约' && draft.payload.type === 'appointment'
        ? `上一条预约「郗女士 ${draft.payload.items[0]!.whenText}」已过期，没有保存，需要的话请重新发。`
        : '上一条改单已过期，没有改，原记录「郗姨 3947元」不变，需要的话请重新发。';
      expect(reply.endsWith(expected)).toBe(true);
      expect((await w.base.getDraft(draft.draftId))?.status).toBe('void');
      expect(await w.call(member, '对')).not.toContain('已过期');
    }
    expect(await w.base.listEntries()).toEqual(before); expect(await w.base.listAppointments()).toEqual(appts);
  });
  it('旧泛称不再存在于源码', () => {
    expect(readFileSync(new URL('../../src/role-eval/pending-slot.ts', import.meta.url), 'utf8')).not.toContain('未完成' + '操作');
  });
});

for (const action of ['作废', '过期', '先问'] as const) it(`R21 多笔草稿 ${action} 每笔一行完整措辞`, async () => {
  const { w, expire } = await setup();
  await w.call('m-zhao', '郗姨：3947（小赵）；訾姨：5189（小赵）');
  if (action === '过期') await expire();
  const reply = await w.call('m-zhao', action === '先问' ? questions[0]! : '逯姨：2873（小赵）');
  const suffix = action === '作废' ? '没有确认，已作废，需要的话请重新报。' : action === '过期' ? '已过期，没有记，需要的话请重新报。' : '还在等你回「对」确认。';
  const lines = [`上一笔「郗姨 3947元」${suffix}`, `上一笔「訾姨 5189元」${suffix}`].join('\n');
  expect(reply).toContain(lines);
  if (action !== '作废') expect(reply.endsWith(lines)).toBe(true);
});

it('R21 过期预检参数与草稿保留私有快照，读取器修改入参及迟到修改不能启用替换', async () => {
  const { w } = await setup();
  await w.call('m-zhao', start('草稿'));
  const drafts = await w.base.listDrafts({ status: 'pending' });
  const before = structuredClone(drafts);
  const { evaluateConfirmableReportDraft } = await import('../../src/role-eval/confirmable-draft-gate.js');
  const admission = { gate: evaluateConfirmableReportDraft({ text: '逯姨：2873', today: '2026-11-16', employeeNames: new Set<string>() }), next: 'draft' as const };
  let writes = 0;
  const args: Parameters<typeof advancePendingSlot>[0] = { drafts, admission, expireOnly: true, askKey: key, text: '辛苦了',
    readAsk: async () => { args.expireOnly = false; drafts[0]!.expiresAt = '2001-01-01T00:00:00Z'; return ''; },
    writes: { transitionPending: async () => { writes++; return true; }, compareAndSetPendingAsk: async () => true, putOperationRecord: async () => {}, createDraft: async () => {}, rewriteDraft: async () => {} },
    now: () => new Date('2026-11-16T02:00:00Z'), active: () => true, expiredReply: '过期' };
  const result = await advancePendingSlot(args);
  drafts[0]!.status = 'confirmed';
  expect(writes).toBe(0); expect(result.drafts).toEqual(before);
});

it('R21 过期条件迁移收到独立只读副本，写入器保留的引用不能污染私有结果', async () => {
  const { w } = await setup(); await w.call('m-zhao', start('草稿'));
  const drafts = await w.base.listDrafts({ status: 'pending' });
  let retained: Draft | undefined;
  const result = await advancePendingSlot({ drafts, askKey: key, text: '辛苦了', readAsk: async () => '',
    writes: { transitionPending: async (expected, next) => {
      retained = next;
      expect(() => { expected.reporterPersonId = 'another-person'; }).toThrow();
      expect(() => { next.payload.type = 'target'; }).toThrow(); return true;
    }, compareAndSetPendingAsk: async () => true, putOperationRecord: async () => {}, createDraft: async () => {}, rewriteDraft: async () => {} },
    now: () => new Date(drafts[0]!.expiresAt), active: () => true, expiredReply: '过期' });
  expect(() => { retained!.status = 'confirmed'; }).toThrow();
  drafts[0]!.reporterPersonId = 'another-person';
  expect(result.expired[0]!.status).toBe('void'); expect(result.expired[0]!.reporterPersonId).toBe('p-zhao');
  expect(result.expiredReminder).toBe(notice('草稿'));
});

for (const kind of ['草稿', '追问'] as const) it(`R21 D179 过期${kind}的异步读取中取消，不清状态，下一请求仍能提醒`, async () => {
  const { w, expire } = await setup(); await w.call('m-zhao', start(kind)); await expire();
  const before = await w.base.listDrafts(); const saved = await w.base.getConfig(key);
  const abort = new AbortController(); const getConfig = w.store.getConfig.bind(w.store);
  const read = vi.spyOn(w.store, 'getConfig').mockImplementation(async readKey => {
    const raw = await getConfig(readKey);
    if (readKey === key) abort.abort();
    return raw;
  });
  const handler = createWecomBotHandler({ mode: 'isolated-synthetic', employeeLoop: true, accessPolicy: true, store: w.store,
    now: () => new Date('2026-11-17T02:00:00Z'), resolve: id => w.base.getPersonByMember(id), send: async () => 'sent',
    model: { complete: async () => ({ type: 'chat', text: '离线桩' }) } });
  const result = await handler.handleMessage({ memberId: 'm-zhao', text: '辛苦了', messageId: 'r21-cancel-expiry',
    sessionId: 'session-m-zhao', bindingVersion: 1, signal: abort.signal });
  expect(result.state).toBe('cancelled');
  await new Promise<void>(resolve => setImmediate(resolve)); read.mockRestore();
  expect(await w.base.listDrafts()).toEqual(before); expect(await w.base.getConfig(key)).toBe(saved);
  expect((await w.call('m-zhao', '辛苦了')).endsWith(notice(kind))).toBe(true);
});
