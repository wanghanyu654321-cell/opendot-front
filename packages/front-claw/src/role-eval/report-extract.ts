import { MAX_NUMERIC_CENTS, yuanIntegerToCents } from './money.js';
import { amountValue, cnAmount, parsePureMoney, type AmountIssue } from './amounts.js';
import { guardUtteranceAmounts, guardIssueToReason } from './amount-guard.js';
import { tryStandardReport, standardAskToReason } from './standard-line.js';
import { normalizeReportText, type ParsedEntry } from './report-parse.js';
import { clauseKind, compoundHead, compoundTail, maskNegatedPastDay } from './scope-refusal.js';

/**
 * R2（M02）：自然句报数的泛化抽取（纯函数，不读库）。不针对任何具体句子，只用通用文法：
 *   客人 = 「姓 + 称谓」（X姐/X姨/X阿姨/X哥/X叔/X先生/X女士/X小姐/X老师/X总…）；项目 = 服务项目名词 + 「项目/套餐/护理」类后缀；
 *   金额 = 阿拉伯数字（可带 ¥、k/w/千/万、元/块/块钱）或中文数字（须带量级或货币单位）；
 *   括号 = 紧跟金额的（员工）= 业绩归属；无括号 = 本人；「替/帮/给 + 员工名 + 报/记/登/补」= 代报对象。
 * 「格式明确」= 每个金额都能配上它前面最近的一位客人/项目，且没有歧义。任何一处不确定 → 不出清单（澄清或拒绝）：
 *   - 金额超过两位小数/零/负数/超技术上界（amounts.ts）；
 *   - 金额配不上客人（含把员工昵称写在客人位置）、同一客人两个金额、客人没有金额；
 *   - 互斥候选（A还是B / A或者B）、未定指代（其中一单）、发送人自己说不确定（还没定/记混了/来着/不清楚…）；
 *   - 括号里多人、代词受益人（给他/替她）而没有括号、明说「不是我的」却没写归谁；
 *   - 说了「两笔」却抽出不同笔数、写了合计但与各笔之和不符；
 * 以下情形不当报数（交给其他意图）：金额所在分句是问句（查结果/进度）、改账/撤回、目标、营销创作且没有报数动作、
 * 非今天的日期（报数只记今天；历史日期请发带日期标题的清单）、金额只出现在引号里（素材）。
 */
export type ExtractedEntry = ParsedEntry & { self: boolean; storeName: string | null };
export type ExtractResult =
  | { status: 'complete'; entries: ExtractedEntry[] }
  | { status: 'unclear'; reason: UnclearReason; detail?: string }
  | { status: 'none' };
export type UnclearReason = AmountIssue | 'orphan_amount' | 'customer_two_amounts' | 'missing_amount' | 'alternatives' | 'unresolved_choice'
  | 'hedged' | 'multi_employee' | 'pronoun_beneficiary' | 'negated_self' | 'count_mismatch' | 'total_mismatch' | 'beneficiary_conflict' | 'vague_amount' | 'not_closed' | 'ask_wan' | 'negation';

/** 称谓：通用中文客人称呼（不是某条语料的词）。 */
export const HONORIFIC = '阿姨|奶奶|爷爷|先生|女士|小姐|老师|姐姐|哥哥|姐|姨|哥|叔|总|嫂|婶';
const NOT_SURNAME = /[有个位的约点是给和跟来去要请半刻号日月天午晚早上下今后期拜客我你他她这那每各大小老阿一二两三四五六七八九十帮替记报算都也就还汇合共总]/;
const CUSTOMER = new RegExp(`([\\u4e00-\\u9fa5])(${HONORIFIC})`, 'g');
/** 项目：服务名词 + 后缀（与预约共用的通用服务词）。 */
const PROJECT = /(面部|补水|肩颈|头皮|足部|身体|美甲|美睫|美容|按摩|推拿|SPA|spa|护肤|皮肤|清洁|美白|紧致|祛痘|拔罐|艾灸|理疗|养生)(?:护理|项目|套餐|疗程|体验|服务)?/g;
/** 不确定（发送人自己说没定/记不清）：通用的模糊表达，不是语料原句。 */
export const HEDGE = /还没(?:定|说|想好|确定|确认|决定)|没(?:定|想好|确定)|未定|不确定|不清楚|不太清楚|记不清|记混|忘了|拿不准|说不准|来着|等我确认|到底(?:按|是|算)哪|好像|大概|差不多|可能是|估计/;
/** 互斥候选连接词。 */
const ALT = /还是|或者|或是|要么|或/g;
const CHOICE = /其中(?:一|某)(?:单|笔|个|条|次|位)|哪(?:一)?(?:单|笔)(?:都|也)?(?:行|可以)/;
const QUESTION = /[?？]|吗|么$|没$|没呀|没啊|没呢|了没|成功没|有没有|是不是|多少(?!钱的)|几笔/;
const CORRECTION = /改成|改为|改到|改下|改一下|改个|更正|写错|填错|记错|报错|多写|少写|撤回|撤销|作废|删掉|删除/;
const TARGET = /目标/;
const MARKETING = /文案|小红书|朋友圈|海报|种草|推广|营销|宣传|标语|口号|推文|公众号|抖音|短视频|脚本|活动方案|广告|话术|标题/;
const REPORT_CUE = /(?<![别不])(?:记|报|登|入账|核对|清单|算我|业绩)/;
const NEG_REPORT = /别(?:报|记|入账|登)|不要(?:报|记|入账|登)|不用(?:报|记|入账|登)|不是报数/;
const NOT_CLOSED = /最后没做|没做成|未成交|没成交|黄了|没买了|没买|白忙活|白忙|没做了|不做了|没搞成|没约成/;
const OTHER_DAY = /昨天|昨儿|昨日|昨晚|前天|前儿|大前天|明天|明日|明儿|后天|大后天|下周|下星期|上周|上星期|\d{1,2}月\d{1,2}[日号]|\d{1,2}[日号](?!码)|(20\d{2})[-/年]\d{1,2}[-/月]\d{1,2}/;
const TOTAL = /(?:一共|总共|合计|共计|总计|总额|加起来)$/;
const COUNT = /(?<![\d.])(\d|[一两二三四五六七八九十])\s*(?:笔|单)(?!价)/;
const SELF_WORD = /^(?:我|我的|本人|我自己|自己|咱|咱自己)$/;
const PRONOUN = /^(?:他|她|它|ta|TA|他们|她们)$/;
const NEG_SELF = /不是我的|不算我|不记我|别记我/;

interface Mention { kind: 'customer' | 'project' | 'amount'; start: number; end: number; name?: string; amount?: number; amountText?: string; issue?: AmountIssue; total?: boolean; employee?: string; moneyLike?: boolean; vague?: boolean }

const CN_NUM = '[零〇一二两三四五六七八九十百千万]+';
const CN_AMOUNT = new RegExp(`(${CN_NUM})(块钱|元|块)?`, 'g');
const ARABIC = /([-−－﹣]|负)?\s*([¥￥])?\s*(\d+(?:\.\d+)?)\s*([kKwW千万](?![a-zA-Z]))?\s*(块钱|元|块)?/g;
/** 数字后面若跟这些量词/时间单位，就不是钱。 */
const NOT_MONEY_AFTER = /^(?:[:：]\d|[.．]\d|点|月|日|号|分|秒|h\b|H\b|小时|笔|单|个|次|天|年|岁|%|％|乘|加|减|除|等|位|人|张|条|句|字|厘米|米|斤|杯|号|楼|层|周|折|倍|成|w(?=[a-z])|码)/;
const BRACKET = /^\s*[（(]\s*([^（）()]{1,16}?)\s*[）)]/;

function maskQuotes(text: string): string {
  return text.replace(/[“"「『‘'][^”"」』’']*[”"」』’']/g, m => '　'.repeat(m.length));
}
function maskIdentifiers(text: string): string {
  return text.replace(/[A-Za-z]+(?:-[A-Za-z0-9]+)+/g, m => '　'.repeat(m.length));
}


/**
 * R6：金额片段 = 数字本身向外扩到修饰用字（不到、将近、大概、负、减、左右、多…），
 * 不以逐个补词为规则；整段必须是「纯数字+单位」（parsePureMoney）。
 * 扩到的是修饰用字集合，不会把「弄成/其实是/算我」等结构词吃进去，以免把合法报单收成澄清。
 * 分隔：空白、标点、客人/项目词边界、以及报/记/算我等结构词。
 */
const MODIFIER_CHARS = /[不未将大约概差负减近才只足满仅快已还乎刚正上下来余开外左右多约摸几估值到]/;
const DELIM_CHAR = /[\s，,。．.!！?？、；;：:()（）【】[\]《》"""''…—–·]/;
const PARTICLE = /[的了呢吧啊呀哈嘛哦噢嗯]/;
const RIGHT_STRUCT = /^(?:算我|算你|算咱|帮我|给我|请|报|记|登|入账|今天|今日|消费|是|要|来|去|做|那笔|这笔)/;
const LEFT_STRUCT = /(?:帮我|给我|请|把|将|报|记|登|是|要|做|消费|今天|今日|那笔|这笔)$/;

function expandAmountFragment(text: string, start: number, end: number, spans: readonly { start: number; end: number }[]): { start: number; end: number; raw: string } {
  let left = start;
  while (left > 0) {
    if (spans.some(s => s.start <= left - 1 && left - 1 < s.end)) break;
    const ch = text[left - 1]!;
    if (DELIM_CHAR.test(ch) || PARTICLE.test(ch)) break;
    if (LEFT_STRUCT.test(text.slice(0, left))) break;
    if (!MODIFIER_CHARS.test(ch)) break;
    left -= 1;
  }
  let right = end;
  while (right < text.length) {
    if (spans.some(s => s.start <= right && right < s.end)) break;
    const ch = text[right]!;
    if (DELIM_CHAR.test(ch) || PARTICLE.test(ch)) break;
    if (RIGHT_STRUCT.test(text.slice(right))) break;
    // 口语角分「块五 / 五毛 / 五角 / 三分」算金额本身，继续纳入再交给 parsePureMoney。
    const tail = text.slice(end, right + 1).replace(/\s+/g, '');
    const isDecimalTail = /^(?:[零〇一二两三四五六七八九](?:毛|角)?(?:[零〇一二两三四五六七八九]分)?)$/.test(tail);
    if (!MODIFIER_CHARS.test(ch) && !isDecimalTail) break;
    right += 1;
  }
  return { start: left, end: right, raw: text.slice(left, right).replace(/\s+/g, '') };
}

function moneyFromFragment(raw: string): { amount?: number; amountText?: string; issue?: AmountIssue; vague?: boolean } {
  const value = parsePureMoney(raw);
  if (value.ok) return { amount: value.amount, ...(value.text ? { amountText: value.text } : { amountText: raw }) };
  if (value.issue === 'negative' || value.issue === 'zero' || value.issue === 'fraction' || value.issue === 'too_large') {
    return { issue: value.issue, amountText: raw };
  }
  return { vague: true, amountText: raw };
}

function mentionsOf(text: string): Mention[] {
  const out: Mention[] = [];
  for (const m of text.matchAll(CUSTOMER)) {
    if (NOT_SURNAME.test(m[1]!)) continue;
    // 「小X」「老X」是员工昵称写法，不当客人；称谓后紧跟「妹/们」等不当客人。
    out.push({ kind: 'customer', start: m.index!, end: m.index! + m[0].length, name: m[0] });
  }
  for (const m of text.matchAll(PROJECT)) out.push({ kind: 'project', start: m.index!, end: m.index! + m[0].length, name: m[0] });
  const spans = out.map(x => ({ start: x.start, end: x.end }));
  for (const m of text.matchAll(ARABIC)) {
    const start = m.index!, end = start + m[0].length;
    const before = text.slice(0, start);
    if (/[A-Za-z0-9_.:：]$/.test(before) || /第\s*$/.test(before)) continue;
    const after = text.slice(end);
    const unit = m[4], yuan = m[5], currency = m[2];
    if (!unit && !yuan && NOT_MONEY_AFTER.test(after)) continue;
    if (unit && /^[kKwW]$/.test(unit) && /^[a-zA-Z]/.test(after)) continue;
    const frag = expandAmountFragment(text, start, end, spans);
    const money = moneyFromFragment(frag.raw);
    const bracket = BRACKET.exec(text.slice(frag.end));
    const moneyLike = !!(unit || yuan || currency || bracket || money.vague || money.issue);
    out.push({ kind: 'amount', start: frag.start, end: frag.end, moneyLike, vague: !!money.vague,
      ...(money.amount !== undefined ? { amount: money.amount } : {}),
      ...(money.amountText !== undefined ? { amountText: money.amountText } : {}),
      ...(money.issue ? { issue: money.issue } : {}),
      total: TOTAL.test(before.trimEnd()), ...(bracket ? { employee: bracket[1]!.trim() } : {}) });
  }
  for (const m of text.matchAll(CN_AMOUNT)) {
    const raw = m[1]!, yuan = m[2];
    if (!/[十百千万]/.test(raw) && !yuan) continue;
    const start = m.index!, end = start + m[0].length;
    if (!yuan && NOT_MONEY_AFTER.test(text.slice(end))) continue;
    if (out.some(x => x.kind === 'amount' && x.start < end && start < x.end)) continue;
    const frag = expandAmountFragment(text, start, end, spans);
    if (out.some(x => x.kind === 'amount' && x.start < frag.end && frag.start < x.end)) continue;
    const money = moneyFromFragment(frag.raw);
    const bracket = BRACKET.exec(text.slice(frag.end));
    out.push({ kind: 'amount', start: frag.start, end: frag.end, moneyLike: true, vague: !!money.vague,
      ...(money.amount !== undefined ? { amount: money.amount } : {}),
      ...(money.amountText !== undefined ? { amountText: money.amountText } : {}),
      ...(money.issue ? { issue: money.issue } : {}),
      total: TOTAL.test(text.slice(0, start).trimEnd()), ...(bracket ? { employee: bracket[1]!.trim() } : {}) });
  }
  return out.sort((a, b) => a.start - b.start || (a.kind === 'amount' ? 1 : -1));
}

/** 金额所在分句（按标点切）。 */
function clauseAt(text: string, index: number): string {
  const left = Math.max(...['，', ',', '；', ';', '。', '！', '!', '\n', '、'].map(p => text.lastIndexOf(p, index - 1)));
  const rights = ['，', ',', '；', ';', '。', '！', '!', '\n', '、'].map(p => text.indexOf(p, index)).filter(i => i >= 0);
  return text.slice(left + 1, rights.length ? Math.min(...rights) + 1 : text.length);
}

function beneficiaryOf(text: string): { kind: 'self' | 'pronoun' | 'named'; name?: string } | null {
  const m = /(?:替|帮|给)(他们|她们|他|她|TA|ta|(?:[A-Za-z0-9]{1,3}店|[\u4e00-\u9fa5]{1,4}店)?[小老阿][\u4e00-\u9fa5]{1,2}?)(?=报|记|登|补|算|代报)/.exec(text)
    ?? /(?:都|全)?(?:记|算)(?:在|到|给)?((?:[A-Za-z0-9]{1,3}店)?[小老阿][\u4e00-\u9fa5]{1,2}?|他|她)(?:的|名下|头上|账上)?(?=$|[，,。！!；;\s]|吧|哈|啊|呀)/.exec(text);
  if (!m) return null;
  const who = m[1]!;
  if (SELF_WORD.test(who)) return { kind: 'self' };
  if (PRONOUN.test(who)) return { kind: 'pronoun' };
  return { kind: 'named', name: who };
}

/** 括号/受益人里的「X店小王」→ 门店名 + 员工名。 */
export function splitStore(name: string): { storeName: string | null; employeeName: string } {
  const m = /^([A-Za-z0-9]{1,3}店|[\u4e00-\u9fa5]{1,6}?店)(.+)$/.exec(name);
  return m && !/^(?:本|我|这|该|门)店$/.test(m[1]!) ? { storeName: m[1]!, employeeName: m[2]! } : { storeName: null, employeeName: name };
}

/** 与具体意图无关的歧义检查（互斥候选、未定指代、发送人自述不确定）。 */
export function ambiguityOf(raw: string): UnclearReason | null {
  const text = maskQuotes(normalizeReportText(raw));
  if (HEDGE.test(text)) return 'hedged';
  if (CHOICE.test(text)) return 'unresolved_choice';
  for (const m of text.matchAll(ALT)) {
    const i = m.index!;
    const left = text.slice(Math.max(0, i - 14), i).split(/[，,；;。！!\n]/).pop() ?? '';
    const right = text.slice(i + m[0].length, i + m[0].length + 14).split(/[，,；;。！!\n]/)[0] ?? '';
    if (slotTypes(left).some(t => slotTypes(right).includes(t))) return 'alternatives';
  }
  return null;
}
function slotTypes(part: string): string[] {
  const types: string[] = [];
  if (/\d|[一二两三四五六七八九十百千万]{2,}/.test(part)) types.push('number');
  if (/OP-|操作号/.test(part)) types.push('op');
  if (/[上下这本]个?月|[上下这本]周|今天|明天|昨天|后天/.test(part)) types.push('period');
  if (new RegExp(`[\\u4e00-\\u9fa5](?:${HONORIFIC})|[小老阿][\\u4e00-\\u9fa5]`).test(part)) types.push('person');
  if (/点|[:：]\d/.test(part)) types.push('time');
  return types;
}

/** 文本里带“钱”特征但有问题的金额（角分/负数/零/超上限）；用于标准清单解析失败时给出准确澄清。 */
export function moneyIssueOf(raw: string): { issue: AmountIssue; text: string } | null {
  const text = maskIdentifiers(maskQuotes(normalizeReportText(raw)));
  for (const m of mentionsOf(text)) if (m.kind === 'amount' && m.issue && m.issue !== 'bad' && (m.moneyLike || m.issue === 'negative' || m.issue === 'fraction')) return { issue: m.issue, text: m.amountText ?? '' };
  return null;
}

/**
 * 与 extractReport 共用同一套未成交/否定报单语义：
 * 只剥掉明确的非报单复合分句（如「先别预约」），避免模型兜底或候选改写擦除原句里的「没成交 / 别记」。
 */
export function nonClosingReportReason(raw: string): 'not_closed' | 'negation' | null {
  if (typeof raw !== 'string') return null;
  let normalized = normalizeReportText(raw).trim();
  if (!normalized || normalized.length > 300) return null;
  const tail = compoundTail(normalized);
  const head = compoundHead(normalized);
  if (tail && clauseKind(tail) && clauseKind(tail) !== 'report' && (clauseKind(head) === 'report' || mentionsOf(maskIdentifiers(maskQuotes(head))).some(m => m.kind === 'amount'))) {
    normalized = head.trim();
  }
  const text = maskIdentifiers(maskQuotes(normalized));
  const flat = text.replace(/\s+/g, '');
  if (!mentionsOf(text).some(m => m.kind === 'amount')) return null;
  if (NOT_CLOSED.test(flat)) return 'not_closed';
  if (NEG_REPORT.test(flat)) return 'negation';
  return null;
}

export function extractReport(raw: string): ExtractResult {
  if (typeof raw !== 'string') return { status: 'none' };
  let normalized = normalizeReportText(raw).trim();
  if (!normalized || normalized.length > 300) return { status: 'none' };
  // 后半句是另一件店务（预约/海报/改账…）时，只从前半句抽报数，避免把后半句客人当成「缺金额」。
  const tail = compoundTail(normalized);
  const head = compoundHead(normalized);
  if (tail && clauseKind(tail) && clauseKind(tail) !== 'report' && clauseKind(head) === 'report') normalized = head.trim();
  // D125：标准行先走同一份语法，避免「X姐：1.2万」被旧抽取把「万」当成单独不确定金额。
  const std = tryStandardReport(normalized, '2026-11-12');
  if (std.status === 'complete') {
    const entries: ExtractedEntry[] = std.report.entries.map(e => {
      const who = e.employeeName;
      const split = who ? splitStore(who) : { storeName: null, employeeName: '' };
      return {
        customer: e.customer, amount: e.amount,
        employeeName: split.employeeName || e.employeeName,
        note: e.note, self: !!e.self || !e.employeeName, storeName: split.storeName,
        ...(e.amountText ? { amountText: e.amountText } : {}),
      };
    });
    return { status: 'complete', entries };
  }
  if (std.status === 'ask') {
    const reason = standardAskToReason(std.reason);
    return { status: 'unclear', reason, ...(std.detail ? { detail: std.detail } : {}) };
  }
  const text = maskIdentifiers(maskQuotes(normalized));
  const flat = text.replace(/\s+/g, '');
  const mentions = mentionsOf(text);
  const amounts = mentions.filter(m => m.kind === 'amount');
  const subjects = mentions.filter(m => m.kind !== 'amount');
  if (!amounts.length && !subjects.some(m => m.kind === 'customer')) return { status: 'none' };
  // 不是报数的句型：交给其他意图。只看前半句，避免后半句「明天预约/改成」把前半句报数整句丢掉。
  const headFlat = compoundHead(normalized).replace(/\s+/g, '');
  const headForDay = maskNegatedPastDay(headFlat);
  if (CORRECTION.test(headFlat) || TARGET.test(headFlat) || OTHER_DAY.test(headForDay)) return { status: 'none' };
  // 未成交/没做成：不出可确认报数（金额只是在说「当时的报价」）。
  if (NOT_CLOSED.test(flat) && amounts.length) return { status: 'unclear', reason: 'not_closed' };
  if (MARKETING.test(flat) && (!REPORT_CUE.test(flat) || NEG_REPORT.test(flat))) return { status: 'none' };
  if (NEG_REPORT.test(flat)) return { status: 'none' };
  const customers = subjects.filter(m => m.kind === 'customer');
  if (!amounts.length) {
    // 有客人、有报数动作、没金额 → 缺金额（澄清）；否则不是报数。
    // 带时间/来店说法的是预约，不是缺金额的报数。
    const timeLike = /\d{1,2}\s*(?:点|[:：]\d{2})|[一二两三四五六七八九十]{1,3}点|明早|明晚|明日|明儿|今晚|约|来做|到店/.test(flat);
    return customers.length && REPORT_CUE.test(flat) && !QUESTION.test(flat) && !timeLike ? { status: 'unclear', reason: 'missing_amount' } : { status: 'none' };
  }
  // 金额所在分句是问句 → 查询，不当报数。
  if (amounts.some(a => QUESTION.test(clauseAt(text, a.start).replace(/\s+/g, '')))) return { status: 'none' };
  if (!subjects.length) return { status: 'none' };
  const vagueAmt = amounts.find(a => a.vague);
  if (vagueAmt) return { status: 'unclear', reason: 'vague_amount', detail: vagueAmt.amountText ?? String(vagueAmt.amount ?? '') };
  const ambiguous = ambiguityOf(normalized);
  if (ambiguous) return { status: 'unclear', reason: ambiguous };
  const bad = amounts.find(a => a.issue && (a.moneyLike || a.issue === 'fraction' || a.issue === 'negative'));
  if (bad) return { status: 'unclear', reason: bad.issue!, detail: bad.amountText ?? '' };
  // 配对：每个非合计金额配它前面最近的、还没配过的客人/项目。
  const used = new Set<Mention>();
  const pairs: { subject: Mention; amount: Mention }[] = [];
  const totals: Mention[] = [];
  for (const a of amounts.filter(x => !x.issue)) {
    if (a.total) { totals.push(a); continue; }
    const subject = [...subjects].reverse().find(s => s.end <= a.start && !used.has(s));
    if (!subject) {
      const paired = [...subjects].reverse().find(s => s.end <= a.start);
      return { status: 'unclear', reason: paired ? 'customer_two_amounts' : 'orphan_amount', detail: a.amountText ?? String(a.amount) };
    }
    // 客人与金额之间夹着另一个人名（员工昵称/他店人员写在客人位）→ 配不上。
    const between = text.slice(subject.end, a.start);
    if (/[小老阿][\u4e00-\u9fa5]/.test(between.replace(/[（(][^）)]*[）)]/g, '')) && subject.kind === 'customer' && /[，,；;、]/.test(between)) return { status: 'unclear', reason: 'orphan_amount', detail: a.amountText ?? String(a.amount) };
    // 同一位客人之后、本金额之前已有一个金额 → 一客两价。
    if (pairs.some(p => p.subject.end <= a.start && p.amount.start > subject.end)) return { status: 'unclear', reason: 'customer_two_amounts' };
    used.add(subject);
    // 项目之前紧挨着的客人与项目视为同一笔（「张姐肩颈护理 380」）。
    if (subject.kind === 'project') { const c = [...customers].reverse().find(x => x.end <= subject.start && !used.has(x) && subject.start - x.end <= 4); if (c) used.add(c); }
    pairs.push({ subject, amount: a });
  }
  if (!pairs.length && totals.length === 1) {
    const a = totals[0]!; const subject = [...subjects].reverse().find(s => s.end <= a.start);
    if (!subject) return { status: 'unclear', reason: 'orphan_amount' };
    used.add(subject); pairs.push({ subject, amount: { ...a, total: false } });
    totals.length = 0;
  }
  if (totals.length) {
    const sum = pairs.reduce((n, p) => n + p.amount.amount!, 0);
    if (totals.length > 1 || pairs.length < 2 || totals[0]!.amount !== sum) return { status: 'unclear', reason: 'total_mismatch' };
  }
  // 客人没有金额。
  if (customers.some(c => !used.has(c) && !pairs.some(p => p.subject.kind === 'project' && Math.abs(p.subject.start - c.end) <= 4))) return { status: 'unclear', reason: 'missing_amount' };
  const count = COUNT.exec(flat);
  if (count) {
    const n = /\d/.test(count[1]!) ? Number(count[1]) : cnAmount(count[1]!.replace('两', '二'));
    if (n !== pairs.length) return { status: 'unclear', reason: 'count_mismatch' };
  }
  // 归属：括号 > 受益人 > 本人。
  const benef = beneficiaryOf(flat);
  const bracketed = pairs.filter(p => p.amount.employee);
  for (const p of bracketed) if (/[/／、,，&]|或|和|跟/.test(p.amount.employee!)) return { status: 'unclear', reason: 'multi_employee' };
  if (benef?.kind === 'pronoun' && bracketed.length !== pairs.length) return { status: 'unclear', reason: 'pronoun_beneficiary' };
  if (NEG_SELF.test(flat) && !bracketed.length && benef?.kind !== 'named') return { status: 'unclear', reason: 'negated_self' };
  if (benef?.kind === 'named' && bracketed.some(p => splitStore(p.amount.employee!).employeeName !== splitStore(benef.name!).employeeName)) return { status: 'unclear', reason: 'beneficiary_conflict' };
  const entries: ExtractedEntry[] = pairs.map(({ subject, amount }) => {
    const who = amount.employee ?? (benef?.kind === 'named' ? benef.name! : null);
    const split = who ? splitStore(who) : { storeName: null, employeeName: '' };
    const customerMention = subject.kind === 'customer' ? subject : [...customers].reverse().find(c => c.end <= subject.start && subject.start - c.end <= 4);
    const note = subject.kind === 'project' ? subject.name! : '';
    return { customer: customerMention?.name ?? null, amount: amount.amount!, employeeName: split.employeeName, note, self: !who, storeName: split.storeName,
      ...(amount.amountText && amount.amountText !== String(amount.amount) ? { amountText: amount.amountText } : {}) };
  });
  // R7：整句过同一道金额校验。脏词（出头/亏了）不能剥掉后把干净数字当完成稿。
  const gated = guardUtteranceAmounts(normalized, 'free');
  if (!gated.ok) return { status: 'unclear', reason: guardIssueToReason(gated.issue), detail: gated.text };
  return { status: 'complete', entries };
}
