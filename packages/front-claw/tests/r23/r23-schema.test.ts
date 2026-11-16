import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { MIGRATION_011_PATH, MIGRATION_011_SQL, MIGRATION_011_DOWN_PATH, MIGRATION_011_DOWN_SQL } from '../../src/role-eval/schema-migrations.js';
it('R23 011 up/down 与内嵌 SQL 一致，唯一索引只约束员工 pending', () => {
  expect(readFileSync(MIGRATION_011_PATH, 'utf8')).toBe(MIGRATION_011_SQL);
  expect(readFileSync(MIGRATION_011_DOWN_PATH, 'utf8')).toBe(MIGRATION_011_DOWN_SQL);
  expect(MIGRATION_011_SQL).toMatch(/CREATE UNIQUE INDEX performance_drafts_pending_reporter_unique\s+ON front_claw_perf.performance_drafts \(reporter_person_id\) WHERE status = 'pending'/);
  expect(MIGRATION_011_DOWN_SQL).toContain('DROP INDEX IF EXISTS front_claw_perf.performance_drafts_pending_reporter_unique');
});

it('R23 011 up/down 只增撤索引与序列，不改写业务行', () => {
  for (const sql of [MIGRATION_011_SQL, MIGRATION_011_DOWN_SQL]) {
    expect(sql.replace(/--[^\n]*/g, '')).not.toMatch(/\b(?:UPDATE|INSERT|DELETE|TRUNCATE)\b/i);
  }
  expect(MIGRATION_011_SQL).toContain('CREATE SEQUENCE IF NOT EXISTS front_claw_perf.pending_order_seq');
  expect(MIGRATION_011_DOWN_SQL).toContain('DROP SEQUENCE IF EXISTS front_claw_perf.pending_order_seq');
});
