import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  LATEST_SCHEMA_VERSION,
  MIGRATION_009_DOWN_PATH, MIGRATION_009_DOWN_SQL, MIGRATION_009_PATH, MIGRATION_009_SQL,
  MIGRATION_010_DOWN_PATH, MIGRATION_010_DOWN_SQL, MIGRATION_010_PATH, MIGRATION_010_SQL,
} from '../../src/role-eval/schema-migrations.js';

describe('R6 009 / 010 迁移文本', () => {
  it('文件与 String.raw 逐字节一致；LATEST=11', () => {
    expect(LATEST_SCHEMA_VERSION).toBe(11);
    expect(readFileSync(MIGRATION_009_PATH, 'utf8')).toBe(MIGRATION_009_SQL);
    expect(readFileSync(MIGRATION_009_DOWN_PATH, 'utf8')).toBe(MIGRATION_009_DOWN_SQL);
    expect(readFileSync(MIGRATION_010_PATH, 'utf8')).toBe(MIGRATION_010_SQL);
    expect(readFileSync(MIGRATION_010_DOWN_PATH, 'utf8')).toBe(MIGRATION_010_DOWN_SQL);
  });

  it('009 升/降档打印状态计数；down 先检查角分再 DROP/UPDATE；无嵌套 BEGIN/COMMIT', () => {
    expect(MIGRATION_009_SQL).toContain('009 status counts before');
    expect(MIGRATION_009_SQL).toContain('009 status counts after');
    expect(MIGRATION_009_DOWN_SQL).toContain('009 down status counts before');
    expect(MIGRATION_009_DOWN_SQL).toContain('009 down status counts after');
    const checkAt = MIGRATION_009_DOWN_SQL.indexOf('cannot_down_fractional_amount');
    expect(checkAt).toBeGreaterThan(0);
    expect(checkAt).toBeLessThan(MIGRATION_009_DOWN_SQL.indexOf('DROP TABLE'));
    expect(checkAt).toBeLessThan(MIGRATION_009_DOWN_SQL.indexOf("SET status = 'recorded'"));
    expect(checkAt).toBeLessThan(MIGRATION_009_DOWN_SQL.indexOf('TYPE integer'));
    expect(MIGRATION_009_SQL).not.toMatch(/^BEGIN\s*;/m);
    expect(MIGRATION_009_SQL).not.toMatch(/^COMMIT\s*;/m);
    expect(MIGRATION_009_DOWN_SQL).not.toMatch(/^BEGIN\s*;/m);
    expect(MIGRATION_009_DOWN_SQL).not.toMatch(/^COMMIT\s*;/m);
  });

  it('010：唯一约束是 (source_draft_id, source_ordinal)，绝不是客户+营业日；加约束前检查重复并 RAISE；有 down', () => {
    expect(MIGRATION_010_SQL).toContain('UNIQUE (source_draft_id, source_ordinal)');
    expect(MIGRATION_010_SQL).toContain('duplicate_source_draft_id');
    expect(MIGRATION_010_SQL).not.toMatch(/UNIQUE\s*\([^)]*customer[^)]*business/i);
    expect(MIGRATION_010_SQL).not.toMatch(/UNIQUE\s*\([^)]*business_day[^)]*customer/i);
    const checkAt = MIGRATION_010_SQL.indexOf('duplicate_source_draft_id');
    const constraintAt = MIGRATION_010_SQL.indexOf('performance_entries_source_draft_unique');
    const updateAt = MIGRATION_010_SQL.indexOf('SET source_draft_id = entry_id');
    expect(checkAt).toBeGreaterThan(0);
    expect(checkAt).toBeLessThan(constraintAt);
    expect(checkAt).toBeLessThan(updateAt);
    // 检查在改写已有重复数据之后、加约束之前：存量 backfill 在检查之后（检查的是已有非空值）。
    expect(MIGRATION_010_SQL).not.toMatch(/^BEGIN\s*;/m);
    expect(MIGRATION_010_SQL).not.toMatch(/^COMMIT\s*;/m);
    expect(MIGRATION_010_DOWN_SQL).toContain('DROP CONSTRAINT IF EXISTS performance_entries_source_draft_unique');
    expect(MIGRATION_010_DOWN_SQL).toContain('DROP COLUMN IF EXISTS source_draft_id');
    expect(MIGRATION_010_DOWN_SQL).toContain('DROP COLUMN IF EXISTS source_ordinal');
  });
});
