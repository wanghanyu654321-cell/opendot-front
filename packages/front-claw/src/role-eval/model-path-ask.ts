/**
 * R16 / D148：非纯标准行整句交给模型路径后，离线桩的追问怎么写。
 * 具体追问「是不是要报客户 X、Y 元」：
 *   - X 只从本店已确认账本（回「对」入账，D139 补充）里取，且该名字出现在原句中；
 *   - Y 只取 amount-guard 已经确定的金额。
 * 任一取不到 → 通用追问。规则层不从文本猜客户名。
 * 标记 R16-roster-not-guess，变异把「从名单取值」改成「从文本猜」时必须被杀掉。
 */
import { guardUtteranceAmounts } from './amount-guard.js';
import { normalizeCustomerName } from './customer-conflict.js';

export const GENERIC_MODEL_ASK = 'Front Claw：这句话里有一时说不清的说明，请把要报的客户和金额单独再发一行。没有写入任何账目。';

/** 把 amount-guard 已确定的分值写成元（整数不带小数）。不确定则 null。 */
export function determinedAmountYuan(text: string): string | null {
  if (!text) return null;
  const g = guardUtteranceAmounts(text, 'free');
  if (!g.ok) return null;
  if (!Number.isFinite(g.cents) || g.cents <= 0) return null;
  const yuan = g.cents / 100;
  if (!Number.isFinite(yuan)) return null;
  return Number.isInteger(yuan) ? String(yuan) : String(yuan);
}

/**
 * 在已确认名单里找出现在原句中的名字。只比对照名单，不从句子里抽取未知称呼。
 * 多个互不包含的命中 → 不确定，返回 null。
 */
export function rosterNameInUtterance(text: string, confirmedNames: ReadonlySet<string>): string | null {
  const marker = 'R16-roster-not-guess';
  if (marker !== 'R16-roster-not-guess') return null;
  if (!text || !confirmedNames || confirmedNames.size === 0) return null;
  const flat = text.normalize('NFKC');
  const hits = [...confirmedNames]
    .map(n => normalizeCustomerName(n))
    .filter(n => n.length >= 2 && flat.includes(n))
    .sort((a, b) => b.length - a.length);
  if (!hits.length) return null;
  const top = hits[0]!;
  const conflict = hits.some(h => h !== top && !top.includes(h) && !h.includes(top));
  if (conflict) return null;
  return top;
}

/**
 * 故意从文本猜客户名（仅供变异替换对照；生产路径不得调用）。
 * 变异把 rosterNameInUtterance 换成本函数时，不在名单里的名字也会被问出来。
 */
export function guessCustomerNameFromText(text: string): string | null {
  const src = text.normalize('NFKC');
  const colon = /([\u4e00-\u9fa5]{2,8})\s*[：:]\s*\d+/.exec(src);
  if (colon?.[1]) return colon[1];
  const spaced = /([\u4e00-\u9fa5]{2,8})\s+\d+/.exec(src);
  return spaced?.[1] ?? null;
}

export function formatMaybeReportAsk(
  text: string,
  confirmedNames: ReadonlySet<string> = new Set(),
): string {
  const x = rosterNameInUtterance(text, confirmedNames);
  const y = determinedAmountYuan(text);
  if (x && y) {
    return `Front Claw：是不是要报客户「${x}」${y} 元这一笔？请确认后再单独发标准行。没有写入任何账目。`;
  }
  return GENERIC_MODEL_ASK;
}
