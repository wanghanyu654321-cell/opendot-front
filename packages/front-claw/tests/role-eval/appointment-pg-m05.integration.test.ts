import { startPgCluster, PG_START_HOOK_TIMEOUT_MS, PG_STOP_HOOK_TIMEOUT_MS } from '../helpers/pg-cluster.js';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Client } from 'pg';
import { FRONT_CLAW_DATABASE_URL, openPerformanceStore } from '../../src/role-eval/performance-open.js';
import { createWecomBotHandler } from '../../src/role-eval/wecom-bot-unified-handler.js';
import { ACCESS_POLICY_KEY, updateAccessPolicy } from '../../src/role-eval/access-policy.js';
import { ACCESS_DENIED, POLICY_CHANGED } from '../../src/role-eval/employee-loop.js';
import type { PerformanceStore } from '../../src/role-eval/performance-store.js';
import { NOW } from './access-fixture-m03.js';
import { membersM05, policyM05, worldM05, registerUnnamedAppointment} from './appointment-fixture-m05.js';

// M05 真实 PostgreSQL 临时集群（自建自删，随机端口，不连常驻库）。程序目录同 performance-postgres.integration.test.ts：
// FRONT_CLAW_PG_BIN 可覆盖，默认 /usr/lib/postgresql/16/bin。本机实测用 PG17 用户态程序，非线上版本。

let cluster: { base: string; stop(): Promise<void> };
let dbSeq = 0;
beforeAll(async () => {
  cluster = await startPgCluster();
}, PG_START_HOOK_TIMEOUT_MS);
afterAll(async () => { await cluster?.stop(); }, PG_STOP_HOOK_TIMEOUT_MS);

/** 每个用例一个新库，互不影响。 */
async function freshDatabase(): Promise<string> {
  const name = `m05_case_${++dbSeq}`;
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
/** 同一库上第二个独立连接池的 handler（模拟另一进程/另一会话）。 */
function handlerOn(store: PerformanceStore, sessionId?: string) {
  const h = createWecomBotHandler({ legacyEntry: true, mode: 'isolated-synthetic', store, now: () => NOW, resolve: id => store.getPersonByMember(id),
    send: async () => { throw Error('M05 不发送'); }, model: { complete: async () => { throw Error('不应调用模型'); } }, employeeLoop: true, accessPolicy: true });
  let seq = 0;
  return (memberId: string, text: string, messageId = `p2-${++seq}`) => h.handleMessage({ memberId, text, messageId, sessionId: sessionId ?? `session-${memberId}`, bindingVersion: 1 }).then(r => r.replies.join('\n'));
}
const zhaoWith = (version: number, status: 'active' | 'revoked') => policyM05(version, { ...membersM05(), 'p-zhao': { role: 'employee', storeIds: ['s-b'], status } });
const managerWith = (version: number, status: 'active' | 'suspended') => policyM05(version, { ...membersM05(), 'p-wang-yj': { role: 'manager', storeIds: ['s-b'], status } });
const appts = (url: string) => count(url, `SELECT count(*)::int AS n FROM front_claw_perf.performance_appointments`);
const reminders = (url: string) => count(url, `SELECT count(*)::int AS n FROM front_claw_perf.performance_notifications WHERE kind='appointment'`);
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
/** 每轮不同的预约时间（明天 10:00 起每轮 +1 小时内的分钟），内容不同 → 预约号不同。 */
const say = (round: number) => `明天下午3点${String(round).padStart(2, '0')}分王姐要来`;

it('真实PG：同一条「对」在两个连接池上同时确认 10 轮 → 每轮预约恰 1 条、待发提醒恰 1 条', async () => {
  const url = await freshDatabase(); const db = await open(url); const other = await open(url);
  const w = await worldM05({ store: db.store });
  const second = handlerOn(other.store);
  for (let round = 0; round < 10; round++) {
    expect(await w.call('m-zhao', say(round))).toContain('预约还没登记');
    const replies = await Promise.all([w.call('m-zhao', '对', `same-${round}`), second('m-zhao', '对', `same-${round}`)]);
    expect(replies.some(reply => reply.includes('预约已登记'))).toBe(true);
    for (const reply of replies) expect(reply).toMatch(/预约已登记|结果未知|草稿版本已变化/);
    expect(await appts(url)).toBe(round + 1); expect(await reminders(url)).toBe(round + 1);
  }
  await db.close(); await other.close();
}, 60_000);

it('真实PG：两个会话各起一张同内容草稿，在两个连接池上同时确认 10 轮 → 主键去重，恰一份登记、另一份作废（duplicate），提醒恰 1 条', async () => {
  const url = await freshDatabase(); const db = await open(url); const other = await open(url);
  await worldM05({ store: db.store });
  const tally = { first: 0, second: 0 };
  for (let round = 0; round < 10; round++) {
    const a = handlerOn(db.store, `sa-${round}`), b = handlerOn(other.store, `sb-${round}`);
    expect(await a('m-zhao', say(round))).toContain('预约还没登记');
    expect(await b('m-zhao', say(round))).toContain('预约还没登记');
    const [ra, rb] = await Promise.all([a('m-zhao', '对'), b('m-zhao', '对')]);
    const won = [ra, rb].filter(reply => reply.includes('预约已登记'));
    expect(won).toHaveLength(1);
    expect([ra, rb].filter(reply => reply.includes('同样的预约已经登记过'))).toHaveLength(1);
    if (ra.includes('预约已登记')) tally.first++; else tally.second++;
    expect(await appts(url)).toBe(round + 1); expect(await reminders(url)).toBe(round + 1);
  }
  console.info(JSON.stringify({ 场景: 'M05 同内容两草稿并发', 证据类型: 'PG17 临时集群，非线上版本', ...tally }));
  await db.close(); await other.close();
}, 60_000);

it('真实PG先后：撤权事务先持策略行 FOR UPDATE，确认因 NOWAIT 安全回滚零写入 → 撤权提交后再确认拒绝', async () => {
  const url = await freshDatabase(); const db = await open(url);
  const w = await worldM05({ store: db.store });
  await registerUnnamedAppointment(w, 'm-zhao', '明天三点有个客人要来');
  const admin = await rawClient(url);
  try {
    await admin.query('BEGIN');
    await admin.query(`SELECT * FROM front_claw_perf.performance_config WHERE key=$1 FOR UPDATE`, [ACCESS_POLICY_KEY]);
    expect(await w.call('m-zhao', '对')).toBe('Front Claw：本次提交因争用已回滚，请查原操作结果；不要另报一笔。');
    expect(await appts(url)).toBe(0); expect(await reminders(url)).toBe(0);
    expect((await db.store.listDrafts({ kind: 'appointment' }))[0]!.status).toBe('confirming');
    await admin.query(`UPDATE front_claw_perf.performance_config SET value=$1 WHERE key=$2`, [JSON.stringify(zhaoWith(2, 'revoked')), ACCESS_POLICY_KEY]);
    await admin.query('COMMIT');
    expect(await w.call('m-zhao', '对')).toBe(ACCESS_DENIED);
    expect(await appts(url)).toBe(0); expect(await reminders(url)).toBe(0);
    expect((await db.store.listDrafts({ kind: 'appointment' }))[0]!.status).toBe('confirming');
  } finally {
    await admin.query('ROLLBACK').catch(() => {});
    await admin.end().catch(() => {});
    await db.close();
  }
}, 30_000);

it('真实PG先后：撤权事务先持策略行 FOR UPDATE 并停用指定店长，确认因 NOWAIT 安全回滚 → 提交后再确认按新策略不排提醒', async () => {
  const url = await freshDatabase(); const db = await open(url);
  const w = await worldM05({ store: db.store });
  expect(await registerUnnamedAppointment(w, 'm-zhao', '明天三点有个客人要来')).toContain('苏晓禾');
  const admin = await rawClient(url);
  try {
    await admin.query('BEGIN');
    await admin.query(`SELECT * FROM front_claw_perf.performance_config WHERE key=$1 FOR UPDATE`, [ACCESS_POLICY_KEY]);
    expect(await w.call('m-zhao', '对', 'mgr-lock')).toBe('Front Claw：本次提交因争用已回滚，请查原操作结果；不要另报一笔。');
    expect(await appts(url)).toBe(0); expect(await reminders(url)).toBe(0);
    await admin.query(`UPDATE front_claw_perf.performance_config SET value=$1 WHERE key=$2`, [JSON.stringify(managerWith(2, 'suspended')), ACCESS_POLICY_KEY]);
    await admin.query('COMMIT');
    const reply = await w.call('m-zhao', '对', 'mgr-lock-2');
    expect(reply).toContain('预约已登记'); expect(reply).not.toContain('已排队提醒');
    expect(await appts(url)).toBe(1); expect(await reminders(url)).toBe(0);
    const final = await w.call('m-zhao', '入账结果 mgr-lock');
    expect(final).toContain('预约已登记'); expect(final).not.toContain('已排队提醒');
  } finally {
    await admin.query('ROLLBACK').catch(() => {});
    await admin.end().catch(() => {});
    await db.close();
  }
}, 30_000);

it('真实PG竞态：确认与撤权（登记人）在两个独立连接池上同时发起 20 轮——要么登记且提醒 1 条，要么拒绝、零写、草稿待确认', async () => {
  const url = await freshDatabase(); const db = await open(url); const admin = await open(url);
  const w = await worldM05({ store: db.store });
  const tally = { registered: 0, denied: 0 };
  let version = 1;
  const set = async (status: 'active' | 'revoked') => { const r = await updateAccessPolicy(admin.store, { expectedVersion: version, next: zhaoWith(version + 1, status), actor: 'test-admin', reason: status, at }); expect(r).toEqual({ ok: true, version: version + 1 }); version++; };
  for (let round = 0; round < 20; round++) {
    if (round > 0) await set('active');
    const before = { a: await appts(url), n: await reminders(url) };
    expect(await w.call('m-zhao', say(round))).toContain('预约还没登记');
    const offset = (round % 10) * 2;
    const [reply] = await Promise.all([
      (round % 2 ? delay(offset) : Promise.resolve()).then(() => w.call('m-zhao', '对')),
      (round % 2 ? Promise.resolve() : delay(offset)).then(() => set('revoked')),
    ]);
    if (reply.includes('预约已登记')) { tally.registered++; expect(await appts(url)).toBe(before.a + 1); expect(await reminders(url)).toBe(before.n + 1); }
    else {
      tally.denied++; expect([ACCESS_DENIED, 'Front Claw：本次提交因争用已回滚，请查原操作结果；不要另报一笔。']).toContain(reply);
      expect(await appts(url)).toBe(before.a); expect(await reminders(url)).toBe(before.n);
      expect((await db.store.listDrafts({ kind: 'appointment' })).filter(d => d.status === 'pending' || d.status === 'confirming')).toHaveLength(1);
      await set('active'); expect(await w.call('m-zhao', '取消')).toContain('已取消');
    }
  }
  console.info(JSON.stringify({ 场景: 'M05 登记/撤权竞态', 证据类型: 'PG17 临时集群，非线上版本', ...tally }));
  expect(tally.registered + tally.denied).toBe(20);
  expect(tally.registered).toBeGreaterThan(0); expect(tally.denied).toBeGreaterThan(0);
  await db.close(); await admin.close();
}, 90_000);

it('真实PG竞态：确认与“指定店长被停用”同时发起 20 轮——预约每轮都成立；提醒 0 或 1 条且与最终回复一致，绝不回滚预约', async () => {
  const url = await freshDatabase(); const db = await open(url); const admin = await open(url);
  const w = await worldM05({ store: db.store });
  const tally = { queued: 0, notQueued: 0, policyChanged: 0 };
  let version = 1;
  const set = async (status: 'active' | 'suspended') => { const r = await updateAccessPolicy(admin.store, { expectedVersion: version, next: managerWith(version + 1, status), actor: 'test-admin', reason: status, at }); expect(r).toEqual({ ok: true, version: version + 1 }); version++; };
  for (let round = 0; round < 20; round++) {
    if (round > 0) await set('active');
    const before = { a: await appts(url), n: await reminders(url) };
    await w.call('m-zhao', say(round));
    const offset = (round % 10) * 2;
    const [first] = await Promise.all([
      (round % 2 ? delay(offset) : Promise.resolve()).then(() => w.call('m-zhao', '对', `rc-${round}`)),
      (round % 2 ? Promise.resolve() : delay(offset)).then(() => set('suspended')),
    ]);
    // R2（D77）：预检后策略版本变了 → 本次不登记（POLICY_CHANGED，零写），按新策略再确认一次必登记；预约绝不回滚。
    let id = `rc-${round}`;
    if (first === POLICY_CHANGED || first.includes('争用已回滚')) {
      tally.policyChanged++;
      expect(await appts(url)).toBe(before.a); expect(await reminders(url)).toBe(before.n);
      if (first === POLICY_CHANGED) id = `rc-${round}-b`;
      expect(await w.call('m-zhao', '对', `rc-${round}-b`)).toContain('预约已登记');
    }
    expect(await appts(url), `round ${round}: ${first}`).toBe(before.a + 1);
    const added = await reminders(url) - before.n;
    const final = await w.call('m-zhao', `入账结果 ${id}`);
    expect(final).toContain('预约已登记');
    if (added === 1) { tally.queued++; expect(final).toContain('已排队提醒'); }
    else { tally.notQueued++; expect(added).toBe(0); expect(final).not.toContain('已排队提醒'); }
  }
  console.info(JSON.stringify({ 场景: 'M05 登记/收件人停用竞态', 证据类型: 'PG17 临时集群，非线上版本', ...tally }));
  expect(tally.queued + tally.notQueued).toBe(20);
  await db.close(); await admin.close();
}, 90_000);

it('真实PG：写待发提醒失败（测试库触发器）→ 预约同事务回滚、回“结果未知”；去掉故障后新进程用原确认续跑只登记一次', async () => {
  const url = await freshDatabase(); const db = await open(url);
  const w = await worldM05({ store: db.store });
  await registerUnnamedAppointment(w, 'm-zhao', '明天三点有个客人要来');
  const admin = await rawClient(url);
  await admin.query(`CREATE FUNCTION front_claw_perf.m05_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected'; END $$`);
  await admin.query(`CREATE TRIGGER m05_fail BEFORE INSERT ON front_claw_perf.performance_notifications FOR EACH ROW EXECUTE FUNCTION front_claw_perf.m05_fail()`);
  const broken = await w.call('m-zhao', '对', 'confirm-x');
  expect(broken).toContain('结果未知'); expect(broken).not.toContain('已登记');
  expect(await appts(url)).toBe(0); expect(await reminders(url)).toBe(0);
  await admin.query(`DROP TRIGGER m05_fail ON front_claw_perf.performance_notifications`); await admin.end();
  const reopened = await open(url);
  const after = handlerOn(reopened.store);
  expect(await after('m-zhao', '对', 'confirm-x')).toContain('预约已登记');
  expect(await after('m-zhao', '对', 'confirm-x')).toContain('预约已登记');
  expect(await appts(url)).toBe(1); expect(await reminders(url)).toBe(1);
  await db.close(); await reopened.close();
});

it('真实PG重启：预约草稿跨进程保留，重启前后无幽灵预约；确认中崩溃后用原确认续跑只登记一次', async () => {
  const url = await freshDatabase(); const db = await open(url);
  const w = await worldM05({ store: db.store });
  await w.call('m-zhao', '后天下午两点王姐来做护理');
  await db.close();
  const reopened = await open(url);
  const after = handlerOn(reopened.store);
  expect(await appts(url)).toBe(0);
  const draft = (await reopened.store.listDrafts({ kind: 'appointment', status: 'pending' }))[0]!;
  const payload = { ...draft.payload, employeeContext: { ...(draft.payload as { employeeContext: object }).employeeContext, actionMessageId: 'lost-confirm', actionFingerprint: (await import('node:crypto')).createHash('sha256').update(JSON.stringify(['对'])).digest('hex') } };
  expect(await reopened.store.transitionPendingDraft(draft, { ...draft, status: 'confirming', payload } as typeof draft)).toBe(true);
  expect(await after('m-zhao', '对', 'lost-confirm')).toContain('预约已登记');
  expect(await after('m-zhao', '对', 'lost-confirm')).toContain('预约已登记');
  expect(await appts(url)).toBe(1); expect(await reminders(url)).toBe(1);
  await reopened.close();
});

it('真实PG：默认宿主写入逐消息审计，关闭再开仍可查询', async () => {
  const { createHash } = await import('node:crypto');
  const { bootFrontClaw } = await import('../../src/role-eval/front-claw-boot.js');
  const url = await freshDatabase();
  const setup = await open(url);
  const w = await worldM05({ store: setup.store });
  await setup.close();
  const boot = await bootFrontClaw({ env: { [FRONT_CLAW_DATABASE_URL]: url },
    employeeLoop: true, accessPolicy: true, model: { complete: w.model }, send: w.send, now: () => NOW });
  const id = 'synthetic-audit-reopen';
  try {
    const r = await boot.handler.handleMessage({ memberId: 'm-wang-yj', text: 's-b本月全店业绩汇总是多少？',
      sessionId: 'session-audit', bindingVersion: 1, messageId: id });
    expect(r.replies.join('')).toContain('本月 1000');
  } finally { await boot.close(); }
  const reader = await open(url);
  try {
    const raw = await reader.store.getConfig('business-audit:v1:' + createHash('sha256').update(JSON.stringify(['m-wang-yj', 'session-audit', 1, id])).digest('hex'));
    expect(JSON.parse(raw!)).toMatchObject({ actor: { personId: 'p-wang-yj', role: 'manager' },
      policyVersion: 1, targetStoreId: 's-b', readStoreIds: ['s-b'], writes: [], outcome: 'read' });
  } finally { await reader.close(); }
});
