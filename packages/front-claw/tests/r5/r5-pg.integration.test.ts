import { expect, it } from 'vitest';
import { migrateDown, migrateUp, schemaVersion, MIGRATION_008_SQL, sqlChecksum } from '../../src/role-eval/schema-migrations.js';
import { PERFORMANCE_MIGRATION_SQL, PERFORMANCE_SCHEMA } from '../../src/role-eval/performance-migration.js';
import { createPostgresPerformanceStore } from '../../src/role-eval/performance-postgres.js';
import { fromPgNumeric, toPgNumeric, sumCents, formatYuan } from '../../src/role-eval/money.js';
import { openSql } from '../../src/migration/pg.js';
import { freshDatabase, rawQuery, useCluster } from '../migration/pg-harness-m08.js';

useCluster();

async function up(url: string) {
  const sql = await openSql(url);
  const result = await migrateUp(sql.client, { apply: true });
  return { sql, result };
}

it('真实PG：009 升：integer→numeric(14,2)；recorded/void/业绩 改写；CHECK；store_targets', async () => {
  const url = await freshDatabase();
  const sql = await openSql(url);
  // 先到 v8（007+008），插入旧口径行，再升 009。
  const { migratePerformance } = await import('../../src/role-eval/performance-postgres.js');
  await migratePerformance(sql.client);
  await sql.client.query(MIGRATION_008_SQL);
  await sql.client.query(
    `INSERT INTO ${PERFORMANCE_SCHEMA}.schema_migrations (version, name, checksum) VALUES (7, '007_front_claw_perf', $1), (8, '008_front_claw_delivery', $2)`,
    [sqlChecksum(PERFORMANCE_MIGRATION_SQL), sqlChecksum(MIGRATION_008_SQL)],
  );
  await rawQuery(url, `INSERT INTO ${PERFORMANCE_SCHEMA}.performance_entries
    (entry_id, store_id, business_day, customer_name, amount, amount_type, owner_person_id, owner_name, reporter_person_id, note, status, disputed, created_at)
    VALUES ('e-old','s-b','2026-11-12','张姐',680,'业绩','p-zhao','小赵','p-zhao','','recorded',false,'2026-11-12T02:00:00.000Z')`);
  await rawQuery(url, `INSERT INTO ${PERFORMANCE_SCHEMA}.performance_entries
    (entry_id, store_id, business_day, customer_name, amount, amount_type, owner_person_id, owner_name, reporter_person_id, note, status, disputed, created_at)
    VALUES ('e-void','s-b','2026-11-12','李姐',100,'业绩','p-zhao','小赵','p-zhao','','void',false,'2026-11-12T02:00:00.000Z')`);
  expect(await schemaVersion(sql.client.query.bind(sql.client))).toBe(8);
  expect(await migrateUp(sql.client, { apply: true })).toMatchObject({ from: 8, to: 11, applied: true });
  const cols = await rawQuery(url, `SELECT data_type, numeric_precision, numeric_scale FROM information_schema.columns
    WHERE table_schema='front_claw_perf' AND table_name='performance_entries' AND column_name='amount'`);
  expect(cols[0]).toMatchObject({ data_type: 'numeric', numeric_precision: 14, numeric_scale: 2 });
  const rows = await rawQuery(url, `SELECT entry_id, amount, amount_type, status FROM ${PERFORMANCE_SCHEMA}.performance_entries ORDER BY entry_id`);
  expect(rows).toEqual([
    expect.objectContaining({ entry_id: 'e-old', amount_type: 'consultant', status: 'confirmed' }),
    expect.objectContaining({ entry_id: 'e-void', amount_type: 'consultant', status: 'voided' }),
  ]);
  expect(fromPgNumeric(rows[0]!.amount)).toBe(68000);
  expect(fromPgNumeric(rows[1]!.amount)).toBe(10000);
  expect(String(rows[0]!.amount)).toBe('680.00');
  const tables = await rawQuery(url, `SELECT to_regclass('front_claw_perf.store_targets')::text AS t`);
  expect(tables[0]!.t).toBe('front_claw_perf.store_targets');
  await expect(rawQuery(url, `INSERT INTO ${PERFORMANCE_SCHEMA}.performance_entries
    (entry_id, store_id, business_day, customer_name, amount, amount_type, owner_person_id, owner_name, reporter_person_id, note, status, disputed, created_at)
    VALUES ('e-bad','s-b','2026-11-12','x',1,'consultant','p','n','p','','recorded',false,'2026-11-12T02:00:00.000Z')`)).rejects.toThrow();
  await sql.close();
}, 60_000);

it('真实PG：009 遇意外 status 整体失败、版本仍 8', async () => {
  const url = await freshDatabase();
  const sql = await openSql(url);
  const { migratePerformance } = await import('../../src/role-eval/performance-postgres.js');
  await migratePerformance(sql.client);
  await sql.client.query(MIGRATION_008_SQL);
  await sql.client.query(
    `INSERT INTO ${PERFORMANCE_SCHEMA}.schema_migrations (version, name, checksum) VALUES (7, '007_front_claw_perf', $1), (8, '008_front_claw_delivery', $2)`,
    [sqlChecksum(PERFORMANCE_MIGRATION_SQL), sqlChecksum(MIGRATION_008_SQL)],
  );
  await rawQuery(url, `INSERT INTO ${PERFORMANCE_SCHEMA}.performance_entries
    (entry_id, store_id, business_day, customer_name, amount, amount_type, owner_person_id, owner_name, reporter_person_id, note, status, disputed, created_at)
    VALUES ('e-weird','s-b','2026-11-12','x',1,'业绩','p','n','p','','weird',false,'2026-11-12T02:00:00.000Z')`);
  await expect(migrateUp(sql.client, { apply: true })).rejects.toThrow(/unexpected_entry_status/);
  expect(await schemaVersion(sql.client.query.bind(sql.client))).toBe(8);
  const cols = await rawQuery(url, `SELECT data_type FROM information_schema.columns WHERE table_schema='front_claw_perf' AND table_name='performance_entries' AND column_name='amount'`);
  expect(cols[0]!.data_type).toBe('integer');
  await sql.close();
}, 60_000);

it('真实PG：680.5 与 0.1+0.2 经 numeric 字符串进出，合计精确；角分 down 失败', async () => {
  const url = await freshDatabase();
  const { sql } = await up(url);
  const store = createPostgresPerformanceStore(sql.client, { deliveryColumns: true });
  await store.insertEntries([
    {
      entryId: 'e-a', storeId: 's-b', businessDay: '2026-11-12', customerName: '张姐',
      amount: 68050, amountType: 'consultant', ownerPersonId: 'p-zhao', ownerName: '小赵',
      reporterPersonId: 'p-zhao', note: '', status: 'confirmed', disputed: false, createdAt: '2026-11-12T02:00:00.000Z',
    },
    {
      entryId: 'e-b', storeId: 's-b', businessDay: '2026-11-12', customerName: '李姐',
      amount: 10, amountType: 'consultant', ownerPersonId: 'p-zhao', ownerName: '小赵',
      reporterPersonId: 'p-zhao', note: '', status: 'confirmed', disputed: false, createdAt: '2026-11-12T02:00:00.000Z',
    },
    {
      entryId: 'e-c', storeId: 's-b', businessDay: '2026-11-12', customerName: '王姐',
      amount: 20, amountType: 'consultant', ownerPersonId: 'p-zhao', ownerName: '小赵',
      reporterPersonId: 'p-zhao', note: '', status: 'confirmed', disputed: false, createdAt: '2026-11-12T02:00:00.000Z',
    },
  ]);
  const raw = await rawQuery(url, `SELECT entry_id, amount::text AS amount FROM ${PERFORMANCE_SCHEMA}.performance_entries ORDER BY entry_id`);
  expect(raw.map(r => r.amount)).toEqual(['680.50', '0.10', '0.20']);
  const listed = await store.listEntries({ storeId: 's-b', status: 'confirmed' });
  expect(listed.map(e => e.amount).sort((a, b) => a - b)).toEqual([10, 20, 68050]);
  expect(sumCents(listed.map(e => e.amount))).toBe(68080);
  expect(formatYuan(sumCents(listed.map(e => e.amount))!)).toBe('680.8');
  const pgSum = await rawQuery(url, `SELECT sum(amount)::text AS s FROM ${PERFORMANCE_SCHEMA}.performance_entries`);
  expect(pgSum[0]!.s).toBe('680.80');
  expect(fromPgNumeric(pgSum[0]!.s)).toBe(68080);
  expect(toPgNumeric(68050)).toBe('680.50');
  await store.saveStoreTarget({ storeId: 's-b', periodMonth: '2026-11', amount: 5_000_000, setBy: 'p-wang-yj', updatedAt: '2026-11-12T02:00:00.000Z' });
  expect((await store.getStoreTarget('s-b', '2026-11'))?.amount).toBe(5_000_000);
  // 先撤 010（10→9），009 的角分检查才生效；失败则版本停在 9、数据不动。
  // 011 尚未发布，新增员工 pending 唯一索引及 D183 序列；先撤它，再保持原 010/009 语义。
  expect(await migrateDown(sql.client, { apply: true })).toMatchObject({ from: 11, to: 10, applied: true });
  expect(await migrateDown(sql.client, { apply: true })).toMatchObject({ from: 10, to: 9, applied: true });
  await expect(migrateDown(sql.client, { apply: true })).rejects.toThrow(/cannot_down_fractional_amount/);
  expect(await schemaVersion(sql.client.query.bind(sql.client))).toBe(9);
  await sql.close();
}, 60_000);

it('真实PG：整元 009 down → integer + recorded + 业绩，store_targets 删除', async () => {
  const url = await freshDatabase();
  const { sql } = await up(url);
  await rawQuery(url, `INSERT INTO ${PERFORMANCE_SCHEMA}.performance_entries
    (entry_id, store_id, business_day, customer_name, amount, amount_type, owner_person_id, owner_name, reporter_person_id, note, status, disputed, created_at)
    VALUES ('e-w','s-b','2026-11-12','张姐','680.00','consultant','p-zhao','小赵','p-zhao','','confirmed',false,'2026-11-12T02:00:00.000Z')`);
  await rawQuery(url, `INSERT INTO ${PERFORMANCE_SCHEMA}.store_targets (store_id, period_month, amount, set_by, updated_at) VALUES ('s-b','2026-11','50000.00','p','2026-11-12T02:00:00.000Z')`);
  // 011 尚未发布，新增员工 pending 唯一索引及 D183 序列；先撤它，再保持原 010/009 语义。
  expect(await migrateDown(sql.client, { apply: true })).toMatchObject({ from: 11, to: 10, applied: true });
  expect(await migrateDown(sql.client, { apply: true })).toMatchObject({ from: 10, to: 9, applied: true });
  expect(await migrateDown(sql.client, { apply: true })).toMatchObject({ from: 9, to: 8, applied: true });
  const cols = await rawQuery(url, `SELECT data_type FROM information_schema.columns WHERE table_schema='front_claw_perf' AND table_name='performance_entries' AND column_name='amount'`);
  expect(cols[0]!.data_type).toBe('integer');
  const rows = await rawQuery(url, `SELECT amount, amount_type, status FROM ${PERFORMANCE_SCHEMA}.performance_entries WHERE entry_id='e-w'`);
  expect(rows[0]).toMatchObject({ amount: 680, amount_type: '业绩', status: 'recorded' });
  expect((await rawQuery(url, `SELECT to_regclass('front_claw_perf.store_targets')::text AS t`))[0]!.t).toBeNull();
  await sql.close();
}, 60_000);
