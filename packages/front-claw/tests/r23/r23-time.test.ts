import { expect, it, vi } from 'vitest';
import { MemoryPerformanceStore } from '../../src/role-eval/performance-store.js';
import { createWecomBotHandler } from '../../src/role-eval/wecom-bot-unified-handler.js';

it('R23 D183 两个入口时钟相差三十一秒：普通草稿可确认，并发输家回 D160', async () => {
  const store = new MemoryPerformanceStore();
  const person = { personId: 'p-sequence', accountId: 'a-sequence', memberId: 'm-sequence', displayName: '小郗', storeId: 's-sequence', storeName: '槐序南店', tier: 'employee' as const, roles: [], active: true };
  await store.savePerson(person);
  await store.setConfig('employee-loop:m01', JSON.stringify({ enabled: true, storeId: person.storeId, memberIds: [person.memberId] }));
  const handler = (offset: number) => createWecomBotHandler({ mode: 'isolated-synthetic', employeeLoop: true, store, now: () => new Date(Date.parse('2026-11-20T02:00:00Z') + offset), resolve: id => store.getPersonByMember(id), send: async () => 'sent', model: { complete: async () => ({ type: 'chat', text: '离线桩' }) } });
  const a = handler(31000), b = handler(0);
  const input = (text: string, messageId: string) => ({ memberId: person.memberId, sessionId: 'sequence-session', bindingVersion: 1, text, messageId });
  await a.handleMessage(input('郗姨：5743（小郗）', 'seq-draft'));
  const replies = (await Promise.all([a.handleMessage(input('对', 'seq-a')), b.handleMessage(input('对', 'seq-b'))])).map(r => r.replies.join('\n'));
  expect(replies.filter(r => r.includes('已入账'))).toHaveLength(1);
  expect(replies.filter(r => r === 'Front Claw：这笔已经入账了，不用重复确认。')).toHaveLength(1);
  expect(await store.listEntries()).toHaveLength(1);
});

it('R23 到达取号挂起也受请求截止约束，迟到返回不能写草稿', async () => {
  const store = new MemoryPerformanceStore();
  let release!: (value: { sequence: string; hours: null }) => void;
  const reading = new Promise<{ sequence: string; hours: null }>(resolve => { release = resolve; });
  vi.spyOn(store, 'capturePendingArrival').mockReturnValue(reading);
  const handler = createWecomBotHandler({ mode: 'isolated-synthetic', employeeLoop: true, store, now: () => new Date('2026-11-20T02:00:00Z'), resolve: id => store.getPersonByMember(id), send: async () => 'sent', model: { complete: async () => ({ type: 'chat', text: '离线桩' }) } });
  const result = await handler.handleMessage({ memberId: 'm-hang', messageId: 'seq-hang', sessionId: 'seq-hang', bindingVersion: 1, text: '郗姨：5743', deadline: performance.now() + 25 });
  expect(result.state).toBe('timeout');
  release({ sequence: '1', hours: null });
  await new Promise(resolve => setTimeout(resolve, 10));
  expect(await store.listDrafts()).toEqual([]);
});

it('R23 D183 替换后跨偏时钟入口确认：平台时间只与平台时间比较', async () => {
  const store = new MemoryPerformanceStore(), at = Date.parse('2026-11-20T02:00:00Z');
  const person = { personId: 'p-offset', accountId: 'a-offset', memberId: 'm-offset', displayName: '小郗', storeId: 's-offset', storeName: '槐序南店', tier: 'employee' as const, roles: [], active: true };
  await store.savePerson(person);
  await store.setConfig('employee-loop:m01', JSON.stringify({ enabled: true, storeId: person.storeId, memberIds: [person.memberId] }));
  const handler = (offset: number) => createWecomBotHandler({ mode: 'isolated-synthetic', employeeLoop: true, store, now: () => new Date(at + offset), resolve: id => store.getPersonByMember(id), send: async () => 'sent', model: { complete: async () => ({ type: 'chat', text: '离线桩' }) } });
  const a = handler(31000), b = handler(0);
  const input = (text: string, id: number) => ({ memberId: person.memberId, sessionId: 'offset-session', bindingVersion: 1, text, messageId: `offset-${id}`, arrivedAt: new Date(at + id * 1000).toISOString() });
  await a.handleMessage(input('郗姨：5743（小郗）', 0));
  await a.handleMessage(input('逯姨：2867（小郗）', 1));
  expect((await b.handleMessage(input('对', 2))).replies.join('\n')).toContain('已入账');
  expect((await store.listEntries()).map(row => [row.customerName, row.amount])).toEqual([['逯姨', 286700]]);
});
