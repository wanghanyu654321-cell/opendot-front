import { startPgCluster, PG_START_HOOK_TIMEOUT_MS, PG_STOP_HOOK_TIMEOUT_MS } from '../helpers/pg-cluster.js';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Client } from 'pg';
import { FRONT_CLAW_DATABASE_URL, openPerformanceStore, type OpenedPerformanceStore } from '../../src/role-eval/performance-open.js';
import { applyLatest } from '../migration/pg-harness-m08.js';
import { createWecomBotHandler } from '../../src/role-eval/wecom-bot-unified-handler.js';
import { ACCESS_POLICY_KEY, updateAccessPolicy } from '../../src/role-eval/access-policy.js';
import { ACCESS_DENIED } from '../../src/role-eval/employee-loop.js';
import { confirmEntryId, type PerformanceStore } from '../../src/role-eval/performance-store.js';
import { baseMembers, NOW, policy, world } from './access-fixture-m03.js';

// M03 真实 PostgreSQL 临时集群（自建自删，随机端口，不连常驻库）。程序目录同 performance-postgres.integration.test.ts：
// FRONT_CLAW_PG_BIN 可覆盖，默认 /usr/lib/postgresql/16/bin。本机实测用 PG17 用户态程序，非线上版本。

let cluster: { base: string; stop(): Promise<void> };
let dbSeq = 0;
beforeAll(async () => {
  cluster = await startPgCluster();
}, PG_START_HOOK_TIMEOUT_MS);
afterAll(async () => { await cluster?.stop(); }, PG_STOP_HOOK_TIMEOUT_MS);

/** 每个用例一个新库，互不影响。 */
async function freshDatabase(): Promise<string> {
  const name = `m03_case_${++dbSeq}`;
  const admin = new Client({ connectionString: `${cluster.base}/postgres` });
  await admin.connect(); await admin.query(`CREATE DATABASE ${name}`); await admin.end();
  return `${cluster.base}/${name}`;
}

const at = NOW.toISOString();
const revoked = (version: number) => policy(version, { ...baseMembers(), 'p-wang-yj': { role: 'manager', storeIds: ['s-b'], status: 'revoked' } });
async function open(url: string) { await applyLatest(url); return openPerformanceStore({ [FRONT_CLAW_DATABASE_URL]: url }, { requirePostgres: true }); }
async function rawClient(url: string) { const c = new Client({ connectionString: url }); await c.connect(); return c; }
async function newEntries(url: string): Promise<string[]> {
  const c = await rawClient(url);
  try { return (await c.query(`SELECT entry_id FROM front_claw_perf.performance_entries WHERE entry_id NOT LIKE 'e-%' ORDER BY entry_id`)).rows.map(row => row.entry_id); }
  finally { await c.end(); }
}
/** 等到另一后端在行锁上等待（pg_stat_activity），超时报错，避免靠 sleep 猜测。 */
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

it('真实PG先后①：撤权事务先持 FOR UPDATE，确认因 NOWAIT 安全回滚不入账 → 撤权提交后再确认看到新策略拒绝', async () => {
  const url = await freshDatabase(); const db = await open(url);
  const w = await world({ store: db.store });
  expect(await w.call('m-wang-yj', '12号测试B店\n560（小赵）')).toContain('代报');
  const draftId = (await db.store.listDrafts({ status: 'pending' }))[0]!.draftId;
  const admin = await rawClient(url);
  await admin.query('BEGIN');
  await admin.query(`SELECT * FROM front_claw_perf.performance_config WHERE key=$1 FOR UPDATE`, [ACCESS_POLICY_KEY]);
  expect(await w.call('m-wang-yj', '对')).toBe('Front Claw：本次提交因争用已回滚，请查原操作结果；不要另报一笔。');
  expect(await newEntries(url)).toEqual([]);
  expect((await db.store.getDraft(draftId))!.status).toBe('pending');
  await admin.query(`UPDATE front_claw_perf.performance_config SET value=$1 WHERE key=$2`, [JSON.stringify(revoked(2)), ACCESS_POLICY_KEY]);
  await admin.query('COMMIT'); await admin.end();
  expect(await w.call('m-wang-yj', '对')).toBe(ACCESS_DENIED);
  expect(await newEntries(url)).toEqual([]);
  expect((await db.store.getDraft(draftId))!.status).toBe('pending');
  expect(w.send).not.toHaveBeenCalled();
  await db.close();
}, 30_000);

it('真实PG先后②：提交事务先持 FOR SHARE 时，撤权（updateAccessPolicy 的 FOR UPDATE）必须等提交结束', async () => {
  const url = await freshDatabase(); const db = await open(url); const other = await open(url);
  await world({ store: db.store });
  const committer = await rawClient(url);
  await committer.query('BEGIN');
  await committer.query(`SELECT * FROM front_claw_perf.performance_config WHERE key=$1 FOR SHARE`, [ACCESS_POLICY_KEY]);
  let finished = false;
  const update = updateAccessPolicy(other.store, { expectedVersion: 1, next: revoked(2), actor: 'test-admin', reason: '撤权', at }).then(result => { finished = true; return result; });
  await waitForLockWait(url, '%FOR UPDATE%');
  expect(finished).toBe(false);
  await committer.query('COMMIT'); await committer.end();
  expect(await update).toEqual({ ok: true, version: 2 });
  await db.close(); await other.close();
});

it('真实PG竞态：确认与撤权在两个独立连接池上同时发起 20 轮，结果与账本始终一致（要么已入账，要么拒绝且零入账）', async () => {
  const url = await freshDatabase(); const db = await open(url); const admin = await open(url);
  const w = await world({ store: db.store });
  const tally = { committed: 0, denied: 0 };
  let version = 1;
  for (let round = 0; round < 20; round++) {
    if (round > 0) { const regrant = await updateAccessPolicy(admin.store, { expectedVersion: version, next: policy(version + 1), actor: 'test-admin', reason: '恢复', at }); expect(regrant.ok).toBe(true); version++; }
    expect(await w.call('m-wang-yj', `12号测试B店\n${100 + round}（小赵）`)).toContain('代报');
    const draft = (await db.store.listDrafts({ status: 'pending' }))[0]!;
    const [reply, revoke] = await Promise.all([
      w.call('m-wang-yj', '对'),
      // 撤权按轮次错开 0–38ms 起跑，让“先提交后撤权”和“先撤权后提交”两种顺序都出现。
      new Promise(resolve => setTimeout(resolve, (round % 20) * 2)).then(() => updateAccessPolicy(admin.store, { expectedVersion: version, next: revoked(version + 1), actor: 'test-admin', reason: '撤权', at })),
    ]);
    expect(revoke).toEqual({ ok: true, version: version + 1 }); version++;
    const saved = (await db.store.getDraft(draft.draftId))!;
    const entries = (await newEntries(url)).filter(id => id === confirmEntryId(draft.draftId, 0));
    if (reply.includes('已入账')) { tally.committed++; expect(saved.status).toBe('confirmed'); expect(entries.length).toBe(1); }
    else { tally.denied++; expect([ACCESS_DENIED, 'Front Claw：本次提交因争用已回滚，请查原操作结果；不要另报一笔。']).toContain(reply); expect(saved.status).toBe('pending'); expect(entries).toEqual([]);
      // 让下一轮能建新草稿：本人取消（取消不需要报数能力以外的权限，此处先恢复授权）。
      const regrant = await updateAccessPolicy(admin.store, { expectedVersion: version, next: policy(version + 1), actor: 'test-admin', reason: '恢复', at }); expect(regrant.ok).toBe(true); version++;
      expect(await w.call('m-wang-yj', '取消')).toContain('取消');
    }
  }
  console.info(JSON.stringify({ 场景: 'M03 确认/撤权竞态', 证据类型: 'PG17 临时集群，非线上版本', ...tally }));
  expect(tally.committed + tally.denied).toBe(20);
  expect(tally.committed).toBeGreaterThan(0); expect(tally.denied).toBeGreaterThan(0);
  await db.close(); await admin.close();
}, 60_000);

it('真实PG：确认已排队、提交前被降级 → 拒绝、零入账', async () => {
  const url = await freshDatabase(); const db = await open(url); const admin = await open(url);
  const w = await world({ store: db.store });
  expect(await w.call('m-wang-yj', '12号测试B店\n560（小赵）')).toContain('代报');
  let fired = false;
  const store = new Proxy(db.store, { get(target, key, receiver) {
    const value = Reflect.get(target, key, receiver);
    if (typeof value !== 'function') return value;
    return async (...args: unknown[]) => {
      if (key === 'commitConfirmingDraft' && !fired) { fired = true;
        const demote = policy(2, { ...baseMembers(), 'p-wang-yj': { role: 'manager', storeIds: ['s-b'], status: 'active' } }, { roles: { employee: ['report_self', 'progress_self'], manager: ['report_self', 'progress_self'], owner: [] } });
        expect(await updateAccessPolicy(admin.store, { expectedVersion: 1, next: demote, actor: 'test-admin', reason: '降级', at })).toEqual({ ok: true, version: 2 }); }
      return (value as (...a: unknown[]) => unknown).apply(target, args);
    };
  } }) as PerformanceStore;
  const handler = createWecomBotHandler({ legacyEntry: true, mode: 'isolated-synthetic', store, now: () => NOW, resolve: id => db.store.getPersonByMember(id),
    send: async () => 'sent', model: { complete: async () => { throw Error('不应调用模型'); } }, employeeLoop: true, accessPolicy: true });
  const result = await handler.handleMessage({ memberId: 'm-wang-yj', text: '对', messageId: 'queued', sessionId: 'session-m-wang-yj', bindingVersion: 1 });
  expect(fired).toBe(true);
  expect(result.replies.join('\n')).toBe(ACCESS_DENIED);
  expect(await newEntries(url)).toEqual([]);
  expect((await db.store.listDrafts())[0]!.status).toBe('pending');
  await db.close(); await admin.close();
});

it('真实PG矩阵抽样：只授权A店的老板排名只读A店；空配置/坏配置全拒零业务读', async () => {
  const url = await freshDatabase(); const db = await open(url);
  const w = await world({ store: db.store });
  w.reset();
  const rank = await w.call('m-boss', '门店排名');
  expect(rank).toContain('测试A店'); expect(rank).not.toContain('测试B店');
  expect(new Set(w.entryStores())).toEqual(new Set(['s-a']));
  for (const raw of ['{broken', null]) {
    const c = await rawClient(url);
    if (raw === null) await c.query(`UPDATE front_claw_perf.performance_config SET key=$1 WHERE key=$2`, [`${ACCESS_POLICY_KEY}:parked`, ACCESS_POLICY_KEY]); // 改键名模拟“策略缺失”，不删行
    else await c.query(`UPDATE front_claw_perf.performance_config SET value=$1 WHERE key=$2`, [raw, ACCESS_POLICY_KEY]);
    await c.end();
    w.reset();
    for (const [member, text] of [['m-boss', '门店排名'], ['m-zhou', '经营汇总'], ['m-wang-yj', '12号测试B店\n1（小赵）']] as const) expect(await w.call(member, text)).toBe(ACCESS_DENIED);
    expect(w.entryStores()).toEqual([]);
  }
  expect(await newEntries(url)).toEqual([]);
  await db.close();
});
