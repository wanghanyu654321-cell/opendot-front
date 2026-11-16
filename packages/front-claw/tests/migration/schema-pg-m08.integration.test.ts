import { expect, it } from 'vitest';
import { migrateDown, migrateUp, schemaVersion, MIGRATION_008_SQL } from '../../src/role-eval/schema-migrations.js';
import { decodeStatus, encodeStatus } from '../../src/role-eval/notification-status.js';
import { ACCESS_POLICY_KEY, updateAccessPolicy } from '../../src/role-eval/access-policy.js';
import { readAll, tableChecksum } from '../../src/migration/inventory.js';
import { TABLES } from '../../src/migration/tables.js';
import { openSql } from '../../src/migration/pg.js';
import { policyM05 } from '../role-eval/appointment-fixture-m05.js';
import { fakeSender } from '../role-eval/notify-fixture-m06.js';
import { freshDatabase, open, rawClient, rawQuery, useCluster } from './pg-harness-m08.js';
import { dispatcher, populate, T0 } from './fixture-m08.js';

// PG17 用户态临时集群（不是线上版本；线上 PG 版本未知，待确认）。全部合成数据。
useCluster();

async function populated() {
  const url = await freshDatabase();
  const db = await open(url);
  await populate(db, (sql, params) => rawQuery(url, sql, params));
  return { url, db };
}
/** R1：008 对畸形历史状态失败关闭；运维先把畸形行改成合法终态（保留通知行本身），再升级。 */
const REPAIR_MALFORMED = `UPDATE front_claw_perf.performance_notifications SET status = 'not_sent|-|-|a=1|r=0|err=malformed_legacy_status' WHERE status = 'pending|garbage|queued|a=1|r=0'`;
async function checksums(url: string) {
  const sql = await openSql(url);
  try { const data = await readAll(sql.client.query.bind(sql.client)); return Object.fromEntries(TABLES.map(spec => [spec.name, tableChecksum(spec, data.get(spec.name)!)])); }
  finally { await sql.close(); }
}
const DELIVERY = ['delivery_state', 'delivery_phase', 'delivery_attempts', 'delivery_resends', 'delivery_next_at', 'delivery_lease_until', 'delivery_lease_token', 'delivery_lease_owner', 'delivery_error', 'delivery_due_at', 'delivery_fence'];
const columnsOf = async (url: string) => (await rawQuery(url, `SELECT column_name FROM information_schema.columns WHERE table_schema='front_claw_perf' AND table_name='performance_notifications'`)).map(r => String(r.column_name));
const iso = (v: unknown) => v === null ? null : v instanceof Date ? v.toISOString() : String(v);
async function deliveryRows(url: string) {
  return rawQuery(url, `SELECT notification_id, status, ${DELIVERY.join(', ')} FROM front_claw_perf.performance_notifications ORDER BY notification_id`);
}
/** 列与 TS decodeStatus 逐字段对照。 */
function expectParity(row: Record<string, unknown>) {
  const raw = String(row.status);
  const { status, delivery } = decodeStatus(raw);
  expect(delivery.error, raw).not.toBe('malformed_status');
  expect({ state: row.delivery_state, phase: row.delivery_phase, attempts: row.delivery_attempts, resends: row.delivery_resends, fence: Number(row.delivery_fence),
    token: row.delivery_lease_token, owner: row.delivery_lease_owner, error: row.delivery_error, due: iso(row.delivery_next_at) ?? iso(row.delivery_lease_until) }, raw)
    .toEqual({ state: status, phase: delivery.phase, attempts: delivery.attempts, resends: delivery.resends, fence: delivery.fence, token: delivery.token, owner: delivery.worker, error: delivery.error, due: delivery.dueAt });
  const due = row.delivery_due_at;
  if (raw === 'pending') expect(due, raw).toBe(-Infinity);
  else if (status === 'pending' && delivery.dueAt) expect(iso(due), raw).toBe(delivery.dueAt);
  else expect(due, raw).toBeNull();
  if (delivery.phase === 'claimed' || delivery.phase === 'sending') expect(row.delivery_next_at, raw).toBeNull();
}

it('真实PG：M01–M07 流程造出的 v7 库 → up（回填）→ down → up：业务行校验和三次一致，列与 decodeStatus 逐字段一致，down 只删 008 对象', async () => {
  const { url, db } = await populated();
  expect(db.schemaVersion).toBe(7);
  // R1：库里有畸形状态（fixture 的 'pending|garbage|…'）→ 升级整体失败回滚，版本仍 7，业务行不变。
  const untouched = await checksums(url);
  { const s0 = await openSql(url); await expect(migrateUp(s0.client, { apply: true })).rejects.toThrow(/invalid_delivery_status/);
    expect(await schemaVersion(s0.client.query.bind(s0.client))).toBe(7); await s0.close(); }
  expect(await checksums(url)).toEqual(untouched);
  expect((await columnsOf(url)).filter(c => c.startsWith('delivery_'))).toEqual([]);
  await rawQuery(url, REPAIR_MALFORMED);
  const before = await checksums(url);
  const statuses = (await deliveryRowsV7(url)).map(r => r.status);
  expect(statuses.some(s => s.startsWith('sent|'))).toBe(true);
  expect(statuses.some(s => s.startsWith('unknown|'))).toBe(true);
  expect(statuses.some(s => /^pending\|.*\|queued\|/.test(s))).toBe(true);
  expect(statuses.some(s => /\|sending\|/.test(s))).toBe(true);
  expect(statuses).toContain('pending');
  const sql = await openSql(url);
  // dry-run：真实执行后整体回滚，库不变。
  expect(await migrateUp(sql.client, { apply: false })).toMatchObject({ from: 7, to: 11, applied: true, dryRun: true });
  expect(await schemaVersion(sql.client.query.bind(sql.client))).toBe(7);
  expect((await columnsOf(url)).filter(c => c.startsWith('delivery_'))).toEqual([]);
  expect(await migrateUp(sql.client, { apply: true })).toMatchObject({ from: 7, to: 11, applied: true });
  expect(await migrateUp(sql.client, { apply: true })).toMatchObject({ from: 11, to: 11, applied: false });
  const first = await deliveryRows(url);
  for (const row of first) expectParity(row);
  const atLatest = await checksums(url);
  // 009 会改写业绩行的 status/amount_type/amount 类型，v9 校验和可以与 v7 不同。
  const c = await rawClient(url);
  await c.query('SET enable_seqscan = off');
  const explain = (await c.query(`EXPLAIN SELECT * FROM front_claw_perf.performance_notifications WHERE delivery_due_at <= $1::timestamptz ORDER BY delivery_due_at`, [new Date(T0).toISOString()])).rows.map(r => r['QUERY PLAN']).join('\n');
  await c.end();
  expect(explain).toContain('performance_notifications_due_idx');
  // D174 新增 011；降档一次一版：11→10→9→8→7。
  expect(await migrateDown(sql.client, { apply: true })).toMatchObject({ from: 11, to: 10, applied: true });
  expect(await migrateDown(sql.client, { apply: false })).toMatchObject({ from: 10, to: 9, dryRun: true });
  expect(await schemaVersion(sql.client.query.bind(sql.client))).toBe(10);
  expect(await migrateDown(sql.client, { apply: true })).toMatchObject({ from: 10, to: 9, applied: true });
  expect(await migrateDown(sql.client, { apply: true })).toMatchObject({ from: 9, to: 8, applied: true });
  expect(await schemaVersion(sql.client.query.bind(sql.client))).toBe(8);
  expect((await columnsOf(url)).filter(c => c.startsWith('delivery_'))).not.toEqual([]);
  expect(await migrateDown(sql.client, { apply: true })).toMatchObject({ from: 8, to: 7, applied: true });
  expect((await columnsOf(url)).filter(c => c.startsWith('delivery_'))).toEqual([]);
  expect(await rawQuery(url, `SELECT proname FROM pg_proc WHERE proname='notification_delivery_sync'`)).toEqual([]);
  expect(await rawQuery(url, `SELECT version FROM front_claw_perf.schema_migrations ORDER BY version`)).toEqual([{ version: 7 }]);
  expect((await rawQuery(url, `SELECT to_regclass('front_claw_perf.migration_import_rows')::text AS t`))[0]!.t).toBe('front_claw_perf.migration_import_rows');
  // 009 down 把 confirmed→recorded、consultant→业绩（按「从 008 升上来的旧库」还原）。
  // 本用例 populate 经 R5 入口写出的已是 confirmed/consultant，所以 entries 校验和与升档前不同；其余 007 表应还原。
  const afterDown = await checksums(url);
  const { performance_entries: _beforeEntries, ...restBefore } = before;
  const { performance_entries: _afterEntries, ...restAfter } = afterDown;
  void _beforeEntries; void _afterEntries;
  expect(restAfter).toEqual(restBefore);
  const kinds = await rawQuery(url, `SELECT status, amount_type, pg_typeof(amount)::text AS t FROM front_claw_perf.performance_entries`);
  expect(kinds.length).toBeGreaterThan(0);
  expect(kinds.every(r => (r.status === 'recorded' || r.status === 'void') && r.amount_type === '业绩' && r.t === 'integer')).toBe(true);
  expect(await migrateDown(sql.client, { apply: true })).toMatchObject({ from: 7, to: 7, applied: false });
  await migrateUp(sql.client, { apply: true });
  expect(await deliveryRows(url)).toEqual(first);
  expect(await checksums(url)).toEqual(atLatest);
  await sql.close(); await db.close();
}, 60_000);

async function deliveryRowsV7(url: string) { return (await rawQuery(url, `SELECT status FROM front_claw_perf.performance_notifications`)) as { status: string }[]; }

it('真实PG：触发器与 decodeStatus 一致——400 个随机合法编码逐字段对照；R1：畸形/边界原文 TS 判畸形且触发器拒写（逐条）', async () => {
  const url = await freshDatabase();
  const db = await open(url);
  const sql = await openSql(url);
  await migrateUp(sql.client, { apply: true });
  let seed = 7;
  const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  const statuses: string[] = [];
  const bases = ['pending', 'sent', 'not_sent', 'unknown'] as const;
  for (let i = 0; i < 400; i++) {
    const base = bases[rnd(4)]!;
    const phase = (['queued', 'claimed', 'sending'] as const)[rnd(3)]!;
    const leased = base === 'pending' && phase !== 'queued';
    statuses.push(encodeStatus(base, { ...(base === 'pending' ? { phase, dueAt: new Date(T0 + (rnd(2000) - 1000) * 60_000).toISOString() } : {}),
      attempts: rnd(9), resends: rnd(3), fence: rnd(3) ? rnd(1e9) : null, token: leased || rnd(2) ? `t${rnd(1e6)}` : null, worker: rnd(2) ? `w-${rnd(50)}` : null, error: rnd(3) ? null : `rejected:${rnd(99999)}` }));
  }
  statuses.push('pending', 'sent', 'not_sent', 'unknown');
  const malformed = ['pendingX', '', '|', 'pending|', 'pending||', 'pending|garbage|queued|a=1', 'pending|2026-11-12T02:00:00Z|queued',
    'pending|2026-11-12T02:00:00.000Z', 'pending|2026-11-12T02:00:00.000Z|bogus|a=2', 'weird|2026-11-12T02:00:00.000Z|claimed|tok=x', 'sent|-|-|a=1|r=0|a=3',
    'pending|2026-11-12T02:00:00.000Z|queued|a= 7|r=-2|tok=|by=|err=', 'pending|2026-11-12T02:00:00.000Z|queued|a5|r|tok', 'unknown|-|-|a=99999999999|r=1',
    'pending|2026-11-12T02:00:00.000Z|sending|a=1x|r=+4|err=a=b=c', 'not_sent|-|-|a=1|r=0|err=x|by=y|tok=z',
    'pending|2026-02-30T02:00:00.000Z|queued|a=1|r=0', 'pending|2026-11-12T24:00:00.000Z|queued|a=1|r=0', 'pending|0000-01-01T00:00:00.000Z|queued|a=0|r=0',
    'pending|2026-11-12T02:00:00.000Z|claimed|a=0|r=0|f=1', 'sent|-|-|a=01|r=0', 'sent|-|-|a=10000|r=0', 'sent|-|-|a=1|r=0|f=-1', 'unknown|-|-|a=1|r=0|err=x|err=y'];
  for (const raw of malformed) {
    expect(decodeStatus(raw).delivery.error, raw).toBe('malformed_status');
    await expect(rawQuery(url, `INSERT INTO front_claw_perf.performance_notifications (notification_id, kind, recipient_person_id, body, status, related_id, created_at, sent_at) VALUES ('bad','k','p','b',$1,'r','2026-11-12T00:00:00.000Z',NULL)`, [raw]), raw).rejects.toThrow(/invalid_delivery_status/);
  }
  for (const [i, status] of statuses.entries()) {
    await rawQuery(url, `INSERT INTO front_claw_perf.performance_notifications (notification_id, kind, recipient_person_id, body, status, related_id, created_at, sent_at) VALUES ($1,'k','p','b',$2,'r','2026-11-12T00:00:00.000Z',NULL)`, [`n${String(i).padStart(4, '0')}`, status]);
  }
  // UPDATE 路径同样推导（旧制品只改 status）；畸形 UPDATE 同样被拒。
  await rawQuery(url, `UPDATE front_claw_perf.performance_notifications SET status = 'sent|-|-|a=2|r=0' WHERE notification_id = 'n0000'`);
  await expect(rawQuery(url, `UPDATE front_claw_perf.performance_notifications SET status = 'sent|-|-|a=x' WHERE notification_id = 'n0000'`)).rejects.toThrow(/invalid_delivery_status/);
  const rows = await deliveryRows(url);
  expect(rows).toHaveLength(statuses.length);
  for (const row of rows) expectParity(row);
  // 直接写列会被覆盖（过渡期唯一写入口是 status 文本）。
  await rawQuery(url, `UPDATE front_claw_perf.performance_notifications SET delivery_attempts = 42 WHERE notification_id = 'n0000'`);
  expect((await rawQuery(url, `SELECT delivery_attempts FROM front_claw_perf.performance_notifications WHERE notification_id='n0000'`))[0]!.delivery_attempts).toBe(2);
  await sql.close(); await db.close();
}, 60_000);

it('真实PG：最新库（v10，含 008 投递列与 010 来源草稿）上应用与同数据 v7 孪生库派发结果逐行一致；M07 制品（文本查询）在升档库上也一致', async () => {
  const a = await populated(); const b = await populated();
  await rawQuery(a.url, REPAIR_MALFORMED); await rawQuery(b.url, REPAIR_MALFORMED);
  const sa = await openSql(a.url); await migrateUp(sa.client, { apply: true }); await sa.close(); await a.db.close();
  const v8 = await open(a.url);
  expect(v8.schemaVersion).toBe(11);
  expect(b.db.schemaVersion).toBe(7);
  const strip = (rows: Record<string, unknown>[]) => rows.map(r => ({ id: r.notification_id, status: r.status }));
  for (const offset of [0, 120_000, 3_600_000]) {
    const fa = fakeSender(), fb = fakeSender();
    const ra = await dispatcher(v8.store, fa.sender, 'w', T0 + offset).tick();
    const rb = await dispatcher(b.db.store, fb.sender, 'w', T0 + offset).tick();
    expect(ra).toEqual(rb);
    expect(fa.wire.map(x => x.notificationId)).toEqual(fb.wire.map(x => x.notificationId));
    expect(strip(await rawQuery(a.url, `SELECT notification_id, status FROM front_claw_perf.performance_notifications ORDER BY notification_id`)))
      .toEqual(strip(await rawQuery(b.url, `SELECT notification_id, status FROM front_claw_perf.performance_notifications ORDER BY notification_id`)));
  }
  for (const row of await deliveryRows(a.url)) expectParity(row);
  // 证明 v8 实例真的按 delivery_due_at 取到期：临时停触发器造一行“文本到期、列为空”，v8 不派它；恢复后派。
  const probeId = 'f'.repeat(64);
  const kind = (await rawQuery(a.url, `SELECT kind FROM front_claw_perf.performance_notifications WHERE notification_id ~ '^[0-9a-f]{64}$' LIMIT 1`))[0]!.kind;
  await rawQuery(a.url, `INSERT INTO front_claw_perf.performance_notifications (notification_id, kind, recipient_person_id, body, status, related_id, created_at, sent_at) VALUES ($1,$2,'p1','b','pending','r','2026-11-12T00:00:00.000Z',NULL)`, [probeId, kind]);
  await rawQuery(a.url, `ALTER TABLE front_claw_perf.performance_notifications DISABLE TRIGGER notification_delivery_sync`);
  await rawQuery(a.url, `UPDATE front_claw_perf.performance_notifications SET delivery_due_at = NULL WHERE notification_id = '${probeId}'`);
  await rawQuery(a.url, `ALTER TABLE front_claw_perf.performance_notifications ENABLE TRIGGER notification_delivery_sync`);
  const probe = fakeSender();
  const statusOf = async () => (await rawQuery(a.url, `SELECT status FROM front_claw_perf.performance_notifications WHERE notification_id='${probeId}'`))[0]!.status as string;
  await dispatcher(v8.store, probe.sender, 'w', T0 + 7_200_000).tick();
  expect(probe.wire.map(x => x.notificationId)).not.toContain(probeId);
  expect(await statusOf()).toBe('pending');
  await rawQuery(a.url, `UPDATE front_claw_perf.performance_notifications SET status = status WHERE notification_id = '${probeId}'`);
  expect(await statusOf()).toBe('pending');
  await dispatcher(v8.store, probe.sender, 'w', T0 + 7_200_000).tick();
  expect(await statusOf(), 'probe').not.toBe('pending');
  // 修复后的畸形行是终态，两边都没派发。
  expect((await rawQuery(a.url, `SELECT count(*)::int AS n FROM front_claw_perf.performance_notifications WHERE status LIKE '%malformed_legacy_status'`))[0]!.n).toBe(1);
  expect((await rawQuery(b.url, `SELECT count(*)::int AS n FROM front_claw_perf.performance_notifications WHERE status LIKE '%malformed_legacy_status'`))[0]!.n).toBe(1);
  await v8.close(); await b.db.close();
}, 90_000);

it('真实PG竞态：新库上 6 个连接池同时 schema-up、6 个实例同时启动（007 基线），5 轮全部成功，只应用一次', async () => {
  for (let round = 0; round < 5; round++) {
    const url = await freshDatabase();
    const pools = await Promise.all(Array.from({ length: 6 }, () => openSql(url)));
    const [ups, opens] = await Promise.all([
      Promise.all(pools.map(p => migrateUp(p.client, { apply: true }))),
      Promise.all(Array.from({ length: 6 }, () => open(url))),
    ]);
    expect(ups.filter(u => u.applied), `round ${round}`).toHaveLength(1);
    expect(await rawQuery(url, `SELECT version FROM front_claw_perf.schema_migrations ORDER BY version`)).toEqual([{ version: 7 }, { version: 8 }, { version: 9 }, { version: 10 }, { version: 11 }]);
    await Promise.all([...pools.map(p => p.close()), ...opens.map(o => o.close())]);
  }
  // 已应用的 008 被改过（校验和不同）→ 拒绝，不静默重跑。
  const url = await freshDatabase();
  const p = await openSql(url);
  await migrateUp(p.client, { apply: true });
  await rawQuery(url, `UPDATE front_claw_perf.schema_migrations SET checksum='tampered' WHERE version=8`);
  await expect(migrateUp(p.client, { apply: true })).rejects.toThrow('migration_checksum_mismatch');
  await p.close();
  expect(MIGRATION_008_SQL).toContain('CREATE INDEX IF NOT EXISTS performance_notifications_due_idx');
}, 120_000);

it('真实PG竞态：策略行不存在时 4 个连接池同时以 expectedVersion=null 首写，10 轮每轮只有一个成功，其余 version_conflict，库里是赢家', async () => {
  for (let round = 0; round < 10; round++) {
    const url = await freshDatabase();
    const dbs = await Promise.all(Array.from({ length: 4 }, () => open(url)));
    const results = await Promise.all(dbs.map((db, i) => updateAccessPolicy(db.store, { expectedVersion: null, next: policyM05(i + 1), actor: `admin-${i}`, reason: 'first', at: new Date(T0).toISOString() })));
    const winners = results.filter(r => r.ok);
    expect(winners, `round ${round}`).toHaveLength(1);
    expect(results.filter(r => !r.ok).every(r => !r.ok && r.reason === 'version_conflict')).toBe(true);
    const stored = JSON.parse(String((await rawQuery(url, `SELECT value FROM front_claw_perf.performance_config WHERE key=$1`, [ACCESS_POLICY_KEY]))[0]!.value));
    expect(stored.version).toBe((winners[0] as { version: number }).version);
    expect((await rawQuery(url, `SELECT count(*)::int AS n FROM front_claw_perf.performance_config WHERE key LIKE 'front-claw-access:audit:%'`))[0]!.n).toBe(1);
    await Promise.all(dbs.map(db => db.close()));
  }
}, 120_000);
