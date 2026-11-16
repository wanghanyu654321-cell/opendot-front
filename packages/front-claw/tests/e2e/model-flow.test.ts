import { expect, it, vi } from 'vitest';
import { MemoryPerformanceStore, type PerformanceStore } from '../../src/role-eval/performance-store.js';
import { createMemoryBindingStore } from '../../src/role-eval/directory-store.js';
import { seedSynthetic } from '../../src/standalone/synthetic.js';
import { createOfflineChannel } from '../../src/standalone/offline.js';
import { startFrontClawOpenDotService } from '../../src/opendot/index.js';
import type { ModelClassifier } from '../../src/role-eval/model-classify.js';

export const reportOutput = { intent: 'report', object: 'performance', action: 'report', slots: { amountText: '560元' }, confidence: 1, uncertain: false };
export async function modelWorld(classifier: ModelClassifier, supplied?: PerformanceStore) {
  const store = supplied ?? new MemoryPerformanceStore();
  const bindings = createMemoryBindingStore();
  await seedSynthetic({ store, bindings });
  const person = (await store.getPerson('synthetic-person'))!;
  await store.savePerson({ ...person, personId: 'other-person', accountId: 'other-account', memberId: 'other-member', displayName: '小林' });
  const { EMPLOYEE_LOOP_CONFIG } = await import('../../src/role-eval/employee-loop.js');
  await store.setConfig(EMPLOYEE_LOOP_CONFIG, JSON.stringify({ enabled: true, storeId: person.storeId, memberIds: ['synthetic-member', 'other-member'] }));
  const { readPolicy, updateAccessPolicy } = await import('../../src/role-eval/access-policy.js');
  const raw = await readPolicy(store);
  const current = { policy: raw.policy ? JSON.parse(raw.policy) : null };
  if (!current.policy) throw Error('seed_policy_missing');
  await updateAccessPolicy(store, { expectedVersion: 1, next: { ...current.policy, version: 2, members: { ...current.policy.members, 'other-person': { role: 'employee', storeIds: [person.storeId], status: 'active' } } }, actor: 'synthetic-admin', reason: 'synthetic second employee', at: '2026-11-12T02:00:00Z' });
  await bindings.saveBinding({ botId: 'synthetic-bot', corpId: 'synthetic-corp', memberId: 'other-member', accountId: 'other-account', version: 1, active: true });
  const logs: Record<string, unknown>[] = [];
  const start = async () => {
    const channel = createOfflineChannel();
    const dependencies = { open: async () => ({ store, bindings, driver: 'memory' as const, async close() {} }), channel: () => channel,
      modelClassify: classifier, modelClassifyTimeoutMs: 500, now: () => new Date('2026-11-12T02:00:00Z'), timers: false, owner: 'synthetic-consumer' };
    const service = await startFrontClawOpenDotService({ env: { FRONT_CLAW_OPENDOT_ADAPTER: '1' }, logger: { info(fields) { logs.push(fields); }, warn() {} } }, dependencies);
    return { service, channel, dependencies };
  };
  const runtime = await start();
  const inject = (text: string, messageId: string, memberId = 'synthetic-member') => runtime.channel.inject({ botId: 'synthetic-bot', corpId: 'synthetic-corp', memberId, text, messageId, reqId: messageId });
  const say = async (text: string, messageId: string) => { const count = runtime.channel.replies.length; inject(text, messageId); await runtime.service.idle(); return runtime.channel.replies.slice(count); };
  return { store, bindings, logs, start, ...runtime, inject, say };
}

it('routes a fake model draft through the amount guard, shared pending slot and employee confirmation', async () => {
  const world = await modelWorld(async () => reportOutput);
  const commit = vi.spyOn(world.store, 'commitConfirmingDraft');
  try {
    await world.say('12号测试店\n380（小赵）', 'fast');
    expect((await world.say('请帮我整理这项 560元', 'model')).join('')).toContain('560');
    const drafts = await world.store.listDrafts();
    expect(drafts.filter(d => d.status === 'pending')).toHaveLength(1);
    expect(drafts.find(d => d.status === 'void')).toBeDefined();
    expect(drafts.find(d => d.status === 'pending')?.payload.employeeContext?.pendingSequence).toMatch(/^\d+$/);
    expect(commit).not.toHaveBeenCalled();
    expect(await world.store.listEntries()).toHaveLength(0);
    expect((await world.say('对', 'confirm')).join('')).toContain('已入账');
    expect(commit).toHaveBeenCalledTimes(1);
    expect((await world.store.listEntries()).map(e => e.amount)).toEqual([56000]);
  } finally { await world.service.close(); }
});

it.each(['bad-json', 'empty', 'timeout', 'rate-limit', 'error', 'invented-amount', 'unsafe-amount'])('keeps the pending slot and ledger safe on model %s', async kind => {
  const world = await modelWorld(async () => {
    if (kind === 'bad-json') return '{invalid';
    if (kind === 'empty') return '';
    if (kind === 'timeout') return new Promise(() => {});
    if (kind === 'rate-limit') throw Object.assign(Error('synthetic'), { status: 429 });
    if (kind === 'error') throw Error('synthetic');
    return { ...reportOutput, slots: { amountText: kind === 'invented-amount' ? '999元' : '560元' } };
  });
  try {
    await world.say('12号测试店\n380（小赵）', 'fast');
    const before = (await world.store.listDrafts()).find(d => d.status === 'pending')!;
    const replies = await world.say(kind === 'unsafe-amount' ? '请帮我整理这项 560元左右' : '请帮我整理这项 560元', 'model');
    expect(replies.join('')).not.toContain('已入账');
    expect((await world.store.listDrafts()).filter(d => d.status === 'pending').map(d => d.draftId)).toEqual([before.draftId]);
    expect(await world.store.listEntries()).toHaveLength(0);
    const log = world.logs.find(l => l.event === 'inbound_message' && l.route === '追问');
    expect(log).toMatchObject({ pendingSequence: expect.stringMatching(/^\d+$/), modelMs: expect.any(Number), gateReason: expect.any(String), errorCategory: expect.any(String) });
    const categories: Record<string, string> = { 'bad-json': 'schema', empty: 'schema', timeout: 'timeout', 'rate-limit': 'rate_limit', error: 'model_error', 'invented-amount': 'none', 'unsafe-amount': 'amount' };
    expect(log?.errorCategory).toBe(categories[kind]);
  } finally { await world.service.close(); }
});

it('serializes one employee before the model while another employee receives a fast reply', async () => {
  let release!: (value: unknown) => void;
  const called: string[] = [];
  const world = await modelWorld(async ({ text }) => { called.push(text); return new Promise(resolve => { release = resolve; }); });
  try {
    world.inject('请帮我整理这项 560元', 'first');
    world.inject('请帮我整理另一项 560元', 'second');
    await vi.waitFor(() => expect(called).toHaveLength(1));
    world.inject('12号测试店\n380（小林）', 'other', 'other-member');
    await vi.waitFor(() => expect(world.channel.replies.some(r => r.includes('380'))).toBe(true), { timeout: 200, interval: 2 });
    expect(called).toEqual(['请帮我整理这项 560元']);
    release(reportOutput);
    await world.service.idle();
    expect(called).toEqual(['请帮我整理这项 560元', '请帮我整理另一项 560元']);
    const seq = world.logs.filter(l => l.event === 'inbound_message').map(l => BigInt(String(l.pendingSequence)));
    expect(new Set(seq).size).toBe(3);
    const first = world.logs.find(l => l.event === 'inbound_message' && l.route === '模型')!;
    const last = world.logs.filter(l => l.event === 'inbound_message').at(-1)!;
    expect(BigInt(String(first.pendingSequence))).toBeLessThan(BigInt(String(last.pendingSequence)));
  } finally { await world.service.close(); }
});

it('reads revocation after the model returns and refuses draft or ledger writes', async () => {
  let release!: (value: unknown) => void;
  let called!: () => void;
  const started = new Promise<void>(resolve => { called = resolve; });
  const world = await modelWorld(async () => { called(); return new Promise(resolve => { release = resolve; }); });
  try {
    world.inject('请帮我整理这项 560元', 'revoked');
    await started;
    const person = (await world.store.getPerson('synthetic-person'))!;
    await world.store.savePerson({ ...person, active: false });
    release(reportOutput);
    await world.service.idle();
    expect(await world.store.listDrafts()).toHaveLength(0);
    expect(await world.store.listEntries()).toHaveLength(0);
  } finally { release?.(undefined); await world.service.close(); }
});

it('bounds durable deduplication reads and ignores a late read result after cancellation', async () => {
  const world = await modelWorld(async () => reportOutput);
  let finish!: (value: string | null) => void;
  const original = world.store.getConfig.bind(world.store);
  const spy = vi.spyOn(world.store, 'getConfig').mockImplementation(key => key.startsWith('front-claw-op:') ? new Promise(resolve => { finish = resolve; }) : original(key));
  try {
    world.inject('请帮我整理这项 560元', 'slow-read');
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    const { operationIdFor } = await import('../../src/opendot/index.js');
    const operation = operationIdFor({ botId: 'synthetic-bot', corpId: 'synthetic-corp', memberId: 'synthetic-member', messageId: 'slow-read' });
    expect((await world.service.cancel(operation)).state).toBe('cancelled');
    finish(null);
    await world.service.idle();
    expect(await world.store.listEntries()).toHaveLength(0);
    expect(await world.store.listDrafts()).toHaveLength(0);
    expect(world.channel.replies).toEqual([]);
    expect(world.logs.filter(l => l.event === 'inbound_message')).toHaveLength(1);
  } finally { finish?.(null); spy.mockRestore(); await world.service.close(); }
});

it('persists msgid suppression across instances without repeating a reply or model call', async () => {
  const model = vi.fn(async () => reportOutput);
  const world = await modelWorld(model);
  await world.say('请帮我整理这项 560元', 'model');
  await world.say('对', 'confirm');
  expect(await world.say('对', 'confirm')).toEqual([]);
  await world.service.close();
  const fresh = await world.start();
  try {
    for (const [text, id] of [['请帮我整理这项 560元', 'model'], ['对', 'confirm']]) fresh.channel.inject({ botId: 'synthetic-bot', corpId: 'synthetic-corp', memberId: 'synthetic-member', reqId: id!, messageId: id!, text: text! });
    await fresh.service.idle();
    expect(fresh.channel.replies).toEqual([]);
    expect(model).toHaveBeenCalledTimes(1);
    expect(await world.store.listEntries()).toHaveLength(1);
  } finally { await fresh.service.close(); }
});

it('writes one structured safe log per inbound and captures the model callback at assembly', async () => {
  const world = await modelWorld(async () => reportOutput);
  world.dependencies.modelClassify = async () => { throw Error('replaced'); };
  const text = '特征消息客户隐私串 560元';
  try {
    await world.say(text, 'private-message');
    const logs = world.logs.filter(l => l.event === 'inbound_message');
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ route: '模型', gateReason: 'accepted', modelMs: expect.any(Number), errorCategory: 'none', pendingSequence: expect.stringMatching(/^\d+$/) });
    expect(JSON.stringify(logs)).not.toMatch(/特征消息|客户隐私串|560元|private-message/);
    expect(Object.keys(logs[0]!)).not.toEqual(expect.arrayContaining(['text', 'customer', 'amount']));
    expect(await world.store.listEntries()).toHaveLength(0);
  } finally { await world.service.close(); }
});
