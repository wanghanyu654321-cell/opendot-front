/**
 * R2/R5：金额的唯一换算规则（报数清单、自然句报数、目标、改账共用）。
 * - 十进制字符串运算，不经浮点；k/K/千 = ×1000，w/W/万 = ×10000；元/块/块钱/元整/块整/整 只是货币单位（「整」= 元）。
 * - R5（D105）：精确到 0.01 元（分）；结果用整数分表示。「680.5元」「99.99」直接收；
 *   换算后超过两位小数（「1.234」无单位、「680.555元」）→ 'fraction'，不取整，由调用方澄清。
 * - 0 → 'zero'；带负号 → 'negative'；超过 numeric(14,2) 技术上界 → 'too_large'；其他写法 → 'bad'。
 * - D80「只收整数元」作废；D84 的 100 万上限和 5 万二次确认已撤，不再有业务限额。
 */
import { MAX_NUMERIC_CENTS, formatYuan } from './money.js';

export type AmountIssue = 'fraction' | 'zero' | 'negative' | 'too_large' | 'bad';
export type AmountValue = { ok: true; amount: number; text?: string } | { ok: false; issue: AmountIssue; text: string };

/** 单笔技术上界（分），对应 numeric(14,2)。D84 业务上限已撤。 */
export const MAX_ENTRY_AMOUNT = MAX_NUMERIC_CENTS;
/** 目标金额技术上界（分），与单笔同一上界。 */
export const MAX_TARGET_AMOUNT = MAX_NUMERIC_CENTS;

const UNIT_ZEROS: Record<string, number> = { k: 3, K: 3, 千: 3, w: 4, W: 4, 万: 4 };
export const ARABIC_AMOUNT = String.raw`([-−－﹣]|负)?\s*[¥￥]?\s*(\d+(?:\.\d+)?)\s*([kKwW千万])?\s*(元整|块整|块钱|元|块|整)?`;
const WHOLE = new RegExp(`^${ARABIC_AMOUNT}$`);

/**
 * 一项阿拉伯数字金额（可带符号/货币符号/单位）→ 整数分或问题。
 * 换算：digits × 10^(unitZeros + 2 − fracLen) 分；fracLen − unitZeros > 2 即超过两位小数。
 */
export function amountValue(raw: string, max = MAX_ENTRY_AMOUNT): AmountValue {
  const text = raw.replace(/\s+/g, '');
  const m = WHOLE.exec(text);
  if (!m || m[2] === undefined) return { ok: false, issue: 'bad', text };
  if (m[1]) return { ok: false, issue: 'negative', text };
  const zeros = m[3] ? UNIT_ZEROS[m[3]]! : 0;
  const [intPart, fracRaw = ''] = m[2].split('.');
  const frac = fracRaw.replace(/0+$/, '');
  // 换算到元后的小数位数 = frac.length − 单位补零。超过 2 位（分）→ 澄清，不取整。
  if (frac.length - zeros > 2) return { ok: false, issue: 'fraction', text };
  const digits = `${intPart}${frac}`.replace(/^0+(?=\d)/, '');
  const exp = zeros + 2 - frac.length;
  // exp >= 0：因为 frac.length - zeros <= 2。cents = digits × 10^exp。
  if (digits.length + exp > 15) return { ok: false, issue: 'too_large', text };
  let cents = 0;
  try {
    const value = BigInt(digits) * (10n ** BigInt(exp));
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) return { ok: false, issue: 'too_large', text };
    cents = Number(value);
  } catch {
    return { ok: false, issue: 'bad', text };
  }
  if (cents === 0) return { ok: false, issue: 'zero', text };
  if (!Number.isSafeInteger(cents) || cents > max) return { ok: false, issue: 'too_large', text };
  return /^\d+$/.test(text) ? { ok: true, amount: cents } : { ok: true, amount: cents, text };
}

const CN_DIGIT: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const CN_UNIT: Record<string, number> = { 十: 10, 百: 100, 千: 1000 };
/** 万以下一段：「一千二」=1200（口语省略）、「五百六十」=560、「一千零二」=1002、「十五」=15。无效写法 → null。返回整数元。 */
function cnSection(raw: string): number | null {
  if (!raw) return 0;
  let total = 0, digit: number | null = null, lastUnit = 0, zeroSeen = false;
  for (const ch of raw) {
    if (ch in CN_DIGIT) {
      if (digit !== null && CN_DIGIT[ch] !== 0) return null; // 「二二」之类连写数字不当金额
      if (CN_DIGIT[ch] === 0) { zeroSeen = true; continue; }
      digit = CN_DIGIT[ch]!;
    } else if (ch in CN_UNIT) {
      const unit = CN_UNIT[ch]!;
      if (lastUnit && unit >= lastUnit) return null;
      total += (digit ?? (unit === 10 && total === 0 ? 1 : NaN)) * unit;
      if (Number.isNaN(total)) return null;
      digit = null; lastUnit = unit; zeroSeen = false;
    } else return null;
  }
  if (digit !== null) total += !zeroSeen && lastUnit >= 100 ? digit * (lastUnit / 10) : digit;
  return total;
}
/** 中文数字金额（含「万」），返回整数元。只在带量级（十/百/千/万）或货币单位时才算金额（「两笔」「一下」不是）。 */
export function cnAmount(raw: string): number | null {
  const parts = raw.split('万');
  if (parts.length > 2) return null;
  if (parts.length === 2) {
    const high = cnSection(parts[0]!), lowRaw = parts[1]!;
    if (high === null || high === 0) return null;
    const low = lowRaw.length === 1 && lowRaw in CN_DIGIT ? CN_DIGIT[lowRaw]! * 1000 : cnSection(lowRaw);
    return low === null ? null : high * 10000 + low;
  }
  return cnSection(raw);
}

const CN_DIGITS = '零〇一二两三四五六七八九';
const CN_INT = `[${CN_DIGITS}十百千万]+`;
const CN_ONE = `[${CN_DIGITS}]`;

/**
 * R6：只放行「纯数字（至多两位小数）加单位」的金额片段。
 * 片段里有任何多余成分（不到、左右、负、减、大概…）→ 非 ok（bad / negative / …），不取整、不丢负号。
 * 中文口语角分：「六百八十块五」「一千二百五十块五毛」解析为 680.5 / 1250.5 元（分）。
 * 解析不完整（例如「块五十」剩字）→ bad，绝不截成整数。
 */
export function parsePureMoney(raw: string, max = MAX_ENTRY_AMOUNT): AmountValue {
  const text = raw.replace(/\s+/g, '');
  if (!text) return { ok: false, issue: 'bad', text: raw };
  const neg = /^(?:负|减|[-−－﹣])(.+)$/.exec(text);
  if (neg) {
    const inner = parsePureMoney(neg[1]!, max);
    if (inner.ok || inner.issue === 'zero') return { ok: false, issue: 'negative', text };
    return { ok: false, issue: 'bad', text };
  }
  const ar = amountValue(text, max);
  if (ar.ok || ar.issue !== 'bad') return ar;
  const cn = new RegExp(`^(${CN_INT})(元整|块整|块钱|元|块|整)?(?:(${CN_ONE})(毛|角)?)?(?:(${CN_ONE})分)?$`).exec(text);
  if (!cn) return { ok: false, issue: 'bad', text };
  const yuan = cnAmount(cn[1]!);
  if (yuan === null) return { ok: false, issue: 'bad', text };
  if (!cn[2] && !/[十百千万]/.test(cn[1]!)) return { ok: false, issue: 'bad', text };
  // 「六百八十块五」：有单位 + 一位中文数字，可省略「毛」。没有单位又没有「毛/角」则不是口语角分。
  if (cn[3] && !cn[2] && !cn[4]) return { ok: false, issue: 'bad', text };
  const jiao = cn[3] ? CN_DIGIT[cn[3]]! : 0;
  const fen = cn[5] ? CN_DIGIT[cn[5]]! : 0;
  const cents = yuan * 100 + jiao * 10 + fen;
  if (cents === 0) return { ok: false, issue: 'zero', text };
  if (!Number.isSafeInteger(cents) || cents > max) return { ok: false, issue: 'too_large', text };
  return { ok: true, amount: cents, text };
}

/** 回显用，转出整数分对应的元字符串。 */
export { formatYuan };
