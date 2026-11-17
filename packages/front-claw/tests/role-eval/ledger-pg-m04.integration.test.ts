import { startPgCluster, PG_START_HOOK_TIMEOUT_MS, PG_STOP_HOOK_TIMEOUT_MS } from '../helpers/pg-cluster.js';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Client } from 'pg';
import { FRONT_CLAW_DATABASE_URL, openPerformanceStore } from '../../src/role-eval/performance-open.js';
import { applyLatest } from '../migration/pg-harness-m08.js';
import { createWecomBotHandler } from '../../src/role-eval/wecom-bot-unified-handler.js';
import { ACCESS_POLICY_KEY, updateAccessPolicy } from '../../src/role-eval/access-policy.js';
import { ACCESS_DENIED } from '../../src/role-eval/employee-loop.js';
import type { PerformanceStore } from '../../src/role-eval/performance-store.js';
import { NOW } from './access-fixture-m03.js';
import { membersM04, policyM04, worldM04 } from './ledger-fixture-m04.js';

// M04 真实 PostgreSQL 临时集群（自建自删，随机端口，不连常驻库）。程序目录同 performance-postgres.integration.test.ts：
// FRONT_CLAW_PG_BIN 可覆盖，默认 /usr/lib/postgresql/16/bin。本机实测用 PG17 用户态程序，非线上版本。

let cluster: { base: string; stop(): Promise<void> };
let dbSeq = 0;
beforeAll(async () => {
  cluster = await startPgCluster();
}, PG_START_HOOK_TIMEOUT_MS);
afterAll(async () => { await cluster?.stop(); }, PG_STOP_HOOK_TIMEOUT_MS);

/** 每个用例一个新库，互不影响。 */
async function freshDatabase(): Promise<string> {
  const name = `m04_case_${++dbSeq}`;
  const admin = new Client({ connectionString: `${cluster.base}/postgres` });
  await admin.connect(); await admin.query(`CREATE DATABASE ${name}`); await admin.end();
  return `${cluster.base}/${name}`;
}

const at = NOW.toISOString();
const CONFLICT = 'Front Claw：对象在你确认前已被改动（可能别人刚改过或刚入账），这次没有写入，请重新发起。';
async function open(url: string) { await applyLatest(url); return openPerformanceStore({ [FRONT_CLAW_DATABASE_URL]: url }, { requirePostgres: true }); }
async function rawClient(url: string) { const c = new Client({ connectionString: url }); await c.connect(); return c; }
async function count(url: string, sql: string, params: unknown[] = []): Promise<number> {
  const c = await rawClient(url);
  try { return (await c.query(sql, params)).rows[0].n; } finally { await c.end(); }
}
async function waitForLockWait(url: string, like: string) {
  const c = await rawClient(url);
  try {
    const started = Date.now();
    for (;;) {
      const r = await c.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE $1`, [like]);
      if (r.rows[0].n > 0) return;
      if (Date.now() - started > 10_000) throw Error('lock_wait_not_observed');
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  } finally { await c.end(); }
}
/** 同一库上第二个独立连接池的 handler（模拟另一进程/另一会话）。 */
function handlerOn(store: PerformanceStore, resolveStore: PerformanceStore) {
  const h = createWecomBotHandler({ legacyEntry: true, mode: 'isolated-synthetic', store, now: () => NOW, resolve: id => resolveStore.getPersonByMember(id),
    send: async () => 'sent', model: { complete: async () => { throw Error('不应调用模型'); } }, employeeLoop: true, accessPolicy: true });
  let seq = 0;
  return (memberId: string, text: string, messageId = `p2-${++seq}`) => h.handleMessage({ memberId, text, messageId, sessionId: `session-${memberId}`, bindingVersion: 1 }).then(r => r.replies.join('\n'));
}
const revokedZhao = (version: number) => policyM04(version, { ...membersM04(), 'p-zhao': { role: 'employee', storeIds: ['s-b'], status: 'revoked' } });
const newEntryAmount = async (store: PerformanceStore, id: string) => (await store.getEntry(id))!.amount;

it('真实PG：两份更正（员工本人、店长指名）在两个连接池上同时确认同一笔 10 轮——每轮恰一份生效、另一份作废，修订恰 1 条、金额=胜者', async () => {
  const url = await freshDatabase(); const db = await open(url); const other = await open(url);
  const w = await worldM04({ store: db.store });
  const second = handlerOn(other.store, other.store);
  const tally = { employeeWon: 0, managerWon: 0 };
  for (let round = 0; round < 10; round++) {
    await w.call('m-zhao', `12号测试B店\n${1000 + round}（小赵）`); expect(await w.call('m-zhao', '对')).toContain('已入账');
    const entry = (await db.store.listEntries({ storeId: 's-b', ownerPersonId: 'p-zhao', status: 'confirmed' })).at(-1)!;
    expect(await w.call('m-zhao', '把刚才那笔改成1')).toContain('还没改账');
    expect(await second('m-wang-yj', '把小赵刚才那笔改成2')).toContain('还没改账');
    const [mine, theirs] = await Promise.all([w.call('m-zhao', '对'), second('m-wang-yj', '对')]);
    const won = [mine, theirs].filter(reply => reply.includes('已改账')).length;
    expect(won).toBe(1);
    expect([mine, theirs].filter(reply => reply === CONFLICT)).toHaveLength(1);
    const amount = await newEntryAmount(db.store, entry.entryId);
    if (mine.includes('已改账')) { tally.employeeWon++; expect(amount).toBe(100); } else { tally.managerWon++; expect(amount).toBe(200); }
    expect(await count(url, `SELECT count(*)::int AS n FROM front_claw_perf.performance_revisions WHERE entry_id=$1`, [entry.entryId])).toBe(1);
  }
  console.info(JSON.stringify({ 场景: 'M04 更正并发', 证据类型: 'PG17 临时集群，非线上版本', ...tally }));
  await db.close(); await other.close();
}, 60_000);

it('真实PG：同一条「对」在两个连接池上同时重放 → 只一条修订、一份改账通知意图', async () => {
  const url = await freshDatabase(); const db = await open(url); const other = await open(url);
  const w = await worldM04({ store: db.store });
  const second = handlerOn(other.store, other.store);
  await w.call('m-zhao', '880（小赵）'); await w.call('m-zhao', '对');
  const entry = (await db.store.listEntries({ storeId: 's-b', ownerPersonId: 'p-zhao', status: 'confirmed' })).at(-1)!;
  await w.call('m-wang-yj', '把小赵刚才那笔改成800');
  const replies = await Promise.all([w.call('m-wang-yj', '对', 'same-confirm'), second('m-wang-yj', '对', 'same-confirm')]);
  expect(replies.some(reply => reply.includes('已改账'))).toBe(true);
  for (const reply of replies) expect(reply).toMatch(/已改账|结果未知|草稿版本已变化/);
  expect(await newEntryAmount(db.store, entry.entryId)).toBe(80000);
  expect(await count(url, `SELECT count(*)::int AS n FROM front_claw_perf.performance_revisions WHERE entry_id=$1`, [entry.entryId])).toBe(1);
  expect(await count(url, `SELECT count(*)::int AS n FROM front_claw_perf.performance_notifications WHERE kind='correction'`)).toBe(1);
  // 之后在同一进程再重发同一确认：M02 请求预算按 messageId 去重，原样回该进程第一次的回复（输掉竞争的一方回“草稿版本已变化”），不再写。
  expect(await w.call('m-wang-yj', '对', 'same-confirm')).toBe(replies[0]);
  // 新进程（无进程内去重）重发同一确认 → 走草稿重放，回原结果；按操作号查也是已改账。
  const fresh = handlerOn(db.store, db.store);
  expect(await fresh('m-wang-yj', '对', 'same-confirm')).toContain('已改账');
  expect(await w.call('m-wang-yj', '入账结果 same-confirm')).toContain('已改账');
  expect(await count(url, `SELECT count(*)::int AS n FROM front_claw_perf.performance_revisions`)).toBe(1);
  await db.close(); await other.close();
});

it('真实PG先后①：撤权事务先持策略行 FOR UPDATE，更正确认因 NOWAIT 安全回滚零修订 → 撤权提交后再确认拒绝', async () => {
  const url = await freshDatabase(); const db = await open(url);
  const w = await worldM04({ store: db.store });
  await w.call('m-zhao', '880（小赵）'); await w.call('m-zhao', '对');
  const entry = (await db.store.listEntries({ storeId: 's-b', ownerPersonId: 'p-zhao', status: 'confirmed' })).at(-1)!;
  await w.call('m-zhao', '把刚才那笔改成800');
  const admin = await rawClient(url);
  await admin.query('BEGIN');
  await admin.query(`SELECT * FROM front_claw_perf.performance_config WHERE key=$1 FOR UPDATE`, [ACCESS_POLICY_KEY]);
  expect(await w.call('m-zhao', '对')).toBe('Front Claw：本次提交因争用已回滚，请查原操作结果；不要另报一笔。');
  expect(await newEntryAmount(db.store, entry.entryId)).toBe(88000);
  expect(await count(url, `SELECT count(*)::int AS n FROM front_claw_perf.performance_revisions`)).toBe(0);
  expect((await db.store.listDrafts({ kind: 'correction' }))[0]!.status).toBe('pending');
  await admin.query(`UPDATE front_claw_perf.performance_config SET value=$1 WHERE key=$2`, [JSON.stringify(revokedZhao(2)), ACCESS_POLICY_KEY]);
  await admin.query('COMMIT'); await admin.end();
  expect(await w.call('m-zhao', '对')).toBe(ACCESS_DENIED);
  expect(await newEntryAmount(db.store, entry.entryId)).toBe(88000);
  expect(await count(url, `SELECT count(*)::int AS n FROM front_claw_perf.performance_revisions`)).toBe(0);
  expect((await db.store.listDrafts({ kind: 'correction' }))[0]!.status).toBe('pending');
  await db.close();
}, 30_000);

it('真实PG先后②：另一事务先锁住账目行并改了金额，更正确认等行锁后比对版本不符 → 作废、零修订、不覆盖', async () => {
  const url = await freshDatabase(); const db = await open(url);
  const w = await worldM04({ store: db.store });
  await w.call('m-zhao', '880（小赵）'); await w.call('m-zhao', '对');
  const entry = (await db.store.listEntries({ storeId: 's-b', ownerPersonId: 'p-zhao', status: 'confirmed' })).at(-1)!;
  await w.call('m-zhao', '把刚才那笔改成800');
  const locker = await rawClient(url);
  await locker.query('BEGIN');
  await locker.query(`SELECT * FROM front_claw_perf.performance_entries WHERE entry_id=$1 FOR UPDATE`, [entry.entryId]);
  const confirming = w.call('m-zhao', '对');
  await waitForLockWait(url, '%performance_entries%FOR UPDATE%');
  await locker.query(`UPDATE front_claw_perf.performance_entries SET amount=$1 WHERE entry_id=$2`, [870, entry.entryId]);
  await locker.query('COMMIT'); await locker.end();
  expect(await confirming).toBe(CONFLICT);
  expect(await newEntryAmount(db.store, entry.entryId)).toBe(87000);
  expect(await count(url, `SELECT count(*)::int AS n FROM front_claw_perf.performance_revisions`)).toBe(0);
  expect((await db.store.listDrafts({ kind: 'correction' }))[0]!.status).toBe('void');
  await db.close();
});

it('真实PG竞态：更正确认与撤权在两个独立连接池上同时发起 20 轮——要么已改且 1 条修订，要么拒绝、金额不变、零修订', async () => {
  const url = await freshDatabase(); const db = await open(url); const admin = await open(url);
  const w = await worldM04({ store: db.store });
  const tally = { committed: 0, denied: 0 };
  let version = 1;
  const grant = async () => { expect((await updateAccessPolicy(admin.store, { expectedVersion: version, next: policyM04(version + 1), actor: 'test-admin', reason: '恢复', at })).ok).toBe(true); version++; };
  for (let round = 0; round < 20; round++) {
    if (round > 0) await grant();
    await w.call('m-zhao', `12号测试B店\n${2000 + round}（小赵）`); expect(await w.call('m-zhao', '对')).toContain('已入账');
    const entry = (await db.store.listEntries({ storeId: 's-b', ownerPersonId: 'p-zhao', status: 'confirmed' })).at(-1)!;
    expect(await w.call('m-zhao', '把刚才那笔改成7')).toContain('还没改账');
    // 偶数轮撤权晚起跑、奇数轮确认晚起跑（0–18ms 错开），让两种先后都稳定出现。
    const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
    const offset = (round % 10) * 2;
    const [reply, revoke] = await Promise.all([
      (round % 2 ? delay(offset) : Promise.resolve()).then(() => w.call('m-zhao', '对')),
      (round % 2 ? Promise.resolve() : delay(offset)).then(() => updateAccessPolicy(admin.store, { expectedVersion: version, next: revokedZhao(version + 1), actor: 'test-admin', reason: '撤权', at })),
    ]);
    expect(revoke).toEqual({ ok: true, version: version + 1 }); version++;
    const revisions = await count(url, `SELECT count(*)::int AS n FROM front_claw_perf.performance_revisions WHERE entry_id=$1`, [entry.entryId]);
    const amount = await newEntryAmount(db.store, entry.entryId);
    if (reply.includes('已改账')) { tally.committed++; expect(amount).toBe(700); expect(revisions).toBe(1); }
    else {
      tally.denied++; expect([ACCESS_DENIED, 'Front Claw：本次提交因争用已回滚，请查原操作结果；不要另报一笔。']).toContain(reply); expect(amount).toBe((2000 + round) * 100); expect(revisions).toBe(0);
      await grant(); expect(await w.call('m-zhao', '取消')).toContain('已取消');
    }
  }
  console.info(JSON.stringify({ 场景: 'M04 更正/撤权竞态', 证据类型: 'PG17 临时集群，非线上版本', ...tally }));
  expect(tally.committed + tally.denied).toBe(20);
  expect(tally.committed).toBeGreaterThan(0); expect(tally.denied).toBeGreaterThan(0);
  await db.close(); await admin.close();
}, 90_000);

it('真实PG：两位有权者同时给同一人定同一月目标（原未设置）→ 恰一份写入，另一份作废；目标行=胜者', async () => {
  const url = await freshDatabase(); const db = await open(url); const other = await open(url);
  const w = await worldM04({ store: db.store });
  await db.store.setConfig('employee-loop:m01', JSON.stringify({ enabled: true, storeId: 's-a', memberIds: ['m-zhou', 'm-boss'] }));
  const second = handlerOn(other.store, other.store);
  expect(await w.call('m-zhou', '给小林定本月目标3万')).toContain('原未设置');
  expect(await second('m-boss', '给小林定本月目标4万')).toContain('原未设置');
  const [a, b] = await Promise.all([w.call('m-zhou', '对'), second('m-boss', '对')]);
  expect([a, b].filter(reply => reply.includes('已设目标'))).toHaveLength(1);
  expect([a, b].filter(reply => reply === CONFLICT)).toHaveLength(1);
  const target = (await db.store.getTarget('s-a', 'p-lin', '2026-11'))!;
  expect(target.amount).toBe(a.includes('已设目标') ? 3_000_000 : 4_000_000);
  expect(await count(url, `SELECT count(*)::int AS n FROM front_claw_perf.performance_targets`)).toBe(1);
  await db.close(); await other.close();
});

it('真实PG重启：目标草稿跨进程保留；重启前后都不产生幽灵目标；确认中崩溃后用原确认续跑只写一次', async () => {
  const url = await freshDatabase(); const db = await open(url);
  const w = await worldM04({ store: db.store });
  await w.call('m-wang-yj', '给小赵定本月目标3万');
  await db.close();
  const reopened = await open(url);
  const after = handlerOn(reopened.store, reopened.store);
  expect(await count(url, `SELECT count(*)::int AS n FROM front_claw_perf.performance_targets`)).toBe(0);
  // 模拟“已转 confirming、提交前进程退出”：直接把草稿推进到 confirming 并记下确认消息号。
  const draft = (await reopened.store.listDrafts({ kind: 'target', status: 'pending' }))[0]!;
  const payload = { ...draft.payload, employeeContext: { ...(draft.payload as { employeeContext: object }).employeeContext, actionMessageId: 'lost-confirm', actionFingerprint: (await import('node:crypto')).createHash('sha256').update(JSON.stringify(['对'])).digest('hex') } };
  expect(await reopened.store.transitionPendingDraft(draft, { ...draft, status: 'confirming', payload } as typeof draft)).toBe(true);
  expect(await after('m-wang-yj', '对', 'lost-confirm')).toContain('已设目标');
  expect(await after('m-wang-yj', '对', 'lost-confirm')).toContain('已设目标');
  expect(await count(url, `SELECT count(*)::int AS n FROM front_claw_perf.performance_targets WHERE amount=30000`)).toBe(1);
  await reopened.close();
});
