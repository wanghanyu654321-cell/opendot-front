import { randomUUID } from 'node:crypto';
import type { SqlClient } from '../role-eval/performance-postgres.js';
import { advisoryLock, IMPORT_LOCK, schemaVersion } from '../role-eval/schema-migrations.js';
import { decodeStatus } from '../role-eval/notification-status.js';
import { canonical, inventory, readAll, readTable, rowKey, rowSha, shapeProblems, summarize, tableChecksum, type CanonicalRow, type Inventory } from './inventory.js';
import { relation, TABLES, type TableSpec } from './tables.js';
import { synthesizedNotices, transformRow } from './transform.js';

type Query = SqlClient['query'];
export interface Planned { spec: TableSpec; key: string; sourceSha: string; targetSha: string; transform: string; row: CanonicalRow }

/** 源 → 预期目标行（按表、主键）。 */
export function plan(source: ReadonlyMap<string, readonly CanonicalRow[]>): Planned[] {
  const out: Planned[] = [];
  for (const spec of TABLES) {
    for (const row of source.get(spec.name) ?? []) {
      const result = transformRow(spec, row);
      if (!result) continue;
      out.push({ spec, key: rowKey(spec, row), sourceSha: rowSha(spec, row), targetSha: rowSha(spec, result.row), transform: result.transform, row: result.row });
    }
    if (spec.name === 'performance_notifications') {
      const drafts = TABLES.find(t => t.name === 'performance_drafts')!;
      const ids = new Set((source.get(spec.name) ?? []).map(row => String(row.notification_id)));
      for (const { draft, row } of synthesizedNotices(source.get('performance_drafts') ?? [], ids)) {
        out.push({ spec, key: rowKey(spec, row), sourceSha: rowSha(drafts, draft), targetSha: rowSha(spec, row), transform: 'draft_notice_suppressed', row });
      }
    }
  }
  return out;
}

async function ledgerExists(query: Query): Promise<boolean> {
  const { rows } = await query<{ ok: string | null }>(`SELECT to_regclass('front_claw_perf.migration_import_rows')::text AS ok`);
  return !!rows[0]?.ok;
}
async function readLedger(query: Query): Promise<Map<string, { sourceSha: string; targetSha: string; transform: string; runId: string }>> {
  const map = new Map<string, { sourceSha: string; targetSha: string; transform: string; runId: string }>();
  if (!await ledgerExists(query)) return map;
  const { rows } = await query<{ table_name: string; source_key: string; source_sha: string; target_sha: string; transform: string; run_id: string }>(
    `SELECT table_name, source_key, source_sha, target_sha, transform, run_id FROM ${relation('migration_import_rows')}`);
  for (const row of rows) map.set(`${row.table_name}\u0000${row.source_key}`, { sourceSha: row.source_sha, targetSha: row.target_sha, transform: row.transform, runId: row.run_id });
  return map;
}

export interface Preflight {
  ok: boolean;
  blocking: string[];
  source: Inventory;
  target: { schemaVersion: number; serverVersion: string; rows: Record<string, number> };
  plan: Record<string, { insert: number; adopt: number; already: number; conflict: number; transforms: Record<string, number> }>;
}

/** 只读预检：源形状、目标版本、逐行分类（新增/采纳/已导入/冲突）。不写任何一边。 */
export async function preflight(source: Query, target: Query): Promise<Preflight> {
  const blocking: string[] = [];
  const shape = await shapeProblems(source);
  blocking.push(...shape.map(p => `source_${p}`));
  const sourceInv = shape.length ? { schemaVersion: await schemaVersion(source), serverVersion: 'unknown', tables: [], amounts: {}, distributions: {}, orphans: {}, malformedPending: 0 } : await inventory(source);
  const targetVersion = await schemaVersion(target);
  const server = (await target<{ server_version: string }>('SHOW server_version')).rows[0]?.server_version ?? 'unknown';
  if (targetVersion < 8) blocking.push('target_needs_schema_up_to_8');
  const result: Preflight['plan'] = {};
  const rowsCount: Record<string, number> = {};
  if (!shape.length) {
    const planned = plan(await readAll(source));
    const ledger = await readLedger(target);
    const targetShapeOk = targetVersion >= 7;
    for (const spec of TABLES) {
      const slot = result[spec.name] = { insert: 0, adopt: 0, already: 0, conflict: 0, transforms: {} as Record<string, number> };
      const current = targetShapeOk ? new Map((await readTable(target, spec)).map(row => [rowKey(spec, row), rowSha(spec, row)])) : new Map<string, string>();
      rowsCount[spec.name] = current.size;
      for (const item of planned.filter(p => p.spec === spec)) {
        slot.transforms[item.transform] = (slot.transforms[item.transform] ?? 0) + 1;
        if (ledger.has(`${spec.name}\u0000${item.key}`)) slot.already += 1;
        else if (!current.has(item.key)) slot.insert += 1;
        else if (current.get(item.key) === item.targetSha) slot.adopt += 1;
        else slot.conflict += 1;
      }
      if (slot.conflict) blocking.push(`conflict:${spec.name}:${slot.conflict}`);
    }
  }
  return { ok: blocking.length === 0, blocking, source: sourceInv, target: { schemaVersion: targetVersion, serverVersion: server, rows: rowsCount }, plan: result };
}

export class ImportConflict extends Error { constructor(readonly table: string, readonly key: string) { super(`import_conflict:${table}`); } }
export interface ImportOptions {
  apply: boolean; sourceLabel: string; batchSize?: number; runId?: string;
  /** 测试：批内（行已写、未提交）调用；抛错 = 模拟该批事务中断。 */
  afterBatch?: (table: string, batch: number) => void | Promise<void>;
}
export interface ImportResult { runId: string; dryRun: boolean; inserted: number; adopted: number; already: number; batches: number; preflight: Preflight }

/**
 * 导入：逐表、逐批一个事务（行 + 台账一起提交，数据导入 advisory lock 下）。重跑：台账已有 → 跳过；
 * 目标已有同主键且内容等于预期 → 只补台账（采纳）；不同 → 整批回滚并报冲突，不覆盖。默认 dry-run（只返回预检）。
 */
export async function importData(source: SqlClient, target: SqlClient, options: ImportOptions): Promise<ImportResult> {
  const runId = options.runId ?? `m08-${new Date().toISOString()}-${randomUUID().slice(0, 8)}`;
  const pre = await preflight(source.query.bind(source), target.query.bind(target));
  const result: ImportResult = { runId, dryRun: !options.apply, inserted: 0, adopted: 0, already: 0, batches: 0, preflight: pre };
  if (!options.apply) return result;
  if (!pre.ok) throw Error(`preflight_blocked:${pre.blocking.join(',')}`);
  const planned = plan(await readAll(source.query.bind(source)));
  const size = Math.max(1, options.batchSize ?? 200);
  await target.query(`INSERT INTO ${relation('migration_runs')} (run_id, source_label, started_at, status, summary_json) VALUES ($1,$2,now(),'running','{}') ON CONFLICT (run_id) DO NOTHING`, [runId, options.sourceLabel]);
  try {
    for (const spec of TABLES) {
      const items = planned.filter(p => p.spec === spec);
      for (let start = 0, batch = 0; start < items.length; start += size, batch += 1) {
        const slice = items.slice(start, start + size);
        const counts = await target.transaction(async query => {
          await advisoryLock(query, IMPORT_LOCK);
          const local = { inserted: 0, adopted: 0, already: 0 };
          for (const item of slice) {
            const seen = await query(`SELECT 1 FROM ${relation('migration_import_rows')} WHERE table_name=$1 AND source_key=$2`, [spec.name, item.key]);
            if (seen.rows.length) { local.already += 1; continue; }
            const where = spec.key.map((column, i) => `${column} = $${i + 1}`).join(' AND ');
            const existing = await query<Record<string, unknown>>(`SELECT ${spec.columns.join(', ')} FROM ${relation(spec.name)} WHERE ${where} FOR UPDATE`, spec.key.map(column => item.row[column]));
            if (existing.rows[0]) {
              if (rowSha(spec, asRow(spec, existing.rows[0])) !== item.targetSha) throw new ImportConflict(spec.name, item.key);
              local.adopted += 1;
            } else {
              const placeholders = spec.columns.map((_, i) => `$${i + 1}`).join(',');
              await query(`INSERT INTO ${relation(spec.name)} (${spec.columns.join(', ')}) VALUES (${placeholders})`, spec.columns.map(column => item.row[column]));
              local.inserted += 1;
            }
            await query(`INSERT INTO ${relation('migration_import_rows')} (table_name, source_key, run_id, source_sha, target_sha, transform) VALUES ($1,$2,$3,$4,$5,$6)`,
              [spec.name, item.key, runId, item.sourceSha, item.targetSha, item.transform]);
          }
          await options.afterBatch?.(spec.name, batch);
          return local;
        });
        result.inserted += counts.inserted; result.adopted += counts.adopted; result.already += counts.already; result.batches += 1;
      }
    }
  } catch (error) {
    await target.query(`UPDATE ${relation('migration_runs')} SET status='failed', finished_at=now(), summary_json=$2 WHERE run_id=$1`,
      [runId, JSON.stringify({ error: error instanceof Error ? error.message : 'unknown', inserted: result.inserted, adopted: result.adopted, already: result.already })]).catch(() => {});
    throw error;
  }
  await target.query(`UPDATE ${relation('migration_runs')} SET status='done', finished_at=now(), summary_json=$2 WHERE run_id=$1`,
    [runId, JSON.stringify({ inserted: result.inserted, adopted: result.adopted, already: result.already, batches: result.batches })]);
  return result;
}
function asRow(spec: TableSpec, raw: Record<string, unknown>): CanonicalRow {
  return canonical(spec, raw);
}

export interface Postflight {
  ok: boolean;
  errors: string[];
  /** expectedChecksum / importedChecksum：去掉 changedSinceImport 的键后，预期行与目标行的表校验和。 */
  tables: Record<string, { expected: number; present: number; ledger: number; changedSinceImport: number; newSinceImport: number; expectedChecksum: string; importedChecksum: string }>;
  amounts: { expected: Inventory['amounts']; imported: Inventory['amounts'] };
  transforms: Record<string, number>;
  suppressedStillPending: number;
}

/**
 * 只读后检：源的每一行（按转换后预期）都在目标、都有台账；导入时的目标 sha = 预期 sha；
 * 导入子集的表校验和与金额合计等于预期（迁移后被正常业务改过的行单列 changedSinceImport，不算错）；
 * 迁移后新增的行单列 newSinceImport；被抑制的历史通知不能再是 pending。
 * 默认严格（导入刚结束时用）：任何导入行被改过都算错；切换营业后复核用 allowChanged（改动只计数）。
 */
export async function postflight(source: Query, target: Query, options: { allowChanged?: boolean } = {}): Promise<Postflight> {
  const planned = plan(await readAll(source));
  const ledger = await readLedger(target);
  const targetData = await readAll(target);
  const errors: string[] = [];
  const tables: Postflight['tables'] = {};
  const transforms: Record<string, number> = {};
  // 校验和/金额只比“导入后未被业务改动”的行：两边去掉同一批 changed 键后应逐字节一致。
  const importedSubset = new Map<string, CanonicalRow[]>();
  const expectedSubset = new Map<string, CanonicalRow[]>();
  let suppressedStillPending = 0;
  for (const spec of TABLES) {
    const rows = targetData.get(spec.name)!;
    const byKey = new Map(rows.map(row => [rowKey(spec, row), row]));
    const items = planned.filter(p => p.spec === spec);
    const keys = new Set(items.map(item => item.key));
    let present = 0, ledgered = 0, changed = 0;
    const subset: CanonicalRow[] = [], expectedRows: CanonicalRow[] = [];
    for (const item of items) {
      transforms[item.transform] = (transforms[item.transform] ?? 0) + 1;
      const row = byKey.get(item.key);
      const entry = ledger.get(`${spec.name}\u0000${item.key}`);
      if (!row) { errors.push(`missing:${spec.name}:${item.key}`); continue; }
      present += 1;
      if (!entry) errors.push(`no_ledger:${spec.name}:${item.key}`);
      else {
        ledgered += 1;
        if (entry.targetSha !== item.targetSha || entry.sourceSha !== item.sourceSha) errors.push(`ledger_mismatch:${spec.name}:${item.key}`);
      }
      if (rowSha(spec, row) !== item.targetSha) changed += 1;
      else { subset.push(row); expectedRows.push(item.row); }
      if ((item.transform === 'notification_pending_suppressed' || item.transform === 'draft_notice_suppressed') && decodeStatus(String(row.status)).status === 'pending') suppressedStillPending += 1;
    }
    importedSubset.set(spec.name, subset);
    expectedSubset.set(spec.name, expectedRows);
    tables[spec.name] = {
      expected: items.length, present, ledger: ledgered, changedSinceImport: changed,
      newSinceImport: rows.filter(row => !keys.has(rowKey(spec, row))).length,
      expectedChecksum: tableChecksum(spec, expectedRows),
      importedChecksum: tableChecksum(spec, subset),
    };
    if (tables[spec.name]!.expectedChecksum !== tables[spec.name]!.importedChecksum) errors.push(`checksum:${spec.name}`);
    if (changed && !options.allowChanged) errors.push(`changed_since_import:${spec.name}:${changed}`);
  }
  if (suppressedStillPending) errors.push(`suppressed_pending:${suppressedStillPending}`);
  const amounts = { expected: summarize(expectedSubset).amounts, imported: summarize(importedSubset).amounts };
  if (JSON.stringify(sortKeys(amounts.expected)) !== JSON.stringify(sortKeys(amounts.imported))) errors.push('amounts');
  return { ok: errors.length === 0, errors, tables, amounts, transforms, suppressedStillPending };
}
const sortKeys = <T>(value: Record<string, T>) => Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : 1));
