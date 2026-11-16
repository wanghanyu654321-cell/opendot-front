/**
 * R4（R3A-06）：临时 PG 上演示最小权限角色——只读角色不能直接写账本表。
 * 真正线上护栏与 D46 同一思路（账本表只许经统一入口所用语句写）；生产接线仍待 D46。
 */
import { expect, it } from 'vitest';
import { Client } from 'pg';
import { useCluster, freshDatabase, open, rawQuery } from '../migration/pg-harness-m08.js';
import { PERFORMANCE_SCHEMA } from '../../src/role-eval/performance-migration.js';

useCluster();

it('只读角色对 performance_entries 的 INSERT 被拒绝；有写权限的角色可以插入（演示）', async () => {
  const url = await freshDatabase();
  const db = await open(url);
  const admin = new Client({ connectionString: url });
  await admin.connect();
  const suffix = 'r4_' + Date.now().toString(36);
  const reader = 'fc_reader_' + suffix;
  const writer = 'fc_writer_' + suffix;
  const dbName = new URL(url).pathname.replace(/^\//, '');
  const insert = `INSERT INTO ${PERFORMANCE_SCHEMA}.performance_entries (entry_id, store_id, business_day, customer_name, amount, amount_type, owner_person_id, owner_name, reporter_person_id, note, status, disputed, created_at) VALUES ($1,'s','2026-11-12','x',1,'业绩','p','n','p','','recorded',false,'2026-11-12T02:00:00.000Z')`;
  try {
    await admin.query(`CREATE ROLE ${reader} LOGIN PASSWORD 'x'`);
    await admin.query(`CREATE ROLE ${writer} LOGIN PASSWORD 'x'`);
    await admin.query(`GRANT CONNECT ON DATABASE ${dbName} TO ${reader}, ${writer}`);
    await admin.query(`GRANT USAGE ON SCHEMA ${PERFORMANCE_SCHEMA} TO ${reader}, ${writer}`);
    await admin.query(`GRANT SELECT ON ALL TABLES IN SCHEMA ${PERFORMANCE_SCHEMA} TO ${reader}`);
    await admin.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${PERFORMANCE_SCHEMA} TO ${writer}`);
    const u = new URL(url);
    const readUrl = `postgres://${reader}:x@${u.host}${u.pathname}`;
    const writeUrl = `postgres://${writer}:x@${u.host}${u.pathname}`;
    await expect(rawQuery(readUrl, insert, ['e-read'])).rejects.toThrow();
    await rawQuery(writeUrl, insert, ['e-write']);
    const rows = await rawQuery(readUrl, `SELECT entry_id FROM ${PERFORMANCE_SCHEMA}.performance_entries WHERE entry_id=$1`, ['e-write']);
    expect(rows).toHaveLength(1);
  } finally {
    await admin.query(`REASSIGN OWNED BY ${reader}, ${writer} TO CURRENT_USER`).catch(() => {});
    await admin.query(`DROP OWNED BY ${reader}, ${writer}`).catch(() => {});
    await admin.query(`DROP ROLE IF EXISTS ${reader}`).catch(() => {});
    await admin.query(`DROP ROLE IF EXISTS ${writer}`).catch(() => {});
    await admin.end();
    await db.close();
  }
}, 30_000);
