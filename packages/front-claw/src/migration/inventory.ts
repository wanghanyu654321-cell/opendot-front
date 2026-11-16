import { createHash } from 'node:crypto';
import type { SqlClient } from '../role-eval/performance-postgres.js';
import { PERFORMANCE_SCHEMA } from '../role-eval/performance-migration.js';
import { decodeStatus } from '../role-eval/notification-status.js';
import { schemaVersion } from '../role-eval/schema-migrations.js';
import { relation, TABLES, type TableSpec } from './tables.js';
import { fromPgNumeric } from '../role-eval/money.js';

export type CanonicalRow = Record<string, string | number | boolean | null>;
type Query = SqlClient['query'];

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
export const rowKey = (spec: TableSpec, row: CanonicalRow) => JSON.stringify(spec.key.map(column => row[column]));
export const rowSha = (spec: TableSpec, row: CanonicalRow) => sha(JSON.stringify(spec.columns.map(column => row[column] ?? null)));

/** 金额列统一成两位小数字符串（「300.00」），007 integer 与 009 numeric 校验和一致。 */
export function canonicalAmount(value: unknown): string {
  const cents = fromPgNumeric(value);
  const sign = cents < 0 ? '-' : '';
  const abs = cents < 0 ? -cents : cents;
  const yuan = Math.trunc(abs / 100);
  const frac = abs % 100;
  return `${sign}${yuan}.${String(frac).padStart(2, '0')}`;
}

export function canonical(spec: TableSpec, raw: Record<string, unknown>): CanonicalRow {
  const out: CanonicalRow = {};
  for (const column of spec.columns) {
    const value = raw[column];
    if (value === null || value === undefined) out[column] = null;
    else if (column === 'amount') out[column] = canonicalAmount(value);
    else if (typeof value === 'string' || typeof value === 'boolean') out[column] = value;
    else if (typeof value === 'number' && Number.isSafeInteger(value)) out[column] = value;
    else throw Error(`unexpected_value_${spec.name}_${column}`);
  }
  return out;
}

/** 按主键排序读出 007 列（v7/v8 一致）。 */
export async function readTable(query: Query, spec: TableSpec): Promise<CanonicalRow[]> {
  const { rows } = await query<Record<string, unknown>>(`SELECT ${spec.columns.join(', ')} FROM ${relation(spec.name)} ORDER BY ${spec.key.map(k => `${k} COLLATE "C"`).join(', ')}`);
  return rows.map(row => canonical(spec, row));
}
/** 表校验和：按主键排序的 (key, rowSha) 序列再 sha256。与行物理顺序、v7/v8 无关。 */
export function tableChecksum(spec: TableSpec, rows: readonly CanonicalRow[]): string {
  const lines = rows.map(row => `${rowKey(spec, row)}\t${rowSha(spec, row)}`).sort();
  return sha(lines.join('\n'));
}

export interface TableInventory { table: string; count: number; checksum: string }
export interface Inventory {
  schemaVersion: number;
  serverVersion: string;
  tables: TableInventory[];
  /** 金额合计：store|status → sum(amount)，条数。 */
  amounts: Record<string, { sum: number; count: number }>;
  distributions: Record<string, Record<string, number>>;
  /** 引用完整性（只报告）：子表引用不到父表的行数。 */
  orphans: Record<string, number>;
  /** 畸形 pending 通知（第二段不是定长 ISO）——v8 下不到期（D53）。 */
  malformedPending: number;
}

export async function shapeProblems(query: Query): Promise<string[]> {
  const { rows } = await query<{ table_name: string; column_name: string }>(
    `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = $1`, [PERFORMANCE_SCHEMA]);
  const have = new Map<string, Set<string>>();
  for (const row of rows) { if (!have.has(row.table_name)) have.set(row.table_name, new Set()); have.get(row.table_name)!.add(row.column_name); }
  const problems: string[] = [];
  for (const spec of TABLES) {
    const columns = have.get(spec.name);
    if (!columns) { problems.push(`missing_table:${spec.name}`); continue; }
    for (const column of spec.columns) if (!columns.has(column)) problems.push(`missing_column:${spec.name}.${column}`);
  }
  return problems;
}

const count = (target: Record<string, number>, key: string) => { target[key] = (target[key] ?? 0) + 1; };
export function summarize(data: ReadonlyMap<string, readonly CanonicalRow[]>): Omit<Inventory, 'schemaVersion' | 'serverVersion'> {
  const rowsOf = (name: string) => data.get(name) ?? [];
  const tables = TABLES.map(spec => ({ table: spec.name, count: rowsOf(spec.name).length, checksum: tableChecksum(spec, rowsOf(spec.name)) }));
  const amounts: Inventory['amounts'] = {};
  for (const entry of rowsOf('performance_entries')) {
    const key = `${entry.store_id}|${entry.status}`;
    const slot = amounts[key] ??= { sum: 0, count: 0 };
    slot.sum += Number(entry.amount); slot.count += 1;
  }
  const distributions: Inventory['distributions'] = { entries: {}, drafts: {}, appointments: {}, notifications: {} };
  for (const row of rowsOf('performance_entries')) count(distributions.entries!, String(row.status));
  for (const row of rowsOf('performance_drafts')) count(distributions.drafts!, String(row.status));
  for (const row of rowsOf('performance_appointments')) count(distributions.appointments!, String(row.status));
  let malformedPending = 0;
  for (const row of rowsOf('performance_notifications')) {
    const decoded = decodeStatus(String(row.status));
    count(distributions.notifications!, decoded.status);
    if (decoded.status === 'pending' && row.status !== 'pending' && decoded.delivery.dueAt === null) malformedPending += 1;
  }
  const people = new Set(rowsOf('performance_people').map(row => String(row.person_id)));
  const accounts = new Set(rowsOf('performance_people').map(row => String(row.account_id)));
  const entries = new Set(rowsOf('performance_entries').map(row => String(row.entry_id)));
  const orphans: Inventory['orphans'] = {
    'aliases.person_id': rowsOf('performance_aliases').filter(row => !people.has(String(row.person_id))).length,
    'bindings.account_id': rowsOf('wecom_bot_bindings').filter(row => !accounts.has(String(row.account_id))).length,
    'entries.owner_person_id': rowsOf('performance_entries').filter(row => !people.has(String(row.owner_person_id))).length,
    'revisions.entry_id': rowsOf('performance_revisions').filter(row => !entries.has(String(row.entry_id))).length,
    'drafts.reporter_person_id': rowsOf('performance_drafts').filter(row => !people.has(String(row.reporter_person_id))).length,
    'appointments.employee_person_id': rowsOf('performance_appointments').filter(row => !people.has(String(row.employee_person_id))).length,
    'notifications.recipient_person_id': rowsOf('performance_notifications').filter(row => !people.has(String(row.recipient_person_id))).length,
  };
  return { tables, amounts, distributions, orphans, malformedPending };
}

export async function readAll(query: Query): Promise<Map<string, CanonicalRow[]>> {
  const data = new Map<string, CanonicalRow[]>();
  for (const spec of TABLES) data.set(spec.name, await readTable(query, spec));
  return data;
}
export async function inventory(query: Query): Promise<Inventory> {
  const server = await query<{ server_version: string }>('SHOW server_version');
  const version = await schemaVersion(query);
  return { schemaVersion: version, serverVersion: server.rows[0]?.server_version ?? 'unknown', ...summarize(await readAll(query)) };
}
