import { expect, it, vi } from 'vitest';
import { ACCESS_POLICY_KEY, authorize, updateAccessPolicy } from '../../src/role-eval/access-policy.js';
import { ACCESS_DENIED, DENIED, STALE_CONSUMER } from '../../src/role-eval/employee-loop.js';
import { confirmEntryId, type PerformanceStore } from '../../src/role-eval/performance-store.js';
import { createWecomBotHandler } from '../../src/role-eval/wecom-bot-unified-handler.js';
import { createNotificationDispatcher, requeueUnknownNotification, NOTIFICATION_AUDIT_PREFIX } from '../../src/role-eval/notification-dispatch.js';
import { decodeStatus, encodeStatus, STATUS_PATTERN } from '../../src/role-eval/notification-status.js';
import { MIGRATION_008_SQL, migrateUp } from '../../src/role-eval/schema-migrations.js';
import { CONSUMER_LEASE_KEY } from '../../src/opendot/consumer-lease.js';
import { openSql } from '../../src/migration/pg.js';
import { NOW, basePeople, baseMembers, policy, world } from '../role-eval/access-fixture-m03.js';
import { worldM05, registerUnnamedAppointment} from '../role-eval/appointment-fixture-m05.js';
import { fakeSender } from '../role-eval/notify-fixture-m06.js';
import { freshDatabase, openLatest as open, rawClient, rawQuery, useCluster } from '../migration/pg-harness-m08.js';

// R1 两个出口的真实 PG 证据（PG17.11 用户态临时集群，非线上版本；全部合成数据）。
useCluster();
const at = NOW.toISOString();
const SHEET = (amount: number) => `12号测试B店\n${amount}（小赵）`;
const zhao = basePeople.find(p => p.personId === 'p-zhao')!;
const wangYj = basePeople.find(p => p.personId === 'p-wang-yj')!;
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
const entriesOf = async (url: string, draftId: string) => (await rawQuery(url, `SELECT entry_id FROM front_claw_perf.performance_entries WHERE entry_id=$1`, [confirmEntryId(draftId, 0)])).length;

// ───────────── 出口 (a)：入账门 ─────────────
it('R1-PG-a1（M03-P0-2/3 先后）：被代报人行被另一事务锁住并停用/调店，确认在入账门 FOR SHARE 上等待 → 对方提交后拒绝、零入账、草稿退回', async () => {
  for (const change of ['deactivate', 'move'] as const) {
    const url = await freshDatabase(); const db = await open(url);
    const w = await world({ store: db.store });
    expect(await w.call('m-wang-yj', SHEET(560))).toContain('代报');
    const draftId = (await db.store.listDrafts({ status: 'pending' }))[0]!.draftId;
    const admin = await rawClient(url);
    await admin.query('BEGIN');
    await admin.query(`SELECT * FROM front_claw_perf.performance_people WHERE person_id='p-zhao' FOR UPDATE`);
    const confirming = w.call('m-wang-yj', '对');
    await waitForLockWait(url, '%performance_people%FOR SHARE%');
    await admin.query(change === 'deactivate' ? `UPDATE front_claw_perf.performance_people SET active=false WHERE person_id='p-zhao'`
      : `UPDATE front_claw_perf.performance_people SET store_id='s-a', store_name='测试A店' WHERE person_id='p-zhao'`);
    await admin.query('COMMIT'); await admin.end();
    expect(await confirming, change).toBe(ACCESS_DENIED);
    expect(await entriesOf(url, draftId), change).toBe(0);
    expect((await db.store.getDraft(draftId))!.status, change).toBe('pending');
    await db.close();
  }
}, 60_000);

it('R1-PG-a2（竞态）：确认与“被代报人停用”在两个独立连接池上同时发起 20 轮——要么入账 1 笔，要么拒绝且零入账、草稿待确认', async () => {
  const url = await freshDatabase(); const db = await open(url); const admin = await open(url);
  const w = await world({ store: db.store });
  // 拒绝有两种来源：确认前的同店在职预检（DENIED），或提交事务内入账门（ACCESS_DENIED，停用发生在预检之后）。
  const tally = { committed: 0, deniedPrecheck: 0, deniedGate: 0 };
  for (let round = 0; round < 20; round++) {
    await admin.store.savePerson({ ...zhao, active: true });
    expect(await w.call('m-wang-yj', SHEET(100 + round))).toContain('代报');
    const draft = (await db.store.listDrafts({ status: 'pending' }))[0]!;
    const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
    const offset = (round % 10) * 2;
    const [reply] = await Promise.all([
      (round % 2 ? delay(offset) : Promise.resolve()).then(() => w.call('m-wang-yj', '对')),
      (round % 2 ? Promise.resolve() : delay(offset)).then(() => admin.store.savePerson({ ...zhao, active: false })),
    ]);
    const n = await entriesOf(url, draft.draftId);
    const status = (await db.store.getDraft(draft.draftId))!.status;
    if (reply.includes('已入账')) { tally.committed++; expect(n).toBe(1); expect(status).toBe('confirmed'); }
    else {
      if (reply === ACCESS_DENIED) tally.deniedGate++; else { expect(reply).toBe(DENIED); tally.deniedPrecheck++; }
      expect(n).toBe(0); expect(status).toBe('pending');
      await admin.store.savePerson({ ...zhao, active: true });
      expect(await w.call('m-wang-yj', '取消')).toContain('取消');
    }
  }
  console.info(JSON.stringify({ 场景: 'R1 出口a 确认/停用竞态', 证据类型: 'PG17 临时集群，非线上版本', ...tally }));
  expect(tally.committed + tally.deniedPrecheck + tally.deniedGate).toBe(20);
  expect(tally.committed).toBeGreaterThan(0); expect(tally.deniedPrecheck + tally.deniedGate).toBeGreaterThan(0);
  await db.close(); await admin.close();
}, 90_000);

it('R1-PG-a3（M03-P0-1 回滚）：绕过接口把策略原文改回旧版本（高水位已前进）→ 读侧判 stale_policy，入账拒绝、零入账', async () => {
  const url = await freshDatabase(); const db = await open(url);
  const w = await world({ store: db.store });
  const revoked = policy(2, { ...baseMembers(), 'p-wang-yj': { role: 'manager', storeIds: ['s-b'], status: 'revoked' } });
  expect(await updateAccessPolicy(db.store, { expectedVersion: 1, next: revoked, actor: 'r1', reason: '撤权', at })).toEqual({ ok: true, version: 2 });
  await expect(db.store.setConfig(ACCESS_POLICY_KEY, JSON.stringify(policy(1)))).rejects.toThrow('protected_config_key');
  await rawQuery(url, `UPDATE front_claw_perf.performance_config SET value=$1 WHERE key=$2`, [JSON.stringify(policy(1)), ACCESS_POLICY_KEY]);
  expect(await authorize(db.store, wangYj, 'report_proxy', 's-b')).toMatchObject({ allowed: false, reason: 'stale_policy' });
  expect(await w.call('m-wang-yj', SHEET(560))).toBe(ACCESS_DENIED);
  expect(await rawQuery(url, `SELECT entry_id FROM front_claw_perf.performance_entries WHERE amount=560`)).toEqual([]);
  // 版本不递增的写入直接拒绝（≤ 高水位）。
  expect(await updateAccessPolicy(db.store, { expectedVersion: 1, next: policy(2), actor: 'r1', reason: 'replay', at })).toEqual({ ok: false, reason: 'version_not_increasing' });
  await db.close();
}, 30_000);

it('R1-PG-a4（M07-P1-1 fencing 先后）：确认带租约 fence；接管事务先锁租约行并把 epoch+1，确认在 FOR SHARE 上等待 → 接管提交后拒绝、零入账；fence 一致时照常入账', async () => {
  const url = await freshDatabase(); const db = await open(url);
  await world({ store: db.store });
  await db.store.updateConfigLocked(CONSUMER_LEASE_KEY, [], () => ({ [CONSUMER_LEASE_KEY]: JSON.stringify({ owner: 'A', token: 'ta', until: NOW.getTime() + 30_000, epoch: 1 }) }));
  const handler = createWecomBotHandler({ legacyEntry: true, mode: 'isolated-synthetic', store: db.store, now: () => NOW, resolve: id => db.store.getPersonByMember(id),
    send: vi.fn(async () => 'sent' as const), model: { complete: vi.fn(async () => ({ type: 'chat' as const, text: 'x' })) }, employeeLoop: true, accessPolicy: true });
  const fence = { key: CONSUMER_LEASE_KEY, owner: 'A', epoch: 1 };
  let seq = 0;
  const call = async (text: string) => (await handler.handleMessage({ memberId: 'm-wang-yj', text, messageId: `f-${++seq}`, sessionId: 's-f', bindingVersion: 1, fence })).replies.join('\n');
  expect(await call(SHEET(561))).toContain('代报');
  const first = (await db.store.listDrafts({ status: 'pending' }))[0]!.draftId;
  expect(await call('对')).toContain('已入账');
  expect(await entriesOf(url, first)).toBe(1);
  expect(await call(SHEET(562))).toContain('代报');
  const draftId = (await db.store.listDrafts({ status: 'pending' }))[0]!.draftId;
  const takeover = await rawClient(url);
  await takeover.query('BEGIN');
  await takeover.query(`SELECT * FROM front_claw_perf.performance_config WHERE key=$1 FOR UPDATE`, [CONSUMER_LEASE_KEY]);
  const confirming = call('对');
  await waitForLockWait(url, '%performance_config%FOR SHARE%');
  await takeover.query(`UPDATE front_claw_perf.performance_config SET value=$1 WHERE key=$2`, [JSON.stringify({ owner: 'B', token: 'tb', until: NOW.getTime() + 30_000, epoch: 2 }), CONSUMER_LEASE_KEY]);
  await takeover.query('COMMIT'); await takeover.end();
  // R3（A-P1-1）：fence 现在在 pending→confirming 这一步（统一入口，FOR SHARE 等待）就挡住，草稿不动、零入账。
  expect(await confirming).toBe(STALE_CONSUMER);
  expect(await entriesOf(url, draftId)).toBe(0);
  expect((await db.store.getDraft(draftId))!.status).toBe('pending');
  await db.close();
}, 30_000);

// ───────────── 出口 (b)：提醒发送前 ─────────────
it('R1-PG-b1（M06-P0-1 先后）：收件人行被另一事务锁住并停用，派发在 beginNotificationSend 的 FOR SHARE 上等待 → 提交后不上线、not_sent', async () => {
  const url = await freshDatabase(); const db = await open(url);
  const w = await worldM05({ store: db.store });
  expect(await registerUnnamedAppointment(w, 'm-zhao', '明天下午3点有个客人要来')).toContain('预约还没登记');
  expect(await w.call('m-zhao', '对')).toContain('预约已登记');
  const admin = await rawClient(url);
  await admin.query('BEGIN');
  await admin.query(`SELECT * FROM front_claw_perf.performance_people WHERE person_id='p-wang-yj' FOR UPDATE`);
  const f = fakeSender();
  const ticking = createNotificationDispatcher({ store: db.store, sender: f.sender, now: () => NOW, worker: 'w1', leaseMs: 60_000 }).tick();
  await waitForLockWait(url, '%performance_people%FOR SHARE%');
  await admin.query(`UPDATE front_claw_perf.performance_people SET active=false WHERE person_id='p-wang-yj'`);
  await admin.query('COMMIT'); await admin.end();
  expect(await ticking).toMatchObject({ sent: 0, refused: 1 });
  expect(f.wire).toEqual([]);
  const status = (await rawQuery(url, `SELECT status FROM front_claw_perf.performance_notifications WHERE kind='appointment'`))[0]!.status as string;
  expect(status).toMatch(/^not_sent\|.*err=recipient_/);
  await db.close();
}, 30_000);

it('R1-PG-b2（M06-P1-1）：领取后租约过期（无人重领）→ 结果写不进；被他人重领（fence+1）→ 旧领取者结果写不进', async () => {
  const url = await freshDatabase(); const db = await open(url);
  const w = await worldM05({ store: db.store });
  expect(await registerUnnamedAppointment(w, 'm-zhao', '明天下午3点有个客人要来')).toContain('预约还没登记');
  expect(await w.call('m-zhao', '对')).toContain('预约已登记');
  const iso = (ms: number) => new Date(NOW.getTime() + ms).toISOString();
  const first = await db.store.claimDueNotifications({ nowIso: iso(0), leaseUntil: iso(60_000), limit: 5, kinds: ['appointment'], worker: 'w1', tokenFor: () => 'tok1' });
  const row = first.claimed[0]!; const raw = row.delivery!.raw; const meta = decodeStatus(raw).delivery;
  expect(meta.fence).toBe(1);
  const sent = encodeStatus('sent', { attempts: 1, resends: 0, fence: meta.fence });
  // 租约已过（应用时钟 +61s），无人重领：fence 一致但到期 → 拒绝。
  expect(await db.store.transitionNotification(row.notificationId, raw, sent, iso(61_000), { epoch: meta.fence, nowIso: iso(61_000) })).toBe(false);
  // 另一派发者重领：fence → 2；旧领取者即使在“自己的时钟”上未到期也写不进。
  const second = await db.store.claimDueNotifications({ nowIso: iso(61_000), leaseUntil: iso(121_000), limit: 5, kinds: ['appointment'], worker: 'w2', tokenFor: () => 'tok2' });
  expect(second.claimed.map(r => decodeStatus(r.delivery!.raw).delivery.fence)).toEqual([2]);
  expect(await db.store.transitionNotification(row.notificationId, raw, sent, iso(10_000), { epoch: 1, nowIso: iso(10_000) })).toBe(false);
  const col = (await rawQuery(url, `SELECT status FROM front_claw_perf.performance_notifications WHERE notification_id=$1`, [row.notificationId]))[0]!.status as string;
  expect(col).toContain('|by=w2');
  await db.close();
}, 30_000);

it('R1-PG-b3（M06-P1-4）：两个连接池同时人工补发同一条 unknown，10 轮——恰一个 requeued，审计只记真正执行者', async () => {
  const url = await freshDatabase(); const db = await open(url); const other = await open(url);
  const w = await worldM05({ store: db.store });
  for (let round = 0; round < 10; round++) {
    expect(await registerUnnamedAppointment(w, 'm-zhao', `明天下午4点${String(round).padStart(2, '0')}分有个客人要来`)).toContain('预约还没登记');
    expect(await w.call('m-zhao', '对')).toContain('预约已登记');
  }
  const ids = (await rawQuery(url, `SELECT notification_id FROM front_claw_perf.performance_notifications WHERE kind='appointment' ORDER BY notification_id`)).map(r => String(r.notification_id));
  expect(ids).toHaveLength(10);
  for (const id of ids) await rawQuery(url, `UPDATE front_claw_perf.performance_notifications SET status='unknown|-|-|a=1|r=0|err=sdk_timeout' WHERE notification_id=$1`, [id]);
  for (const id of ids) {
    const results = await Promise.all([
      requeueUnknownNotification(db.store, id, { actor: 'operator-A', reason: '确认未送达', now: NOW }),
      requeueUnknownNotification(other.store, id, { actor: 'operator-B', reason: '确认未送达', now: NOW }),
    ]);
    expect([...results].sort()).toEqual(['not_unknown', 'requeued']);
    const winner = results[0] === 'requeued' ? 'operator-A' : 'operator-B';
    const audits = await rawQuery(url, `SELECT key, value FROM front_claw_perf.performance_config WHERE key LIKE $1`, [`${NOTIFICATION_AUDIT_PREFIX}${id}:%`]);
    expect(audits).toHaveLength(1);
    expect(JSON.parse(String(audits[0]!.value)).actor).toBe(winner);
  }
  await db.close(); await other.close();
}, 60_000);

it('R1-PG-b4（M06-P1-3）：008 触发器与 TS 用同一严格文法；v8 库上畸形写入被拒、合法写入带出 delivery_fence', async () => {
  expect(MIGRATION_008_SQL).toContain(`$re$${STATUS_PATTERN}$re$`);
  const url = await freshDatabase(); const db = await open(url);
  const sql = await openSql(url); await migrateUp(sql.client, { apply: true }); await sql.close();
  const insert = (id: string, status: string) => rawQuery(url, `INSERT INTO front_claw_perf.performance_notifications (notification_id, kind, recipient_person_id, body, status, related_id, created_at, sent_at) VALUES ($1,'reminder','p','b',$2,'r','2026-11-12T00:00:00.000Z',NULL)`, [id, status]);
  await expect(insert('bad-1', 'pending|2026-02-30T00:00:00.000Z|queued|a=1|r=0')).rejects.toThrow(/invalid_delivery_status/);
  await expect(insert('bad-2', 'sent|-|-|a=Infinity|r=0')).rejects.toThrow(/invalid_delivery_status/);
  await expect(insert('bad-3', 'pending|2026-11-12T00:00:00.000Z|claimed|a=0|r=0|f=1')).rejects.toThrow(/invalid_delivery_status/);
  await insert('ok-1', 'pending|2026-11-12T00:00:00.000Z|claimed|a=0|r=0|f=7|tok=t|by=w');
  expect((await rawQuery(url, `SELECT delivery_fence::int AS f, delivery_lease_owner AS o FROM front_claw_perf.performance_notifications WHERE notification_id='ok-1'`))[0]).toEqual({ f: 7, o: 'w' });
  await db.close();
}, 30_000);

it('R1-PG-c1（M03-P1-3）：空库 6 个连接池同时首写策略，10 轮每轮恰一个成功', async () => {
  for (let round = 0; round < 10; round++) {
    const url = await freshDatabase();
    const pools = await Promise.all([0, 1, 2, 3, 4, 5].map(() => open(url)));
    const results = await Promise.all(pools.map((p, i) => updateAccessPolicy(p.store as PerformanceStore, { expectedVersion: null, next: policy(1 + i), actor: `a${i}`, reason: 'init', at })));
    expect(results.filter(r => r.ok)).toHaveLength(1);
    for (const p of pools) await p.close();
  }
}, 120_000);
