import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { MIGRATION_008_DOWN_PATH, MIGRATION_008_DOWN_SQL, MIGRATION_008_PATH, MIGRATION_008_SQL, SCHEMA_LOCK, IMPORT_LOCK, inTransaction } from '../../src/role-eval/schema-migrations.js';
import { createPostgresPerformanceStore, migratePerformance, type SqlClient } from '../../src/role-eval/performance-postgres.js';
import { ACCESS_POLICY_HIGH_WATER_KEY, ACCESS_POLICY_KEY, updateAccessPolicy } from '../../src/role-eval/access-policy.js';
import { MemoryPerformanceStore } from '../../src/role-eval/performance-store.js';
import { assertSafeUrl, sameDatabase } from '../../src/migration/guards.js';
import { runCli, TARGET_ENV, SOURCE_ENV, ROLLBACK_ENV } from '../../src/migration/cli.js';
import { SUPPRESSED_ERROR, synthesizedNotices, transformRow } from '../../src/migration/transform.js';
import { TABLES } from '../../src/migration/tables.js';
import { draftReminderId, draftVoidNoticeId } from '../../src/role-eval/notification-dispatch.js';
import { MemorySql } from '../role-eval/sql-fixture.js';
import { policyM05 } from '../role-eval/appointment-fixture-m05.js';

const spec = (name: string) => TABLES.find(t => t.name === name)!;
const at = '2026-11-12T02:00:00.000Z';

describe('M08 迁移 008：正文、加法性、down 只删 008 对象', () => {
  it('TS 常量与 migrations/*.sql 逐字节一致；up 不删不清任何东西；down 只删 008 自己建的触发器/函数/索引/列', () => {
    expect(readFileSync(MIGRATION_008_PATH, 'utf8')).toBe(MIGRATION_008_SQL);
    expect(readFileSync(MIGRATION_008_DOWN_PATH, 'utf8')).toBe(MIGRATION_008_DOWN_SQL);
    const code = (sql: string) => sql.replace(/--[^\n]*/g, '');
    expect(code(MIGRATION_008_SQL)).not.toMatch(/\b(TRUNCATE|DELETE\s+FROM|DROP\s+(TABLE|SCHEMA|COLUMN|INDEX|FUNCTION))\b/i);
    expect(code(MIGRATION_008_SQL).match(/\bDROP\b[^;]*/gi)).toEqual(['DROP TRIGGER IF EXISTS notification_delivery_sync ON front_claw_perf.performance_notifications']);
    const down = code(MIGRATION_008_DOWN_SQL);
    expect(down).not.toMatch(/\b(TRUNCATE|DELETE|DROP\s+TABLE|DROP\s+SCHEMA|UPDATE)\b/i);
    const dropped = [...down.matchAll(/DROP (INDEX|TRIGGER|FUNCTION|COLUMN) IF EXISTS ([\w.]+)/g)].map(m => `${m[1]} ${m[2]}`);
    const created = [...code(MIGRATION_008_SQL).matchAll(/ADD COLUMN IF NOT EXISTS (\w+)/g)].map(m => `COLUMN ${m[1]}`);
    expect(dropped).toEqual(['INDEX front_claw_perf.performance_notifications_due_idx', 'TRIGGER notification_delivery_sync', 'FUNCTION front_claw_perf.notification_delivery_sync', ...created]);
    expect(created).toHaveLength(11); // R1：+delivery_fence
    // 只改 front_claw_perf；没碰 007 的建表语句；没有新的迁移号冲突（只有 007 与 008）。
    expect([...code(MIGRATION_008_SQL).matchAll(/(?:TABLE|ON|FUNCTION|INDEX IF NOT EXISTS \w+\s+ON)\s+([\w.]+)/g)].map(m => m[1]).filter(n => n!.includes('.')).every(n => n!.startsWith('front_claw_perf.'))).toBe(true);
    expect(readFileSync('migrations/007_front_claw_perf.sql', 'utf8')).not.toContain('delivery_');
  });
  it('启动不自动升 008（只跑 007 基线并探测版本）；v8 用索引化到期条件，v7 仍用原文本条件', async () => {
    const open = readFileSync('src/role-eval/performance-open.ts', 'utf8');
    expect(open).not.toMatch(/migrateUp|MIGRATION_008/);
    expect(open).toContain('schemaVersion(');
    const seen: string[] = [];
    const client: SqlClient = {
      async query(sql) { seen.push(sql.replace(/\s+/g, ' ')); return { rows: [] }; },
      async transaction(work) { return work(async (sql, params) => client.query(sql, params)); },
    };
    const options = { kinds: ['appointment' as const], nowIso: at, limit: 5, leaseUntil: at, worker: 'w', tokenFor: () => 't' };
    await createPostgresPerformanceStore(client, { deliveryColumns: true }).claimDueNotifications(options);
    await createPostgresPerformanceStore(client).claimDueNotifications(options);
    expect(seen[0]).toContain('delivery_due_at <= $2::timestamptz');
    expect(seen[0]).not.toContain('split_part');
    expect(seen[1]).toContain("split_part(status, '|', 2) <= $2");
  });
});

describe('M08 advisory lock 与策略首写', () => {
  it('migratePerformance 在一个事务里先拿 schema 锁再执行 007 语句', async () => {
    const sql = new MemorySql();
    const order: string[] = [];
    const query = sql.query.bind(sql);
    sql.query = (async (text: string, params?: readonly unknown[]) => { order.push(text.trim().split(/\s+/).slice(0, 3).join(' ')); return query(text, params); }) as typeof sql.query;
    await migratePerformance(sql);
    expect(sql.advisoryLocks).toEqual([[...SCHEMA_LOCK]]);
    expect(order[0]).toBe('BEGIN');
    expect(order[1]).toBe('SELECT pg_advisory_xact_lock($1, $2)');
    expect(order.at(-1)).toBe('COMMIT');
    expect(SCHEMA_LOCK).not.toEqual(IMPORT_LOCK);
  });
  it('updateAccessPolicy 先补高水位行再以它为第一把锁；缺策略时首写成功，第二个 null 首写 version_conflict', async () => {
    const store = new MemoryPerformanceStore();
    const insert = vi.spyOn(store, 'insertConfigIfAbsent');
    const locked = vi.spyOn(store, 'updateConfigLocked');
    expect(await updateAccessPolicy(store, { expectedVersion: null, next: policyM05(1), actor: 'a', reason: 'r', at })).toEqual({ ok: true, version: 1 });
    expect(insert).toHaveBeenCalledWith(ACCESS_POLICY_HIGH_WATER_KEY, '0');
    expect(locked.mock.calls[0]!.slice(0, 2)).toEqual([ACCESS_POLICY_HIGH_WATER_KEY, [ACCESS_POLICY_KEY]]);
    expect(await updateAccessPolicy(store, { expectedVersion: null, next: policyM05(2), actor: 'b', reason: 'r', at })).toEqual({ ok: false, reason: 'version_conflict' });
    expect(JSON.parse((await store.getConfig(ACCESS_POLICY_KEY))!).version).toBe(1);
  });
  it('dry-run 事务：照常执行再整体回滚，返回结果', async () => {
    const sql = new MemorySql();
    await migratePerformance(sql);
    const result = await inTransaction(sql, false, async query => { await query(`INSERT INTO front_claw_perf.performance_config (key, value) VALUES ($1,$2)`, ['k', 'v']); return 'planned'; });
    expect(result).toBe('planned');
    expect((await sql.query(`SELECT * FROM front_claw_perf.performance_config WHERE key=$1`, ['k'])).rows).toEqual([]);
  });
});

describe('M08 守卫与 CLI（永不连共用 PG；默认 dry-run；不打印连接串）', () => {
  it('URL 含 legacy-shared-pg / legacy_appointment_db（含编码）一律拒绝；同库判定', () => {
    for (const url of ['postgres://u:p@legacy-shared-pg:5432/x', 'postgres://u@10.0.0.5/legacy_appointment_db', 'postgresql://u@h/db?host=legacy-shared-pg-20261008-r1',
      'postgres://u@h/%6Cegacy_appointment_db', 'postgres://u@LEGACY-SHARED-PG-20261008-R1/x']) expect(() => assertSafeUrl(url, 'target'), url).toThrow('forbidden_target_database');
    expect(() => assertSafeUrl('', 'source')).toThrow('missing_source_url');
    expect(() => assertSafeUrl('mysql://h/db', 'source')).toThrow('invalid_source_url');
    expect(() => assertSafeUrl('postgres://frontclaw@127.0.0.1:5555/m08_case_1', 'target')).not.toThrow();
    expect(sameDatabase('postgres://a@H:5432/db', 'postgres://b:pw@h/db')).toBe(true);
    expect(sameDatabase('postgres://a@h:5432/db', 'postgres://a@h:5433/db')).toBe(false);
  });
  it('CLI：被拒的库不会被连接；未知命令给用法；错误信息不含连接串', async () => {
    const open = vi.fn();
    for (const command of ['schema-up', 'import', 'export-rollback', 'preflight']) {
      const bad = await runCli([command, '--apply'], { [TARGET_ENV]: 'postgres://u:secret@legacy-shared-pg-20261008-r1:5432/front', [SOURCE_ENV]: 'postgres://u@x/legacy_appointment_db', [ROLLBACK_ENV]: 'postgres://u@y/z' }, { open });
      expect(bad.code).toBe(1);
      expect(JSON.stringify(bad.report)).not.toContain('secret');
    }
    const badSource = await runCli(['import', '--apply'], { [TARGET_ENV]: 'postgres://u@t/a', [SOURCE_ENV]: 'postgres://u@x/legacy_appointment_db' }, { open });
    expect(badSource.report).toMatchObject({ error: 'forbidden_source_database' });
    const badRollback = await runCli(['export-rollback', '--apply'], { [TARGET_ENV]: 'postgres://u@t/a', [ROLLBACK_ENV]: 'postgres://u@legacy-shared-pg/a' }, { open });
    expect(badRollback.report).toMatchObject({ error: 'forbidden_rollback_database' });
    const sameRb = await runCli(['export-rollback'], { [TARGET_ENV]: 'postgres://u@t/a', [ROLLBACK_ENV]: 'postgres://v@t:5432/a' }, { open });
    expect(sameRb.report).toMatchObject({ error: 'rollback_same_as_target' });
    expect(open).not.toHaveBeenCalled();
    expect((await runCli(['drop-everything'], {}, { open })).code).toBe(2);
    const failing = await runCli(['schema-status'], { [TARGET_ENV]: 'postgres://u:pw@t/a' }, { open: async () => { throw Error('connect failed for postgres://u:pw@t/a'); } });
    expect(JSON.stringify(failing.report)).not.toContain('pw@');
  });
});

describe('M08 转换规则', () => {
  it('pending_manager→registered；pending* 通知→not_sent 抑制（计数保留）；终态通知原样；租约行不迁；历史草稿通知置 unknown', () => {
    expect(transformRow(spec('performance_appointments'), { status: 'pending_manager', appointment_id: 'a' })).toEqual({ row: { status: 'registered', appointment_id: 'a' }, transform: 'appointment_pending_manager_to_registered' });
    expect(transformRow(spec('performance_appointments'), { status: 'confirmed' })!.transform).toBe('copy');
    for (const status of ['pending', 'pending|2026-11-12T02:00:00.000Z|queued|a=2|r=1|err=x', 'pending|2026-11-12T02:00:00.000Z|sending|a=1|r=0|tok=t|by=w', 'pending|garbage']) {
      const out = transformRow(spec('performance_notifications'), { status })!;
      expect(out.transform, status).toBe('notification_pending_suppressed');
      expect(String(out.row.status), status).toMatch(new RegExp(`^not_sent\\|-\\|-\\|a=\\d+\\|r=\\d+\\|err=${SUPPRESSED_ERROR}$`));
    }
    expect(transformRow(spec('performance_notifications'), { status: 'pending|2026-11-12T02:00:00.000Z|queued|a=2|r=1' })!.row.status).toBe(`not_sent|-|-|a=2|r=1|err=${SUPPRESSED_ERROR}`);
    for (const status of ['sent|-|-|a=1|r=0', 'unknown|-|-|a=1|r=0|err=x', 'not_sent|-|-|a=5|r=0', 'sent']) expect(transformRow(spec('performance_notifications'), { status })!.transform).toBe('copy');
    expect(transformRow(spec('performance_config'), { key: 'front-claw-opendot-consumer', value: '{}' })).toBeNull();
    expect(transformRow(spec('performance_config'), { key: 'front-claw-access-policy', value: '{}' })!.transform).toBe('copy');
    expect(transformRow(spec('performance_drafts'), { kind: 'report', status: 'pending', reminder: 'none', void_notice: 'none' })!.row).toMatchObject({ reminder: 'unknown', void_notice: 'unknown' });
    expect(transformRow(spec('performance_drafts'), { kind: 'report', status: 'confirmed', reminder: 'none', void_notice: 'none' })!.transform).toBe('copy');
    expect(transformRow(spec('performance_drafts'), { kind: 'report', status: 'void', reminder: 'sent', void_notice: 'none' })!.row).toMatchObject({ reminder: 'sent', void_notice: 'unknown' });
  });
  it('历史报数草稿：按 M06 确定性 ID 合成已抑制通知（待确认 2 条、已作废 1 条）；源里已有同 ID 则不合成', () => {
    const drafts = [
      { draft_id: 'd1', kind: 'report', status: 'pending', reporter_person_id: 'p', created_at: at },
      { draft_id: 'd2', kind: 'report', status: 'void', reporter_person_id: 'p', created_at: at },
      { draft_id: 'd3', kind: 'report', status: 'confirmed', reporter_person_id: 'p', created_at: at },
      { draft_id: 'd4', kind: 'target', status: 'pending', reporter_person_id: 'p', created_at: at },
    ];
    const out = synthesizedNotices(drafts, new Set([draftVoidNoticeId('d1')]));
    expect(out.map(o => o.row.notification_id)).toEqual([draftReminderId('d1'), draftVoidNoticeId('d2')]);
    expect(out.every(o => String(o.row.status).startsWith('not_sent|') && o.row.status!.toString().endsWith(SUPPRESSED_ERROR))).toBe(true);
  });
});
