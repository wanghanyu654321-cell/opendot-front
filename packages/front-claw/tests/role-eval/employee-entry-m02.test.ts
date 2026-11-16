import { describe, expect, it, vi } from 'vitest';
import { createWecomBotHandler } from '../../src/role-eval/wecom-bot-unified-handler.js';
import { createPostgresPerformanceStore, migratePerformance } from '../../src/role-eval/performance-postgres.js';
import type { Person } from '../../src/role-eval/performance-store.js';
import type { RouteLogRecord } from '../../src/role-eval/route-log.js';
import type { EmployeeRouterOptions } from '../../src/role-eval/employee-entry.js';
import { CHITCHAT_REPLY, MARKETING_UNAVAILABLE, MULTI_REPLY } from '../../src/role-eval/employee-entry.js';
import { MemorySql } from './sql-fixture.js';

// 合成数据：B 店为首批试用门店的替身；苏晓禾为测试账号名的合成占位，不含真实标识。
const people: Person[] = [
  { personId: 'p-wang-yj', accountId: 'a-wang-yj', memberId: 'm-wang-yj', displayName: '苏晓禾', storeId: 's-b', storeName: '测试B店', tier: 'employee', roles: ['marketing'], active: true },
  { personId: 'p-zhao', accountId: 'a-zhao', memberId: 'm-zhao', displayName: '小赵', storeId: 's-b', storeName: '测试B店', tier: 'employee', roles: [], active: true },
  { personId: 'p-lin', accountId: 'a-lin', memberId: 'm-lin', displayName: '小林', storeId: 's-a', storeName: '测试A店', tier: 'employee', roles: [], active: true },
];
async function world(router: EmployeeRouterOptions = {}) {
  const sql = new MemorySql();
  await migratePerformance(sql);
  const store = createPostgresPerformanceStore(sql);
  for (const person of people) await store.savePerson(person);
  await store.saveAlias({ storeId: 's-b', alias: '赵赵', personId: 'p-zhao' });
  await store.setConfig('employee-loop:m01', JSON.stringify({ enabled: true, storeId: 's-b', memberIds: ['m-wang-yj', 'm-zhao'] }));
  const model = vi.fn(async () => ({ type: 'chat' as const, text: '不应进入模型' }));
  const outbound: string[] = [];
  const routes: RouteLogRecord[] = [];
  const handler = createWecomBotHandler({
    legacyEntry: true, mode: 'isolated-synthetic', store, now: () => new Date('2026-11-12T02:00:00Z'),
    resolve: id => store.getPersonByMember(id), send: async () => 'sent', model: { complete: model },
    employeeLoop: true, onOutbound: text => outbound.push(text), router: { ...router, onRoute: record => routes.push(record) },
  });
  let seq = 0;
  const call = (text: string, messageId = `msg-${++seq}`, memberId = 'm-wang-yj') =>
    handler.handleMessage({ memberId, text, messageId, sessionId: `session-${memberId}`, bindingVersion: 1 });
  return { sql, store, model, outbound, routes, call, snapshot: async () => ({ entries: await store.listEntries(), drafts: await store.listDrafts() }) };
}
const reply = (result: { replies: string[] }) => result.replies.join('\n');

describe('M02 路由：店务、闲聊和澄清不进营销', () => {
  it('“帮我写今天报数清单”、闲聊、进度、确认即使营销已开且获权也不进营销', async () => {
    const marketing = { enabled: true, handle: vi.fn(async () => '营销稿') };
    const w = await world({ marketing });
    const before = await w.snapshot();
    expect(reply(await w.call('帮我写今天报数清单'))).toContain('标准清单');
    expect(reply(await w.call('你好'))).toBe(CHITCHAT_REPLY);
    expect(reply(await w.call('对'))).toContain('没有待确认');
    await w.call('我的进度');
    // D165/D157：紧贴前缀且含复合请求，整句先问；不保证旧的通用复合句措辞。
    expect(reply(await w.call('报一下今天380然后帮我写个朋友圈文案'))).toMatch(/没有写入/);
    expect(marketing.handle).not.toHaveBeenCalled(); expect(w.model).not.toHaveBeenCalled();
    expect(await w.snapshot()).toEqual(before);
  });
  it('明确营销：启用且获权才调用端口一次；未启用或未获权解释且零写入', async () => {
    const marketing = { enabled: true, handle: vi.fn(async () => '周末文案草稿') };
    const w = await world({ marketing });
    const before = await w.snapshot();
    expect(reply(await w.call('帮我写一条周末活动的朋友圈文案'))).toBe('周末文案草稿');
    expect(marketing.handle).toHaveBeenCalledTimes(1);
    expect(reply(await w.call('帮我写一条周末活动的朋友圈文案', 'zhao-mk', 'm-zhao'))).toBe(MARKETING_UNAVAILABLE);
    const off = await world({ marketing: { enabled: false, handle: marketing.handle } });
    expect(reply(await off.call('帮我写一条周末活动的朋友圈文案'))).toBe(MARKETING_UNAVAILABLE);
    expect(reply(await (await world()).call('写个小红书种草笔记'))).toBe(MARKETING_UNAVAILABLE);
    expect(marketing.handle).toHaveBeenCalledTimes(1);
    expect(await w.snapshot()).toEqual(before);
  });
});

describe('M02 同店代报 / 跨店拒绝', () => {
  it('同店代报：回显注明代报，确认后业绩记给括号里的员工，报数人为发送人', async () => {
    const w = await world();
    const echo = reply(await w.call('12号测试B店\n560（小赵）', 'proxy-report'));
    expect(echo).toContain('小赵'); expect(echo).toContain('代报');
    expect(await w.store.listEntries()).toEqual([]);
    expect(reply(await w.call('对', 'proxy-confirm'))).toContain('已入账');
    const entries = await w.store.listEntries();
    expect(entries.map(row => [row.ownerPersonId, row.ownerName, row.reporterPersonId, row.amount])).toEqual([['p-zhao', '小赵', 'p-wang-yj', 56000]]);
    expect(reply(await w.call('我的进度', 'zhao-progress', 'm-zhao'))).toContain('560');
    expect(reply(await w.call('我的进度', 'wang-progress'))).not.toContain('560');
    // 别名也按本店解析
    await w.call('12号测试B店\n100（赵赵）', 'alias-report'); await w.call('对', 'alias-confirm');
    expect((await w.store.listEntries()).filter(row => row.ownerPersonId === 'p-zhao').map(row => row.amount).sort()).toEqual([10000, 56000]);
  });
  it('跨店代报（他店门店名或他店员工）拒绝且零写入', async () => {
    const w = await world();
    const before = await w.snapshot();
    for (const text of ['12号测试A店\n500（小林）', '12号测试B店\n500（小林）', '12号测试B店\n500（不存在的人）']) {
      expect(reply(await w.call(text))).toContain('跨店不能代报');
      await w.call('对');
      expect(await w.snapshot()).toEqual(before);
    }
  });
  it('代报草稿条目被改写（换人/改金额）后摘要不符，不能确认', async () => {
    const w = await world();
    await w.call('12号测试B店\n560（小赵）', 'src');
    const draft = (await w.store.listDrafts())[0]!;
    if (draft.payload.type !== 'report') throw Error('类型');
    for (const added of [draft.payload.added.map(item => ({ ...item, employeeId: 'p-lin', employeeName: '小林' })), draft.payload.added.map(item => ({ ...item, amount: 9999 }))]) {
      await w.store.saveDraft({ ...draft, payload: { ...draft.payload, added } });
      const before = await w.snapshot(); await w.call('对'); expect(await w.snapshot()).toEqual(before);
    }
    await w.store.saveDraft(draft);
    // 确认前对象离职：拒绝
    await w.store.savePerson({ ...people[1]!, active: false });
    const before = await w.snapshot(); await w.call('对'); expect(await w.snapshot()).toEqual(before);
  });
});

describe('M02 统一截止、唯一终态、去重与分段日志', () => {
  it('慢库超时：唯一终态带原消息号可查，不新写；迟到结果只记日志；重发原消息走正常流程', async () => {
    const w = await world({ budgetMs: 80 });
    const list = w.store.listDrafts.bind(w.store);
    const slow = vi.spyOn(w.store, 'listDrafts').mockImplementation(async (...args) => { await new Promise(resolve => setTimeout(resolve, 200)); return list(...args); });
    const before = await w.snapshot();
    const started = performance.now();
    const timed = await w.call('12号测试B店\n300（苏晓禾）', 'slow-1');
    expect(performance.now() - started).toBeLessThan(180);
    expect(timed).toMatchObject({ state: 'timeout', target: 'store' });
    expect(reply(timed)).toContain('入账结果 slow-1');
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(await w.snapshot()).toEqual(before);
    expect(w.routes.some(row => row.requestId === 'slow-1' && row.stage === 'commit' && row.late)).toBe(true);
    expect(w.outbound.filter(text => text.includes('slow-1'))).toHaveLength(1);
    slow.mockRestore();
    const retry = await w.call('12号测试B店\n300（苏晓禾）', 'slow-1');
    expect(retry.state).toBe('completed'); expect(reply(retry)).toContain('300');
    expect(reply(await w.call('我的进度', 'after-timeout'))).toBeTruthy();
  });
  it('同一消息重复到达：只投递一次最终回复，不重复记账', async () => {
    const w = await world();
    await w.call('12号测试B店\n200（苏晓禾）', 'dup-r');
    const first = await w.call('对', 'dup-c');
    const second = await w.call('对', 'dup-c');
    expect(second).toMatchObject({ duplicate: true, state: 'completed' });
    expect(reply(second)).toBe(reply(first));
    expect(w.outbound.filter(text => text === reply(first))).toHaveLength(1);
    expect((await w.store.listEntries()).map(row => row.amount)).toEqual([20000]);
  });
  it('route 日志四段齐全、带请求号、不含正文和金额', async () => {
    const w = await world();
    await w.call('12号测试B店\n777（苏晓禾）', 'log-1');
    const rows = w.routes.filter(row => row.requestId === 'log-1');
    expect(rows.map(row => row.stage)).toEqual(['inbound', 'classify', 'commit', 'deliver']);
    expect(rows[1]).toMatchObject({ label: 'report', target: 'store', source: 'rule' });
    expect(JSON.stringify(w.routes)).not.toMatch(/777|苏晓禾|测试B店/);
  });
  it('本地替身时延（非达标结论）：分类+M01 店务入口，报 P50/P95/最大值', async () => {
    const w = await world();
    const samples: number[] = [];
    for (let i = 0; i < 100; i++) {
      const started = performance.now();
      await w.call(i % 2 ? '我的进度' : '你好', `lat-${i}`);
      samples.push(performance.now() - started);
    }
    samples.sort((a, b) => a - b);
    const pick = (q: number) => samples[Math.min(samples.length - 1, Math.ceil(q * samples.length) - 1)]!;
    const stats = { 证据类型: 'MemorySql 替身 + 进程内调用；非真实 PG/模型/企微投递，不作达标结论', n: samples.length, p50: pick(0.5), p95: pick(0.95), max: samples.at(-1) };
    console.info(JSON.stringify({ 场景: 'M02本地时延', ...stats }));
    expect(stats.n).toBe(100);
  });
});
