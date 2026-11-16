import { expect, it, vi } from 'vitest';
import type { PerformanceStore, Person } from '../../src/role-eval/performance-store.js';
import { createWecomBotHandler } from '../../src/role-eval/wecom-bot-unified-handler.js';
import { newCustomerAskKey } from '../../src/role-eval/customer-name-policy.js';
import { collectKnownCustomerNames } from '../../src/role-eval/store-customer-roster.js';
import { DRAFT_EXPIRED_REREPORT, ALREADY_CONFIRMED_TEXT } from '../../src/role-eval/employee-loop.js';

const person: Person = { personId: 'p-r23', accountId: 'a-r23', memberId: 'm-r23', displayName: '小郦', storeId: 's-r23', storeName: '栖梧东店', tier: 'employee', roles: [], active: true };
const epoch = Date.parse('2026-11-20T02:00:00Z');
const key = newCustomerAskKey(person.personId, 'r23-session');
export function pendingContract(label: string, open: () => Promise<{ store: PerformanceStore; close(): Promise<void> }>) {
  async function setup() {
    const db = await open(), store = db.store;
    await store.savePerson(person);
    await store.setConfig('employee-loop:m01', JSON.stringify({ enabled: true, storeId: person.storeId, memberIds: [person.memberId] }));
    let at = epoch, seq = 0;
    const handler = () => createWecomBotHandler({ mode: 'isolated-synthetic', employeeLoop: true, store, now: () => new Date(at), resolve: id => store.getPersonByMember(id), send: async () => 'sent', model: { complete: async () => ({ type: 'chat', text: '离线桩' }) } });
    const input = (text: string, arrivedAt?: string) => ({ memberId: person.memberId, sessionId: 'r23-session', messageId: `r23-${++seq}`, bindingVersion: 1, text, ...(arrivedAt ? { arrivedAt } : {}) });
    const call = async (text: string, arrivedAt?: string) => (await handler().handleMessage(input(text, arrivedAt))).replies.join('\n');
    const pending = () => store.listDrafts({ status: 'pending', reporterPersonId: person.personId });
    const ledger = () => store.listEntries({ status: 'confirmed' });
    return { ...db, handler, input, call, pending, ledger, setAt: (n: number) => { at = n; } };
  }
  for (const concurrent of [false, true]) it(`${label} D183 跨过期边界${concurrent ? '交错读取' : '顺序'}：早到的对不能确认新单`, async () => {
    const w = await setup();
    try {
      await w.call('郦姨：4217（小郦）');
      const old = (await w.pending())[0]!, end = Date.parse(old.expiresAt), earlyAt = new Date(end - 100).toISOString();
      let early: Promise<{ replies: string[] }> | undefined, release = () => {}, spy: ReturnType<typeof vi.spyOn> | undefined;
      if (concurrent) {
        let entered!: () => void; const started = new Promise<void>(r => { entered = r; }); const held = new Promise<void>(r => { release = r; });
        const read = w.store.listDrafts.bind(w.store); let once = true;
        spy = vi.spyOn(w.store, 'listDrafts').mockImplementation(async filter => { if (once) { once = false; entered(); await held; } return read(filter); });
        w.setAt(end - 100); early = w.handler().handleMessage(w.input('对', earlyAt)); await started;
      }
      w.setAt(end + 1000); await w.call('昝姨：3187（小郦）');
      release(); const reply = early ? (await early).replies.join('\n') : await w.call('对', earlyAt); spy?.mockRestore();
      expect(reply).toBe('上一笔已作废，新的一笔「昝姨 3187元」请看清后再回「对」。');
      expect(await w.ledger()).toEqual([]); expect(await w.pending()).toHaveLength(1);
      w.setAt(end + 3000); expect(await w.call('对')).toContain('已入账');
      expect((await w.ledger()).map(e => [e.customerName, e.amount])).toEqual([['昝姨', 318700]]);
    } finally { await w.close(); }
  });
  it(`${label} D183 固定时钟：普通单正常确认，同秒替换保守拒绝`, async () => {
    const w = await setup();
    try {
      await w.call('郦姨：4217（小郦）'); expect(await w.call('对')).toContain('已入账');
      await w.call('昝姨：3187（小郦）'); await w.call('逯姨：2593（小郦）');
      expect(await w.call('对', new Date(epoch).toISOString())).toBe('上一笔已作废，新的一笔「逯姨 2593元」请看清后再回「对」。');
      expect(await w.pending()).toHaveLength(1); w.setAt(epoch + 2000); expect(await w.call('对')).toContain('已入账');
    } finally { await w.close(); }
  });
  for (const ask of [false, true]) it(`${label} D183 无替换标记也保护初次${ask ? '追问' : '草稿'}：入口先到、读取迟到`, async () => {
    const w = await setup();
    try {
      let release!: () => void, entered!: () => void;
      const held = new Promise<void>(r => { release = r; }), started = new Promise<void>(r => { entered = r; });
      const read = w.store.listDrafts.bind(w.store); let once = true;
      const spy = vi.spyOn(w.store, 'listDrafts').mockImplementation(async filter => { if (once) { once = false; entered(); await held; } return read(filter); });
      const early = w.call('对'); await started;
      await w.call(`${ask ? '鄢霁' : '郦姨'}：4217（小郦）`);
      release(); const reply = await early; spy.mockRestore();
      expect(reply).not.toContain('上一笔已作废'); expect(reply).not.toContain('已入账');
      expect(await w.ledger()).toEqual([]);
      if (ask) { expect(reply).toContain('是新客户'); expect(await w.pending()).toEqual([]); w.setAt(epoch + 2000); await w.call('是'); }
      else { expect(reply).toContain('还没入账'); expect(await w.pending()).toHaveLength(1); }
      w.setAt(epoch + 5000); expect(await w.call('对')).toContain('已入账');
    } finally { await w.close(); }
  });
  for (const answer of ['是', '对', '好的', '是的', '对的']) it(`${label} D185 过期追问答${answer}只回一次 D176，不建客户`, async () => {
    const w = await setup();
    try {
      await w.call('鄢霁：4639（小郦）'); const raw = (await w.store.getConfig(key))!;
      w.setAt(Date.parse(JSON.parse(raw).expiresAt));
      expect(await w.call(answer)).toBe('上一笔「鄢霁」已过期，没有记，需要的话请重新报。');
      expect(await w.store.getConfig(key)).toBe(''); expect(await w.pending()).toEqual([]); expect(await w.ledger()).toEqual([]);
      expect((await collectKnownCustomerNames(w.store, person.storeId)).has('鄢霁')).toBe(false);
      expect(await w.call(answer)).not.toContain('已过期');
    } finally { await w.close(); }
  });
  it(`${label} D183 存储层严格序号：早于或等于草稿均拒绝，后到才条件迁移`, async () => {
    const w = await setup();
    try {
      const early = await w.store.capturePendingArrival();
      await w.call('郦姨：4217（小郦）');
      const draft = (await w.pending())[0]!;
      const issued = draft.payload.type === 'report' ? draft.payload.employeeContext!.pendingSequence! : '';
      const next = { ...structuredClone(draft), status: 'confirming' as const };
      expect(await w.store.transitionPendingDraft(draft, next, undefined, { arrivedSequence: early.sequence })).toBe(false);
      expect(await w.store.transitionPendingDraft(draft, next, undefined, { arrivedSequence: issued })).toBe(false);
      const later = await w.store.capturePendingArrival();
      expect(await w.store.transitionPendingDraft(draft, next, undefined, { arrivedSequence: later.sequence })).toBe(true);
    } finally { await w.close(); }
  });
  it(`${label} D183 追问存储层直接替换：等于或早于追问序号无副作用，后到才保存`, async () => {
    const w = await setup();
    try {
      await w.call('郦姨：4217（小郦）');
      const original = (await w.pending())[0]!;
      const issued = (await w.store.capturePendingArrival()).sequence;
      // 直接布置追问，并保留旧草稿作副作用哨兵；调用存储层，绕过应用层 staleAnswer。
      const value = JSON.stringify({ names: ['鄢霁'], listed: [], issuedSequence: issued, issuedAt: new Date(epoch).toISOString(), expiresAt: new Date(epoch + 60000).toISOString() });
      await w.store.setConfig(key, value);
      const draft = { ...structuredClone(original), draftId: original.draftId + '-answer' };
      const before = await w.store.listDrafts();
      for (const arrivedSequence of [issued, String(BigInt(issued) - 1n)]) {
        expect(await w.store.replacePendingReport({ reporterPersonId: person.personId, at: new Date(epoch + 2000).toISOString(), draft, expectedAsk: { key, value, arrivedSequence } })).toEqual({ saved: false, drafts: [], asks: [] });
        expect(await w.store.listDrafts()).toEqual(before);
        expect(await w.store.getDraft(draft.draftId)).toBeNull();
        expect(await w.store.getConfig(key)).toBe(value);
        expect(await w.ledger()).toEqual([]);
      }
      const later = await w.store.capturePendingArrival();
      const saved = await w.store.replacePendingReport({ reporterPersonId: person.personId, at: new Date(epoch + 2000).toISOString(), draft, expectedAsk: { key, value, arrivedSequence: later.sequence } });
      expect(saved.saved).toBe(true);
      expect(saved.drafts.map(d => d.draftId)).toEqual([original.draftId]);
      expect((await w.store.getDraft(original.draftId))!.status).toBe('void');
      expect((await w.pending()).map(d => d.draftId)).toEqual([draft.draftId]);
      expect(await w.store.getConfig(key)).toBe('');
      expect(await w.ledger()).toEqual([]);
    } finally { await w.close(); }
  });
  for (const ask of [false, true]) it(`${label} 迁移前无序号${ask ? '追问' : '草稿'}保守拒绝肯定词，D174 替换后可正常确认`, async () => {
    const w = await setup();
    try {
      await w.call(`${ask ? '鄢霁' : '郦姨'}：4217（小郦）`);
      if (ask) {
        const value = JSON.parse((await w.store.getConfig(key))!);
        delete value.issuedSequence;
        await w.store.setConfig(key, JSON.stringify(value));
      } else {
        const draft = (await w.pending())[0]!;
        if (draft.payload.type === 'report') delete draft.payload.employeeContext!.pendingSequence;
        await w.store.saveDraft(draft);
      }
      const before = await w.store.listDrafts(), raw = await w.store.getConfig(key);
      await w.call('对');
      expect(await w.store.listDrafts()).toEqual(before);
      expect(await w.store.getConfig(key)).toBe(raw);
      expect(await w.ledger()).toEqual([]);
      w.setAt(epoch + 2000); await w.call('昝姨：3187（小郦）');
      expect(await w.pending()).toHaveLength(1);
      expect((await w.store.getConfig(key))?.trim()).toBeFalsy();
      w.setAt(epoch + 4000); expect(await w.call('对')).toContain('已入账');
      expect((await w.ledger()).map(e => [e.customerName, e.amount])).toEqual([['昝姨', 318700]]);
    } finally { await w.close(); }
  });
  it(`${label} D181 过期草稿回对仍只回 D143`, async () => {
    const w = await setup(); try { await w.call('郦姨：4217（小郦）'); w.setAt(Date.parse((await w.pending())[0]!.expiresAt)); expect(await w.call('对')).toBe(DRAFT_EXPIRED_REREPORT); expect(await w.call('辛苦了')).not.toContain('已过期'); } finally { await w.close(); }
  });
  for (const answer of ['是', '对', '新单']) for (let attempt = 0; attempt < 4; attempt++) it(`${label} D174 并发${answer}与新报单 #${attempt}：最多一件，随后可确认`, async () => {
    const w = await setup();
    try {
      await w.call('鄢霁：4639（小郦）'); w.setAt(epoch + 2000);
      const replies = await Promise.all([w.call(answer === '新单' ? '郦姨：4217（小郦）' : answer), w.call('昝姨：3187（小郦）')]);
      const pending = await w.pending(); expect(pending).toHaveLength(1); expect((await w.store.getConfig(key))?.trim()).toBeFalsy();
      expect(replies.join('\n')).not.toContain('账本暂不可用');
      w.setAt(epoch + 5000); expect(await w.call('对')).toContain('已入账');
      const draft = pending[0]!; expect(draft.payload.type).toBe('report');
      if (draft.payload.type === 'report') expect((await w.ledger()).map(e => [e.customerName, e.amount])).toEqual(draft.payload.added.map(i => [i.customer, i.amount]));
      expect(await w.call('对')).toBe(ALREADY_CONFIRMED_TEXT);
    } finally { await w.close(); }
  });
  it(`${label} D174 员工约束跨会话：新追问替换另一会话草稿`, async () => {
    const w = await setup();
    try {
      await w.call('郦姨：4217（小郦）'); w.setAt(epoch + 2000);
      const input = { ...w.input('鄢霁：4639（小郦）'), sessionId: 'r23-other-session' };
      expect((await w.handler().handleMessage(input)).replies.join('\n')).toContain('上一笔「郦姨 4217元」没有确认，已作废，需要的话请重新报。');
      expect(await w.pending()).toEqual([]); expect(await w.store.getConfig(newCustomerAskKey(person.personId, input.sessionId))).toBeTruthy();
      w.setAt(epoch + 4000); await w.call('昝姨：3187（小郦）');
      expect((await w.store.getConfig(newCustomerAskKey(person.personId, input.sessionId)))?.trim()).toBeFalsy();
      expect(await w.pending()).toHaveLength(1); w.setAt(epoch + 6000); expect(await w.call('对')).toContain('已入账');
      expect((await w.ledger()).map(e => e.customerName)).toEqual(['昝姨']);
    } finally { await w.close(); }
  });
  it(`${label} D174 替换写入保留私有快照，修改入参与迟到修改返回值不能换身份`, async () => {
    const w = await setup();
    try {
      await w.call('郦姨：4217（小郦）'); const original = (await w.pending())[0]!;
      const write = { reporterPersonId: person.personId, at: new Date(epoch + 2000).toISOString(), draft: { ...structuredClone(original), draftId: original.draftId + '-snapshot' } };
      const saving = w.store.replacePendingReport(write);
      write.reporterPersonId = 'p-unrelated'; write.draft.reporterPersonId = 'p-unrelated';
      if (write.draft.payload.type === 'report') write.draft.payload.added[0]!.amount = 1;
      const result = await saving; expect(result.saved).toBe(true); expect(result.drafts[0]!.status).toBe('pending');
      result.drafts[0]!.reporterPersonId = 'p-unrelated';
      expect((await w.store.getDraft(original.draftId))!.reporterPersonId).toBe(person.personId);
      const saved = (await w.pending())[0]!; expect(saved.reporterPersonId).toBe(person.personId);
      if (saved.payload.type === 'report') expect(saved.payload.added[0]!.amount).toBe(421700);
    } finally { await w.close(); }
  });
  it(`${label} D174 存储兜底拒绝同员工第二条 pending`, async () => {
    const w = await setup(); try { await w.call('郦姨：4217（小郦）'); const d = (await w.pending())[0]!; await expect(w.store.saveDraft({ ...d, draftId: d.draftId + '-conflict' })).rejects.toThrow(); expect(await w.pending()).toHaveLength(1); } finally { await w.close(); }
  });
  it(`${label} D174 迟到的追问肯定答复不能覆盖已保存新报单`, async () => {
    const w = await setup();
    try {
      await w.call('鄢霁：4639（小郦）'); w.setAt(epoch + 2000);
      let release!: () => void, entered!: () => void; const held = new Promise<void>(r => { release = r; }), started = new Promise<void>(r => { entered = r; });
      const read = w.store.listEntries.bind(w.store); let once = true;
      const spy = vi.spyOn(w.store, 'listEntries').mockImplementation(async filter => { if (once) { once = false; entered(); await held; } return read(filter); });
      const early = w.call('是'); await started; await w.call('昝姨：3187（小郦）'); release(); await early; spy.mockRestore();
      expect(await w.pending()).toHaveLength(1); w.setAt(epoch + 5000); expect(await w.call('对')).toContain('已入账'); expect((await w.ledger()).map(e => e.customerName)).toEqual(['昝姨']);
    } finally { await w.close(); }
  });
}
