import { startPgCluster, PG_START_HOOK_TIMEOUT_MS, PG_STOP_HOOK_TIMEOUT_MS } from '../helpers/pg-cluster.js';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Client } from 'pg';
import { FRONT_CLAW_DATABASE_URL, openPerformanceStore } from '../../src/role-eval/performance-open.js';
import { createWecomBotHandler } from '../../src/role-eval/wecom-bot-unified-handler.js';
import { ACCESS_POLICY_KEY, updateAccessPolicy } from '../../src/role-eval/access-policy.js';
import type { PerformanceStore } from '../../src/role-eval/performance-store.js';
import { NOW } from './access-fixture-m03.js';
import { membersM05, policyM05, worldM05 } from './appointment-fixture-m05.js';
import { createBotSender } from '../../src/role-eval/wecom-bot-sender.js';
import { bootFrontClaw } from '../../src/role-eval/front-claw-boot.js';
import { createBotNotificationSender, createNotificationDispatcher, type DispatchEvent, type NotificationSender } from '../../src/role-eval/notification-dispatch.js';
import { readFile, mkdir } from 'node:fs/promises';
import { fakeSender } from './notify-fixture-m06.js';

// M06 真实 PostgreSQL 临时集群（自建自删，随机端口，不连常驻库）。程序目录同 performance-postgres.integration.test.ts：
// FRONT_CLAW_PG_BIN 可覆盖，默认 /usr/lib/postgresql/16/bin。本机实测用 PG17 用户态程序，非线上版本。

let cluster: { base: string; stop(): Promise<void> };
let dbSeq = 0;
beforeAll(async () => {
  cluster = await startPgCluster();
}, PG_START_HOOK_TIMEOUT_MS);
afterAll(async () => { await cluster?.stop(); }, PG_STOP_HOOK_TIMEOUT_MS);

/** 每个用例一个新库，互不影响。 */
async function freshDatabase(): Promise<string> {
  const name = `m06_case_${++dbSeq}`;
  const admin = new Client({ connectionString: `${cluster.base}/postgres` });
  await admin.connect(); await admin.query(`CREATE DATABASE ${name}`); await admin.end();
  return `${cluster.base}/${name}`;
}

const at = NOW.toISOString();
async function open(url: string) { return openPerformanceStore({ [FRONT_CLAW_DATABASE_URL]: url }, { requirePostgres: true }); }
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
const MIN = 60_000;
const T0 = NOW.getTime();
const rows = async (url: string) => (await (async () => { const c = await rawClient(url); try { return (await c.query(`SELECT notification_id, kind, status FROM front_claw_perf.performance_notifications ORDER BY notification_id`)).rows as { notification_id: string; kind: string; status: string }[]; } finally { await c.end(); } })());
const say = (round: number) => `明天下午3点${String(round).padStart(2, '0')}分王姐要来`;
async function seeded(count: number) {
  const url = await freshDatabase(); const db = await open(url);
  const w = await worldM05({ store: db.store });
  for (let i = 0; i < count; i++) { expect(await w.call('m-zhao', say(i))).toContain('预约还没登记'); expect(await w.call('m-zhao', '对')).toContain('预约已登记'); }
  return { url, db, w };
}
function make(store: PerformanceStore, sender: NotificationSender, worker: string, offsetMs = 0, extra: Partial<Parameters<typeof createNotificationDispatcher>[0]> = {}) {
  const events: DispatchEvent[] = [];
  return { ...createNotificationDispatcher({ store, sender, now: () => new Date(T0 + offsetMs), worker, leaseMs: MIN, onEvent: e => events.push(e), ...extra }), events };
}
const managerWith = (version: number, status: 'active' | 'suspended') => policyM05(version, { ...membersM05(), 'p-wang-yj': { role: 'manager', storeIds: ['s-b'], status } });

it('真实PG：4 个派发者在 4 个独立连接池上同时跑 3 轮，30 条提醒每条恰好上线一次，全部 sent', async () => {
  const { url, db } = await seeded(30);
  const pools = [db, ...await Promise.all([1, 2, 3].map(() => open(url)))];
  const f = fakeSender();
  const ds = pools.map((p, i) => make(p.store, f.sender, `w${i}`, 0, { batch: 4 }));
  for (let round = 0; round < 3; round++) await Promise.all(ds.map(d => d.tick()));
  const ids = f.wire.map(i => i.notificationId);
  expect(ids).toHaveLength(30); expect(new Set(ids).size).toBe(30);
  expect((await rows(url)).every(r => r.status.startsWith('sent|'))).toBe(true);
  const perWorker = ds.map(d => d.events.filter(e => e.type === 'sent').length);
  console.info(JSON.stringify({ 场景: 'M06 多派发者竞争', 证据类型: 'PG17 临时集群，非线上版本', perWorker, wire: ids.length, unique: new Set(ids).size }));
  expect(perWorker.filter(n => n > 0).length).toBeGreaterThan(1);
  for (const p of pools) await p.close();
}, 90_000);

it('真实PG先后：撤权事务先持策略行 FOR UPDATE，派发在 beginNotificationSend 等锁 → 撤权（停用指定店长）提交后不上线，not_sent', async () => {
  const { url, db } = await seeded(1);
  const admin = await rawClient(url);
  await admin.query('BEGIN');
  await admin.query(`SELECT * FROM front_claw_perf.performance_config WHERE key=$1 FOR UPDATE`, [ACCESS_POLICY_KEY]);
  const f = fakeSender();
  const ticking = make(db.store, f.sender, 'w1').tick();
  await waitForLockWait(url, '%FOR SHARE%');
  await admin.query(`UPDATE front_claw_perf.performance_config SET value=$1 WHERE key=$2`, [JSON.stringify(managerWith(2, 'suspended')), ACCESS_POLICY_KEY]);
  await admin.query('COMMIT'); await admin.end();
  expect(await ticking).toMatchObject({ refused: 1, sent: 0 });
  expect(f.wire).toEqual([]);
  expect((await rows(url))[0]!.status).toMatch(/^not_sent\|.*err=recipient_ineligible/);
  await db.close();
});

it('真实PG竞态：派发与“停用指定店长”在两个连接池上同时发起 20 轮——要么上线且 sent，要么不上线且 not_sent，状态与发送器记录一致', async () => {
  const url = await freshDatabase(); const db = await open(url); const admin = await open(url);
  const w = await worldM05({ store: db.store });
  const tally = { sent: 0, refused: 0 };
  let version = 1;
  const set = async (status: 'active' | 'suspended') => { const r = await updateAccessPolicy(admin.store, { expectedVersion: version, next: managerWith(version + 1, status), actor: 'test-admin', reason: status, at }); expect(r).toEqual({ ok: true, version: version + 1 }); version++; };
  for (let round = 0; round < 20; round++) {
    if (round > 0) await set('active');
    await w.call('m-zhao', say(round)); expect(await w.call('m-zhao', '对')).toContain('已排队提醒');
    const f = fakeSender();
    const offset = (round % 10) * 2;
    await Promise.all([
      (round % 2 ? new Promise(r => setTimeout(r, offset)) : Promise.resolve()).then(() => make(db.store, f.sender, `w${round}`).tick()),
      (round % 2 ? Promise.resolve() : new Promise(r => setTimeout(r, offset))).then(() => set('suspended')),
    ]);
    const mine = (await rows(url)).filter(r => !r.status.startsWith('sent|') && !r.status.startsWith('not_sent|'));
    expect(mine).toEqual([]);
    const total = await rows(url);
    const sentNow = total.filter(r => r.status.startsWith('sent|')).length, refusedNow = total.filter(r => r.status.startsWith('not_sent|')).length;
    expect(sentNow + refusedNow).toBe(round + 1);
    if (f.wire.length) { tally.sent++; expect(sentNow).toBe(tally.sent); } else { tally.refused++; expect(refusedNow).toBe(tally.refused); }
  }
  console.info(JSON.stringify({ 场景: 'M06 派发/停用店长竞态', 证据类型: 'PG17 临时集群，非线上版本', ...tally }));
  expect(tally.sent + tally.refused).toBe(20); expect(tally.sent).toBeGreaterThan(0); expect(tally.refused).toBeGreaterThan(0);
  await db.close(); await admin.close();
}, 90_000);

it('真实PG：复用现有 wecom-bot-sender，SDK 不回执（超时）→ unknown，不当 sent，之后多轮不自动重发', async () => {
  const { url, db } = await seeded(1);
  const sdkCalls: string[] = [];
  const bot = createBotSender({ timeoutMs: 100, sdk: { mode: 'isolated-synthetic', ready: () => true, reply: async () => ({}), sendMessage: async (chatid: string) => { sdkCalls.push(chatid); return new Promise(() => {}); } } });
  const d = make(db.store, createBotNotificationSender(bot), 'w1');
  expect(await d.tick()).toMatchObject({ unknown: 1, sent: 0 });
  for (const offset of [MIN, 10 * MIN, 120 * MIN]) await make(db.store, createBotNotificationSender(bot), 'w2', offset).tick();
  expect(sdkCalls).toEqual(['m-wang-yj']);
  expect((await rows(url))[0]!.status).toMatch(/^unknown\|.*err=send_result_unknown/);
  bot.close(); await db.close();
});

it('真实PG：租约到期前别的派发者领不到；过期领取者（发送前停住）之后不能上线也写不进状态', async () => {
  const { url, db } = await seeded(1);
  const other = await open(url);
  let release!: () => void;
  const stuck: NotificationSender = { async send(_i, beforeSend) { await new Promise<void>(r => { release = r; }); try { await beforeSend(); } catch { return { state: 'blocked', detail: 'authority_refused' }; } return { state: 'accepted', detail: 'late' }; } };
  const a = make(db.store, stuck, 'A');
  const aTick = a.tick();
  for (let i = 0; i < 100 && !release; i++) await new Promise(r => setTimeout(r, 20));
  const f = fakeSender();
  expect(await make(other.store, f.sender, 'B', 30_000).tick()).toMatchObject({ claimed: 0 });
  expect(await make(other.store, f.sender, 'B', MIN + 1000).tick()).toMatchObject({ claimed: 1, sent: 1 });
  release(); await aTick;
  expect(a.events.some(e => e.type === 'lost')).toBe(true);
  expect(f.wire).toHaveLength(1);
  expect((await rows(url))[0]!.status).toMatch(/^sent\|.*a=1/);
  await db.close(); await other.close();
});

it('真实PG：已进入发送阶段的派发者停住 → 另一连接池上的派发者在租约到期后判 unknown；停住者迟到的“已接受”写不进去（条件写）', async () => {
  const { url, db } = await seeded(1);
  const other = await open(url);
  let resolve!: (r: { state: 'accepted'; detail: string }) => void;
  const deferred = new Promise<{ state: 'accepted'; detail: string }>(r => { resolve = r; });
  const fa = fakeSender(() => ({ deferred }));
  const a = make(db.store, fa.sender, 'A');
  const aTick = a.tick();
  for (let i = 0; i < 100 && !fa.wire.length; i++) await new Promise(r => setTimeout(r, 20));
  expect((await rows(url))[0]!.status).toMatch(/^pending\|[^|]+\|sending\|a=1/);
  const fb = fakeSender();
  expect(await make(other.store, fb.sender, 'B', MIN + 1000).tick()).toMatchObject({ recovered: 1, claimed: 0 });
  resolve({ state: 'accepted', detail: 'late' }); await aTick;
  expect(a.events.some(e => e.type === 'stale_claim')).toBe(true);
  expect((await rows(url))[0]!.status).toMatch(/^unknown\|.*err=lease_expired_during_send/);
  expect(fa.wire).toHaveLength(1); expect(fb.calls).toEqual([]);
  await db.close(); await other.close();
});

it('真实PG：boot 在 FRONT_CLAW_NOTIFY_DISPATCH=1 + 员工入口 + 访问策略时才启动派发；未设开关则 disabled', async () => {
  const url = await freshDatabase();
  const common = { send: async () => 'sent' as const, model: { complete: async () => ({ type: 'chat' as const, text: 'x' }) }, employeeLoop: true, accessPolicy: true };
  const f = fakeSender();
  const off = await bootFrontClaw({ ...common, env: { [FRONT_CLAW_DATABASE_URL]: url } });
  expect(off.startNotificationDispatch(f.sender)).toBe('disabled'); await off.close();
  const on = await bootFrontClaw({ ...common, env: { [FRONT_CLAW_DATABASE_URL]: url, FRONT_CLAW_NOTIFY_DISPATCH: '1' } });
  expect(on.startNotificationDispatch(f.sender, { intervalMs: 600_000 })).toBe('started');
  expect(on.startNotificationDispatch(f.sender)).toBe('already');
  await on.close();
  expect(f.calls).toEqual([]);
});

// ---- 真实子进程 kill -9 崩溃点矩阵 ----
let workerFile = '';
async function bundleWorker(): Promise<string> {
  if (workerFile) return workerFile;
  const { build } = await import('rolldown');
  const dir = join(process.cwd(), 'node_modules', '.m06-worker');
  await mkdir(dir, { recursive: true });
  workerFile = join(dir, 'notify-worker.mjs');
  await build({ input: join(process.cwd(), 'tests/role-eval/notify-worker-m06.ts'), platform: 'node', external: [/^[^./]/], output: { file: workerFile, format: 'esm' }, write: true, logLevel: 'silent' });
  return workerFile;
}
async function runWorker(env: Record<string, string>): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  const file = await bundleWorker();
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [file], { env: { PATH: process.env.PATH ?? '', ...env }, stdio: ['ignore', 'ignore', 'inherit'] });
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
}
const POINTS = ['crash-before-claim', 'crash-after-claim', 'crash-in-begin-tx', 'crash-on-wire', 'crash-after-ack'] as const;
it('真实进程重启：5 个崩溃点各自 kill -9 后，新进程（租约到期后）恢复——未上线的只补发一次，已上线的判 unknown 不重发；租约内重启不动', async () => {
  const matrix: Record<string, unknown>[] = [];
  for (const point of POINTS) {
    const { url, db } = await seeded(1);
    await db.close();
    const outDir = await mkdtemp(join(tmpdir(), 'm06-worker-'));
    const out = join(outDir, 'log.txt');
    const crashed = await runWorker({ M06_DB_URL: url, M06_MODE: point, M06_OUT: out, M06_WORKER: 'crashed', M06_NOW_MS: String(T0) });
    expect(crashed.signal, point).toBe('SIGKILL');
    const afterCrash = (await rows(url))[0]!.status;
    const early = await runWorker({ M06_DB_URL: url, M06_MODE: 'normal', M06_OUT: out, M06_WORKER: 'early', M06_NOW_MS: String(T0 + 10_000) });
    expect(early.code, point).toBe(0);
    const afterEarly = (await rows(url))[0]!.status;
    const late = await runWorker({ M06_DB_URL: url, M06_MODE: 'normal', M06_OUT: out, M06_WORKER: 'restarted', M06_NOW_MS: String(T0 + 2 * MIN) });
    expect(late.code, point).toBe(0);
    const final = (await rows(url))[0]!.status;
    const log = await readFile(out, 'utf8');
    const wire = log.split('\n').filter(line => / WIRE /.test(line)).map(line => line.split(' ')[0]);
    matrix.push({ point, afterCrash: afterCrash.split('|').slice(0, 3).join('|'), afterEarly: afterEarly.split('|').slice(0, 3).join('|'), final: final.replace(/\|tok=[^|]*/, ''), wire });
    if (point === 'crash-on-wire' || point === 'crash-after-ack') {
      expect(wire, point).toEqual(['crashed']);
      expect(final, point).toMatch(/^unknown\|.*err=lease_expired_during_send/);
    } else {
      expect(wire, point).toEqual([point === 'crash-before-claim' ? 'early' : 'restarted']);
      expect(final, point).toMatch(/^sent\|/);
    }
    if (point !== 'crash-before-claim') expect(afterEarly, point).toBe(afterCrash); // 租约内的重启不动它
    await rm(outDir, { recursive: true, force: true });
  }
  console.info(JSON.stringify({ 场景: 'M06 真实进程崩溃点矩阵', 证据类型: 'PG17 临时集群，非线上版本；node 子进程 SIGKILL', matrix }));
}, 180_000);
