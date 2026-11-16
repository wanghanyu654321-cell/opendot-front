import type { SqlClient } from '../role-eval/performance-postgres.js';
import { migratePerformance } from '../role-eval/performance-postgres.js';
import { advisoryLock, IMPORT_LOCK, inTransaction, schemaVersion } from '../role-eval/schema-migrations.js';
import { readAll, readTable, rowKey, rowSha, type CanonicalRow } from './inventory.js';
import { relation, RUNTIME_CONFIG_KEYS, TABLES } from './tables.js';
import { fromPgNumeric } from '../role-eval/money.js';

export interface ExportResult {
  dryRun: boolean;
  tables: Record<string, { source: number; insert: number; update: number; unchanged: number; keptDestOnly: number }>;
  verified: boolean;
  mismatches: string[];
}

/**
 * R2 回退导出：把 OpenDot 侧目标库（v7/v8）的全部 007 列行——包括迁移后新增/更正的业务——写进一个 007 布局的隔离库。
 * 目标库为准：目的库缺的插入、不同的更新（目标是切换后的最新事实）、相同的不动；目的库独有的行保留（不删任何行）。
 * 历史通知保持抑制状态，sent/unknown 原样（目的库上的兼容制品不会重发）。运行态租约行不导出。
 * 默认 dry-run：整段在事务里执行再回滚，返回真实统计。目的库须是新的隔离库（守卫在 CLI 层）。
 */
export async function exportForRollback(from: SqlClient, dest: SqlClient, options: { apply: boolean }): Promise<ExportResult> {
  const data = await readAll(from.query.bind(from));
  if (options.apply) await migratePerformance(dest);
  const destVersion = await schemaVersion(dest.query.bind(dest));
  const result: ExportResult = { dryRun: !options.apply, tables: {}, verified: false, mismatches: [] };
  if (!options.apply && destVersion < 7) {
    for (const spec of TABLES) {
      const rows = (data.get(spec.name) ?? []).filter(row => !(spec.name === 'performance_config' && RUNTIME_CONFIG_KEYS.has(String(row.key))));
      result.tables[spec.name] = { source: rows.length, insert: rows.length, update: 0, unchanged: 0, keptDestOnly: 0 };
    }
    return result;
  }
  await inTransaction(dest, options.apply, async query => {
    await advisoryLock(query, IMPORT_LOCK);
    for (const spec of TABLES) {
      const rows = (data.get(spec.name) ?? []).filter(row => !(spec.name === 'performance_config' && RUNTIME_CONFIG_KEYS.has(String(row.key))));
      const existing = new Map((await readTable(query, spec)).map(row => [rowKey(spec, row), row]));
      const slot = result.tables[spec.name] = { source: rows.length, insert: 0, update: 0, unchanged: 0, keptDestOnly: 0 };
      const keys = new Set<string>();
      for (const row of rows) {
        const key = rowKey(spec, row);
        keys.add(key);
        const current = existing.get(key);
        if (current && rowSha(spec, current) === rowSha(spec, row)) { slot.unchanged += 1; continue; }
        const values = spec.columns.map(column => {
          if (column !== 'amount' || destVersion >= 9 || row[column] === null || row[column] === undefined) return row[column];
          const cents = fromPgNumeric(row[column]);
          if (cents % 100 !== 0) throw Error('cannot_export_fractional_amount');
          return Math.trunc(cents / 100);
        });
        if (!current) {
          await query(`INSERT INTO ${relation(spec.name)} (${spec.columns.join(', ')}) VALUES (${spec.columns.map((_, i) => `$${i + 1}`).join(',')})`, values);
          slot.insert += 1;
        } else {
          const sets = spec.columns.filter(column => !spec.key.includes(column)).map(column => `${column} = $${spec.columns.indexOf(column) + 1}`).join(', ');
          const where = spec.key.map(column => `${column} = $${spec.columns.indexOf(column) + 1}`).join(' AND ');
          await query(`UPDATE ${relation(spec.name)} SET ${sets} WHERE ${where}`, values);
          slot.update += 1;
        }
      }
      slot.keptDestOnly = [...existing.keys()].filter(key => !keys.has(key)).length;
    }
    // 事务内复核：每一行目的库 sha = 来源 sha。
    for (const spec of TABLES) {
      const after = new Map((await readTable(query, spec)).map(row => [rowKey(spec, row), rowSha(spec, row)]));
      for (const row of data.get(spec.name) ?? []) {
        if (spec.name === 'performance_config' && RUNTIME_CONFIG_KEYS.has(String(row.key))) continue;
        if (after.get(rowKey(spec, row)) !== rowSha(spec, row)) result.mismatches.push(`${spec.name}:${rowKey(spec, row)}`);
      }
    }
    result.verified = result.mismatches.length === 0;
    if (!result.verified) throw Error('rollback_export_verify_failed');
    return result;
  });
  return result;
}
export type { CanonicalRow };
