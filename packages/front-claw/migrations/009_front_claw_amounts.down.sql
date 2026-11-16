-- Down for migration 009 (R5). Reverts amount columns to integer only when all
-- values are whole yuan; restores recorded/void status labels; drops store_targets.
-- Fractional amounts abort the down (fail closed).
-- R6 P2：先检查角分，有则 RAISE，不 DROP、不 UPDATE。通过后再改数据。升/降档打印状态计数。
-- 本文件不含 BEGIN/COMMIT（由 migrateDown 的事务包裹；嵌套 COMMIT 会提前结束外层事务）。

DO $$
DECLARE
  n_recorded int;
  n_void int;
  n_confirmed int;
  n_voided int;
  n_pending int;
BEGIN
  SELECT
    count(*) FILTER (WHERE status = 'recorded'),
    count(*) FILTER (WHERE status = 'void'),
    count(*) FILTER (WHERE status = 'confirmed'),
    count(*) FILTER (WHERE status = 'voided'),
    count(*) FILTER (WHERE status = 'pending')
  INTO n_recorded, n_void, n_confirmed, n_voided, n_pending
  FROM front_claw_perf.performance_entries;
  RAISE NOTICE '009 down status counts before: recorded=% void=% confirmed=% voided=% pending=%',
    n_recorded, n_void, n_confirmed, n_voided, n_pending;
END $$;

DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM front_claw_perf.performance_entries WHERE amount <> trunc(amount)
  ) OR EXISTS (
    SELECT 1 FROM front_claw_perf.performance_targets WHERE amount <> trunc(amount)
  ) THEN
    RAISE EXCEPTION 'cannot_down_fractional_amount';
  END IF;
END $$;

DROP TABLE IF EXISTS front_claw_perf.store_targets;

ALTER TABLE front_claw_perf.performance_entries
  DROP CONSTRAINT IF EXISTS performance_entries_status_check;
UPDATE front_claw_perf.performance_entries SET status = 'recorded' WHERE status = 'confirmed';
UPDATE front_claw_perf.performance_entries SET status = 'void' WHERE status = 'voided';

UPDATE front_claw_perf.performance_entries SET amount_type = '业绩' WHERE amount_type = 'consultant';

ALTER TABLE front_claw_perf.performance_entries
  ALTER COLUMN amount TYPE integer USING amount::integer;
ALTER TABLE front_claw_perf.performance_targets
  ALTER COLUMN amount TYPE integer USING amount::integer;

DO $$
DECLARE
  n_recorded int;
  n_void int;
  n_confirmed int;
  n_voided int;
  n_pending int;
BEGIN
  SELECT
    count(*) FILTER (WHERE status = 'recorded'),
    count(*) FILTER (WHERE status = 'void'),
    count(*) FILTER (WHERE status = 'confirmed'),
    count(*) FILTER (WHERE status = 'voided'),
    count(*) FILTER (WHERE status = 'pending')
  INTO n_recorded, n_void, n_confirmed, n_voided, n_pending
  FROM front_claw_perf.performance_entries;
  RAISE NOTICE '009 down status counts after: recorded=% void=% confirmed=% voided=% pending=%',
    n_recorded, n_void, n_confirmed, n_voided, n_pending;
END $$;
