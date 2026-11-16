import { expect, it, describe } from 'vitest';
import { Client } from 'pg';
import {
  migrateDown, migrateUp, schemaVersion, MIGRATION_008_SQL, MIGRATION_009_SQL, MIGRATION_010_SQL, sqlChecksum,
} from '../../src/role-eval/schema-migrations.js';
import { PERFORMANCE_MIGRATION_SQL, PERFORMANCE_SCHEMA } from '../../src/role-eval/performance-migration.js';
import { migratePerformance, createPostgresPerformanceStore } from '../../src/role-eval/performance-postgres.js';
import { openSql } from '../../src/migration/pg.js';
import { assertReadonlyRole } from '../../src/migration/pg.js';
import { freshDatabase, rawQuery, useCluster, createReadonlyRole, rawClient } from '../migration/pg-harness-m08.js';
import { confirmEntryId, type Draft, type LedgerEntry } from '../../src/role-eval/performance-store.js';

useCluster();

async function toV9(url: string) {
  const sql = await openSql(url);
  await migratePerformance(sql.client);
  await sql.client.query(MIGRATION_008_SQL);
  await sql.client.query(
    `INSERT INTO ${PERFORMANCE_SCHEMA}.schema_migrations (version, name, checksum) VALUES (7, '007_front_claw_perf', $1), (8, '008_front_claw_delivery', $2)`,
    [sqlChecksum(PERFORMANCE_MIGRATION_SQL), sqlChecksum(MIGRATION_008_SQL)],
  );
  // Apply only 009 by running its SQL and inserting version 9 (migrateUp would also apply 010).
  await sql.client.query(MIGRATION_009_SQL);
  await sql.client.query(
    `INSERT INTO ${PERFORMANCE_SCHEMA}.schema_migrations (version, name, checksum) VALUES (9, '009_front_claw_amounts', $1)`,
    [sqlChecksum(MIGRATION_009_SQL)],
  );
  return sql;
}

describe('R6 真实PG：009 计数与角分原子、010 重复 RAISE、只读角色、同草稿只记一笔', () => {
  it('009 升档 NOTICE 含 before/after 状态计数', async () => {
    const url = await freshDatabase();
    const sql = await openSql(url);
    await migratePerformance(sql.client);
    await sql.client.query(MIGRATION_008_SQL);
    await sql.client.query(
      `INSERT INTO ${PERFORMANCE_SCHEMA}.schema_migrations (version, name, checksum) VALUES (7, '007_front_claw_perf', $1), (8, '008_front_claw_delivery', $2)`,
      [sqlChecksum(PERFORMANCE_MIGRATION_SQL), sqlChecksum(MIGRATION_008_SQL)],
    );
    await rawQuery(url, `INSERT INTO ${PERFORMANCE_SCHEMA}.performance_entries
      (entry_id, store_id, business_day, customer_name, amount, amount_type, owner_person_id, owner_name, reporter_person_id, note, status, disputed, created_at)
      VALUES ('e-old','s-b','2026-11-12','张姐',680,'业绩','p-zhao','小赵','p-zhao','','recorded',false,'2026-11-12T02:00:00.000Z')`);
    const notices: string[] = [];
    const c = await rawClient(url);
    c.on('notice', msg => { notices.push(msg.message ?? String(msg)); });
    await c.query('BEGIN');
    await c.query(MIGRATION_009_SQL);
    await c.query('ROLLBACK');
    await c.end();
    expect(notices.some(n => /009 status counts before:.*recorded=1/.test(n))).toBe(true);
    expect(notices.some(n => /009 status counts after:.*confirmed=1/.test(n))).toBe(true);
    expect(await schemaVersion(sql.client.query.bind(sql.client))).toBe(8);
    await sql.close();
  }, 60_000);

  it('009 down：有角分时 RAISE，版本停在 9，角分行和状态都不变（先撤 010）', async () => {
    const url = await freshDatabase();
    const sql = await openSql(url);
    await migrateUp(sql.client, { apply: true });
    expect(await schemaVersion(sql.client.query.bind(sql.client))).toBe(11);
    await rawQuery(url, `INSERT INTO ${PERFORMANCE_SCHEMA}.performance_entries
      (entry_id, store_id, business_day, customer_name, amount, amount_type, owner_person_id, owner_name, reporter_person_id, note, status, disputed, created_at, source_draft_id, source_ordinal)
      VALUES ('e-frac','s-b','2026-11-12','张姐','680.50','consultant','p-zhao','小赵','p-zhao','','confirmed',false,'2026-11-12T02:00:00.000Z','e-frac',0)`);
    // D174：最新版本 011 先降到 010，保留原 009 角分护栏。
    expect(await migrateDown(sql.client, { apply: true })).toMatchObject({ from: 11, to: 10 });
    expect(await migrateDown(sql.client, { apply: true })).toMatchObject({ from: 10, to: 9 });
    const before = await rawQuery(url, `SELECT amount::text AS amount, status, amount_type FROM ${PERFORMANCE_SCHEMA}.performance_entries WHERE entry_id='e-frac'`);
    expect(before[0]).toMatchObject({ amount: '680.50', status: 'confirmed', amount_type: 'consultant' });
    await expect(migrateDown(sql.client, { apply: true })).rejects.toThrow(/cannot_down_fractional_amount/);
    expect(await schemaVersion(sql.client.query.bind(sql.client))).toBe(9);
    const after = await rawQuery(url, `SELECT amount::text AS amount, status, amount_type FROM ${PERFORMANCE_SCHEMA}.performance_entries WHERE entry_id='e-frac'`);
    expect(after).toEqual(before);
    const storeTargets = await rawQuery(url, `SELECT to_regclass('front_claw_perf.store_targets')::text AS t`);
    expect(storeTargets[0]!.t).toBe('front_claw_perf.store_targets');
    await sql.close();
  }, 60_000);

  it('010：已有重复 (source_draft_id, source_ordinal) 时 RAISE，版本仍 9，业务行不动', async () => {
    const url = await freshDatabase();
    const sql = await toV9(url);
    expect(await schemaVersion(sql.client.query.bind(sql.client))).toBe(9);
    await rawQuery(url, `ALTER TABLE ${PERFORMANCE_SCHEMA}.performance_entries ADD COLUMN IF NOT EXISTS source_draft_id text, ADD COLUMN IF NOT EXISTS source_ordinal integer`);
    await rawQuery(url, `INSERT INTO ${PERFORMANCE_SCHEMA}.performance_entries
      (entry_id, store_id, business_day, customer_name, amount, amount_type, owner_person_id, owner_name, reporter_person_id, note, status, disputed, created_at, source_draft_id, source_ordinal)
      VALUES
      ('e1','s-b','2026-11-12','张姐','680.00','consultant','p-zhao','小赵','p-zhao','','confirmed',false,'2026-11-12T02:00:00.000Z','draft-dup',0),
      ('e2','s-b','2026-11-12','李姐','200.00','consultant','p-zhao','小赵','p-zhao','','confirmed',false,'2026-11-12T02:00:01.000Z','draft-dup',0)`);
    const before = await rawQuery(url, `SELECT entry_id, source_draft_id, source_ordinal FROM ${PERFORMANCE_SCHEMA}.performance_entries ORDER BY entry_id`);
    await expect(migrateUp(sql.client, { apply: true })).rejects.toThrow(/duplicate_source_draft_id/);
    expect(await schemaVersion(sql.client.query.bind(sql.client))).toBe(9);
    const after = await rawQuery(url, `SELECT entry_id, source_draft_id, source_ordinal FROM ${PERFORMANCE_SCHEMA}.performance_entries ORDER BY entry_id`);
    expect(after).toEqual(before);
    const constraint = await rawQuery(url, `SELECT conname FROM pg_constraint WHERE conname='performance_entries_source_draft_unique'`);
    expect(constraint).toEqual([]);
    await sql.close();
  }, 60_000);

  it('同一草稿并发确认 / 重试只记一笔（ON CONFLICT DO NOTHING + 事务内查重）', async () => {
    const url = await freshDatabase();
    const sql = await openSql(url);
    await migrateUp(sql.client, { apply: true });
    const store = createPostgresPerformanceStore(sql.client, { deliveryColumns: true });
    const draft: Draft = {
      draftId: 'draft-once', reporterPersonId: 'p-zhao', storeId: 's-b', businessDay: '2026-11-12',
      expiresAt: '2026-11-13T00:00:00.000Z', kind: 'report',
      payload: { type: 'report', added: [{ employeeId: 'p-zhao', employeeName: '小赵', amount: 68000, customer: '张姐', note: '', amountType: 'consultant' }], missing: [], skipped: 0,
        employeeContext: { sessionId: 's', bindingVersion: 1, accountId: 'a', memberId: 'm-zhao', version: 'v', messageId: 'm', fingerprint: 'f', itemsDigest: 'd' } },
      status: 'confirming', reminder: 'none', voidNotice: 'none', createdAt: '2026-11-12T02:00:00.000Z', closedAt: null,
    };
    await store.saveDraft({ ...draft, status: 'pending' }, { ifAbsent: true });
    await store.transitionPendingDraft({ ...draft, status: 'pending' }, draft);
    const entry = (index: number): LedgerEntry => ({
      entryId: confirmEntryId(draft.draftId, index), storeId: 's-b', businessDay: '2026-11-12',
      customerName: '张姐', amount: 68000, amountType: 'consultant', ownerPersonId: 'p-zhao', ownerName: '小赵',
      reporterPersonId: 'p-zhao', note: '', status: 'confirmed', disputed: false, createdAt: '2026-11-12T02:00:00.000Z',
      sourceDraftId: draft.draftId, sourceOrdinal: index,
    });
    const a = await openSql(url);
    const b = await openSql(url);
    const storeA = createPostgresPerformanceStore(a.client, { deliveryColumns: true });
    const storeB = createPostgresPerformanceStore(b.client, { deliveryColumns: true });
    const confirmed: Draft = { ...draft, status: 'confirmed', closedAt: '2026-11-12T02:00:01.000Z' };
    await Promise.all([
      storeA.commitConfirmingDraft(confirmed, [entry(0)]),
      storeB.commitConfirmingDraft(confirmed, [entry(0)]),
    ]);
    const rows = await rawQuery(url, `SELECT entry_id, source_draft_id, source_ordinal FROM ${PERFORMANCE_SCHEMA}.performance_entries`);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source_draft_id: 'draft-once', source_ordinal: 0 });
    // 再重试同一草稿仍是一笔
    const c = await openSql(url);
    const again = await createPostgresPerformanceStore(c.client, { deliveryColumns: true }).commitConfirmingDraft(confirmed, [entry(0)]);
    expect((await rawQuery(url, `SELECT count(*)::int AS n FROM ${PERFORMANCE_SCHEMA}.performance_entries`))[0]!.n).toBe(1);
    void again;
    await a.close(); await b.close(); await c.close(); await sql.close();
  }, 60_000);

  it('M08-02：专用只读角色正例通过、超级用户/有写权限反例拒绝；SET 也写不进去', async () => {
    const url = await freshDatabase();
    const sql = await openSql(url);
    await migrateUp(sql.client, { apply: true });
    await rawQuery(url, `INSERT INTO ${PERFORMANCE_SCHEMA}.performance_config (key, value) VALUES ('k','v')`);
    // 反例：超级用户
    await expect(assertReadonlyRole(sql.client.query.bind(sql.client))).rejects.toThrow(/source_role_is_superuser|source_role_has_write/);
    await expect(openSql(url, { readOnly: true, requireReadonlyRole: true })).rejects.toThrow(/source_role_is_superuser|source_role_has_write/);
    const roUrl = await createReadonlyRole(url);
    const ro = await openSql(roUrl, { readOnly: true, requireReadonlyRole: true });
    const read = await ro.client.query(`SELECT key, value FROM ${PERFORMANCE_SCHEMA}.performance_config WHERE key=$1`, ['k']);
    expect(read.rows).toEqual([{ key: 'k', value: 'v' }]);
    await expect(ro.client.query(`INSERT INTO ${PERFORMANCE_SCHEMA}.performance_config (key, value) VALUES ('x','y')`)).rejects.toThrow();
    // 事务里试图关掉只读再写：BEGIN TRANSACTION READ ONLY 下 SET 也无法写入
    await expect(ro.client.transaction(async query => {
      await query('SET TRANSACTION READ WRITE').catch(() => {});
      return query(`INSERT INTO ${PERFORMANCE_SCHEMA}.performance_config (key, value) VALUES ('z','w')`);
    })).rejects.toThrow();
    const still = await rawQuery(url, `SELECT key FROM ${PERFORMANCE_SCHEMA}.performance_config ORDER BY key`);
    expect(still.map(r => r.key)).toEqual(['k']);
    // 有 INSERT 权限的非超管角色也被拒绝
    const parsed = new URL(url);
    const db = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
    const admin = new Client({ connectionString: url });
    await admin.connect();
    await admin.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='frontclaw_migrate_rw') THEN CREATE ROLE frontclaw_migrate_rw LOGIN NOSUPERUSER; END IF; END $$`);
    await admin.query(`GRANT CONNECT ON DATABASE ${db} TO frontclaw_migrate_rw`);
    await admin.query(`GRANT USAGE, CREATE ON SCHEMA front_claw_perf TO frontclaw_migrate_rw`);
    await admin.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA front_claw_perf TO frontclaw_migrate_rw`);
    await admin.end();
    const rwUrl = `postgres://frontclaw_migrate_rw@${parsed.hostname}:${parsed.port}/${encodeURIComponent(db)}`;
    await expect(openSql(rwUrl, { readOnly: true, requireReadonlyRole: true })).rejects.toThrow(/source_role_has_write|source_role_has_ddl/);
    await ro.close();
    await sql.close();
  }, 60_000);
});
