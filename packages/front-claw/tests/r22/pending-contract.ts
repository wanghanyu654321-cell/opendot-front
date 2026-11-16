import { expect, it, vi } from 'vitest';
import type { Draft, PerformanceStore, Person } from '../../src/role-eval/performance-store.js';
import { createWecomBotHandler } from '../../src/role-eval/wecom-bot-unified-handler.js';
import { consumerWrites } from '../../src/role-eval/consumer-writes.js';
import { advancePendingSlot } from '../../src/role-eval/pending-slot.js';
import { newCustomerAskKey } from '../../src/role-eval/customer-name-policy.js';
import { ALREADY_CONFIRMED_TEXT, DRAFT_EXPIRED_REREPORT } from '../../src/role-eval/employee-loop.js';

const person: Person = { personId: 'p-r22', accountId: 'a-r22', memberId: 'm-r22', displayName: '小嵇', storeId: 's-r22', storeName: '栖霞西店', tier: 'employee', roles: [], active: true };
const key = newCustomerAskKey(person.personId, 'r22-session');
const epoch = Date.parse('2026-11-18T02:00:00Z');
const iso = (n: number) => new Date(n).toISOString();
export function pendingContract(label: string, open: () => Promise<{ store: PerformanceStore; close(): Promise<void> }>) {
  async function setup() {
    const db = await open(); const store = db.store;
    await store.savePerson(person);
    await store.setConfig('employee-loop:m01', JSON.stringify({ enabled: true, storeId: person.storeId, memberIds: [person.memberId] }));
    let at = epoch, seq = 0;
    const handler = (clock = () => new Date(at)) => createWecomBotHandler({ mode: 'isolated-synthetic', employeeLoop: true, store, now: clock,
      resolve: id => store.getPersonByMember(id), send: async () => 'sent', model: { complete: async () => ({ type: 'chat', text: '离线桩' }) } });
    const main = handler();
    const input = (text: string, arrivedAt?: string) => ({ memberId: person.memberId, sessionId: 'r22-session', bindingVersion: 1, messageId: `r22-${++seq}`, text, ...(arrivedAt ? { arrivedAt } : {}) });
    const call = async (text: string, arrivedAt?: string) => { at += 1000; return (await main.handleMessage(input(text, arrivedAt))).replies.join('\n'); };
    const pending = async () => (await store.listDrafts({ status: 'pending' }))[0]!;
    const ledger = () => store.listEntries({ status: 'confirmed' });
    return { ...db, handler, input, call, pending, ledger, setAt: (next: number) => { at = next; } };
  }
  for (const ask of [false, true]) it(`${label} D183 先到的对与新报单交错，不确认新版本`, async () => {
    const w = await setup();
    try {
      await w.call('郗姨：3923（小嵇）');
      // 入口捕获到达时间后卡在异步读取；另一处理器保存新版本，再放行这条「对」。
      let release!: () => void, entered!: () => void;
      const held = new Promise<void>(r => { release = r; }); const started = new Promise<void>(r => { entered = r; });
      const reader = w.store.listDrafts.bind(w.store); let once = true;
      const spy = vi.spyOn(w.store, 'listDrafts').mockImplementation(async filter => {
        if (once) { once = false; entered(); await held; }
        return reader(filter);
      });
      const early = w.handler(() => new Date(epoch + 1500)).handleMessage(w.input('对'));
      await started;
      await w.call(`${ask ? '郗霁' : '逯姨'}：2879（小嵇）`);
      release(); const reply = (await early).replies.join('\n'); spy.mockRestore();
      expect(reply).toBe(`上一笔已作废，新的一笔「${ask ? '郗霁' : '逯姨'} 2879元」请看清后再回「对」。`);
      expect(await w.ledger()).toEqual([]);
      if (ask) { expect(await w.store.getConfig(key)).toBeTruthy(); await w.call('是'); }
      else expect((await w.pending()).status).toBe('pending');
      expect(await w.call('对')).toContain('已入账');
      expect((await w.ledger()).map(e => [e.customerName, e.amount])).toEqual([[ask ? '郗霁' : '逯姨', 287900]]);
    } finally { await w.close(); }
  });
  for (const ask of [false, true]) for (const precision of ['fixed', 'second'] as const) it(`${label} D183 未替换的${ask ? '追问' : '草稿'}允许${precision}时钟确认`, async () => {
    const w = await setup();
    try {
      const at = epoch + 700;
      const h = w.handler(() => new Date(at));
      await h.handleMessage(w.input(`${ask ? '郗霁' : '郗姨'}：3923（小嵇）`));
      // 秒级 createTime 是本秒下界；无 D174 替换，不能据此误报「上一笔已作废」。
      const arrivedAt = iso(precision === 'second' ? epoch : at);
      if (ask) expect((await h.handleMessage(w.input('是', arrivedAt))).replies.join('\n')).toContain('还没入账');
      expect((await h.handleMessage(w.input('对', arrivedAt))).replies.join('\n')).toContain('已入账');
      expect(await w.ledger()).toHaveLength(1);
    } finally { await w.close(); }
  });
  for (const ask of [false, true]) it(`${label} D183 同秒替换仍保守，后续明确晚到才能确认`, async () => {
    const w = await setup();
    try {
      const h = w.handler(() => new Date(epoch + 700));
      await h.handleMessage(w.input('郗姨：3923（小嵇）'));
      await h.handleMessage(w.input(`${ask ? '郗霁' : '逯姨'}：2879（小嵇）`));
      expect((await h.handleMessage(w.input('对', iso(epoch)))).replies.join('\n'))
        .toBe(`上一笔已作废，新的一笔「${ask ? '郗霁' : '逯姨'} 2879元」请看清后再回「对」。`);
      expect(await w.ledger()).toEqual([]);
      w.setAt(epoch + 2000);
      if (ask) await w.call('是');
      expect(await w.call('对')).toContain('已入账');
      expect(await w.ledger()).toHaveLength(1);
    } finally { await w.close(); }
  });
  it(`${label} D183 替换追问转草稿后保留保护，不能被迟到的对确认`, async () => {
    const w = await setup();
    try {
      await w.call('郗姨：3923（小嵇）');
      await w.call('郗霁：2879（小嵇）');
      await w.call('是');
      expect(await w.call('对', iso(epoch + 1500))).toBe('上一笔已作废，新的一笔「郗霁 2879元」请看清后再回「对」。');
      expect(await w.ledger()).toEqual([]);
      expect(await w.call('对')).toContain('已入账');
    } finally { await w.close(); }
  });
  it(`${label} 正常并发两次对：一笔、一条入账回复、另一条 D160`, async () => {
    const w = await setup();
    try {
      await w.call('郗姨：3923（小嵇）'); w.setAt(epoch + 3000);
      const replies = (await Promise.all([w.handler(), w.handler()].map(h => h.handleMessage(w.input('对'))))).map(r => r.replies.join('\n'));
      expect(await w.ledger()).toHaveLength(1);
      expect(replies.filter(r => r.includes('已入账'))).toHaveLength(1);
      expect(replies.filter(r => r === ALREADY_CONFIRMED_TEXT)).toHaveLength(1);
    } finally { await w.close(); }
  });
  it(`${label} 对与过期结算竞争：绝不既提醒又入账`, async () => {
    const w = await setup();
    try {
      await w.call('郗姨：3923（小嵇）'); const draft = await w.pending();
      const end = Date.parse(draft.expiresAt);
      const replies = (await Promise.all([
        w.handler(() => new Date(end - 1)).handleMessage(w.input('对', iso(end - 1))),
        w.handler(() => new Date(end)).handleMessage(w.input('辛苦了', iso(end))),
      ])).map(r => r.replies.join('\n'));
      const entries = await w.ledger(); const reminders = replies.join('\n').split('上一笔「郗姨 3923元」已过期，没有记，需要的话请重新报。').length - 1;
      expect([entries.length, reminders]).toEqual(entries.length ? [1, 0] : [0, 1]);
    } finally { await w.close(); }
  });
  it(`${label} 过期条件下推：未到期行即使被传来结算也不能迁移或提醒`, async () => {
    const w = await setup();
    try {
      await w.call('郗姨：3923（小嵇）'); const draft = await w.pending();
      const at = iso(epoch + 5000), next = { ...draft, status: 'void' as const, closedAt: at };
      expect(await w.store.transitionPendingDraft(draft, next, undefined, { expiredAt: at })).toBe(false);
      // 本请求持有已过期的旧窗口，存储里的同版本窗口被并发更新。仍须由存储层拒绝。
      const stale = { ...draft, expiresAt: at };
      const result = await advancePendingSlot({ drafts: [stale], askKey: key, text: '辛苦了', readAsk: () => w.store.getConfig(key),
        writes: consumerWrites(w.store, undefined, () => epoch + 5000), now: () => new Date(at), active: () => true, expiredReply: DRAFT_EXPIRED_REREPORT });
      expect(result.blocked).toBe(true); expect(result.expiredReminder).toBe(''); expect((await w.pending()).draftId).toBe(draft.draftId);
    } finally { await w.close(); }
  });
  it(`${label} D183 严格比较在存储层：出现时间等于或晚于到达时间都不能 claim`, async () => {
    const w = await setup();
    try {
      await w.call('郗姨：3923（小嵇）'); const draft = await w.pending();
      for (const arrivedAt of [draft.createdAt, iso(Date.parse(draft.createdAt) - 1)]) {
        expect(await w.store.transitionPendingDraft(draft, { ...draft, status: 'confirming' }, undefined, { arrivedAt })).toBe(false);
      }
      expect((await w.pending()).status).toBe('pending');
    } finally { await w.close(); }
  });
  it(`${label} 过期追问 CAS：迟到清除不能覆盖新版本，过期与签发时间也由存储核对`, async () => {
    const w = await setup();
    try {
      await w.call('郗霁：3923（小嵇）'); const raw = (await w.store.getConfig(key))!;
      const ask = JSON.parse(raw); const at = Date.parse(ask.expiresAt);
      expect(await w.store.compareAndSetPendingAsk(key, raw, '', { expiredAt: iso(at - 1) })).toBe(false);
      expect(await w.store.compareAndSetPendingAsk(key, raw, '', { arrivedAt: ask.issuedAt })).toBe(false);
      const replacement = JSON.stringify({ ...ask, version: 'r22-new-version', issuedAt: iso(at), expiresAt: iso(at + 60_000) });
      await w.store.setConfig(key, replacement);
      expect(await w.store.compareAndSetPendingAsk(key, raw, '', { expiredAt: iso(at) })).toBe(false);
      expect(await w.store.getConfig(key)).toBe(replacement);
      // 让同一请求读到旧值，然后并发保存替代追问，旧请求不得发出过期提醒。
      await w.store.setConfig(key, raw);
      const result = await advancePendingSlot({ drafts: [], askKey: key, text: '辛苦了', readAsk: async () => { await w.store.setConfig(key, replacement); return raw; },
        writes: consumerWrites(w.store, undefined, () => at), now: () => new Date(at), active: () => true, expiredReply: DRAFT_EXPIRED_REREPORT });
      expect(result.blocked).toBe(true); expect(result.expiredReminder).toBe(''); expect(await w.store.getConfig(key)).toBe(replacement);
      expect(await w.store.compareAndSetPendingAsk(key, replacement, '', { expiredAt: iso(at + 60_000) })).toBe(true);
    } finally { await w.close(); }
  });
  it(`${label} 两个请求同时结算同一过期追问：恰好一条提醒`, async () => {
    const w = await setup();
    try {
      await w.call('郗霁：3923（小嵇）'); const raw = (await w.store.getConfig(key))!; const at = Date.parse(JSON.parse(raw).expiresAt);
      const results = await Promise.all([0, 1].map(() => advancePendingSlot({ drafts: [], askKey: key, text: '辛苦了', readAsk: async () => raw,
        writes: consumerWrites(w.store, undefined, () => at), now: () => new Date(at), active: () => true, expiredReply: DRAFT_EXPIRED_REREPORT })));
      expect(results.filter(r => !!r.expiredReminder)).toHaveLength(1); expect(await w.store.getConfig(key)).toBe('');
    } finally { await w.close(); }
  });
}
