// R2-5（D46）：真实 PG17 临时集群里建最小权限业务账号（只有 USAGE + 表级 DML，无 CREATE），用凭据文件启动并完成一笔报数。
// 只读挂载无法在无 sudo 下构造 → 由注入的挂载判定代替（REPORT 已注明）；全部合成数据。
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { DATABASE_URL_FILE, resetCredentialCacheForTests } from '../../src/role-eval/credential-file.js';
import { openPerformanceStore } from '../../src/role-eval/performance-open.js';
import { world } from '../role-eval/access-fixture-m03.js';
import { cluster, freshDatabase, open, rawQuery, useCluster } from '../migration/pg-harness-m08.js';

useCluster();
const dir = mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'r2-credpg-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

it('R2-PG-c1：业务账号（无 DDL 权限）经凭据文件启动 → 不建表不改表也能报数入账；同账号建表被 PG 拒绝', async () => {
  const url = await freshDatabase();
  const admin = await open(url); await admin.close(); // 迁移账号（此处为集群超级用户）先建 007 基线
  const role = `fc_biz_${Date.now()}`;
  const dbName = new URL(url).pathname.slice(1);
  await rawQuery(url, `CREATE ROLE ${role} LOGIN`);
  await rawQuery(url, `REVOKE CREATE ON SCHEMA public FROM PUBLIC`);
  await rawQuery(url, `GRANT CONNECT ON DATABASE ${dbName} TO ${role}`);
  await rawQuery(url, `GRANT USAGE ON SCHEMA front_claw_perf TO ${role}`);
  await rawQuery(url, `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA front_claw_perf TO ${role}`);
  await rawQuery(url, `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA front_claw_perf TO ${role}`);
  const bizUrl = `${cluster.base.replace('frontclaw@', `${role}:SYNTHETIC-biz@`)}/${dbName}`;
  const path = join(dir, 'biz-url'); writeFileSync(path, `${bizUrl}\n`, { mode: 0o600 }); chmodSync(path, 0o600);
  resetCredentialCacheForTests();
  const opened = await openPerformanceStore({ [DATABASE_URL_FILE]: path }, { requirePostgres: true, credentials: { readOnlyMount: () => true } });
  expect(opened.schemaVersion).toBe(7);
  const w = await world({ store: opened.store });
  expect(await w.call('m-wang-yj', '12号测试B店\n560（小赵）')).toContain('代报');
  expect(await w.call('m-wang-yj', '对')).toContain('已入账');
  expect((await rawQuery(url, `SELECT count(*)::int AS n FROM front_claw_perf.performance_entries WHERE amount=560`))[0]!.n).toBe(1);
  await opened.close();
  await expect(rawQuery(bizUrl, `CREATE TABLE front_claw_perf.x_probe(id int)`)).rejects.toThrow(/permission denied/);
}, 60_000);
