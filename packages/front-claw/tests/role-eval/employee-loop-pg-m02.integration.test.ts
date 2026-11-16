import { appendFileSync } from 'node:fs';
import { startPgCluster, PG_START_HOOK_TIMEOUT_MS, PG_STOP_HOOK_TIMEOUT_MS } from '../helpers/pg-cluster.js';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Client } from 'pg';
import type { Person } from '../../src/role-eval/performance-store.js';
import { FRONT_CLAW_DATABASE_URL, openPerformanceStore, type OpenedPerformanceStore } from '../../src/role-eval/performance-open.js';
import { applyLatest } from '../migration/pg-harness-m08.js';
import { confirmEntryId } from '../../src/role-eval/performance-store.js';
import { createWecomBotHandler } from '../../src/role-eval/wecom-bot-unified-handler.js';

// 真实 PostgreSQL 临时集群（自建自删，随机端口，不连常驻库）。程序目录同 performance-postgres.integration.test.ts：
// FRONT_CLAW_PG_BIN 可覆盖，默认 /usr/lib/postgresql/16/bin。本机实测用 PG17 用户态程序，非线上版本。
const people: Person[] = [
  { personId: 'p-wang-yj', accountId: 'a-wang-yj', memberId: 'm-wang-yj', displayName: '苏晓禾', storeId: 's-b', storeName: '测试B店', tier: 'employee', roles: [], active: true },
  { personId: 'p-zhao', accountId: 'a-zhao', memberId: 'm-zhao', displayName: '小赵', storeId: 's-b', storeName: '测试B店', tier: 'employee', roles: [], active: true },
  { personId: 'p-lin', accountId: 'a-lin', memberId: 'm-lin', displayName: '小林', storeId: 's-a', storeName: '测试A店', tier: 'employee', roles: [], active: true },
];

let cluster: { base: string; stop(): Promise<void> };
let dbSeq = 0;
beforeAll(async () => {
  cluster = await startPgCluster();
}, PG_START_HOOK_TIMEOUT_MS);
afterAll(async () => { await cluster?.stop(); }, PG_STOP_HOOK_TIMEOUT_MS);

/** 每个用例一个新库，互不影响。 */
async function freshDatabase(): Promise<string> {
  const name = `m02_case_${++dbSeq}`;
  const admin = new Client({ connectionString: `${cluster.base}/postgres` });
  await admin.connect(); await admin.query(`CREATE DATABASE ${name}`); await admin.end();
  return `${cluster.base}/${name}`;
}
async function world(url: string, opened?: OpenedPerformanceStore) {
  if (!opened) await applyLatest(url);
  const db = opened ?? await openPerformanceStore({ [FRONT_CLAW_DATABASE_URL]: url }, { requirePostgres: true });
  expect(db.driver).toBe('postgres');
  const handler = createWecomBotHandler({
    legacyEntry: true, mode: 'isolated-synthetic', store: db.store, now: () => new Date('2026-11-12T02:00:00Z'),
    resolve: id => db.store.getPersonByMember(id), send: async () => 'sent',
    model: { complete: async () => { throw Error('不应调用模型'); } }, employeeLoop: true,
  });
  const call = (text: string, messageId: string, memberId = 'm-wang-yj') =>
    handler.handleMessage({ memberId, text, messageId, sessionId: `session-${memberId}`, bindingVersion: 1 }).then(r => r.replies.join('\n'));
  return { db, call };
}
async function seed(url: string) {
  const w = await world(url);
  for (const person of people) await w.db.store.savePerson(person);
  await w.db.store.setConfig('employee-loop:m01', JSON.stringify({ enabled: true, storeId: 's-b', memberIds: ['m-wang-yj', 'm-zhao'] }));
  return w;
}
async function counts(url: string) {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const entries = await client.query(`SELECT owner_person_id, reporter_person_id, amount::text AS amount FROM front_claw_perf.performance_entries ORDER BY entry_id`);
    const drafts = await client.query(`SELECT status FROM front_claw_perf.performance_drafts ORDER BY draft_id`);
    return { entries: entries.rows, drafts: drafts.rows.map(row => row.status) };
  } finally { await client.end(); }
}

it('M01 真实PG：确认前不入账；重复“对”（新消息号与原消息号）不加账', async () => {
  const url = await freshDatabase(); const w = await seed(url);
  expect(await w.call('12号测试B店\n380（苏晓禾）', 'r-1')).toContain('380');
  expect((await counts(url)).entries).toEqual([]);
  expect(await w.call('对', 'c-1')).toContain('已入账');
  await w.call('对', 'c-2'); await w.call('对', 'c-1'); await w.call('12号测试B店\n380（苏晓禾）', 'r-1');
  const after = await counts(url);
  expect(after.entries).toEqual([{ owner_person_id: 'p-wang-yj', reporter_person_id: 'p-wang-yj', amount: '380.00' }]);
  expect(after.drafts).toEqual(['confirmed']);
  await w.db.close();
});

it('M02 真实PG：同店代报业绩记给括号员工；跨店代报拒绝且零写入', async () => {
  const url = await freshDatabase(); const w = await seed(url);
  expect(await w.call('12号测试B店\n560（小赵）', 'proxy-r')).toContain('代报');
  expect((await counts(url)).entries).toEqual([]);
  expect(await w.call('对', 'proxy-c')).toContain('已入账');
  expect((await counts(url)).entries).toEqual([{ owner_person_id: 'p-zhao', reporter_person_id: 'p-wang-yj', amount: '560.00' }]);
  const before = await counts(url);
  expect(await w.call('12号测试A店\n500（小林）', 'cross-1')).toContain('跨店不能代报');
  expect(await w.call('12号测试B店\n500（小林）', 'cross-2')).toContain('跨店不能代报');
  await w.call('对', 'cross-c');
  expect(await counts(url)).toEqual(before);
  await w.db.close();
});

it('真实PG并发：两条独立连接同时对同一草稿回“对”，只入账一次，另一方得到确定结果、不挂起', async () => {
  const url = await freshDatabase(); const a = await seed(url);
  const b = await world(url); // 第二个独立连接池 + 独立 handler 实例
  await a.call('12号测试B店\n420（苏晓禾）', 'race-r');
  const draftId = (await a.db.store.listDrafts())[0]!.draftId;
  const started = Date.now();
  const replies = await Promise.all([a.call('对', 'race-a'), b.call('对', 'race-b')]);
  expect(Date.now() - started).toBeLessThan(10_000);
  expect((await counts(url)).entries).toEqual([{ owner_person_id: 'p-wang-yj', reporter_person_id: 'p-wang-yj', amount: '420.00' }]);
  expect(replies.filter(text => text.includes('已入账'))).toHaveLength(1);
  const loser = replies.find(text => !text.includes('已入账'))!;
  // R18 / D160：输家只回「这笔已经入账了，不用重复确认。」（「已经入账」不含「已入账」字串），不多记一笔、金额不翻倍。
  expect(loser).toBe('Front Claw：这笔已经入账了，不用重复确认。');
  expect(replies.filter(text => text === 'Front Claw：这笔已经入账了，不用重复确认。')).toHaveLength(1);
  expect(loser).not.toContain('结果未知');
  expect(loser).not.toContain('已入账');
  // 各自按原消息号查回：赢家已入账；输家没有自己的确认动作，不会冒认。
  const booked = (await counts(url)).entries;
  const evidence = JSON.stringify({ 场景: '真实PG并发确认', 证据类型: 'PG17 临时集群，非线上版本', 入账笔数: booked.length, 金额合计: booked.reduce((s, r) => s + Number(r.amount), 0), 已入账回复数: replies.filter(t => t.includes('已入账')).length, replies });
  console.info(evidence);
  if (process.env.R18_PG_EVIDENCE) appendFileSync(process.env.R18_PG_EVIDENCE, evidence + '\n');

  // 存储层：两连接对同一条已认领草稿同时提交，同一 entry_id 唯一约束 + 状态条件只落一笔。
  await a.call('12号测试B店\n90（苏晓禾）', 'race2-r');
  const second = (await a.db.store.listDrafts()).find(d => d.status === 'pending')!;
  const claimed = await a.db.store.claimPendingDraft(second.draftId);
  expect(claimed?.status).toBe('confirming');
  if (claimed!.payload.type !== 'report') throw Error('类型');
  const entry = (n: number) => ({ entryId: confirmEntryId(claimed!.draftId, 0), storeId: 's-b', businessDay: claimed!.businessDay, customerName: null, amount: 9000 * n, amountType: 'consultant' as const,
    ownerPersonId: 'p-wang-yj', ownerName: '苏晓禾', reporterPersonId: 'p-wang-yj', note: '', status: 'confirmed' as const, disputed: false, createdAt: claimed!.createdAt });
  const done = { ...claimed!, status: 'confirmed' as const, closedAt: '2026-11-12T02:00:01.000Z' };
  const commits = await Promise.all([a.db.store.commitConfirmingDraft(done, [entry(1)]), b.db.store.commitConfirmingDraft(done, [entry(1)])]);
  // R17 / D151：只有真正把 confirming 改成 confirmed 的那次返回 >0，另一次返回 0。
  expect(commits.filter(n => n > 0)).toHaveLength(1);
  expect(commits.filter(n => n === 0)).toHaveLength(1);
  const rows = (await counts(url)).entries.filter(row => row.amount === '90.00');
  expect(rows).toHaveLength(1);
  expect(draftId).not.toBe(second.draftId);
  await a.db.close(); await b.db.close();
}, 30_000);
