import { afterEach, expect, it } from 'vitest';
import pg from 'pg';
import { updateAccessPolicy } from '../../src/role-eval/access-policy.js';
import { ACCESS_DENIED, POLICY_CHANGED } from '../../src/role-eval/employee-loop.js';
import { confirmEntryId, type CommitGuard, type Draft } from '../../src/role-eval/performance-store.js';
import { createPostgresPerformanceStore, type SqlClient } from '../../src/role-eval/performance-postgres.js';
import { createNotificationDispatcher } from '../../src/role-eval/notification-dispatch.js';
import { decodeStatus, encodeStatus } from '../../src/role-eval/notification-status.js';
import { gate, installPausePoints } from '../../src/role-eval/pause-points.js';
import { CONSUMER_LEASE_KEY } from '../../src/opendot/consumer-lease.js';
import { NOW, basePeople, baseMembers, policy, world } from '../role-eval/access-fixture-m03.js';
import { membersM05, policyM05, worldM05, registerUnnamedAppointment} from '../role-eval/appointment-fixture-m05.js';
import { fakeSender } from '../role-eval/notify-fixture-m06.js';
import { freshDatabase, openLatest as open, rawQuery, useCluster } from '../migration/pg-harness-m08.js';

// R2（补充1/2）：暂停点驱动的确定性竞态（PG17 用户态临时集群，非线上版本；全部合成数据）。
// 第一个连接池停在“读完数据之后、提交之前”，第二个独立连接池插入变更，再放行第一个。
useCluster();
let uninstall: (() => void) | null = null;
afterEach(() => { uninstall?.(); uninstall = null; });
const at = NOW.toISOString();
const SHEET = (amount: number) => `12号测试B店\n${amount}（小赵）`;
const zhao = basePeople.find(p => p.personId === 'p-zhao')!;
const wangYj = basePeople.find(p => p.personId === 'p-wang-yj')!;
const entriesOf = async (url: string, draftId: string) => (await rawQuery(url, `SELECT entry_id FROM front_claw_perf.performance_entries WHERE entry_id=$1`, [confirmEntryId(draftId, 0)])).length;

type Change = 'revoke' | 'deactivate_actor' | 'deactivate_target' | 'move_target' | 'bump_version';
const CHANGES: Change[] = ['revoke', 'deactivate_actor', 'deactivate_target', 'move_target', 'bump_version'];

it('R2-PG-p1（入账门暂停点）：A 停在提交前，B 撤权/停用提交人/停用被代报人/调店/提升策略版本 → A 被门拒绝、零入账、草稿退回；恢复后再确认恰好入账一次', async () => {
  for (const change of CHANGES) {
    const url = await freshDatabase(); const db = await open(url); const admin = await open(url);
    const w = await world({ store: db.store });
    expect(await w.call('m-wang-yj', SHEET(560)), change).toContain('代报');
    const draftId = (await db.store.listDrafts({ status: 'pending' }))[0]!.draftId;
    const g = gate();
    uninstall = installPausePoints({ 'commit-gate:before-commit': g.hook });
    const confirming = w.call('m-wang-yj', '对');
    expect((await g.reached).id).toBe(draftId);
    expect((await db.store.getDraft(draftId))!.status).toBe('confirming');
    // B：另一个连接池插进来。
    if (change === 'revoke') expect(await updateAccessPolicy(admin.store, { expectedVersion: 1, next: policy(2, { ...baseMembers(), 'p-wang-yj': { role: 'manager', storeIds: ['s-b'], status: 'suspended' } }), actor: 'r2', reason: '撤权', at })).toMatchObject({ ok: true });
    if (change === 'bump_version') expect(await updateAccessPolicy(admin.store, { expectedVersion: 1, next: policy(2), actor: 'r2', reason: '只提升版本', at })).toMatchObject({ ok: true });
    if (change === 'deactivate_actor') await admin.store.savePerson({ ...wangYj, active: false });
    if (change === 'deactivate_target') await admin.store.savePerson({ ...zhao, active: false });
    if (change === 'move_target') await admin.store.savePerson({ ...zhao, storeId: 's-a', storeName: '测试A店' });
    g.release();
    expect(await confirming, change).toBe(change === 'bump_version' ? POLICY_CHANGED : ACCESS_DENIED);
    expect(await entriesOf(url, draftId), change).toBe(0);
    expect((await db.store.getDraft(draftId))!.status, change).toBe('pending');
    uninstall(); uninstall = null;
    // 恢复（只为证明“只入账一次”）：撤销 B 的变更后本人重新确认。
    if (change === 'revoke') expect(await updateAccessPolicy(admin.store, { expectedVersion: 2, next: policy(3), actor: 'r2', reason: '恢复', at })).toMatchObject({ ok: true });
    if (change === 'deactivate_actor') await admin.store.savePerson(wangYj);
    if (change !== 'revoke' && change !== 'bump_version' && change !== 'deactivate_actor') await admin.store.savePerson(zhao);
    expect(await w.call('m-wang-yj', '对'), change).toContain('已入账');
    // R18 / D160：紧接着重复确认只回「这笔已经入账了，不用重复确认。」，不再入账。
    expect(await w.call('m-wang-yj', '对'), change).toBe('Front Claw：这笔已经入账了，不用重复确认。');
    expect(await entriesOf(url, draftId), change).toBe(1);
    expect((await rawQuery(url, `SELECT count(*)::int AS n FROM front_claw_perf.performance_entries WHERE amount=560`))[0]!.n, change).toBe(1);
    await db.close(); await admin.close();
  }
}, 120_000);

it('R2-PG-p1b（入账门暂停点 + M07 fence）：A 停在提交前，B 接管消费租约（epoch+1）→ A 被挡、零入账；fence 一致的再次确认恰好一笔', async () => {
  const url = await freshDatabase(); const db = await open(url); const admin = await open(url);
  await world({ store: db.store });
  const { createWecomBotHandler } = await import('../../src/role-eval/wecom-bot-unified-handler.js');
  const lease = (owner: string, epoch: number) => JSON.stringify({ owner, token: `t${owner}`, until: NOW.getTime() + 30_000, epoch });
  await db.store.updateConfigLocked(CONSUMER_LEASE_KEY, [], () => ({ [CONSUMER_LEASE_KEY]: lease('A', 1) }));
  const handler = createWecomBotHandler({ legacyEntry: true, mode: 'isolated-synthetic', store: db.store, now: () => NOW, resolve: id => db.store.getPersonByMember(id),
    send: async () => 'sent' as const, model: { complete: async () => ({ type: 'chat' as const, text: 'x' }) }, employeeLoop: true, accessPolicy: true });
  let seq = 0;
  const call = async (text: string, fence: { key: string; owner: string; epoch: number }) => (await handler.handleMessage({ memberId: 'm-wang-yj', text, messageId: `p1b-${++seq}`, sessionId: 's-p1b', bindingVersion: 1, fence })).replies.join('\n');
  expect(await call(SHEET(571), { key: CONSUMER_LEASE_KEY, owner: 'A', epoch: 1 })).toContain('代报');
  const draftId = (await db.store.listDrafts({ status: 'pending' }))[0]!.draftId;
  const g = gate();
  uninstall = installPausePoints({ 'commit-gate:before-commit': g.hook });
  const confirming = call('对', { key: CONSUMER_LEASE_KEY, owner: 'A', epoch: 1 });
  await g.reached;
  await admin.store.updateConfigLocked(CONSUMER_LEASE_KEY, [], () => ({ [CONSUMER_LEASE_KEY]: lease('B', 2) }));
  g.release();
  expect(await confirming).toBe(ACCESS_DENIED);
  expect(await entriesOf(url, draftId)).toBe(0);
  // R4：A 已不是当前持有者，补偿不得把草稿退回（以免打扰 B 的 in-replay）；可能仍是 confirming，由 B 接手。
  expect(['pending', 'confirming']).toContain((await db.store.getDraft(draftId))!.status);
  uninstall(); uninstall = null;
  expect(await call('对', { key: CONSUMER_LEASE_KEY, owner: 'B', epoch: 2 })).toContain('已入账');
  expect(await entriesOf(url, draftId)).toBe(1);
  await db.close(); await admin.close();
}, 30_000);

it('R2-PG-p2（发送门暂停点）：A 派发者预检读完后停住，B 停用收件人 / 撤收件人权限 → A 的发送门拒绝，不上线、not_sent', async () => {
  for (const change of ['deactivate', 'revoke'] as const) {
    const url = await freshDatabase(); const db = await open(url); const admin = await open(url);
    const w = await worldM05({ store: db.store });
    expect(await registerUnnamedAppointment(w, 'm-zhao', '明天下午3点有个客人要来')).toContain('预约还没登记');
    expect(await w.call('m-zhao', '对')).toContain('预约已登记');
    const g = gate();
    uninstall = installPausePoints({ 'send-gate:before-begin': g.hook });
    const f = fakeSender();
    const ticking = createNotificationDispatcher({ store: db.store, sender: f.sender, now: () => NOW, worker: 'w1', leaseMs: 60_000 }).tick();
    await g.reached;
    if (change === 'deactivate') await admin.store.savePerson({ ...wangYj, active: false });
    else expect(await updateAccessPolicy(admin.store, { expectedVersion: 1, next: policyM05(2, { ...membersM05(), 'p-wang-yj': { role: 'manager', storeIds: ['s-b'], status: 'suspended' } }), actor: 'r2', reason: '撤权', at })).toMatchObject({ ok: true });
    g.release();
    expect(await ticking, change).toMatchObject({ sent: 0, refused: 1 });
    expect(f.wire, change).toEqual([]);
    const status = (await rawQuery(url, `SELECT status FROM front_claw_perf.performance_notifications WHERE kind='appointment'`))[0]!.status as string;
    expect(status, change).toMatch(/^not_sent\|.*err=recipient_/);
    uninstall(); uninstall = null;
    await db.close(); await admin.close();
  }
}, 60_000);

it('R2-PG-p3（标记已发送暂停点 + fencing）：A 已上线、停在写回前；租约过期后 B 的派发者回收过期的发送中行（转未知）→ A 的「已发送」条件更新 0 行被挡，不覆盖 B 的结论', async () => {
  const url = await freshDatabase(); const db = await open(url); const admin = await open(url);
  const w = await worldM05({ store: db.store });
  expect(await registerUnnamedAppointment(w, 'm-zhao', '明天下午3点有个客人要来')).toContain('预约还没登记');
  expect(await w.call('m-zhao', '对')).toContain('预约已登记');
  const g = gate();
  uninstall = installPausePoints({ 'notify:before-mark': g.hook });
  const f = fakeSender();
  const ticking = createNotificationDispatcher({ store: db.store, sender: f.sender, now: () => NOW, worker: 'w1', leaseMs: 60_000 }).tick();
  await g.reached;
  expect(f.wire).toHaveLength(1);
  const before = (await rawQuery(url, `SELECT status FROM front_claw_perf.performance_notifications WHERE kind='appointment'`))[0]!.status as string;
  expect(decodeStatus(before).delivery.phase).toBe('sending');
  uninstall(); uninstall = null; // B 不经过暂停点
  const later = new Date(NOW.getTime() + 61_000);
  const b = await createNotificationDispatcher({ store: admin.store, sender: fakeSender().sender, now: () => later, worker: 'w2', leaseMs: 60_000 }).tick();
  const afterB = (await rawQuery(url, `SELECT status FROM front_claw_perf.performance_notifications WHERE kind='appointment'`))[0]!.status as string;
  expect(afterB).not.toBe(before);
  g.release();
  expect(await ticking).toMatchObject({ sent: 0, lost: 1 });
  const final = (await rawQuery(url, `SELECT status FROM front_claw_perf.performance_notifications WHERE kind='appointment'`))[0]!.status as string;
  expect(final).toBe(afterB);
  expect(final.startsWith('sent')).toBe(false);
  console.info(JSON.stringify({ 场景: 'R2 标记已发送被 fencing 挡住', B: b, before, afterB }));
  await db.close(); await admin.close();
}, 30_000);

it('R2-PG-p2b（发送门暂停点 + fencing）：A 领取（f=1）后停在 begin 前；租约过期后 B 重新领取（f=2）并发完 → 放行 A：begin 0 行被挡（lost），不重复上线', async () => {
  const url = await freshDatabase(); const db = await open(url); const admin = await open(url);
  const w = await worldM05({ store: db.store });
  expect(await registerUnnamedAppointment(w, 'm-zhao', '明天下午3点有个客人要来')).toContain('预约还没登记');
  expect(await w.call('m-zhao', '对')).toContain('预约已登记');
  const g = gate();
  uninstall = installPausePoints({ 'send-gate:before-begin': g.hook });
  const fa = fakeSender(), fb = fakeSender();
  const ticking = createNotificationDispatcher({ store: db.store, sender: fa.sender, now: () => NOW, worker: 'w1', leaseMs: 60_000 }).tick();
  await g.reached;
  const claimedByA = (await rawQuery(url, `SELECT status FROM front_claw_perf.performance_notifications WHERE kind='appointment'`))[0]!.status as string;
  uninstall(); uninstall = null;
  const later = new Date(NOW.getTime() + 61_000);
  const b = await createNotificationDispatcher({ store: admin.store, sender: fb.sender, now: () => later, worker: 'w2', leaseMs: 60_000 }).tick();
  const afterB = (await rawQuery(url, `SELECT status FROM front_claw_perf.performance_notifications WHERE kind='appointment'`))[0]!.status as string;
  expect(decodeStatus(claimedByA).delivery.fence).toBe(1);
  expect(b).toMatchObject({ claimed: 1, sent: 1 }); // B 以 f=2 重新领取并发完（终态 sent 不再带 f）
  expect(afterB.startsWith('sent|')).toBe(true);
  g.release();
  const a = await ticking;
  expect(fa.wire).toEqual([]);
  expect(fb.wire).toHaveLength(1);
  expect(a).toMatchObject({ sent: 0 });
  expect((await rawQuery(url, `SELECT status FROM front_claw_perf.performance_notifications WHERE kind='appointment'`))[0]!.status).toBe(afterB);
  console.info(JSON.stringify({ 场景: 'R2 发送门被 fencing 挡住', A: a, B: b }));
  await db.close(); await admin.close();
}, 30_000);

// ───────────── 补充2：fencing 比对与写入在同一条条件 UPDATE ─────────────
function recordingClient(url: string) {
  const pool = new pg.Pool({ connectionString: url, max: 2 });
  const log: string[] = [];
  const client: SqlClient = {
    async query(sql, params) { log.push(sql.replace(/\s+/g, ' ').trim()); const r = await pool.query(sql, params ? [...params] : []); return { rows: r.rows }; },
    async transaction(work) {
      const held = await pool.connect();
      const q: SqlClient['query'] = async (sql, params) => { log.push(sql.replace(/\s+/g, ' ').trim()); const r = await held.query(sql, params ? [...params] : []); return { rows: r.rows }; };
      try { await held.query('BEGIN'); const out = await work(q); await held.query('COMMIT'); return out; }
      catch (error) { await held.query('ROLLBACK').catch(() => {}); throw error; } finally { held.release(); }
    },
  };
  return { client, log, end: () => pool.end() };
}

it('R2-PG-f1（补充2）：通知结果写回只发一条带 f=预期 的条件 UPDATE（无先读后判）；f 不符/租约过期 → 0 行被挡；一致 → 写入', async () => {
  const url = await freshDatabase(); const db = await open(url);
  const w = await worldM05({ store: db.store });
  expect(await registerUnnamedAppointment(w, 'm-zhao', '明天下午3点有个客人要来')).toContain('预约还没登记');
  expect(await w.call('m-zhao', '对')).toContain('预约已登记');
  const iso = (ms: number) => new Date(NOW.getTime() + ms).toISOString();
  const claim = await db.store.claimDueNotifications({ nowIso: iso(0), leaseUntil: iso(60_000), limit: 5, kinds: ['appointment'], worker: 'w1', tokenFor: () => 'tok1' });
  const row = claim.claimed[0]!; const raw = row.delivery!.raw; const f = decodeStatus(raw).delivery.fence;
  const rec = recordingClient(url); const store = createPostgresPerformanceStore(rec.client);
  const sent = encodeStatus('sent', { attempts: 1, resends: 0, fence: f });
  // 绕过 TS 预判：直接把库里的 f 改大（模拟被他人重领后原文恰好相同之外的情形由 status= 覆盖；这里专测 SQL 里的 f 条件）。
  rec.log.length = 0;
  expect(await store.transitionNotification(row.notificationId, raw, sent, iso(1000), { epoch: f, nowIso: iso(61_000) })).toBe(false); // 过期：TS 预判直接挡
  expect(rec.log).toEqual([]);
  rec.log.length = 0;
  expect(await store.transitionNotification(row.notificationId, raw, sent, iso(1000), { epoch: f, nowIso: iso(1000) })).toBe(true);
  expect(rec.log).toHaveLength(1);
  expect(rec.log[0]).toMatch(/^UPDATE \S+performance_notifications SET status=\$1, sent_at=\$2 WHERE notification_id=\$3 AND status=\$4 AND COALESCE\(substring\(status from .+\)::bigint, 0\) = \$5 AND .*split_part\(status, '\|', 2\) > \$6 RETURNING/);
  expect(rec.log.some(sql => /^SELECT/i.test(sql))).toBe(false);
  // 直接验证 SQL 条件本身：同一原文下 f 参数不符 / now 已过到期时间 → 0 行。
  await rawQuery(url, `UPDATE front_claw_perf.performance_notifications SET status=$1 WHERE notification_id=$2`, [raw, row.notificationId]);
  const sql = rec.log[0]!;
  const direct = async (epoch: number, nowIso: string) => (await rawQuery(url, sql, [sent, iso(1000), row.notificationId, raw, epoch, nowIso])).length;
  expect(await direct(f + 1, iso(1000))).toBe(0);
  expect(await direct(f, iso(61_000))).toBe(0);
  expect(await direct(f, iso(1000))).toBe(1);
  await rec.end(); await db.close();
}, 30_000);

it('R2-PG-f2（补充2）：入账提交的 M07 fence 并进关闭草稿的条件 UPDATE——快照判定放行但租约 owner/epoch 不符或已到期 → 0 行被挡、草稿退回、零入账', async () => {
  const url = await freshDatabase(); const db = await open(url);
  const w = await world({ store: db.store });
  const lease = (owner: string, epoch: number, until: number) => JSON.stringify({ owner, token: `t${owner}`, until, epoch });
  await db.store.updateConfigLocked(CONSUMER_LEASE_KEY, [], () => ({ [CONSUMER_LEASE_KEY]: lease('B', 2, NOW.getTime() + 30_000) }));
  const rec = recordingClient(url); const store = createPostgresPerformanceStore(rec.client);
  const attempt = async (amount: number, fence: CommitGuard['fence']) => {
    expect(await w.call('m-wang-yj', SHEET(amount))).toContain('代报');
    const pending = (await db.store.listDrafts({ status: 'pending' }))[0]!;
    const confirming = (await db.store.claimPendingDraft(pending.draftId))!;
    const next: Draft = { ...confirming, status: 'confirmed', closedAt: at };
    const entry = { entryId: confirmEntryId(pending.draftId, 0), storeId: 's-b', businessDay: pending.businessDay, customerName: null, amount, amountType: 'consultant' as const,
      ownerPersonId: 'p-zhao', ownerName: '小赵', reporterPersonId: 'p-wang-yj', note: '', status: 'confirmed' as const, disputed: false, createdAt: at };
    // 快照判定恒放行：只剩 SQL 里的 fence 条件起作用。
    const guard: CommitGuard = { key: '', check: () => true, checkSnapshot: () => true, personIds: [], ...(fence ? { fence } : {}) };
    rec.log.length = 0;
    const n = await store.commitConfirmingDraft(next, [entry], guard);
    return { n, draftId: pending.draftId };
  };
  const now = () => NOW.getTime();
  for (const [label, fence] of [['owner 不符', { key: CONSUMER_LEASE_KEY, owner: 'A', epoch: 2, nowMs: now }], ['epoch 不符', { key: CONSUMER_LEASE_KEY, owner: 'B', epoch: 1, nowMs: now }],
    ['已到期', { key: CONSUMER_LEASE_KEY, owner: 'B', epoch: 2, nowMs: () => NOW.getTime() + 31_000 }]] as const) {
    const r = await attempt(580 + label.length, fence);
    expect(r.n, label).toBe(-1);
    expect(await entriesOf(url, r.draftId), label).toBe(0);
    // R4：租约不符时补偿经统一入口比对当前持有者，0 行，草稿可能仍 confirming；随后由持有者「取消」。
    expect(['pending', 'confirming']).toContain((await db.store.getDraft(r.draftId))!.status);
    expect(rec.log.some(sql => /^UPDATE \S+performance_drafts SET status=\$1, payload_json=\$2, closed_at=\$3 WHERE draft_id=\$4 AND status=\$5 AND EXISTS \(SELECT 1 FROM \S+performance_config c WHERE c\.key=\$6 AND .*"epoch".* = \$8 AND .*"until".* > \$9\)/.test(sql)), label).toBe(true);
    expect(await w.call('m-wang-yj', '取消'), label).toContain('取消');
  }
  const ok = await attempt(599, { key: CONSUMER_LEASE_KEY, owner: 'B', epoch: 2, nowMs: now });
  expect(ok.n).toBe(1);
  expect(await entriesOf(url, ok.draftId)).toBe(1);
  await rec.end(); await db.close();
}, 30_000);
