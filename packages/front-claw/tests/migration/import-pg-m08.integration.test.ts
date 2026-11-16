import { expect, it } from 'vitest';
import { migrateDown, migrateUp } from '../../src/role-eval/schema-migrations.js';
import { importData, postflight, preflight } from '../../src/migration/import.js';
import { exportForRollback } from '../../src/migration/rollback-export.js';
import { readAll, rowKey, rowSha } from '../../src/migration/inventory.js';
import { TABLES } from '../../src/migration/tables.js';
import { openSql, type OpenedSql } from '../../src/migration/pg.js';
import { runCli, SOURCE_ENV, TARGET_ENV, ROLLBACK_ENV, SOURCE_HOST_ENV, SOURCE_PORT_ENV, ALLOWED_ENV } from '../../src/migration/cli.js';
import { fakeSender } from '../role-eval/notify-fixture-m06.js';
import { createReadonlyRole, freshDatabase, open, rawQuery, useCluster } from './pg-harness-m08.js';
import { dispatcher, handlerFor, populate, say, T0 } from './fixture-m08.js';

// PG17 用户态临时集群（不是线上版本；线上 PG 版本未知，待确认）。源库 = “旧 Front Claw PG 的授权副本”的合成替身。
useCluster();

async function source() {
  const url = await freshDatabase();
  const db = await open(url);
  await populate(db, (sql, params) => rawQuery(url, sql, params));
  await db.close();
  return url;
}
async function target() {
  const url = await freshDatabase();
  const sql = await openSql(url);
  await migrateUp(sql.client, { apply: true });
  return { url, sql };
}
const q = (s: OpenedSql) => s.client.query.bind(s.client);
async function snapshot(url: string) {
  const s = await openSql(url);
  try {
    const data = await readAll(q(s));
    return Object.fromEntries(TABLES.map(spec => [spec.name, Object.fromEntries((data.get(spec.name) ?? []).map(row => [rowKey(spec, row), rowSha(spec, row)]))]));
  } finally { await s.close(); }
}
const countWhere = async (url: string, sql: string, params: unknown[] = []) => Number((await rawQuery(url, sql, params))[0]!.n);

it('真实PG：在 M01–M07 流程造出的旧库上迁移——只读源、预检/dry-run 零写入、分批导入、后检对账、重跑无重复、历史通知不派发', async () => {
  const srcUrl = await source();
  const tgt = await target();
  const src = await openSql(srcUrl, { readOnly: true });
  await expect(src.client.query(`INSERT INTO front_claw_perf.performance_config (key, value) VALUES ('x','y')`)).rejects.toMatchObject({ code: '25006' });
  const srcBefore = await snapshot(srcUrl), tgtBefore = await snapshot(tgt.url);
  const pre = await preflight(q(src), q(tgt.sql));
  expect(pre.ok).toBe(true);
  expect(pre.source.schemaVersion).toBe(7);
  expect(pre.source.serverVersion).toMatch(/^17\./);
  expect(pre.plan.performance_appointments!.transforms).toMatchObject({ appointment_pending_manager_to_registered: 1 });
  expect(pre.plan.performance_config!.transforms.copy).toBeGreaterThan(0);
  const dry = await importData(src.client, tgt.sql.client, { apply: false, sourceLabel: 'synthetic' });
  expect(dry.dryRun).toBe(true); expect(dry.inserted).toBe(0);
  expect(await snapshot(tgt.url)).toEqual(tgtBefore);
  const done = await importData(src.client, tgt.sql.client, { apply: true, sourceLabel: 'synthetic', batchSize: 3, runId: 'run-1' });
  const expectedRows = Object.values(pre.plan).reduce((n, p) => n + p.insert, 0);
  expect(done.inserted).toBe(expectedRows);
  const post = await postflight(q(src), q(tgt.sql));
  expect(post.errors).toEqual([]);
  expect(post.ok).toBe(true);
  expect(post.transforms.appointment_pending_manager_to_registered).toBe(1);
  expect(post.transforms.notification_pending_suppressed).toBeGreaterThanOrEqual(4);
  expect(post.transforms.draft_notices_suppressed).toBeGreaterThanOrEqual(1);
  expect(post.transforms.draft_notice_suppressed).toBeGreaterThanOrEqual(2);
  expect(post.amounts.imported).toEqual(post.amounts.expected);
  expect(await snapshot(srcUrl)).toEqual(srcBefore);
  // 运行态租约行没有迁；旧预约可追溯（台账记了源 sha 与转换名）。
  expect(await countWhere(tgt.url, `SELECT count(*)::int AS n FROM front_claw_perf.performance_config WHERE key='front-claw-opendot-consumer'`)).toBe(0);
  expect(await rawQuery(tgt.url, `SELECT a.status, l.transform FROM front_claw_perf.performance_appointments a JOIN front_claw_perf.migration_import_rows l ON l.table_name='performance_appointments' AND l.source_key = '["' || a.appointment_id || '"]' WHERE a.note='旧入口' ORDER BY a.created_at`))
    .toEqual([{ status: 'registered', transform: 'appointment_pending_manager_to_registered' }, { status: 'confirmed', transform: 'copy' }]);
  // 重跑：全部“已导入”，零新增。
  const again = await importData(src.client, tgt.sql.client, { apply: true, sourceLabel: 'synthetic', runId: 'run-2' });
  expect(again).toMatchObject({ inserted: 0, adopted: 0, already: expectedRows });
  expect((await postflight(q(src), q(tgt.sql))).ok).toBe(true);
  // 目标库上派发：历史通知一条都不发（全被抑制；sent/unknown 原样）。
  const target8 = await open(tgt.url);
  expect(target8.schemaVersion).toBe(11);
  const f = fakeSender();
  for (const offset of [0, 3_600_000, 86_400_000]) await dispatcher(target8.store, f.sender, 'tgt', T0 + offset).tick();
  expect(f.wire).toEqual([]);
  expect(await rawQuery(tgt.url, `SELECT run_id, status FROM front_claw_perf.migration_runs ORDER BY run_id`)).toEqual([{ run_id: 'run-1', status: 'done' }, { run_id: 'run-2', status: 'done' }]);
  await target8.close(); await src.close(); await tgt.sql.close();
}, 120_000);

it('真实PG：在每个批次边界中断（批内已写未提交）后重跑，最终结果与不中断的一次导入逐行一致', async () => {
  const srcUrl = await source();
  const src = await openSql(srcUrl, { readOnly: true });
  const ref = await target();
  await importData(src.client, ref.sql.client, { apply: true, sourceLabel: 'ref', batchSize: 4, runId: 'ref' });
  const reference = await snapshot(ref.url);
  const batches = Number((await rawQuery(ref.url, `SELECT summary_json FROM front_claw_perf.migration_runs WHERE run_id='ref'`)).map(r => JSON.parse(String(r.summary_json)).batches)[0]);
  expect(batches).toBeGreaterThan(5);
  const totalLedger = await countWhere(ref.url, `SELECT count(*)::int AS n FROM front_claw_perf.migration_import_rows`);
  const ledgers: number[] = [];
  for (let k = 0; k < batches; k++) {
    const tgt = await target();
    let seen = 0;
    await expect(importData(src.client, tgt.sql.client, { apply: true, sourceLabel: 'cut', batchSize: 4, runId: `cut-${k}`, afterBatch: () => { if (seen++ === k) throw Error('injected_crash'); } })).rejects.toThrow('injected_crash');
    // 中断批整体回滚：台账只含之前已提交的 k 批，且与业务行一一对应（没有半批）。
    const ledger = await countWhere(tgt.url, `SELECT count(*)::int AS n FROM front_claw_perf.migration_import_rows`);
    ledgers.push(ledger);
    expect(ledger, `k=${k}`).toBe(k === 0 ? 0 : Math.max(...ledgers.slice(0, -1)) < ledger ? ledger : -1);
    expect(ledger).toBeLessThan(totalLedger);
    await importData(src.client, tgt.sql.client, { apply: true, sourceLabel: 'cut', batchSize: 4, runId: `resume-${k}` });
    expect(await snapshot(tgt.url), `k=${k}`).toEqual(reference);
    expect((await postflight(q(src), q(tgt.sql))).ok, `k=${k}`).toBe(true);
    expect(await rawQuery(tgt.url, `SELECT run_id, status FROM front_claw_perf.migration_runs ORDER BY run_id`)).toEqual([{ run_id: `cut-${k}`, status: 'failed' }, { run_id: `resume-${k}`, status: 'done' }]);
    await tgt.sql.close();
  }
  await src.close(); await ref.sql.close();
}, 300_000);

it('真实PG竞态：两个导入器同时跑同一目标库——无重复、台账每行一条；目标已有不同内容的同主键行 → 预检拦下，导入报冲突不覆盖', async () => {
  const srcUrl = await source();
  const src = await openSql(srcUrl, { readOnly: true });
  const tgt = await target();
  const other = await openSql(tgt.url);
  const [a, b] = await Promise.all([
    importData(src.client, tgt.sql.client, { apply: true, sourceLabel: 'a', batchSize: 5, runId: 'a' }),
    importData(src.client, other.client, { apply: true, sourceLabel: 'b', batchSize: 7, runId: 'b' }),
  ]);
  expect(a.inserted + b.inserted).toBe(a.inserted + a.already);
  expect((await postflight(q(src), q(tgt.sql))).ok).toBe(true);
  expect(await countWhere(tgt.url, `SELECT count(*)::int AS n FROM (SELECT table_name, source_key FROM front_claw_perf.migration_import_rows GROUP BY 1,2 HAVING count(*) > 1) d`)).toBe(0);
  // 冲突：新目标库里预先放一笔同 entry_id、金额不同的账。
  const clash = await target();
  const entry = (await rawQuery(srcUrl, `SELECT * FROM front_claw_perf.performance_entries ORDER BY entry_id LIMIT 1`))[0]!;
  await rawQuery(clash.url, `INSERT INTO front_claw_perf.performance_entries (entry_id, store_id, business_day, customer_name, amount, amount_type, owner_person_id, owner_name, reporter_person_id, note, status, disputed, created_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`, [entry.entry_id, entry.store_id, entry.business_day, entry.customer_name, Number(entry.amount) + 1, entry.amount_type, entry.owner_person_id, entry.owner_name, entry.reporter_person_id, entry.note, entry.status, entry.disputed, entry.created_at]);
  const pre = await preflight(q(src), q(clash.sql));
  expect(pre.ok).toBe(false);
  expect(pre.blocking).toContain('conflict:performance_entries:1');
  await expect(importData(src.client, clash.sql.client, { apply: true, sourceLabel: 'c' })).rejects.toThrow('preflight_blocked');
  expect(Number((await rawQuery(clash.url, `SELECT amount FROM front_claw_perf.performance_entries WHERE entry_id=$1`, [entry.entry_id]))[0]!.amount)).toBe(Number(entry.amount) + 1);
  expect(await countWhere(clash.url, `SELECT count(*)::int AS n FROM front_claw_perf.migration_import_rows`)).toBe(0);
  await src.close(); await tgt.sql.close(); await other.close(); await clash.sql.close();
}, 120_000);

it('真实PG：迁移后继续营业（入账/更正/目标/预约/sent/unknown）→ R2 导出到新隔离 007 库、R1 同库降回 v7，新业务与审计全保留，不重发', async () => {
  const srcUrl = await source();
  const src = await openSql(srcUrl, { readOnly: true });
  const tgt = await target();
  await importData(src.client, tgt.sql.client, { apply: true, sourceLabel: 'synthetic', runId: 'go' });
  const live = await open(tgt.url);
  const call = handlerFor(live.store, 'after');
  const entriesBefore = await countWhere(tgt.url, `SELECT count(*)::int AS n FROM front_claw_perf.performance_entries`);
  await call('m-zhao', '12号测试B店\n1234（小赵）'); expect(await call('m-zhao', '对')).toContain('已入账');
  await call('m-zhao', '把刚才那笔改成1200'); await call('m-zhao', '对');
  await call('m-zhou', '给小林定本月目标5万'); await call('m-zhou', '对');
  await call('m-zhao', say(30)); expect(await call('m-zhao', '对')).toContain('预约已登记');
  await call('m-zhao', say(31)); expect(await call('m-zhao', '对')).toContain('预约已登记');
  const f = fakeSender((_, n) => n === 1 ? { state: 'accepted', detail: 'sdk_ack_accepted', code: 0 } : 'throw');
  const tick = await dispatcher(live.store, f.sender, 'after', T0 + 3_700_000).tick();
  expect(f.wire).toHaveLength(2);
  expect(tick).toMatchObject({ sent: 1 });
  expect(await countWhere(tgt.url, `SELECT count(*)::int AS n FROM front_claw_perf.performance_entries`)).toBe(entriesBefore + 1);
  expect(await countWhere(tgt.url, `SELECT count(*)::int AS n FROM front_claw_perf.performance_revisions`)).toBeGreaterThanOrEqual(2);
  const post = await postflight(q(src), q(tgt.sql), { allowChanged: true });
  expect(post.errors).toEqual([]);
  expect(Object.values(post.tables).reduce((n, t) => n + t.newSinceImport, 0)).toBeGreaterThan(5);
  await live.close();
  const after = await snapshot(tgt.url);
  const { ['front-claw-opendot-consumer']: _lease, ...afterConfig } = after.performance_config as Record<string, string>;
  void _lease;

  // R2：导出到新的隔离库（007 布局）。dry-run 不建 schema；目的库原有独有行保留。
  const destUrl = await freshDatabase();
  const dest = await openSql(destUrl);
  const tgtRead = await openSql(tgt.url, { readOnly: true });
  const dry = await exportForRollback(tgtRead.client, dest.client, { apply: false });
  expect(dry.dryRun).toBe(true);
  expect((await rawQuery(destUrl, `SELECT to_regclass('front_claw_perf.performance_entries')::text AS t`))[0]!.t).toBeNull();
  const exported = await exportForRollback(tgtRead.client, dest.client, { apply: true });
  expect(exported.verified).toBe(true);
  const destSnap = await snapshot(destUrl);
  expect({ ...destSnap, performance_config: destSnap.performance_config }).toEqual({ ...after, performance_config: afterConfig });
  await rawQuery(destUrl, `INSERT INTO front_claw_perf.performance_config (key, value) VALUES ('dest-only','keep')`);
  await rawQuery(destUrl, `UPDATE front_claw_perf.performance_entries SET amount = amount + 1 WHERE entry_id = (SELECT min(entry_id) FROM front_claw_perf.performance_entries)`);
  const rerun = await exportForRollback(tgtRead.client, dest.client, { apply: true });
  expect(rerun.tables.performance_entries).toMatchObject({ insert: 0, update: 1 });
  expect(Object.entries(rerun.tables).filter(([name]) => name !== 'performance_entries').every(([, t]) => t.insert === 0 && t.update === 0)).toBe(true);
  expect(await snapshot(destUrl)).toMatchObject({ performance_entries: after.performance_entries });
  expect(rerun.tables.performance_config!.keptDestOnly).toBe(1);
  // 目的库上起 v7 兼容制品（文本到期查询）：一条都不发。
  const destStore = await open(destUrl);
  expect(destStore.schemaVersion).toBe(7);
  const fd = fakeSender();
  for (const offset of [3_700_000, 86_400_000]) await dispatcher(destStore.store, fd.sender, 'dest', T0 + offset).tick();
  expect(fd.wire.map(x => x.notificationId)).toEqual([]);
  await destStore.close();

  // R1：同库降回 v7（一次一版：10→9→8→7）。业务行一行不少；009 down 会把 confirmed/consultant 还原为 recorded/业绩。
  // D174：先撤 011，再沿用原有降档验证。
  expect(await migrateDown(tgt.sql.client, { apply: true })).toMatchObject({ from: 11, to: 10, applied: true });
  expect(await migrateDown(tgt.sql.client, { apply: true })).toMatchObject({ from: 10, to: 9, applied: true });
  expect(await migrateDown(tgt.sql.client, { apply: true })).toMatchObject({ from: 9, to: 8, applied: true });
  expect(await migrateDown(tgt.sql.client, { apply: true })).toMatchObject({ from: 8, to: 7, applied: true });
  const downSnap = await snapshot(tgt.url);
  const { performance_entries: afterEntries, ...afterRest } = after;
  const { performance_entries: downEntries, ...downRest } = downSnap;
  expect(Object.keys(downEntries as object).sort()).toEqual(Object.keys(afterEntries as object).sort());
  expect(downRest).toEqual(afterRest);
  const v7 = await open(tgt.url);
  expect(v7.schemaVersion).toBe(7);
  const f7 = fakeSender();
  for (const offset of [3_700_000, 86_400_000]) await dispatcher(v7.store, f7.sender, 'v7', T0 + offset).tick();
  expect(f7.wire).toEqual([]);
  const call7 = handlerFor(v7.store, 'v7');
  await call7('m-zhao', '12号测试B店\n4321（小赵）'); expect(await call7('m-zhao', '对')).toContain('已入账');
  await v7.close();
  // 再升回 v8：列重新推导，后检仍通过。
  await migrateUp(tgt.sql.client, { apply: true });
  expect((await postflight(q(src), q(tgt.sql), { allowChanged: true })).ok).toBe(true);
  await src.close(); await tgt.sql.close(); await dest.close(); await tgtRead.close();
}, 180_000);

it('真实PG：CLI 全流程默认 dry-run（schema-up/import/export-rollback 不加 --apply 不写），加 --apply 后预检→导入→后检通过；连接串不出现在输出里', async () => {
  const srcUrl = await source();
  const roUrl = await createReadonlyRole(srcUrl);
  const tgtUrl = await freshDatabase();
  const rbUrl = await freshDatabase();
  const src = new URL(roUrl);
  const env = {
    [SOURCE_ENV]: roUrl, [TARGET_ENV]: tgtUrl, [ROLLBACK_ENV]: rbUrl,
    [SOURCE_HOST_ENV]: src.hostname, [SOURCE_PORT_ENV]: src.port,
    [ALLOWED_ENV]: `${src.hostname}:${src.port}/${src.pathname.replace(/^\//, '')}`,
  };
  const out: unknown[] = [];
  const run = async (...args: string[]) => { const r = await runCli(args, env); out.push(r.report); return r; };
  expect((await run('schema-status')).report).toMatchObject({ version: 0 });
  expect((await run('schema-up')).report).toMatchObject({ dryRun: true });
  expect((await run('schema-status')).report).toMatchObject({ version: 0 });
  expect((await run('schema-up', '--apply')).report).toMatchObject({ to: 11, applied: true });
  expect((await run('preflight')).code).toBe(0);
  expect((await run('import')).report).toMatchObject({ dryRun: true, inserted: 0 });
  expect(await countWhere(tgtUrl, `SELECT count(*)::int AS n FROM front_claw_perf.performance_entries`)).toBe(0);
  expect((await run('import', '--apply', '--source-label=synthetic-copy', '--batch=10')).code).toBe(0);
  const post = await run('postflight');
  expect(post.code).toBe(0);
  expect((await run('export-rollback')).report).toMatchObject({ dryRun: true });
  expect((await run('export-rollback', '--apply')).report).toMatchObject({ verified: true });
  const tgtParsed = new URL(tgtUrl);
  expect((await runCli(['import'], {
    ...env, [SOURCE_ENV]: tgtUrl,
    [SOURCE_HOST_ENV]: tgtParsed.hostname, [SOURCE_PORT_ENV]: tgtParsed.port,
    [ALLOWED_ENV]: `${tgtParsed.hostname}:${tgtParsed.port}/${tgtParsed.pathname.replace(/^\//, '')}`,
  })).report).toMatchObject({ error: 'source_same_as_target' });
  expect((await run('schema-down')).report).toMatchObject({ dryRun: true, from: 11 });
  const text = JSON.stringify(out);
  expect(text).not.toContain('postgres://');
  expect(text).not.toContain(srcUrl.split('@')[1]!);
}, 120_000);

it('真实PG：导入后被改的行严格后检报错；导入途中（预检之后）出现的冲突行 → 该批回滚、报冲突、不覆盖', async () => {
  const srcUrl = await source();
  const src = await openSql(srcUrl, { readOnly: true });
  const tgt = await target();
  await importData(src.client, tgt.sql.client, { apply: true, sourceLabel: 'x' });
  expect((await postflight(q(src), q(tgt.sql))).ok).toBe(true);
  await rawQuery(tgt.url, `UPDATE front_claw_perf.performance_entries SET amount = amount + 1 WHERE entry_id = (SELECT min(entry_id) FROM front_claw_perf.performance_entries)`);
  const strict = await postflight(q(src), q(tgt.sql));
  expect(strict.ok).toBe(false);
  expect(strict.errors).toContain('changed_since_import:performance_entries:1');
  expect((await postflight(q(src), q(tgt.sql), { allowChanged: true })).ok).toBe(true);
  // 竞态冲突：第一批提交后、后面的表导入前，另一写者塞进一笔同主键不同内容的账。
  const late = await target();
  const entry = (await rawQuery(srcUrl, `SELECT * FROM front_claw_perf.performance_entries ORDER BY entry_id LIMIT 1`))[0]!;
  let injected = false;
  await expect(importData(src.client, late.sql.client, { apply: true, sourceLabel: 'late', batchSize: 50, afterBatch: async table => {
    if (injected || table !== 'performance_people') return;
    injected = true;
    await rawQuery(late.url, `INSERT INTO front_claw_perf.performance_entries (entry_id, store_id, business_day, customer_name, amount, amount_type, owner_person_id, owner_name, reporter_person_id, note, status, disputed, created_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`, [entry.entry_id, entry.store_id, entry.business_day, entry.customer_name, 1, entry.amount_type, entry.owner_person_id, entry.owner_name, entry.reporter_person_id, 'other writer', entry.status, entry.disputed, entry.created_at]);
  } })).rejects.toThrow('import_conflict:performance_entries');
  expect((await rawQuery(late.url, `SELECT amount, note FROM front_claw_perf.performance_entries WHERE entry_id=$1`, [entry.entry_id]))).toEqual([{ amount: '1.00', note: 'other writer' }]);
  expect(await countWhere(late.url, `SELECT count(*)::int AS n FROM front_claw_perf.migration_import_rows WHERE table_name='performance_entries'`)).toBe(0);
  expect(await rawQuery(late.url, `SELECT status FROM front_claw_perf.migration_runs`)).toEqual([{ status: 'failed' }]);
  await src.close(); await tgt.sql.close(); await late.sql.close();
}, 120_000);
