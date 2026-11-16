import { startPgCluster, PG_START_HOOK_TIMEOUT_MS, PG_STOP_HOOK_TIMEOUT_MS } from '../helpers/pg-cluster.js';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Client } from 'pg';
import { FRONT_CLAW_DATABASE_URL, openPerformanceStore } from '../../src/role-eval/performance-open.js';
import { applyLatest } from '../migration/pg-harness-m08.js';
import { ACCESS_POLICY_KEY } from '../../src/role-eval/access-policy.js';
import { ACCESS_DENIED } from '../../src/role-eval/employee-loop.js';
import { startFrontClawOpenDotService, operationIdFor, type FrontClawOpenDotService } from '../../src/opendot/adapter.js';
import { CONSUMER_LEASE_KEY, createConsumerLease } from '../../src/opendot/consumer-lease.js';
import { membersM05, policyM05 } from '../role-eval/appointment-fixture-m05.js';
import { fakeHost, manualClock, offlineChannels, opIdOf, seedWorld } from './fixture-m07.js';

// M07 真实 PostgreSQL 临时集群（自建自删，随机端口，不连常驻库）。FRONT_CLAW_PG_BIN 可覆盖；
// 本机实测用 PG17 用户态程序 —— 不是线上版本。全部合成数据。
let cluster: { base: string; stop(): Promise<void> };
let dbSeq = 0;
beforeAll(async () => {
  // The append runner already owns and verifies this disposable cluster.
  if (process.env.APPEND_OWNED_PG === '1') {
    if (process.env.APPEND_PG_BASE !== 'postgres://append_synthetic@localhost:55482') throw Error('owned_pg_required');
    cluster = {base: process.env.APPEND_PG_BASE, stop: async () => {}};
  } else cluster = await startPgCluster();
}, PG_START_HOOK_TIMEOUT_MS);
afterAll(async () => { await cluster?.stop(); }, PG_STOP_HOOK_TIMEOUT_MS);

async function freshDatabase(): Promise<string> {
  const name = `m07_case_${++dbSeq}`;
  const admin = new Client({ connectionString: `${cluster.base}/postgres` });
  await admin.connect(); await admin.query(`CREATE DATABASE ${name}`); await admin.end();
  return `${cluster.base}/${name}`;
}
const env = (url: string) => ({ [FRONT_CLAW_DATABASE_URL]: url });
async function open(url: string) { await applyLatest(url); return openPerformanceStore(env(url), { requirePostgres: true }); }
async function seeded() { const url = await freshDatabase(); const db = await open(url); await seedWorld(db.store, db.bindings); await db.close(); return url; }
async function rawClient(url: string) { const c = new Client({ connectionString: url }); await c.connect(); return c; }
async function count(url: string, sql: string, params: unknown[] = []): Promise<number> {
  const c = await rawClient(url);
  try { return (await c.query(sql, params)).rows[0].n; } finally { await c.end(); }
}
const entries560 = (url: string) => count(url, `SELECT count(*)::int AS n FROM front_claw_perf.performance_entries WHERE amount=560`);
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
/** 默认入口：不注入 open —— 适配器按 env 里的 FRONT_CLAW_DATABASE_URL 自己开 PG（与线上同一路径）。 */
async function adapter(url: string, owner: string, clock = manualClock()) {
  const channels = offlineChannels();
  const { host, logs } = fakeHost(env(url));
  const service = await startFrontClawOpenDotService(host, { channel: channels.factory, now: clock.now, owner, timers: false, leaseMs: 30_000, renewMs: 10_000 });
  return { service, channels, logs, clock };
}
const say = async (a: { service: FrontClawOpenDotService; channels: ReturnType<typeof offlineChannels> }, member: string, text: string, msgid: string) => { a.channels.send(member, text, msgid); await a.service.idle(); return a.channels.replies().at(-1) ?? ''; };
const SHEET = '12号测试B店\n560（小赵）';

it('真实PG：OpenDot 假宿主 → 适配器（默认开库路径）→ handler → 临时 PG → 回复记录器；结果与账本一致', async () => {
  const url = await seeded();
  const a = await adapter(url, 'A');
  expect(a.service.state()).toBe('active');
  expect(await say(a, 'm-zhao', SHEET, 'pg-1')).toContain('560');
  expect(await say(a, 'm-zhao', '对', 'pg-2')).toContain('已入账');
  expect(await entries560(url)).toBe(1);
  expect(await a.service.result(operationIdFor(opIdOf('m-zhao', 'pg-2')))).toMatchObject({ state: 'completed', ledgerSettled: true, draftStatus: 'confirmed' });
  await a.service.close();
  const lease = JSON.parse((await (async () => { const c = await rawClient(url); try { return (await c.query(`SELECT value FROM front_claw_perf.performance_config WHERE key=$1`, [CONSUMER_LEASE_KEY])).rows[0].value as string; } finally { await c.end(); } })()));
  expect(lease).toEqual({ owner: null, token: null, until: 0, epoch: expect.any(Number) });
}, 30_000);

it('真实PG竞态：租约行尚不存在时 6 个连接池同时首次抢租约，10 轮每轮恰好一个赢', async () => {
  for (let round = 0; round < 10; round++) {
    const url = await freshDatabase();
    // 先由一个连接完成建表（M07 时并发首次建表会撞 23505；M08 已加 advisory lock，并发启动另见 schema-pg-m08）。
    const first = await open(url);
    const dbs = [first, ...await Promise.all(Array.from({ length: 5 }, () => open(url)))];
    expect(await count(url, `SELECT count(*)::int AS n FROM front_claw_perf.performance_config WHERE key=$1`, [CONSUMER_LEASE_KEY])).toBe(0);
    const clock = manualClock();
    const leases = dbs.map((db, i) => createConsumerLease({ store: db.store, owner: `I${i}`, ttlMs: 30_000, now: clock.now }));
    const won = await Promise.all(leases.map(l => l.acquire()));
    expect(won.filter(Boolean), `round ${round}`).toHaveLength(1);
    const holder = leases[won.indexOf(true)]!;
    const others = await Promise.all(leases.filter(l => l !== holder).map(l => l.acquire()));
    expect(others.every(x => !x)).toBe(true);
    await Promise.all(dbs.map(db => db.close()));
  }
}, 60_000);

it('真实PG：持有者“崩溃”（不关停、不释放）→ 到期前别人接不了 → 到期后接管；企微重投同 msgid 不重复入账', async () => {
  const url = await seeded();
  const clockA = manualClock(), clockB = manualClock();
  const a = await adapter(url, 'A', clockA);
  await say(a, 'm-zhao', SHEET, 'cr-1');
  await say(a, 'm-zhao', '对', 'cr-2');
  // A 崩溃：此后不再 tick/close。
  const b = await adapter(url, 'B', clockB);
  expect(b.service.state()).toBe('standby');
  clockB.advance(29_000); await b.service.tick();
  expect(b.service.state()).toBe('standby');
  clockB.advance(1_500); await b.service.tick();
  expect(b.service.state()).toBe('active');
  // 企微对未确认的回调重投：同 msgid 的报数与「对」。
  await say(b, 'm-zhao', SHEET, 'cr-1');
  const reply = await say(b, 'm-zhao', '对', 'cr-2');
  expect(reply).not.toContain('结果未知');
  expect(await entries560(url)).toBe(1);
  await b.service.close();
  // A 的连接池收尾（不释放租约：模拟崩溃后进程退出）。
  (a.service as unknown as { close(): Promise<void> }).close().catch(() => {});
}, 30_000);

it('真实PG（R1 fencing）：时钟偏差双消费者同时收到同一「对」，旧 epoch 的 A 处理前即丢弃、不写不回；B 恰好一笔，5 轮', async () => {
  const url = await seeded();
  const ca = manualClock(), cb = manualClock();
  const a = await adapter(url, 'A', ca);
  cb.advance(30_001);
  const b = await adapter(url, 'B', cb);
  expect([a.service.state(), b.service.state()]).toEqual(['active', 'active']);
  for (let round = 0; round < 5; round++) {
    const amount = 600 + round;
    // A 的租约在 PG 里已被 B 接管（epoch 已 +1）：发给 A 的帧在处理前即按 fencing 丢弃，不建草稿、不回复。
    const staleBefore = a.service.stats().droppedStale;
    await say(a, 'm-zhao', `12号测试B店\n${amount}（小赵）`, `dd-x-${round}`);
    expect(a.service.stats().droppedStale).toBe(staleBefore + 1);
    await say(b, 'm-zhao', `12号测试B店\n${amount}（小赵）`, `dd-s-${round}`);
    const f = a.channels.frame('m-zhao', '对', `dd-c-${round}`);
    const aBefore = a.channels.replies().length;
    a.channels.current().frame(f); b.channels.current().frame(f);
    await Promise.all([a.service.idle(), b.service.idle()]);
    expect(a.channels.replies().length, `round ${round} A silent`).toBe(aBefore);
    expect(await count(url, `SELECT count(*)::int AS n FROM front_claw_perf.performance_entries WHERE amount=$1`, [amount]), `round ${round}`).toBe(1);
  }
  await a.service.close(); await b.service.close();
}, 60_000);

it('真实PG竞态：「对」与撤权同时发生 —— 配置争用 NOWAIT 拒绝、零入账；撤权提交后仍拒绝', async () => {
  const url = await seeded();
  const a = await adapter(url, 'A');
  expect(await say(a, 'm-zhao', SHEET, 'rv-1')).toContain('560');
  const admin = await rawClient(url);
  await admin.query('BEGIN');
  await admin.query(`SELECT value FROM front_claw_perf.performance_config WHERE key=$1 FOR UPDATE`, [ACCESS_POLICY_KEY]);
  a.channels.send('m-zhao', '对', 'rv-2');
  await a.service.idle();
  expect(a.channels.replies().at(-1)).toContain('争用已回滚');
  expect(await entries560(url)).toBe(0);
  const members = membersM05(); members['p-zhao'] = { ...members['p-zhao']!, status: 'suspended' };
  await admin.query(`UPDATE front_claw_perf.performance_config SET value=$1 WHERE key=$2`, [JSON.stringify(policyM05(2, members)), ACCESS_POLICY_KEY]);
  await admin.query('COMMIT'); await admin.end();
  await a.service.idle();
  const reply = a.channels.replies().at(-1) ?? '';
  expect(reply).not.toContain('已入账');
  expect(await entries560(url)).toBe(0);
  expect(await say(a, 'm-zhao', '对', 'rv-3')).toBe(ACCESS_DENIED);
  expect(await entries560(url)).toBe(0);
  await a.service.close();
}, 30_000);

it('PG binding: NOWAIT refuses a busy binding before any business settlement', async () => {
  const url = await seeded(); const a = await adapter(url, 'binding-revoke');
  const blocker = await rawClient(url);
  try {
    await say(a, 'm-zhao', SHEET, 'binding-draft');
    await blocker.query('BEGIN');
    await blocker.query(`SELECT * FROM front_claw_perf.wecom_bot_bindings WHERE bot_id=$1 AND member_id=$2 FOR UPDATE`, ['fc-bot', 'm-zhao']);
    a.channels.send('m-zhao', '对', 'binding-confirm');
    await a.service.idle();
    expect(a.channels.replies().at(-1)).toContain('争用已回滚');
    expect(await entries560(url)).toBe(0);
    await blocker.query(`UPDATE front_claw_perf.wecom_bot_bindings SET active=false, version=version+1 WHERE bot_id=$1 AND member_id=$2`, ['fc-bot', 'm-zhao']);
    await blocker.query('COMMIT'); await a.service.idle();
    expect(await entries560(url)).toBe(0);
  } finally {await blocker.query('ROLLBACK'); await blocker.end(); await a.service.close();}
}, 30_000);

it('PG binding: commit holds the binding row until ledger commit; a later revocation serializes behind it', async () => {
  const url = await seeded(); const a = await adapter(url, 'binding-commit');
  const blocker = await rawClient(url), revoker = await rawClient(url);
  const lockKey = (value: string) => {let hash = 0; for (let i = 0; i < value.length; i++) hash = (Math.imul(hash, 31) + value.charCodeAt(i)) | 0; return hash;};
  const keys = [lockKey('s-b'), lockKey('2026-11-12')];
  let revoke: Promise<unknown> | undefined;
  try {
    await say(a, 'm-zhao', SHEET, 'binding-first-draft');
    await blocker.query('SELECT pg_advisory_lock($1,$2)', keys);
    a.channels.send('m-zhao', '对', 'binding-first-confirm');
    await waitForLockWait(url, 'SELECT pg_advisory_xact_lock%');
    revoke = revoker.query(`UPDATE front_claw_perf.wecom_bot_bindings SET active=false, version=version+1 WHERE bot_id=$1 AND member_id=$2`, ['fc-bot', 'm-zhao']);
    await waitForLockWait(url, 'UPDATE front_claw_perf.wecom_bot_bindings%');
    await blocker.query('SELECT pg_advisory_unlock($1,$2)', keys);
    await revoke; await a.service.idle();
    expect(await entries560(url)).toBe(1);
    const previous = a.channels.replies().length;
    await say(a, 'm-zhao', '对', 'binding-after-revoke');
    expect(await entries560(url)).toBe(1);
    expect(a.channels.replies().length).toBeGreaterThanOrEqual(previous);
  } finally {await blocker.query('SELECT pg_advisory_unlock($1,$2)', keys); await revoke; await blocker.end(); await revoker.end(); await a.service.close();}
}, 30_000);
