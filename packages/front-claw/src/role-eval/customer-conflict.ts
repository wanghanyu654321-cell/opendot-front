/**
 * D131：本店今天已有客户的兜底匹配（宁可多触发）。
 * 归一后去掉称谓后缀；核心名至少 2 个字才对「这一行」做包含匹配；
 * 核心名只有 1 个字则退回整词相等（避免「丽」「王姐」误伤「美丽」「王丽」）。
 * 完整全名（去空白后 ≥2 字，如「王姐」「周老师」）若作为整段出现在行里，仍算命中，用来堵「前缀+王姐」。
 */
import { HONORIFIC } from './standard-line.js';

const HONOR_PARTS = HONORIFIC.split('|').sort((a, b) => b.length - a.length);

export function normalizeCustomerName(name: string): string {
  return (name ?? '').normalize('NFKC').replace(/\s+/g, '').trim();
}

/** 去掉一个尾部称谓后的核心名（「王姐」→「王」，「李小雪」→「李小雪」，「周老师」→「周」）。 */
export function customerCoreName(name: string): string {
  const n = normalizeCustomerName(name);
  if (!n) return '';
  for (const h of HONOR_PARTS) {
    if (n.length > h.length && n.endsWith(h)) return n.slice(0, n.length - h.length);
  }
  return n;
}

/**
 * 已有客户名是否与本行冲突。返回命中的已有客户原名（去重、保序）。
 * @param line 员工刚发的整行（含前缀、备注），包含匹配看这一行。
 * @param existingNames 本店今天已确认单上的客户名。
 * @param parsedCustomers 本行解析出的客户名（整词相等用）。
 */
export function customerNameConflicts(
  line: string,
  existingNames: readonly string[],
  parsedCustomers: readonly (string | null | undefined)[] = [],
): string[] {
  const flatLine = normalizeCustomerName(line);
  const parsed = parsedCustomers
    .map(c => (c ? normalizeCustomerName(c) : ''))
    .filter(Boolean);
  const hits: string[] = [];
  const seen = new Set<string>();
  for (const raw of existingNames) {
    const full = normalizeCustomerName(raw);
    if (!full) continue;
    const core = customerCoreName(raw);
    let hit = false;
    // 解析出的客户名与全名或核心名整词相等。
    if (parsed.some(p => p === full || (core && p === core))) hit = true;
    else if (core.length >= 2) {
      // 兜底：核心名至少两字，出现在这一行里就算（「客户李小雪」含「李小雪」）。
      if (flatLine.includes(core)) hit = true;
    } else {
      // 核心名只有 1 个字：不做单字包含（「丽」不匹配「美丽」）。
      // 全名至少两字时（「王姐」），行里出现完整全名仍算，堵住「这次王姐」；「王丽」不含「王姐」。
      if (full.length >= 2 && flatLine.includes(full)) hit = true;
    }
    if (hit && !seen.has(full)) {
      seen.add(full);
      hits.push(raw);
    }
  }
  return hits;
}
