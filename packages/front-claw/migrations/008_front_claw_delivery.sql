-- Migration 008 (M08). Formal delivery columns on front_claw_perf.performance_notifications, derived from the M06
-- status-text encoding by a trigger. During the transition the status text stays the only write path; old artifacts that
-- write only status keep the columns correct. Applied explicitly (front-claw-migrate schema-up --apply), not at startup.
-- R1: the trigger validates the strict status grammar and rejects malformed text; delivery_fence carries the fencing epoch.

CREATE TABLE IF NOT EXISTS front_claw_perf.schema_migrations (
  version integer PRIMARY KEY,
  name text NOT NULL,
  checksum text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE front_claw_perf.performance_notifications
  ADD COLUMN IF NOT EXISTS delivery_state text,
  ADD COLUMN IF NOT EXISTS delivery_phase text,
  ADD COLUMN IF NOT EXISTS delivery_attempts integer,
  ADD COLUMN IF NOT EXISTS delivery_resends integer,
  ADD COLUMN IF NOT EXISTS delivery_next_at timestamptz,
  ADD COLUMN IF NOT EXISTS delivery_lease_until timestamptz,
  ADD COLUMN IF NOT EXISTS delivery_lease_token text,
  ADD COLUMN IF NOT EXISTS delivery_lease_owner text,
  ADD COLUMN IF NOT EXISTS delivery_error text,
  ADD COLUMN IF NOT EXISTS delivery_due_at timestamptz,
  ADD COLUMN IF NOT EXISTS delivery_fence bigint;

CREATE OR REPLACE FUNCTION front_claw_perf.notification_delivery_sync() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  -- R1: strict grammar, identical to STATUS_PATTERN in src/role-eval/notification-status.ts (tested).
  pat constant text := $re$^(?:(pending|sent|not_sent|unknown)|pending\|(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)\|(queued|claimed|sending)\|a=((?:0|[1-9]\d{0,3}))\|r=((?:0|[1-9]\d{0,3}))(?:\|f=((?:0|[1-9]\d{0,14})))?(?:\|tok=([A-Za-z0-9_.:\-]{1,80}))?(?:\|by=([A-Za-z0-9_.:\-]{1,80}))?(?:\|err=([A-Za-z0-9_.:\-]{1,80}))?|(sent|not_sent|unknown)\|-\|-\|a=((?:0|[1-9]\d{0,3}))\|r=((?:0|[1-9]\d{0,3}))(?:\|f=((?:0|[1-9]\d{0,14})))?(?:\|tok=([A-Za-z0-9_.:\-]{1,80}))?(?:\|by=([A-Za-z0-9_.:\-]{1,80}))?(?:\|err=([A-Za-z0-9_.:\-]{1,80}))?)$$re$;
  g text[];
  t text[];
  due timestamptz;
BEGIN
  g := regexp_match(NEW.status, pat);
  IF g IS NULL THEN
    RAISE EXCEPTION 'invalid_delivery_status' USING ERRCODE = '22023', DETAIL = left(NEW.status, 120);
  END IF;
  NEW.delivery_phase := NULL; NEW.delivery_attempts := 0; NEW.delivery_resends := 0; NEW.delivery_fence := 0;
  NEW.delivery_next_at := NULL; NEW.delivery_lease_until := NULL; NEW.delivery_lease_token := NULL;
  NEW.delivery_lease_owner := NULL; NEW.delivery_error := NULL; NEW.delivery_due_at := NULL;
  IF g[1] IS NOT NULL THEN
    NEW.delivery_state := g[1];
    IF g[1] = 'pending' THEN
      NEW.delivery_phase := 'queued';
      NEW.delivery_due_at := '-infinity';
    END IF;
    RETURN NEW;
  END IF;
  IF g[2] IS NOT NULL THEN
    BEGIN
      due := g[2]::timestamptz;
    EXCEPTION WHEN others THEN
      RAISE EXCEPTION 'invalid_delivery_status' USING ERRCODE = '22023', DETAIL = left(NEW.status, 120);
    END;
    IF to_char(due AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') <> g[2] THEN
      RAISE EXCEPTION 'invalid_delivery_status' USING ERRCODE = '22023', DETAIL = left(NEW.status, 120);
    END IF;
    NEW.delivery_state := 'pending';
    NEW.delivery_phase := g[3];
    t := g[4:9];
  ELSE
    NEW.delivery_state := g[10];
    t := g[11:16];
  END IF;
  IF NEW.delivery_phase IN ('claimed', 'sending') AND t[4] IS NULL THEN
    RAISE EXCEPTION 'invalid_delivery_status' USING ERRCODE = '22023', DETAIL = left(NEW.status, 120);
  END IF;
  NEW.delivery_attempts := t[1]::integer;
  NEW.delivery_resends := t[2]::integer;
  NEW.delivery_fence := coalesce(t[3]::bigint, 0);
  NEW.delivery_lease_token := t[4];
  NEW.delivery_lease_owner := t[5];
  NEW.delivery_error := t[6];
  IF NEW.delivery_phase IN ('claimed', 'sending') THEN NEW.delivery_lease_until := due;
  ELSE NEW.delivery_next_at := due;
  END IF;
  IF NEW.delivery_state = 'pending' THEN NEW.delivery_due_at := due; END IF;
  RETURN NEW;
END
$fn$;

DROP TRIGGER IF EXISTS notification_delivery_sync ON front_claw_perf.performance_notifications;
CREATE TRIGGER notification_delivery_sync
  BEFORE INSERT OR UPDATE ON front_claw_perf.performance_notifications
  FOR EACH ROW EXECUTE FUNCTION front_claw_perf.notification_delivery_sync();

-- Backfill: re-derive every existing row from its status text (status itself is unchanged).
-- R1: a malformed legacy status raises here and the whole migration rolls back (fail closed; fix the row, then re-run).
UPDATE front_claw_perf.performance_notifications SET status = status;

CREATE INDEX IF NOT EXISTS performance_notifications_due_idx
  ON front_claw_perf.performance_notifications (delivery_due_at, created_at, notification_id)
  WHERE delivery_due_at IS NOT NULL;

-- Data-import ledger (source primary key -> target row), kept on rollback because it is data.
CREATE TABLE IF NOT EXISTS front_claw_perf.migration_runs (
  run_id text PRIMARY KEY,
  source_label text NOT NULL,
  started_at timestamptz NOT NULL,
  finished_at timestamptz,
  status text NOT NULL,
  summary_json text NOT NULL
);
CREATE TABLE IF NOT EXISTS front_claw_perf.migration_import_rows (
  table_name text NOT NULL,
  source_key text NOT NULL,
  run_id text NOT NULL,
  source_sha text NOT NULL,
  target_sha text NOT NULL,
  transform text NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (table_name, source_key)
);
