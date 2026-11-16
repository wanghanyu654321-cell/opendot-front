-- Down for migration 008 (M08). Removes only 008 delivery objects. Business rows, status text, schema_migrations and the
-- import ledger stay. Run only after Front Claw writers are stopped (artifacts at v8 query delivery_due_at).
DROP INDEX IF EXISTS front_claw_perf.performance_notifications_due_idx;
DROP TRIGGER IF EXISTS notification_delivery_sync ON front_claw_perf.performance_notifications;
DROP FUNCTION IF EXISTS front_claw_perf.notification_delivery_sync();
ALTER TABLE front_claw_perf.performance_notifications
  DROP COLUMN IF EXISTS delivery_state,
  DROP COLUMN IF EXISTS delivery_phase,
  DROP COLUMN IF EXISTS delivery_attempts,
  DROP COLUMN IF EXISTS delivery_resends,
  DROP COLUMN IF EXISTS delivery_next_at,
  DROP COLUMN IF EXISTS delivery_lease_until,
  DROP COLUMN IF EXISTS delivery_lease_token,
  DROP COLUMN IF EXISTS delivery_lease_owner,
  DROP COLUMN IF EXISTS delivery_error,
  DROP COLUMN IF EXISTS delivery_due_at,
  DROP COLUMN IF EXISTS delivery_fence;
