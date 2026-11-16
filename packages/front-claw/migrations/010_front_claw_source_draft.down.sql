-- Down for migration 010 (R6 / M04-01). Drops the source-draft unique constraint
-- and columns. Does not rewrite business rows. No BEGIN/COMMIT (wrapped by migrateDown).

ALTER TABLE front_claw_perf.performance_entries
  DROP CONSTRAINT IF EXISTS performance_entries_source_draft_unique;
ALTER TABLE front_claw_perf.performance_entries
  DROP COLUMN IF EXISTS source_draft_id,
  DROP COLUMN IF EXISTS source_ordinal;
