import { createHash } from 'node:crypto';
import { PERFORMANCE_MIGRATION_SQL, PERFORMANCE_SCHEMA } from './performance-migration.js';
import type { SqlClient } from './performance-postgres.js';

/**
 * M08：front_claw_perf 的版本化迁移。007 是只读基准（启动时幂等执行，现行为）；008 起显式执行（默认不随启动）。
 * 版本表 front_claw_perf.schema_migrations（008 创建）；没有版本表 = v7（有 007 表）或 v0。
 * 所有 schema 迁移（含启动的 007 基线）在同一把事务级 advisory lock 下串行（参考 golang-migrate/Flyway：版本表 + 锁 + 校验和）。
 * 008 的 SQL 正文与 migrations/008_front_claw_delivery(.down).sql 逐字节一致（有测试）。
 */
export const SCHEMA_LOCK: readonly [number, number] = [0x46434c57, 7];
export const IMPORT_LOCK: readonly [number, number] = [0x46434c57, 8];
export const MIGRATION_008_PATH = 'migrations/008_front_claw_delivery.sql';
export const MIGRATION_008_DOWN_PATH = 'migrations/008_front_claw_delivery.down.sql';
export const MIGRATION_008_SQL = String.raw`-- Migration 008 (M08). Formal delivery columns on front_claw_perf.performance_notifications, derived from the M06
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
`;
export const MIGRATION_008_DOWN_SQL = String.raw`-- Down for migration 008 (M08). Removes only 008 delivery objects. Business rows, status text, schema_migrations and the
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
`;
export const MIGRATION_009_PATH = 'migrations/009_front_claw_amounts.sql';
export const MIGRATION_009_DOWN_PATH = 'migrations/009_front_claw_amounts.down.sql';
export const MIGRATION_009_SQL = String.raw`-- Migration 009 (R5). Amount columns integer → numeric(14,2); entry status
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
`;
export const MIGRATION_009_DOWN_SQL = String.raw`-- Down for migration 009 (R5). Reverts amount columns to integer only when all
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
`;
export const MIGRATION_010_PATH = 'migrations/010_front_claw_source_draft.sql';
export const MIGRATION_010_DOWN_PATH = 'migrations/010_front_claw_source_draft.down.sql';
export const MIGRATION_010_SQL = String.raw`-- Migration 010 (R6 / M04-01). Source draft identity for confirm-time idempotency.
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
`;
export const MIGRATION_010_DOWN_SQL = String.raw`-- Down for migration 010 (R6 / M04-01). Drops the source-draft unique constraint
-- and columns. Does not rewrite business rows. No BEGIN/COMMIT (wrapped by migrateDown).

ALTER TABLE front_claw_perf.performance_entries
  DROP CONSTRAINT IF EXISTS performance_entries_source_draft_unique;
ALTER TABLE front_claw_perf.performance_entries
  DROP COLUMN IF EXISTS source_draft_id,
  DROP COLUMN IF EXISTS source_ordinal;
`;
export const MIGRATION_011_PATH = 'migrations/011_front_claw_pending_reporter.sql';
export const MIGRATION_011_DOWN_PATH = 'migrations/011_front_claw_pending_reporter.down.sql';
export const MIGRATION_011_SQL = String.raw`-- D174：按员工跨门店、跨会话约束；存量冲突须先审查，不静默作废业务数据。
CREATE SEQUENCE IF NOT EXISTS front_claw_perf.pending_order_seq AS bigint NO CYCLE CACHE 1;
CREATE UNIQUE INDEX performance_drafts_pending_reporter_unique
  ON front_claw_perf.performance_drafts (reporter_person_id) WHERE status = 'pending';
`;
export const MIGRATION_011_DOWN_SQL = String.raw`-- 仅撤销本次索引和序列，不修改业务行。
DROP INDEX IF EXISTS front_claw_perf.performance_drafts_pending_reporter_unique;
DROP SEQUENCE IF EXISTS front_claw_perf.pending_order_seq;
`;
export const LATEST_SCHEMA_VERSION = 11;
export const sqlChecksum = (sql: string) => createHash('sha256').update(sql).digest('hex');

type Query = SqlClient['query'];
export const advisoryLock = (query: Query, key: readonly [number, number]) => query('SELECT pg_advisory_xact_lock($1, $2)', [key[0], key[1]]);

export async function schemaVersion(query: Query): Promise<number> {
  const { rows } = await query<{ ledger: string | null; base: string | null }>(
    `SELECT to_regclass('${PERFORMANCE_SCHEMA}.schema_migrations')::text AS ledger, to_regclass('${PERFORMANCE_SCHEMA}.performance_config')::text AS base`);
  const row = rows[0];
  if (!row?.ledger) return row?.base ? 7 : 0;
  const top = await query<{ version: number | null }>(`SELECT max(version) AS version FROM ${PERFORMANCE_SCHEMA}.schema_migrations`);
  return top.rows[0]?.version ?? 7;
}

/** 007 基线语句（与 migratePerformance 相同的加法检查）。 */
export function baselineStatements(sql = PERFORMANCE_MIGRATION_SQL): string[] {
  const statements = sql.replace(/--[^\n]*/g, '').split(';').map(s => s.trim()).filter(Boolean);
  for (const statement of statements) {
    const compact = statement.replace(/\s+/g, ' ').trim();
    if (/^(drop|alter)\b/i.test(compact)) throw Error('migration_not_additive');
    const createsSchema = new RegExp(`^CREATE SCHEMA IF NOT EXISTS ${PERFORMANCE_SCHEMA}$`, 'i').test(compact);
    if (!createsSchema && !compact.includes(`${PERFORMANCE_SCHEMA}.`)) throw Error('migration_schema');
  }
  return statements;
}

export interface SchemaStep { from: number; to: number; applied: boolean; dryRun: boolean }

/** 升到最新（v11）：锁 → 007 基线 → 008 → 009 → 010 → 011（已应用则核对校验和）。apply=false 时在事务里执行后整体回滚，只报告。 */
async function checksumAt(query: Query, version: number, expected: string): Promise<void> {
  const row = await query<{ checksum: string }>(`SELECT checksum FROM ${PERFORMANCE_SCHEMA}.schema_migrations WHERE version = $1`, [version]);
  if (row.rows[0] && row.rows[0].checksum !== expected) throw Error('migration_checksum_mismatch');
}
export async function migrateUp(client: SqlClient, options: { apply: boolean; baseline?: string }): Promise<SchemaStep> {
  return inTransaction(client, options.apply, async query => {
    await advisoryLock(query, SCHEMA_LOCK);
    for (const statement of baselineStatements(options.baseline)) await query(statement);
    const from = await schemaVersion(query);
    let current = from;
    if (current >= 8) await checksumAt(query, 8, sqlChecksum(MIGRATION_008_SQL));
    if (current >= 9) await checksumAt(query, 9, sqlChecksum(MIGRATION_009_SQL));
    if (current >= 10) await checksumAt(query, 10, sqlChecksum(MIGRATION_010_SQL));
    if (current >= 11) await checksumAt(query, 11, sqlChecksum(MIGRATION_011_SQL));
    if (current >= 11) return { from, to: current, applied: false, dryRun: !options.apply };
    if (current < 8) {
      await query(MIGRATION_008_SQL);
      await query(`INSERT INTO ${PERFORMANCE_SCHEMA}.schema_migrations (version, name, checksum) VALUES (7, '007_front_claw_perf', $1) ON CONFLICT (version) DO NOTHING`, [sqlChecksum(options.baseline ?? PERFORMANCE_MIGRATION_SQL)]);
      await query(`INSERT INTO ${PERFORMANCE_SCHEMA}.schema_migrations (version, name, checksum) VALUES (8, '008_front_claw_delivery', $1)`, [sqlChecksum(MIGRATION_008_SQL)]);
      current = 8;
    }
    if (current < 9) {
      await query(MIGRATION_009_SQL);
      await query(`INSERT INTO ${PERFORMANCE_SCHEMA}.schema_migrations (version, name, checksum) VALUES (9, '009_front_claw_amounts', $1)`, [sqlChecksum(MIGRATION_009_SQL)]);
      current = 9;
    }
    if (current < 10) {
      await query(MIGRATION_010_SQL);
      await query(`INSERT INTO ${PERFORMANCE_SCHEMA}.schema_migrations (version, name, checksum) VALUES (10, '010_front_claw_source_draft', $1)`, [sqlChecksum(MIGRATION_010_SQL)]);
    }
    await query(MIGRATION_011_SQL);
    await query(`INSERT INTO ${PERFORMANCE_SCHEMA}.schema_migrations (version, name, checksum) VALUES (11, '011_front_claw_pending_reporter', $1)`, [sqlChecksum(MIGRATION_011_SQL)]);
    return { from, to: 11, applied: true, dryRun: !options.apply };
  });
}

/** 降一档：v10→v9 撤 010；v9→v8 撤 009（先查角分，有则失败不动数据）；v8→v7 撤 008。 */
export async function migrateDown(client: SqlClient, options: { apply: boolean }): Promise<SchemaStep> {
  return inTransaction(client, options.apply, async query => {
    await advisoryLock(query, SCHEMA_LOCK);
    const from = await schemaVersion(query);
    if (from >= 11) {
      await query(MIGRATION_011_DOWN_SQL);
      await query(`DELETE FROM ${PERFORMANCE_SCHEMA}.schema_migrations WHERE version = 11`);
      return { from, to: 10, applied: true, dryRun: !options.apply };
    }
    if (from >= 10) {
      await query(MIGRATION_010_DOWN_SQL);
      await query(`DELETE FROM ${PERFORMANCE_SCHEMA}.schema_migrations WHERE version = 10`);
      return { from, to: 9, applied: true, dryRun: !options.apply };
    }
    if (from >= 9) {
      await query(MIGRATION_009_DOWN_SQL);
      await query(`DELETE FROM ${PERFORMANCE_SCHEMA}.schema_migrations WHERE version = 9`);
      return { from, to: 8, applied: true, dryRun: !options.apply };
    }
    if (from < 8) return { from, to: from, applied: false, dryRun: !options.apply };
    await query(MIGRATION_008_DOWN_SQL);
    await query(`DELETE FROM ${PERFORMANCE_SCHEMA}.schema_migrations WHERE version = 8`);
    return { from, to: 7, applied: true, dryRun: !options.apply };
  });
}

class DryRun extends Error { constructor(readonly result: unknown) { super('dry_run_rollback'); } }
/** apply=false：照常执行再整体回滚（PG 的 DDL 可回滚），得到真实结果而不留痕。 */
export async function inTransaction<T>(client: SqlClient, apply: boolean, work: (query: Query) => Promise<T>): Promise<T> {
  try {
    return await client.transaction(async query => {
      const result = await work(query);
      if (!apply) throw new DryRun(result);
      return result;
    });
  } catch (error) {
    if (error instanceof DryRun) return error.result as T;
    throw error;
  }
}
