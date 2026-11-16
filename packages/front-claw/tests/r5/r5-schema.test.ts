import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import {
  LATEST_SCHEMA_VERSION, MIGRATION_009_DOWN_PATH, MIGRATION_009_DOWN_SQL,
  MIGRATION_009_PATH, MIGRATION_009_SQL,
} from '../../src/role-eval/schema-migrations.js';

it('R5：009 文件与嵌入 String.raw 字节一致；R6 起 LATEST=11', () => {
  expect(LATEST_SCHEMA_VERSION).toBe(11);
  expect(readFileSync(MIGRATION_009_PATH, 'utf8')).toBe(MIGRATION_009_SQL);
  expect(readFileSync(MIGRATION_009_DOWN_PATH, 'utf8')).toBe(MIGRATION_009_DOWN_SQL);
});

it('R5：009 升：numeric(14,2)、status CHECK、amount_type 复用、store_targets；不新增 allocation/refund_flag/perf_type 列', () => {
  expect(MIGRATION_009_SQL).toContain('numeric(14,2)');
  expect(MIGRATION_009_SQL).toContain("CHECK (status IN ('pending', 'confirmed', 'voided'))");
  expect(MIGRATION_009_SQL).toContain("amount_type = 'consultant'");
  expect(MIGRATION_009_SQL).toContain('CREATE TABLE IF NOT EXISTS front_claw_perf.store_targets');
  expect(MIGRATION_009_SQL).not.toMatch(/\ballocation\b/);
  expect(MIGRATION_009_SQL).not.toMatch(/\brefund_flag\b/);
  expect(MIGRATION_009_SQL).not.toMatch(/\bperf_type\b/);
  expect(MIGRATION_009_SQL).toContain('unexpected_entry_status');
});

it('R5：009 down 在有角分时失败；整元才改回 integer；去掉 CHECK 和 store_targets；R6 先检查角分再改数据', () => {
  expect(MIGRATION_009_DOWN_SQL).toContain('cannot_down_fractional_amount');
  expect(MIGRATION_009_DOWN_SQL).toContain('TYPE integer');
  expect(MIGRATION_009_DOWN_SQL).toContain('DROP TABLE IF EXISTS front_claw_perf.store_targets');
  expect(MIGRATION_009_DOWN_SQL).toContain("status = 'recorded' WHERE status = 'confirmed'");
  expect(MIGRATION_009_DOWN_SQL).toContain("amount_type = '业绩'");
  const checkAt = MIGRATION_009_DOWN_SQL.indexOf('cannot_down_fractional_amount');
  const dropAt = MIGRATION_009_DOWN_SQL.indexOf('DROP TABLE');
  const updateAt = MIGRATION_009_DOWN_SQL.indexOf("SET status = 'recorded'");
  const alterAt = MIGRATION_009_DOWN_SQL.indexOf('TYPE integer');
  expect(checkAt).toBeGreaterThan(0);
  expect(checkAt).toBeLessThan(dropAt);
  expect(checkAt).toBeLessThan(updateAt);
  expect(checkAt).toBeLessThan(alterAt);
});
