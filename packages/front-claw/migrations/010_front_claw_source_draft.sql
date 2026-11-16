-- Migration 010 (R6 / M04-01). Source draft identity for confirm-time idempotency.
-- UNIQUE (source_draft_id, source_ordinal)：一份草稿可有多行，不能只对 draft_id 单列唯一。
-- 绝不在（客户 + 营业日）上建唯一约束：同客户当天两笔是合法的。
-- 加约束前先检查已有重复，有则 RAISE，不改数据。本文件不含 BEGIN/COMMIT（由 migrateUp 事务包裹）。

ALTER TABLE front_claw_perf.performance_entries
  ADD COLUMN IF NOT EXISTS source_draft_id text,
  ADD COLUMN IF NOT EXISTS source_ordinal integer;

DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM front_claw_perf.performance_entries
    WHERE source_draft_id IS NOT NULL
    GROUP BY source_draft_id, source_ordinal
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'duplicate_source_draft_id';
  END IF;
END $$;

-- 存量行用 entry_id 作为来源身份、ordinal = 0，保证可加约束且不与新草稿冲突。
UPDATE front_claw_perf.performance_entries
  SET source_draft_id = entry_id, source_ordinal = 0
  WHERE source_draft_id IS NULL;

ALTER TABLE front_claw_perf.performance_entries
  ADD CONSTRAINT performance_entries_source_draft_unique
  UNIQUE (source_draft_id, source_ordinal);
