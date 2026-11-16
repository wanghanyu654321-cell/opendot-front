/**
 * R5（D105）：金额一律用整数分（cents）计算和保存应用层状态；
 * PG numeric(14,2) 存「元」，node-pg 把 numeric 读成字符串。进制换算、加减、回显都不经过 JS 浮点。
 *
 * numeric(14,2) 上界 = 999999999999.99 元 = 99_999_999_999_999 分（安全整数范围内）。
 */
export const CENTS_PER_YUAN = 100;
/** 技术上界（分），对应 numeric(14,2) 能存下的最大值；不是业务限额。 */
export const MAX_NUMERIC_CENTS = 99_999_999_999_999;
export const MAX_NUMERIC_YUAN = '999999999999.99';

export type MoneyIssue = 'bad' | 'too_large';

const NUMERIC = /^-?(0|[1-9]\d*)(?:\.(\d+))?$/;

/** 把分格式化成元的十进制字符串：68000→「680」，68050→「680.5」，68005→「680.05」。 */
export function formatYuan(cents: number): string {
  if (!Number.isSafeInteger(cents)) throw Error('money_not_integer_cents');
  const sign = cents < 0 ? '-' : '';
  const abs = cents < 0 ? -cents : cents;
  const yuan = Math.trunc(abs / CENTS_PER_YUAN);
  const frac = abs % CENTS_PER_YUAN;
  if (frac === 0) return `${sign}${yuan}`;
  if (frac % 10 === 0) return `${sign}${yuan}.${frac / 10}`;
  return `${sign}${yuan}.${String(frac).padStart(2, '0')}`;
}

/** 写入 PG：有角分时两位小数（「680.50」）；整元写「680」，007 integer 列也能收下（迁移测源库）。numeric(14,2) 两种都能存。 */
export function toPgNumeric(cents: number): string {
  if (!Number.isSafeInteger(cents) || Math.abs(cents) > MAX_NUMERIC_CENTS) throw Error('money_overflow');
  const sign = cents < 0 ? '-' : '';
  const abs = cents < 0 ? -cents : cents;
  const yuan = Math.trunc(abs / CENTS_PER_YUAN);
  const frac = abs % CENTS_PER_YUAN;
  if (frac === 0) return `${sign}${yuan}`;
  return `${sign}${yuan}.${String(frac).padStart(2, '0')}`;
}

/**
 * 从 PG 读金额。numeric 是字符串；007 整数列或 MemorySql 可能是整数元。
 * 整数 number → 按「元」解释（迁移前的 integer 列）；字符串按 numeric 元解析。
 */
export function fromPgNumeric(value: unknown): number {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || Math.abs(value) > MAX_NUMERIC_CENTS / CENTS_PER_YUAN) throw Error('postgres_row');
    return value * CENTS_PER_YUAN;
  }
  if (typeof value === 'string') {
    const cents = yuanStringToCents(value);
    if (cents === null) throw Error('postgres_row');
    return cents;
  }
  throw Error('postgres_row');
}

/** 「680」「680.5」「680.50」「0.10」→ 分；超过两位小数或非法 → null。允许技术上界以内。 */
export function yuanStringToCents(raw: string): number | null {
  const text = raw.trim();
  const m = NUMERIC.exec(text);
  if (!m) return null;
  const neg = text.startsWith('-');
  const intPart = (m[1] ?? '0').replace(/^-/, '');
  const fracRaw = m[2] ?? '';
  if (fracRaw.length > 2) {
    // 超过两位：仅当多余位全是 0 才收下（「680.500」= 680.50）。
    if (!/^0+$/.test(fracRaw.slice(2))) return null;
  }
  const frac = (fracRaw + '00').slice(0, 2);
  const digits = `${intPart}${frac}`.replace(/^0+(?=\d)/, '');
  if (digits.length > 15) return null;
  const cents = Number(digits);
  if (!Number.isSafeInteger(cents) || cents > MAX_NUMERIC_CENTS) return null;
  return neg ? -cents : cents;
}

/** 整数元 → 分。仅用于本身已是整数的中文数字等。 */
export function yuanIntegerToCents(yuan: number): number | null {
  if (!Number.isSafeInteger(yuan)) return null;
  if (yuan > MAX_NUMERIC_CENTS / CENTS_PER_YUAN || yuan < -MAX_NUMERIC_CENTS / CENTS_PER_YUAN) return null;
  return yuan * CENTS_PER_YUAN;
}

/** 整数分相加，超出技术上界则 null。 */
export function addCents(...parts: number[]): number | null {
  let total = 0;
  for (const part of parts) {
    if (!Number.isSafeInteger(part)) return null;
    const next = total + part;
    if (!Number.isSafeInteger(next) || Math.abs(next) > MAX_NUMERIC_CENTS) return null;
    total = next;
  }
  return total;
}

export function sumCents(values: Iterable<number>): number | null {
  return addCents(...values);
}
