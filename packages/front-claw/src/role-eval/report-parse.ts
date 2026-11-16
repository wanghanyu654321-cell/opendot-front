import { amountValue } from './amounts.js';
import { guardUtteranceAmounts, isStandardAmountLine } from './amount-guard.js';
import {
  normalizeReportText, parseHeader, parseHeaderSplit,
  parseStandardLine, tryStandardReport,
} from './standard-line.js';

export { normalizeReportText, parseHeader, parseHeaderSplit };

export interface ParsedEntry {
  customer: string | null;
  amount: number;
  employeeName: string;
  note: string;
  /** R1（M02）：原文金额带单位或小数时保留原写法，确认回显「1.2k → 1200」（amount 为分，回显用元）；纯整数不带。 */
  amountText?: string;
  /** R4（D102）：无括号员工，记给报单人。 */
  self?: boolean;
  /** D133：归属说法（标准行语法剥出，不进备注）。 */
  ownership?: 'self' | 'other' | 'not_self';
  ownershipText?: string;
  /** D134：复合后半句。 */
  compound?: string;
  /** D137：从归属说法取出的员工名。 */
  attributedName?: string;
}

export interface ParsedReport {
  businessDay: string;
  storeName: string | null;
  entries: ParsedEntry[];
}

export type ParseResult =
  | { status: 'complete'; report: ParsedReport }
  | { status: 'incomplete' }
  | { status: 'none' };

/**
 * R1（M02）：金额文法。一项 = 整数或小数 + 可选数量单位（k/千/w/万）+ 可选货币单位（元/块）；
 * 多项用 + 相加。换算后精确到分（最多两位小数），否则不猜。解析前统一 NFKC（全角数字/括号/冒号/加号 → 半角）。
 */
const TERM = String.raw`\d+(?:\.\d+)?\s*(?:[kKwW千万])?\s*(?:元|块钱?)?`;
const AMOUNT = String.raw`(${TERM}(?:\s*[+＋]\s*${TERM})*)`;
/** R1：路由用的“金额（员工）”行模式，与解析共用同一金额文法；括号里多人不算。 */
export const ENTRY_LINE_PATTERN = new RegExp(String.raw`${AMOUNT}\s*[（(]\s*[^（）()\s/／、,，&或]{1,12}\s*[）)]`);

/** 一项金额 → 整数分（R5：与 amounts.ts 同一规则；超过两位小数/零/超技术上界 → null，调用方澄清，不取整）。 */
export function amountOfTerm(raw: string): number | null {
  const value = amountValue(raw);
  return value.ok ? value.amount : null;
}


export function parseEntryLine(line: string): ParsedEntry[] | null {
  // D125：切分只走 standard-line.ts 的同一份语法。
  const parsed = parseStandardLine(line, 'standard-line');
  if (parsed.status !== 'ok' || !parsed.entries.length) return null;
  const entries = parsed.entries as ParsedEntry[];
  const ctx = isStandardAmountLine(line) ? 'standard-line' : 'free';
  const g = guardUtteranceAmounts(line, ctx);
  return g.ok ? entries : null;
}

export function parseReportText(text: string, businessDay: string): ParseResult {
  const r = tryStandardReport(text, businessDay, { requireHeader: true });
  if (r.status === 'complete') return { status: 'complete', report: r.report };
  if (r.status === 'incomplete') return { status: 'incomplete' };
  return { status: 'none' };
}

export interface ReportFields {
  businessDay: string;
  storeName: string | null;
  entries: ParsedEntry[];
}

function record(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/** Same field rules the fast path uses. Invalid or extra fields are rejected, never filled in. */
export function validateReportFields(value: unknown): { ok: true; report: ReportFields } | { ok: false } {
  const body = record(value);
  if (!body) return { ok: false };
  const keys = Object.keys(body);
  if (keys.some(key => !['businessDay', 'storeName', 'entries'].includes(key))) return { ok: false };
  if (typeof body.businessDay !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(body.businessDay)) return { ok: false };
  if (!(body.storeName === null || (typeof body.storeName === 'string' && body.storeName.trim().length > 0))) return { ok: false };
  if (!Array.isArray(body.entries) || body.entries.length === 0) return { ok: false };
  const entries: ParsedEntry[] = [];
  for (const item of body.entries) {
    const row = record(item);
    if (!row) return { ok: false };
    if (Object.keys(row).some(key => !['customer', 'amount', 'employeeName', 'note'].includes(key))) return { ok: false };
    if (!('customer' in row) || !('amount' in row) || !('employeeName' in row)) return { ok: false };
    const customer = row.customer;
    const employeeName = row.employeeName;
    const note = 'note' in row ? row.note : '';
    if (!(customer === null || (typeof customer === 'string' && customer.trim().length > 0))) return { ok: false };
    if (typeof employeeName !== 'string' || !employeeName.trim()) return { ok: false };
    if (typeof row.amount !== 'number' || !Number.isSafeInteger(row.amount) || row.amount <= 0) return { ok: false };
    if (typeof note !== 'string') return { ok: false };
    entries.push({
      customer: customer === null ? null : customer.trim(),
      amount: row.amount,
      employeeName: employeeName.trim(),
      note: note.trim(),
    });
  }
  return { ok: true, report: { businessDay: body.businessDay, storeName: body.storeName === null ? null : body.storeName.trim(), entries } };
}

/**
 * M04：没有日期标题、但每一行都是标准报数行（如「张姐 680（小王）」「880（小赵）」）时，
 * 按调用方给定的营业日解析，门店留空（由调用方按本人门店处理）。任何一行不合格 → none，不猜。
 */
export function parseLooseReport(text: string, businessDay: string): ParseResult {
  const lines = normalizeReportText(text).split(/\r?\n/).map(line => line.trim()).filter(line => line.length > 0);
  if (!lines.length || lines.length > 50) return { status: 'none' };
  // 有日期标题的走 parseReportText，这里只收无标题的标准行。
  if (parseHeader(lines[0]!, businessDay)) return { status: 'none' };
  const r = tryStandardReport(text, businessDay);
  if (r.status === 'complete') return { status: 'complete', report: { ...r.report, storeName: null } };
  return { status: 'none' };
}
