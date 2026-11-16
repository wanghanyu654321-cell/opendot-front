-- Migration 009 (R5). Amount columns integer → numeric(14,2); entry status
-- recorded/void → confirmed/voided with CHECK; amount_type '业绩' → 'consultant';
-- new store_targets table. Applied explicitly (front-claw-migrate schema-up --apply),
-- not at startup. Additive on 007/008; does not rewrite those migration files.
-- R6：升/降档打印状态计数；down 先检查角分再改数据（失败则整笔回滚，不动数据）。

ALTER TABLE front_claw_perf.performance_entries
  ALTER COLUMN amount TYPE numeric(14,2) USING amount::numeric(14,2);
ALTER TABLE front_claw_perf.performance_targets
  ALTER COLUMN amount TYPE numeric(14,2) USING amount::numeric(14,2);

DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM front_claw_perf.performance_entries
    WHERE status NOT IN ('recorded', 'void', 'confirmed', 'voided', 'pending')
  ) THEN
    RAISE EXCEPTION 'unexpected_entry_status';
  END IF;
END $$;

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
  RAISE NOTICE '009 status counts before: recorded=% void=% confirmed=% voided=% pending=%',
    n_recorded, n_void, n_confirmed, n_voided, n_pending;
END $$;

UPDATE front_claw_perf.performance_entries SET status = 'confirmed' WHERE status = 'recorded';
UPDATE front_claw_perf.performance_entries SET status = 'voided' WHERE status = 'void';

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
  RAISE NOTICE '009 status counts after: recorded=% void=% confirmed=% voided=% pending=%',
    n_recorded, n_void, n_confirmed, n_voided, n_pending;
END $$;

ALTER TABLE front_claw_perf.performance_entries
  DROP CONSTRAINT IF EXISTS performance_entries_status_check;
ALTER TABLE front_claw_perf.performance_entries
  ADD CONSTRAINT performance_entries_status_check
  CHECK (status IN ('pending', 'confirmed', 'voided'));

UPDATE front_claw_perf.performance_entries SET amount_type = 'consultant' WHERE amount_type = '业绩';

CREATE TABLE IF NOT EXISTS front_claw_perf.store_targets (
  store_id text NOT NULL,
  period_month text NOT NULL,
  amount numeric(14,2) NOT NULL,
  set_by text NOT NULL,
  updated_at text NOT NULL,
  PRIMARY KEY (store_id, period_month)
);
