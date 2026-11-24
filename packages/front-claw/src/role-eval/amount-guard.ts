/**
 * R7（D120）：金额进入草稿的唯一收口。
 *
 * 根因（R6 探针，不改白名单词表）：
 * - `parsePureMoney('2000出头')` / `parsePureMoney('亏了800')` 本身已经拒绝；
 * - 但 `expandAmountFragment` 只向外扩「已知修饰字」，「出/头/亏/赔」不在集合里，
 *   片段被收成干净的「2000」「800」，再交给白名单就通过了；
 * - `parseEntryLine` 把「出头」当成备注，金额项仍是 2000；
 * - `amountValue('0.33')` 在自由句里把无单位小数当成 0.33 元；
 * - `ledger-commands.parseAmount`、模型槽位等路径没有再走同一道校验。
 *
 * 修法：所有产出金额的路径必须经过本文件的校验函数。不是往 MODIFIER_CHARS 加词。
 * 整句检查（`guardUtteranceAmounts`）看数字两边的残留，未知后缀失败关闭；
 * 草稿写入前 `sealDraftAmounts` 再核一次——只带干净数字、丢掉脏词，会失败。
 *
 * 标准行（「客户：金额（员工）」）里的纯数字默认按元收，不追问（门①）。
 * 不在标准行里的无单位小数、以及约数/方向词（出头、左右、多、亏、赔等）一律追问，不改符号。
 * 「0.33w」「3k」「1.2万」等明确单位直接解析。
 */
import { amountValue, parsePureMoney, type AmountIssue, type AmountValue } from './amounts.js';
import { formatYuan } from './money.js';
import {
  applyStandardDecimalPolicy, isStandardAmountLine, tryStandardReport,
} from './standard-line.js';

export { isStandardAmountLine } from './standard-line.js';

export type AmountContext = 'standard-line' | 'free';
export type AmountGuardIssue = AmountIssue | 'vague_amount' | 'bare_ambiguous' | 'unvalidated' | 'ask_wan';

export type AmountGuardOk = { ok: true; cents: number; source: string; context: AmountContext };
export type AmountGuardFail = { ok: false; issue: AmountGuardIssue; text: string };
export type AmountGuardResult = AmountGuardOk | AmountGuardFail;

export class UnvalidatedAmountError extends Error {
  readonly issue: AmountGuardIssue;
  readonly text: string;
  constructor(issue: AmountGuardIssue, text: string) {
    super('unvalidated_amount');
    this.name = 'UnvalidatedAmountError';
    this.issue = issue;
    this.text = text;
  }
}


const DELIM = /[\s，,。．.!！?？、；;：:()（）【】[\]《》""''…—–·+＋]/;
const PARTICLE = /[的了呢吧啊呀哈嘛哦噢嗯]/;
/** 金额左边允许的结构（改口/报记），不是约数。 */
const LEFT_STRUCT = /(?:帮我|给我|请|把|将|报|记|登|是|要|做|付|收|消费|今天|今日|那笔|这笔|弄成|改成|写成|填成|调成|调到|记成|报成|应当是|应该是|应为|其实是|算我|算成)$/;
/** 金额右边允许的结构。 */
const RIGHT_STRUCT = /^(?:算我|算你|算咱|归我|归你|帮我|给我|请|报|记|登|入账|今天|今日|消费|是|要|来|去|做|那笔|这笔|面部|补水|肩颈|护理|项目|套餐|(?:帮|替)[\u4e00-\u9fa5]{1,4}(?:报|记|登|算)|(?:报|记|算|登)[\u4e00-\u9fa5]{1,4}(?:的|名下|今天的|今日的))/;
const HONOR = /(?:阿姨|奶奶|爷爷|先生|女士|小姐|老师|姐姐|哥哥|姐|姨|哥|叔|总|嫂|婶)$/;
/** 方向/亏损：前缀出现时金额不能当正数收下，也绝不改符号后入账。 */
const LOSS_PREFIX = /(?:亏|赔|损失|少收|亏了|赔了|亏掉)$/;
/** 约数/上限下限前缀（不到、将近、大概…）。 */
const HEDGE_PREFIX = /(?:不到|不满|不足|将近|接近|快到|大约|大概|差不多|约|估计|几乎|可能|左右)$/;
const SCALE_UNIT = /^(?:[kKwW千万])/;
const MONEY_UNIT = /^(?:元整|块整|块钱|元|块|整|毛|角|分)/;
const ORAL_DECIMAL = /^(?:[零〇一二两三四五六七八九](?:毛|角)?(?:[零〇一二两三四五六七八九]分)?)/;
/** 数字后面是时间/日期/计数单位：不是金额，整段跳过（12号、17点、11月、2笔）。 */
const NOT_AMOUNT_AFTER = /^(?:点|时|分(?!钟)|秒|小时|钟|月|日|号|年|笔|单|个|次|位|人|天|周|折|倍|成|楼|层|岁|%|％)/;
/** 横向空白（不含换行）。金额跨度不得把下一行吞进来。 */
const HSPACE = String.raw`[^\S\r\n]`;
const ARABIC = new RegExp(
  String.raw`(?:[-−－﹣]|负)?${HSPACE}*[¥￥]?${HSPACE}*\d+(?:\.\d+)?${HSPACE}*(?:[kKwW千万](?![a-zA-Z]))?${HSPACE}*(?:元整|块整|块钱|元|块|整)?`,
  'g',
);
const CN_NUM = /[零〇一二两三四五六七八九十百千万]+(?:元整|块整|块钱|元|块|整)?/g;

function inferContext(raw: string, explicit?: AmountContext): AmountContext {
  if (explicit) return explicit;
  return isStandardAmountLine(raw) ? 'standard-line' : 'free';
}

function stripSpace(text: string): string {
  return text.replace(/\s+/g, '');
}

/**
 * 单项金额（模型槽位、改账新金额、标准行金额位）。
 * 标准行：纯数字（含最多两位小数）按元收。
 * 自由句：必须有明确单位（k/w/千/万/元/块）或合法中文数；无单位小数追问；干净整数按元收（「张姐680」门①）。
 */
export function guardAmountTerm(raw: string, context: AmountContext, max?: number): AmountGuardResult {
  const text = raw.normalize('NFKC').replace(/\s+/g, '');
  if (!text) return { ok: false, issue: 'bad', text: raw };
  // 整项必须是「干净金额表达式」：不能夹带出头/左右/亏/赔等。
  if (hasHedgeResidue(text)) return { ok: false, issue: 'vague_amount', text };
  const parsed = parsePureMoney(text, max);
  if (parsed.ok) {
    if (context === 'free' && isBareAmbiguousDecimal(text)) {
      return { ok: false, issue: 'bare_ambiguous', text };
    }
    if (context === 'standard-line') {
      const pol = applyStandardDecimalPolicy(text);
      if (!pol.ok) {
        return { ok: false, issue: pol.issue === 'ask_wan' ? 'ask_wan' : pol.issue, text: pol.text };
      }
      return { ok: true, cents: pol.cents, source: text, context };
    }
    return { ok: true, cents: parsed.amount, source: text, context };
  }
  if (parsed.issue !== 'bad') return { ok: false, issue: parsed.issue, text };
  // 标准行纯数字（amountValue 已覆盖整数和小数）—— parsePureMoney 失败且 issue=bad 时不再放行。
  return { ok: false, issue: 'bad', text };
}

function isBareAmbiguousDecimal(text: string): boolean {
  // 无单位、以 0. 开头的小数（0.33、0.5）：自由句里既可能是元也可能是万，追问。
  // 「680.5」整数部分 ≥ 1，按元收（与「680.5元」同值，不伤常见角分写法）。
  // 带 k/w/千/万/元/块 的不是裸小数。
  if (/[kKwW千万元块整¥￥]/.test(text)) return false;
  if (/[零〇一二两三四五六七八九十百千万]/.test(text)) return false;
  return /^0+\.\d{1,2}$/.test(text);
}

function hasHedgeResidue(text: string): boolean {
  // 干净金额 = 可选符号 + 数字 + 可选单位 + 可选口语角分。任何多出来的汉字（出头、左右、多、亏…）都不干净。
  const clean = /^(?:负|减|[-−－﹣])?(?:[¥￥])?(?:\d+(?:\.\d+)?|[零〇一二两三四五六七八九十百千万]+)(?:[kKwW千万])?(?:元整|块整|块钱|元|块|整)?(?:[零〇一二两三四五六七八九](?:毛|角)?)?(?:[零〇一二两三四五六七八九]分)?$/;
  return !clean.test(text);
}

/**
 * 检查整句：句子里每一个金额表达式都必须过同一道校验。
 * 不是把脏词从数字上剥掉再解析——残留在数字两侧的未知汉字（出头）或方向词（亏了）直接失败。
 */
export function guardUtteranceAmounts(raw: string, context?: AmountContext): AmountGuardResult {
  if (typeof raw !== 'string') return { ok: false, issue: 'bad', text: '' };
  // A labelled ASCII store identifier is not a money token. Preserve separators and validate every other span.
  const text = raw.normalize('NFKC').replace(
    /(门店\s*)([A-Za-z0-9][A-Za-z0-9._-]{0,119})(?=\s|[，,。;；]|的?(?:本月|今天|业绩|汇总)|$)/g,
    (match, label: string, id: string) => /[A-Za-z]/.test(id) && /[-_]/.test(id) ? label + ' '.repeat(id.length) : match,
  );
  const ctx = inferContext(text, context);
  // D125：标准行整段按同一份语法收口，不跨行把下一行称呼当约数后缀。
  if (ctx === 'standard-line' || isStandardAmountLine(text)) {
    const std = tryStandardReport(text, '2026-11-12');
    if (std.status === 'complete' && std.report.entries.length) {
      const last = std.report.entries[std.report.entries.length - 1]!;
      return { ok: true, cents: last.amount, source: last.amountText ?? String(last.amount), context: 'standard-line' };
    }
    if (std.status === 'ask') {
      const issue: AmountGuardIssue = std.reason === 'ask_wan' ? 'ask_wan'
        : (std.reason === 'fraction' || std.reason === 'zero' || std.reason === 'negative' || std.reason === 'too_large' || std.reason === 'bad')
          ? std.reason : 'vague_amount';
      return { ok: false, issue, text: std.detail ?? text.trim() };
    }
    // not_today / none / incomplete：落到下面的跨度扫描（查询句等）。
  }
  const spans = collectAmountSpans(text);
  if (!spans.length) return { ok: false, issue: 'bad', text: text.trim() || raw };
  let last: AmountGuardOk | null = null;
  for (const span of spans) {
    const checked = checkSpan(text, span, ctx);
    if (checked.ok === 'skip') continue;
    if (!checked.ok) return checked;
    last = checked;
  }
  return last ?? { ok: false, issue: 'bad', text };
}

interface Span { start: number; end: number; core: string }

function collectAmountSpans(text: string): Span[] {
  const out: Span[] = [];
  for (const re of [ARABIC, CN_NUM]) {
    re.lastIndex = 0;
    for (const m of text.matchAll(new RegExp(re.source, 'g'))) {
      const core = m[0]!;
      // 中文「两笔」「一下」不是金额：无量级且无货币单位则跳过。
      if (re === CN_NUM && !/[十百千万]/.test(core) && !/(?:块钱|元整|块整|元|块|整)/.test(core)) continue;
      const start = m.index!;
      const end = start + core.length;
      // 被更长的阿拉伯数字跨住的中文片段跳过（不会发生），重叠则留更长。
      if (out.some(s => s.start < end && start < s.end && (s.end - s.start) >= (end - start))) continue;
      const filtered = out.filter(s => !(s.start < end && start < s.end && (end - start) > (s.end - s.start)));
      filtered.push({ start, end, core });
      out.length = 0;
      out.push(...filtered);
    }
  }
  return out.sort((a, b) => a.start - b.start);
}


function isDateOrTimeContext(text: string, start: number, end: number): boolean {
  const before = text.slice(Math.max(0, start - 10), start);
  const after = text.slice(end, end + 12);
  const core = text.slice(start, end).replace(/\s+/g, '');
  // 「2026-11-12」里的「-12」会被金额正则收成负号+数字：前面是数字时这是日期分隔，不是负金额。
  if (start > 0 && /[-−－﹣]/.test(text[start] ?? '') && /\d/.test(text[start - 1] ?? '')) return true;
  // 「15:00」的分钟：前面是「数字+冒号」。标准行「赵芳：35」的冒号前是名字，不能跳过。
  if (start >= 2 && /[:：]/.test(text[start - 1] ?? '') && /\d/.test(text[start - 2] ?? '') && /^\d{1,2}$/.test(core)) return true;
  // 「10月24」的日：前面是月；「10/25」的日：前面是斜线或点（已含在分隔里）。
  if (/[-/年月]$/.test(before) || /^[-/.月日号]/.test(after)) return true;
  if (/^\d{4}$/.test(core) && /^[-/年]/.test(after)) return true;
  if (/^[点时]/.test(after) || /^[:：]\d{2}/.test(after)) return true;
  // 标题日期「11.12 B店」「10.25天澜店」：月.日 后面不是货币单位，则不是 11.12 元。
  const afterFlat = after.replace(/\s+/g, '');
  if (/^(?:0?[1-9]|1[0-2])[./](?:0?[1-9]|[12]\d|3[01])$/.test(core)) {
    if (!MONEY_UNIT.test(afterFlat) && !SCALE_UNIT.test(afterFlat)
      && (/^[\u4e00-\u9fa5A-Za-z]/.test(afterFlat) || after.startsWith('\n') || after.startsWith('\r') || /店/.test(after))) {
      return true;
    }
  }
  return false;
}

type SpanResult = AmountGuardResult | { ok: 'skip' };

/** 行尾表情、装饰标点不是约数后缀。用 codePoint 判断，避免只拿到 UTF-16 代理对一半。 */
function isDecorationAt(text: string, i: number): boolean {
  const cp = text.codePointAt(i) ?? 0;
  if (cp >= 0x1F300 && cp <= 0x1FAFF) return true;
  if (cp >= 0x2600 && cp <= 0x27BF) return true;
  if (cp >= 0xFE00 && cp <= 0xFE0F) return true;
  if (cp === 0x200D) return true;
  return /[。．.!！?？~～、，,…・]/.test(String.fromCodePoint(cp));
}

function checkSpan(text: string, span: Span, ctx: AmountContext): SpanResult {
  // 金额跨度若误吞了换行或首尾空白，先裁回；换行是硬边界，不得把下一行当后缀。
  let left = span.start;
  let right = span.end;
  while (left < right && /\s/.test(text[left]!)) left += 1;
  const nlInSpan = text.slice(left, right).search(/[\r\n]/);
  if (nlInSpan !== -1) right = left + nlInSpan;
  while (right > left && /\s/.test(text[right - 1]!)) right -= 1;
  // 口语角分纳入核心（只看同行，不跨行拼接）。
  const oralSlice = text.slice(right).replace(/[^\S\r\n]+/g, '');
  const oral = oralSlice.startsWith('\n') || oralSlice.startsWith('\r') ? null : ORAL_DECIMAL.exec(oralSlice);
  if (oral && /(?:块|元|块钱)\s*$/.test(text.slice(left, right))) {
    // oral 匹配的是去掉横向空白后的文本，按原文本从 right 起数到同等内容。
    let seen = 0;
    let k = right;
    const want = oral[0]!;
    while (k < text.length && seen < want.length) {
      const ch = text[k]!;
      if (ch === '\n' || ch === '\r') break;
      if (/[^\S\r\n]/.test(ch)) { k += 1; continue; }
      k += 1;
      seen += 1;
    }
    if (seen === want.length) right = k;
  }
  const core = stripSpace(text.slice(left, right));
  // 后缀：只在同行内跳过空白，直到分隔或结构。非空且不是单位 → 约数。
  let suffixStart = right;
  let crossedNewline = false;
  while (suffixStart < text.length && /\s/.test(text[suffixStart]!)) {
    if (text[suffixStart] === '\n' || text[suffixStart] === '\r') { crossedNewline = true; break; }
    suffixStart += 1;
  }
  let suffixEnd = suffixStart;
  if (!crossedNewline) {
    while (suffixEnd < text.length) {
      const ch = text[suffixEnd]!;
      if (ch === '\n' || ch === '\r' || isDecorationAt(text, suffixEnd) || DELIM.test(ch) || PARTICLE.test(ch)) break;
      const rest = text.slice(suffixEnd);
      if (RIGHT_STRUCT.test(rest) || MONEY_UNIT.test(rest) || SCALE_UNIT.test(rest)) break;
      // 金额后紧贴的短称呼是归属，不是约数（出头/左右仍会收入 suffix）。
      if (HONOR.test(rest) && rest.length <= 6 && !/(?:出头|左右|上下|开外|多|来|近|亏|赔)/.test(rest)) break;
      suffixEnd += 1;
    }
  }
  if (isDateOrTimeContext(text, span.start, right) || NOT_AMOUNT_AFTER.test(text.slice(suffixStart))) {
    return { ok: 'skip' };
  }
  const suffix = stripSpace(text.slice(suffixStart, suffixEnd));
  if (suffix) {
    // 失败关闭：金额后紧跟的未知汉字一律当约数（出头、左右、多），不剥掉后收下数字。
    return { ok: false, issue: 'vague_amount', text: stripSpace(text.slice(span.start, suffixEnd)) };
  }
  // 前缀：跳过语气词「了」，看是否亏损/约数。不跨过换行。
  let prefixEnd = left;
  while (prefixEnd > 0 && /[^\S\r\n]/.test(text[prefixEnd - 1]!)) prefixEnd -= 1;
  let prefixStart = prefixEnd;
  while (prefixStart > 0) {
    const ch = text[prefixStart - 1]!;
    if (ch === '\n' || ch === '\r' || DELIM.test(ch)) break;
    const leftText = text.slice(0, prefixStart);
    if (LEFT_STRUCT.test(leftText) || HONOR.test(leftText)) break;
    if (PARTICLE.test(ch) && prefixStart === prefixEnd) {
      // 「亏了800」：了是语气词，继续向左把「亏」纳入。
      prefixStart -= 1;
      continue;
    }
    if (PARTICLE.test(ch)) break;
    prefixStart -= 1;
  }
  const prefix = stripSpace(text.slice(prefixStart, prefixEnd));
  if (prefix) {
    // 约数/亏损前缀必须追问，不改符号。其余前缀（客人名「林倩 10000」、动词「付了1.6k」、店名）放行，以免伤门①。
    if (LOSS_PREFIX.test(prefix) || HEDGE_PREFIX.test(prefix) || /(?:出头|左右|上下|开外|多|来|近)$/.test(prefix) || /^(?:亏|赔|不到|将近|大概|大约|约|近|出头)/.test(prefix)) {
      return { ok: false, issue: LOSS_PREFIX.test(prefix) || /^(?:亏|赔)/.test(prefix) ? 'negative' : 'vague_amount', text: stripSpace(text.slice(prefixStart, right)) };
    }
  }
  const term = guardAmountTerm(core, ctx);
  if (!term.ok) return { ...term, text: term.text || core };
  return term;
}

/**
 * 草稿写入前的强制收口。任何路径（规则、模型槽位、改金额）要把金额放进草稿，必须经过这里。
 * - 源句本身有约数/方向词（「2000出头」）→ 失败，即使 items 只带了干净的 2000。
 * - 分值与源项用本函数重算的结果不一致 → 失败。
 * - 条目没有可复核的源、又对不上句中任何已校验金额 → 失败。
 */
export function sealDraftAmounts(input: {
  utterance: string;
  items: readonly { amount: number; amountText?: string }[];
  context?: AmountContext;
}): asserts input is { utterance: string; items: readonly { amount: number; amountText?: string }[]; context?: AmountContext } {
  if (!input.items.length) throw new UnvalidatedAmountError('unvalidated', input.utterance);
  const ctx = inferContext(input.utterance, input.context);
  const utterance = guardUtteranceAmounts(input.utterance, ctx);
  if (!utterance.ok) throw new UnvalidatedAmountError(utterance.issue, utterance.text);
  const accepted: number[] = [];
  // 同一份语法已经收下的标准行：金额以语法结果为准，不把归属说法当成约数后缀。
  const std = tryStandardReport(input.utterance, '2026-11-12');
  if (std.status === 'complete') {
    accepted.push(...std.report.entries.map(e => e.amount));
  }
  // 收集句中每一个通过校验的金额（分），用于对不上 amountText 时的对照。
  for (const span of collectAmountSpans(input.utterance.normalize('NFKC'))) {
    const checked = checkSpan(input.utterance.normalize('NFKC'), span, ctx);
    if (checked.ok === true) accepted.push(checked.cents);
  }
  for (const item of input.items) {
    if (!Number.isSafeInteger(item.amount) || item.amount <= 0) {
      throw new UnvalidatedAmountError('unvalidated', item.amountText ?? String(item.amount));
    }
    if (item.amountText !== undefined && item.amountText !== '') {
      const g = guardAmountTerm(item.amountText, ctx);
      if (!g.ok || g.cents !== item.amount) {
        throw new UnvalidatedAmountError(g.ok ? 'unvalidated' : g.issue, item.amountText);
      }
    } else if (!accepted.includes(item.amount)) {
      // 没有源文、分值也不在句中已校验金额里：视为绕过。
      throw new UnvalidatedAmountError('unvalidated', formatYuan(item.amount));
    }
    // 即便单项干净，源句整体已在上面拒绝过脏词（出头）；走到这里说明句与项都通过。
  }
}

/** 把 AmountGuardIssue 映到既有澄清原因。 */
export function guardIssueToReason(issue: AmountGuardIssue): AmountIssue | 'vague_amount' | 'ask_wan' {
  if (issue === 'ask_wan') return 'ask_wan';
  if (issue === 'vague_amount' || issue === 'bare_ambiguous' || issue === 'unvalidated') return 'vague_amount';
  return issue;
}

/** 供模型槽位调用：原始金额字符串 → 通过则返回分，否则失败。模型不得直接给分。 */
export function centsFromModelSlot(amountText: unknown, context: AmountContext = 'free'): AmountGuardResult {
  if (typeof amountText !== 'string') return { ok: false, issue: 'unvalidated', text: String(amountText ?? '') };
  return guardAmountTerm(amountText, context);
}

/** 重新导出，便于调用方统一从收口模块取解析。 */
export { amountValue, parsePureMoney, formatYuan };
export type { AmountValue, AmountIssue };
