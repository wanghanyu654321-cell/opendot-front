import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
/**
 * R8（D125）：标准行快通道的唯一语法。
 *
 * 抽取、清单解析、amount-guard 都调用本文件，不允许各层再各自切分金额与称呼。
 * 一行 = 可选前缀 + 客户名（可带 姐/哥/老师 等称谓）+ 分隔（全/半角冒号或空白或紧贴）
 *       + 金额（阿拉伯或中文，可带 千/万/k/w/元/块，可 + 相加）
 *       + 可选（员工名）全/半角括号 + 可选行尾备注。
 * 多行：每行独立；金额后缀不得跨行吞下一行称呼。
 * 标题行：日期 + 店名，可与首行明细同行。
 *
 * 同时承载：
 *   D122 无单位小数政策（整数部分 < 100 追问「是 X 万吗」，≥100 按元，超过两位小数追问）；
 *   D123 行尾否定按词组（不按单字「不」），「不错」「不用找」不拦；
 *   D124 非今天日期（含吞进客户名的「昨天」）按 D81 拒。
 *   R12：放开的客户名只认 2–4 个汉字名字/昵称，后接冒号、空格或金额；片段含时间词、动词、查询词、汇总词即不认。
 *        尾部是「姓+称谓」的（今天的钱姐、昨天周老师）仍走原口径，日期前缀由 D124 处理。
 *   D138：不带括号时，2–4 个汉字全名/昵称与姓+称谓均可自报，记给报单人（D102）；非名字词仍不认。
 */
import { resolveDayOnly, resolveMonthDay } from './metrics.js';
import { parsePureMoney, type AmountIssue } from './amounts.js';
import { maskNegatedPastDay, clauseKind, compoundHead, compoundTail, selfProgressPhrase, isSelfProgressQuery } from './scope-refusal.js';
import { customerNameLooksContaminated } from './negated-makeup.js';
import { stripFixedNegatedMakeup } from './negated-makeup-fixed.js';
import { isWhitelistedRemark, REMARK_DRAFT_POLICY } from './remark-whitelist.js';
import { stripTrailingCourtesy } from './remark-courtesy.js';
import { matchesCustomerNameStructure } from './customer-name-structure.js';

export const normalizeReportText = (text: string): string => text.normalize('NFKC');

export const HONORIFIC = '阿姨|奶奶|爷爷|先生|女士|小姐|老师|姐姐|哥哥|姐|姨|哥|叔|总|嫂|婶';
/** 恰好「姓 + 称谓」的客户（无括号员工时可记给报单人）。 */
export const CUSTOMER_HONORIFIC = new RegExp(`^[\\u4e00-\\u9fa5](?:${HONORIFIC})$`);

/**
 * R12 / D138 产品边界：放开的客户名只认 2–4 个汉字全名或昵称，后面紧跟冒号、空格或金额；无括号时记给报单人。
 * 名字片段里含时间词、动词、查询词、汇总词即不认。
 * 非名字词表至少覆盖：一共、总共、合计、目标、本月、本周、这周、刚才、全部。
 * 尾部是「姓+称谓」的（「今天的钱姐」「昨天周老师」）仍走原口径，日期前缀由 D124 处理；
 * 「客户李小雪」「丽」等既有可解析写法只要不含非名字词就保持可解析。
 */
const CUSTOMER_NOT_NAME_CONFIG = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../config/customer-not-name.json'), 'utf8')) as { frozen: boolean; words: string[] };
export const CUSTOMER_NOT_NAME_WORDS: readonly string[] = Object.freeze([...CUSTOMER_NOT_NAME_CONFIG.words]);
const NON_SUMMARY_CUSTOMER_WORDS = /整单|储值卡|目标|本月|本周|这周|刚才|全部|今天|今日|昨天|昨晚|昨日|前天|明天|明日|后天|今晚|今早|上周|下周|这个月|上个月|上月|当月|查询|查一下|查下|汇总|排名|多少|来做|过来|到店|开始|退款|改成|改到|改为|改账|大概|大约|左右|出头|撤回|撤销|更正|亏了|赔了|退了|减了|少了|多了|付了|收了|成交|将近|不到|几乎|差不多|写成|订正|瞅一|列一|约一|记成|当成|算成|重新/;
export const NOT_CUSTOMER_NAME = new RegExp([NON_SUMMARY_CUSTOMER_WORDS.source, ...CUSTOMER_NOT_NAME_WORDS.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))].join('|'));
const HONORIFIC_SUFFIX = new RegExp(String.raw`[\u4e00-\u9fa5](?:${HONORIFIC})$`);

/** 客户栏是否可当作名字。含非名字词的片段不认；尾部称谓走原口径。 */
export function isExactHonorificCustomerName(raw: string): boolean {
  const name = normalizeReportText(raw).trim();
  if (!name) return false;
  if (CUSTOMER_HONORIFIC.test(name)) return true;
  return new RegExp(String.raw`^[\u4e00-\u9fa5]{1,2}(?:${HONORIFIC})$`).test(name);
}

export function isAcceptableCustomerLabel(raw: string): boolean {
  const name = normalizeReportText(raw).trim();
  if (!name) return false;
  // R15-leftover-fragment-ask：否定补报残片、无法识别前缀不能进客户名。
  // R17：解析层保持 R16 口径（D131 前缀二选一依赖此处），纯度由 confirmable-draft-gate 单闸判。
  if (customerNameLooksContaminated(name)) return false;
  if (HONORIFIC_SUFFIX.test(name)) return true;
  if (NOT_CUSTOMER_NAME.test(name)) return false;
  return true;
}

/**
 * D138 / D102：不带括号时，2–4 个汉字全名或昵称（及姓+称谓）可走自报快通道，记给报单人。
 * 经 NOT_CUSTOMER_NAME 把关；代词「我/你/他」和 1 字、超过 4 字的不放开。
 */
export function isOpenedSelfCustomerName(raw: string): boolean {
  const name = normalizeReportText(raw).trim();
  if (!name) return false;
  // R15-leftover-fragment-ask：残片（后补许姨、并非补录…）不认作客户名。
  if (customerNameLooksContaminated(name)) return false;
  if (CUSTOMER_HONORIFIC.test(name)) return true;
  if (NOT_CUSTOMER_NAME.test(name)) return false;
  if (/^(?:我|你|他|她|它|本人|咱)$/.test(name)) return false;
  // 祈使/动作前缀（「把许姐680」是改账，不是客户叫「把许姐」）
  // D170/D173：配置姓氏＋名的完整形态不能被动作首字抢先拒收；仍须经过 D152、非名字表和名单。
  if (/^(?:把|将|帮|请|替|给|用|找|看|查|改|写|列|约|瞅|订)/.test(name) && !matchesCustomerNameStructure(name)) return false;
  return /^[\u4e00-\u9fa5]{2,4}$/.test(name); // D138-open
}

/**
 * 放开的无称谓名字后，金额须是阿拉伯数字或带量级/货币单位的中文，
 * 避免把「瞅一眼」「将近七百」里的「一」「七百」收成确定金额。
 */
export function openedSelfAmountOk(name: string, amountText: string): boolean {
  const who = normalizeReportText(name).trim();
  if (CUSTOMER_HONORIFIC.test(who)) return true;
  const t = normalizeReportText(amountText).trim();
  if (!t) return false;
  if (/\d/.test(t)) return true;
  if (/[kKwW千万元块]/.test(t)) return true;
  return false;
}


/** D122：标准行无单位小数政策。产品负责人 21:30 已定，集中在这一处。 */
export const STANDARD_DECIMAL_POLICY = {
  /** 整数部分小于此值的无单位小数 → 追问「是 X 万吗」。 */
  askIfIntegerPartBelow: 100,
  maxFractionDigits: 2,
} as const;

/** D123：否定/取消词组（不按单字「不」）。 */
export const NEGATION_PHRASES = /没做(?:了|成)?|未到|没到|不做了|没做了|取消|退款|退了|退卡|不对|先别记|先别入|先不要记|先别登|别记了|不要记(?:了|这)?|未成交|没成交|最后没做|没买了|没买|白忙活|白忙|没搞成|黄了/;
/** D123：含「不」但不拦的备注。 */
export const BENIGN_REMARKS = /不错|不用找|不用谢|不用客气/;
/** 行尾仍按 D120 追问的金额约数（不是普通备注）。 */
const REMARK_HEDGE = /出头|左右|上下|开外|大概|大约|将近|不到|差不多|估计|不一定|待确认|回头再对|先别记|^(?:多|来)/;

const ARABIC_TERM = String.raw`(?:[-−－﹣]|负)?\s*[¥￥]?\s*\d+(?:\.\d+)?\s*(?:[kKwW千万])?\s*(?:元整|块整|块钱|元|块|整)?(?:[零〇一二两三四五六七八九](?:毛|角)?)?(?:[零〇一二两三四五六七八九]分)?`;
const CN_TERM = String.raw`[零〇一二两三四五六七八九十百千万]+(?:元整|块整|块钱|元|块|整)?(?:[零〇一二两三四五六七八九](?:毛|角)?)?(?:[零〇一二两三四五六七八九]分)?`;
const TERM = String.raw`(?:${ARABIC_TERM}|${CN_TERM})`;
const AMOUNT = String.raw`(${TERM}(?:\s*[+＋]\s*${TERM})*)`;
const EMPLOYEE = String.raw`[（(]\s*([^（）()]{1,16}?)\s*[）)]`;
/** D171/D153：只读取标准行客户位；解析拒收非名字时也能给出同一个通用先问。 */
export function hasNonCustomerStandardLabel(line: string): boolean {
  const match = new RegExp(String.raw`^([^\d\s()（）:：+＋.\-−－﹣负¥￥]+?)\s*[:：]?\s*${AMOUNT}(?:\s*${EMPLOYEE})?\s*(.*)$`).exec(line);
  return !!match?.[1] && CUSTOMER_NOT_NAME_WORDS.some(word => match[1]!.includes(word));
}
const MULTI_EMPLOYEE = /[/／、,，&]|或/;
/** 行首列表记号：序号、列表短横、圈号（D125 多行清单格式，不是前缀词）。 */
const LINE_PREFIX = /^(?:\d+\s*[.、．)]\s*|[-—–•*]\s*|[①②③④⑤⑥⑦⑧⑨⑩]\s*)/;

/**
 * R18 / D158：行首前缀只认 config/line-prefix-fixed.json 的两张固定表（标签、寒暄＋D135 客套），由本语法来认。
 * 不做模糊匹配、不做泛化；表外前缀一律不剥（后续按不纯先问）。
 */
const LINE_PREFIX_CONFIG = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../config/line-prefix-fixed.json'), 'utf8')) as { labels: string[]; greetings: string[] };
const COURTESY_CONFIG = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../config/remark-courtesy.json'), 'utf8')) as { courtesy: string[] };
const escapeRe = (w: string) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const byLengthDesc = (ws: readonly string[]) => [...ws].sort((a, b) => b.length - a.length).map(escapeRe).join('|');
export const LINE_PREFIX_LABELS: readonly string[] = Object.freeze([...LINE_PREFIX_CONFIG.labels]);
export const LINE_PREFIX_GREETINGS: readonly string[] = Object.freeze([...LINE_PREFIX_CONFIG.greetings, ...COURTESY_CONFIG.courtesy]);
/** D165：固定标签仅在分隔后剥离；【标签】本身算分隔。 */
const LABEL_PREFIX = new RegExp(`^(?:【(?:${byLengthDesc(LINE_PREFIX_LABELS)})】[:：，,\\s]*|(?:${byLengthDesc(LINE_PREFIX_LABELS)})[:：，,\\s]+)`);
const GREETING_PREFIX = new RegExp(`^(?:(?:${byLengthDesc(LINE_PREFIX_GREETINGS)})+[:：，,\\s]+)+`);

/** D166：只剥完整行尾表情簇；剩在客户/金额中间的由 D152 拒收。 */
const EMOJI_CLUSTER = String.raw`(?:\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier})*(?:\u200D\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier})*)*|\p{Regional_Indicator}{2})`;
export function stripTrailingReportEmoji(text: string): string {
  return text.replace(new RegExp(String.raw`(?:\s*${EMOJI_CLUSTER})+\s*$`, 'u'), '').trimEnd();
}
export function containsReportEmoji(text: string): boolean {
  return /[\p{Extended_Pictographic}\p{Regional_Indicator}\u200D\uFE0F]/u.test(text);
}

export type StandardAskReason = 'negation' | 'ask_wan' | 'fraction' | 'vague_amount' | 'hedge' | 'not_closed' | 'multi_employee' | 'alternatives' | AmountIssue;

export interface StandardEntry {
  customer: string | null;
  /** D161：分号段自己的 D101/D164 抬头，不能被别段门店覆盖。 */
  storeName?: string | null;
  amount: number;
  employeeName: string;
  note: string;
  self?: boolean;
  amountText?: string;
  /** D133：归属说法（已从备注剥掉）。self=记给报单人；other/not_self=记给别人。 */
  ownership?: 'self' | 'other' | 'not_self';
  ownershipText?: string;
  /** D134：用「再/另外/顺便/还有」等拆出的后半句，不进备注。 */
  compound?: string;
  /** D137：从归属说法取出的员工名（「报小王的」→ 小王）。 */
  attributedName?: string;
}

export type StandardLineOk = { status: 'ok'; entries: StandardEntry[]; remark: string };
export type StandardLineAsk = { status: 'ask'; reason: StandardAskReason; detail?: string };
export type StandardLineResult = StandardLineOk | StandardLineAsk | { status: 'none' };

export type StandardReportResult =
  | { status: 'complete'; report: { businessDay: string; storeName: string | null; entries: StandardEntry[] } }
  | StandardLineAsk
  | { status: 'not_today'; detail?: string }
  | { status: 'incomplete' }
  | { status: 'none' };

export type DecimalPolicyResult =
  | { ok: true; cents: number; text: string }
  | { ok: false; issue: 'ask_wan' | AmountIssue | 'vague_amount'; text: string; askWan?: string };

/**
 * D122：标准行金额位。有明确单位（含中文万/千）直接解析；
 * 无单位整数按元；无单位小数整数部分 < 100 追问「是 X 万吗」，≥100 按元（最多两位小数）。
 */
export function applyStandardDecimalPolicy(raw: string): DecimalPolicyResult {
  const text = raw.normalize('NFKC').replace(/\s+/g, '');
  if (!text) return { ok: false, issue: 'bad', text: raw };
  const unitless = /^(?:[-−－﹣]|负)?(\d+)(?:\.(\d+))?$/.exec(text);
  if (unitless) {
    const frac = unitless[2];
    const intPart = Number(unitless[1]);
    if (frac && frac.length > STANDARD_DECIMAL_POLICY.maxFractionDigits) {
      return { ok: false, issue: 'fraction', text };
    }
    if (frac && intPart < STANDARD_DECIMAL_POLICY.askIfIntegerPartBelow) {
      const shown = `${unitless[1]}.${frac}`;
      return { ok: false, issue: 'ask_wan', text, askWan: shown };
    }
  }
  const parsed = parsePureMoney(text);
  if (parsed.ok) return { ok: true, cents: parsed.amount, text };
  return { ok: false, issue: parsed.issue, text };
}


/** D133：归属说法（语法，不进白名单）。长的优先；可带「一下」「哈」这类轻语气。 */
export type OwnershipKind = 'self' | 'other' | 'not_self';

const OWNERSHIP_SELF = [
  '记我今天的', '报我今天的', '登我今天的', '算我今天的',
  '记我今日的', '报我今日的', '登我今日的', '算我今日的',
  '记我名下', '报我名下', '算我名下', '登我名下',
  '是我今天的单', '是我今日的单', '今天我的单', '今日我的单', '我今天的单',
  '报我的单', '记我的单', '算我的单', '登我的单',
  '报我的', '记我的', '算我的', '登我的',
];
const OWNERSHIP_OTHER = [
  '我替同店的他报', '替同店的他报', '帮同店的他报',
  '替同店的他记', '帮同店的他记',
  '帮他报', '替他报', '帮他记', '替他记', '帮他登', '替他登',
];
const OWNERSHIP_NOT_SELF = [
  '这一单不是我的', '这一笔不是我的', '这单不是我的', '这不是我的单',
  '不是我的单', '不是我的',
];

function byLonger(a: string, b: string): number { return b.length - a.length || a.localeCompare(b, 'zh'); }

export interface StandardTailParts {
  remark: string;
  ownership: OwnershipKind | null;
  ownershipText: string;
  compound: string | null;
  courtesy: string | null;
  attributedName: string | null;
}

const SELF_PRONOUN = /^(?:我|本人|我自己)$/;
const OTHER_PRONOUN = /^(?:他|她|它|他们|她们|别人)$/;
const BOUND_LEFT = /[，,;；、。.\s]/;
const BOUND_RIGHT = /[，,;；、。.\s哈啊呀啦吧哦嘛呢]/;
const TONE_AFTER = /^(?:哈|啊|呀|啦|吧|哦|嘛|呢)/;
const NAMED_ATTR = [
  /(?:我)?(?:报|算|登(?!记)|(?<!登)记)([\u4e00-\u9fa5]{1,4})(?:今天的单|今日的单|今天的|今日的|名下|的单|的)/,
  /(?:我)?(?:帮|替|给)([\u4e00-\u9fa5]{1,4})(?:报|算|登(?!记)|(?<!登)记)(?:上|的|一下|下)?/,
];

function phraseIndex(flat: string, phrase: string): number {
  let from = 0;
  while (from <= flat.length) {
    const i = flat.indexOf(phrase, from);
    if (i < 0) return -1;
    const end = i + phrase.length;
    // 「不算我的」里的「算我的」不算确定匹配：左边是「不/没/别/非」则跳过。
    if (i > 0 && /[不没别非]/.test(flat[i - 1]!)) {
      from = i + 1;
      continue;
    }
    const atStart = i === 0;
    const atEnd = end === flat.length;
    const leftBound = atStart || BOUND_LEFT.test(flat[i - 1]!);
    const rightBound = atEnd || BOUND_RIGHT.test(flat[end] ?? '');
    if (atStart || atEnd || (leftBound && rightBound)) return i;
    from = i + 1;
  }
  return -1;
}

function isDefiniteAppointmentRequest(text: string): boolean {
  const flat = text.normalize('NFKC').replace(/\s+/g, '');
  if (!flat) return false;
  // 确定的预约/登记请求（「帮小林登记下」），不是「帮写朋友圈」这类宣传备注。
  return /(?:预约|帮.{0,8}(?:预约|登记)|(?:给我|帮我)?登记(?:下|一下)?)/.test(flat)
    && !/(?:海报|文案|朋友圈|小红书|宣传|推广)/.test(flat);
}

function isDefiniteAmendment(text: string): boolean {
  const flat = text.normalize('NFKC').replace(/\s+/g, '');
  if (clauseKind(flat) !== 'correction') return false;
  return /(?:把|将)?(?:刚才|刚刚|最近|上一|最后)?(?:那笔|这笔|那单|这单).{0,16}(?:改成|改为|改到|更正|撤回|撤销)/.test(flat)
    || /(?:改成|改为|更正为|撤回|撤销).{0,12}(?:\d|[零〇一二两三四五六七八九十百千万])/.test(flat);
}

/**
 * D133–D135、D137：在同一份语法里剥行尾。
 * 顺序：确定的复合后半句 → 确定的归属说法 → 整段客套。
 * 只剥确定匹配到的部分；剩下任何残余不论 clauseKind 判成什么，都是 D130 要判断的备注。
 */

/**
 * R14-negated-makeup-strip：客户名抽取前剥离否定补报短语。
 * 覆盖「不是补报 / 不是在补 / 不是补的」以及带「昨天」的既有说法；不误伤「不用补水」。
 */
/** D142 固定剥离：词表与正则在 config/negated-makeup-fixed.json（R16 起不再扩充）。 */
export function stripNegatedMakeupPhrases(s: string): string {
  return stripFixedNegatedMakeup(s);
}

function stripNegatedMakeupPhrase(s: string): string {
  return stripNegatedMakeupPhrases(s);
}

/** R14-compound-strip-report-verb：纯报单指令残片（「报一下」「给我报一下」）不是备注。 */
function stripReportVerbLeftover(s: string): string {
  const t = s.normalize('NFKC').trim();
  if (!t) return t;
  const flat = t.replace(/\s+/g, '').replace(/[，,。.!！？?]+$/g, '');
  if (/^(?:请)?(?:先|就)?(?:帮我|给我|替我|为我)?(?:来)?(?:报|记|登)(?:一下|下|了|上|进来|进来了)?(?:吧|啊|呢|哈|哦)?$/.test(flat)) return '';
  return t;
}

function isProgressQueryResidue(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  // R16：撤掉 D145 结构判断。仅保留 D141 测试中已有的固定短语（selfProgressPhrase / isSelfProgressQuery），解析层可拆分；入口不再为此出草稿。
  return selfProgressPhrase(t) || isSelfProgressQuery(t);
}

/** 报单指令后面紧跟本人进度（有无逗号、有无「再/另外」）→ 拆成复合，进度不进备注。 */
function peelProgressAfterReportVerb(text: string): { head: string; tail: string } | null {
  const raw = text.normalize('NFKC').trim();
  if (!raw) return null;
  const m = /^(.*?)(?:请)?(?:先|就)?(?:帮我|给我|替我|为我)?(?:来)?(?:报|记)(?:一下|下|了|上)?[，,。；;]?\s*(?:然后再|然后|再帮我|再给我|再|顺便|顺带|同时|另外|还有)?(?=看|查|问|列)(.+)$/.exec(raw);
  if (!m) return null;
  const tail = (m[2] ?? '').trim();
  const head = (m[1] ?? '').replace(/^[，,;；、。.\s]+/, '').replace(/[，,;；、。.\s]+$/, '').trim();
  if (tail.length >= 2 && isProgressQueryResidue(tail)) return { head, tail };
  return null;
}

export function interpretStandardTail(raw: string): StandardTailParts {
  const empty: StandardTailParts = { remark: '', ownership: null, ownershipText: '', compound: null, courtesy: null, attributedName: null };
  if (typeof raw !== 'string') return empty;
  let s = raw.normalize('NFKC').trim();
  if (!s) return empty;
  let compound = compoundTail(s);
  if (compound) s = compoundHead(s).trim();
  // 整段备注本身就是确定的改账或预约登记分句（无连接词）→ 当复合，不当备注。
  // 「帮写朋友圈」不是确定的复合，仍走 D130。
  if (!compound && (isDefiniteAmendment(s) || isDefiniteAppointmentRequest(s))) {
    compound = s;
    s = '';
  }
  // R14-compound-strip-report-verb：仅对 D141 原固定短语拆出进度（解析层）；入口按 D145 撤销整句交模型，不出草稿。
  if (!compound) {
    const peeled = peelProgressAfterReportVerb(s);
    if (peeled) {
      compound = peeled.tail;
      s = peeled.head;
    } else if (isProgressQueryResidue(s)) {
      compound = s;
      s = '';
    }
  }
  s = s.replace(/^[，,;；、。.\s]+/, '').replace(/[，,;；、。.\s]+$/, '').trim();

  let ownership: OwnershipKind | null = null;
  let ownershipText = '';
  let attributedName: string | null = null;
  const table: { phrase: string; kind: OwnershipKind }[] = [
    ...OWNERSHIP_NOT_SELF.map(phrase => ({ phrase, kind: 'not_self' as const })),
    ...OWNERSHIP_OTHER.map(phrase => ({ phrase, kind: 'other' as const })),
    ...OWNERSHIP_SELF.map(phrase => ({ phrase, kind: 'self' as const })),
  ].sort((a, b) => byLonger(a.phrase, b.phrase));
  const flat = s;
  for (const { phrase, kind } of table) {
    const i = phraseIndex(flat, phrase);
    if (i < 0) continue;
    let end = i + phrase.length;
    if (kind === 'other') {
      const ext = /^(?:一下|下)/.exec(flat.slice(end));
      if (ext) end += ext[0].length;
    }
    const tone = TONE_AFTER.exec(flat.slice(end));
    if (tone) end += tone[0].length;
    ownership = kind;
    ownershipText = flat.slice(i, end);
    s = (flat.slice(0, i) + flat.slice(end)).replace(/^[，,;；、。.\s]+/, '').replace(/[，,;；、。.\s]+$/, '').trim();
    break;
  }
  if (!ownership) {
    for (const re of NAMED_ATTR) {
      const m = re.exec(flat);
      if (!m || m.index === undefined || !m[1]) continue;
      const who = m[1];
      // 必须是确定的整段或边界匹配，避免从更长不认识的句子中间掏字。
      let end = m.index + m[0].length;
      const tone = TONE_AFTER.exec(flat.slice(end));
      if (tone) end += tone[0].length;
      const atStart = m.index === 0;
      const atEnd = end === flat.length;
      const leftBound = atStart || BOUND_LEFT.test(flat[m.index - 1]!);
      const rightBound = atEnd || BOUND_RIGHT.test(flat[end] ?? '');
      if (!(atStart || atEnd || (leftBound && rightBound))) continue;
      if (m.index > 0 && /[不没别非]/.test(flat[m.index - 1]!)) continue;
      ownershipText = flat.slice(m.index, end);
      if (SELF_PRONOUN.test(who)) {
        ownership = 'self';
      } else if (OTHER_PRONOUN.test(who)) {
        ownership = 'other';
      } else {
        ownership = 'other';
        attributedName = who;
      }
      s = (flat.slice(0, m.index) + flat.slice(end)).replace(/^[，,;；、。.\s]+/, '').replace(/[，,;；、。.\s]+$/, '').trim();
      break;
    }
  }

  // 「不是在补昨天」这类否定补报是 D124 已处理的限定，不是 D130 备注。
  s = stripNegatedMakeupPhrase(s);
  s = stripReportVerbLeftover(s);
  const stripped = stripTrailingCourtesy(s);
  return {
    remark: stripped.rest,
    ownership,
    ownershipText,
    compound,
    courtesy: stripped.courtesy,
    attributedName,
  };
}

/**
 * D133 / D137：归属与括号员工是否一致或互补。冲突时返回追问句（不含「Front Claw：」前缀），否则 null。
 * employeeIsReporter：括号解析后的员工是不是报单人；hasExplicitEmployee：行里写了括号员工。
 * attributedName：从「报小王的」取出的名字，与括号不一致时追问。
 */
export function ownershipConflictDetail(input: {
  ownership: OwnershipKind | null | undefined;
  ownershipText?: string;
  employeeName: string;
  employeeIsReporter: boolean;
  hasExplicitEmployee: boolean;
  attributedName?: string | null;
}): string | null {
  const kind = input.ownership;
  if (!kind) return null;
  const said = input.ownershipText?.trim() ? `「${input.ownershipText.trim()}」` : '这句话的归属';
  const who = input.employeeName.trim() || '这位同事';
  const attr = input.attributedName?.trim() ?? '';
  if (attr && input.hasExplicitEmployee && input.employeeName.trim() && attr !== input.employeeName.trim()) {
    return `括号里是${who}，又说${said}（${attr}），互相冲突，需要确认这笔记给谁。`;
  }
  if (kind === 'self') {
    if (!input.hasExplicitEmployee || input.employeeIsReporter) return null;
    return `括号里是${who}，又说${said}，互相冲突，需要确认这笔记给谁。`;
  }
  // other / not_self：应记给别人（互补），不能是自己，也不能没写员工（D137：归属里已写出名字则算写了）。
  if (!input.hasExplicitEmployee && !attr) {
    return `说了${said}，但没有写出记给哪位同事，需要确认这笔记给谁。`;
  }
  if (input.employeeIsReporter && !attr) {
    return `说了${said}，括号里却是你自己（${who}），互相冲突，需要确认这笔记给谁。`;
  }
  if (input.employeeIsReporter && attr && attr === input.employeeName.trim()) {
    return `说了${said}，括号里却是你自己（${who}），互相冲突，需要确认这笔记给谁。`;
  }
  return null;
}

/**
 * D130：只有整条备注都落在正向白名单里才 allow（直接出草稿）。
 * 约数仍按 D120 记 hedge。其余（含「不错但没做」、旧否定词组）为 model，入口交给模型、桩则追问。
 * REMARK_DRAFT_POLICY 固定为 whitelist，不走「其他备注直接出草稿」的旧默认。
 */
export function classifyStandardRemark(remark: string): 'allow' | 'negation' | 'hedge' | 'model' {
  const t = remark.normalize('NFKC').trim();
  if (!t) return 'allow';
  if (REMARK_DRAFT_POLICY === 'whitelist' && isWhitelistedRemark(t)) return 'allow';
  if (REMARK_HEDGE.test(t)) return 'hedge';
  if (/^(?:多|来)$/.test(t.replace(/[。.!！]/g, ''))) return 'hedge';
  // 否定词组不再单独放行或单独追问：不在白名单里，走模型（桩一律追问）。
  if (NEGATION_PHRASES.test(t)) return 'model';
  return 'model';
}

function amountsOf(raw: string, context: 'standard-line' | 'free'): { amount: number; text?: string }[] | DecimalPolicyResult & { ok: false } {
  const parts = raw.split(/[+＋]/).map(p => p.trim()).filter(Boolean);
  if (!parts.length) return { ok: false, issue: 'bad', text: raw };
  const out: { amount: number; text?: string }[] = [];
  for (const part of parts) {
    const r = context === 'standard-line' ? applyStandardDecimalPolicy(part) : parsePureMoney(part.replace(/\s+/g, ''));
    if (!r.ok) {
      if ('issue' in r) {
        const fail: DecimalPolicyResult & { ok: false } = { ok: false, issue: r.issue as 'ask_wan' | AmountIssue | 'vague_amount', text: r.text };
        if ('askWan' in r && r.askWan) fail.askWan = r.askWan;
        return fail;
      }
      return { ok: false, issue: 'bad', text: part };
    }
    const cents = 'cents' in r ? r.cents : r.amount;
    const shown = part.replace(/\s+/g, '');
    out.push(/^\d+$/.test(shown) ? { amount: cents } : { amount: cents, text: shown });
  }
  return out;
}

function expand(customer: string | null, amountText: string, employeeName: string, note: string, self: boolean, context: 'standard-line' | 'free'): StandardLineResult {
  const who = customer?.trim() ?? '';
  if (customer !== null && !who) return { status: 'none' };
  // D133–D137：先在这份语法里剥复合、归属、客套；无括号时可以从归属取员工。
  const tail = interpretStandardTail(note);
  let name = employeeName.trim();
  let isSelf = self;
  const attributed = tail.attributedName?.trim() ?? '';
  if (attributed) {
    if (!name) {
      name = attributed;
      isSelf = false;
    }
  }
  if (!isSelf && (!name || /[：:]/.test(name))) return { status: 'none' };
  if (isSelf && name) return { status: 'none' };
  if (name && MULTI_EMPLOYEE.test(name)) return { status: 'ask', reason: 'multi_employee', detail: name };
  const amounts = amountsOf(amountText, context);
  if (!Array.isArray(amounts)) {
    if (amounts.issue === 'ask_wan') return { status: 'ask', reason: 'ask_wan', ...(amounts.askWan ? { detail: amounts.askWan } : { detail: amounts.text }) };
    return { status: 'ask', reason: amounts.issue === 'vague_amount' ? 'vague_amount' : amounts.issue, detail: amounts.text };
  }
  const kept = tail.remark;
  const remarkKind = classifyStandardRemark(kept);
  if (remarkKind === 'negation') return { status: 'ask', reason: 'negation', detail: kept };
  if (remarkKind === 'hedge') return { status: 'ask', reason: 'vague_amount', detail: kept };
  // 备注里还像有另一笔金额：本行不把第二笔吞进备注，交给自然抽取（与既有 looseSwallowed 一致）。
  // 只看剥完后的备注；后半句里的数字不让本行退回 none。
  if (/\d/.test(kept)) {
    return { status: 'none' };
  }
  // 「或者/还是」后还有金额：备选歧义，交给抽取/ambiguity，不出完整行。
  if (/(?:或者|还是|或是)/.test(kept)) {
    return { status: 'none' };
  }
  const entries: StandardEntry[] = amounts.map(({ amount, text }) => ({
    customer: customer === null ? null : who,
    amount,
    employeeName: name,
    note: kept,
    ...(isSelf ? { self: true } : {}),
    ...(text ? { amountText: text } : {}),
    ...(tail.ownership ? { ownership: tail.ownership, ownershipText: tail.ownershipText } : {}),
    ...(tail.compound ? { compound: tail.compound } : {}),
    ...(attributed ? { attributedName: attributed } : {}),
  }));
  return { status: 'ok', entries, remark: kept };
}

export function stripLinePrefix(line: string): string {
  let t = line.trim();
  // R18 / D158：先剥固定寒暄（整段），再剥固定标签；都只认表内词。
  const g = GREETING_PREFIX.exec(t);
  if (g && t.slice(g[0].length).trim()) t = t.slice(g[0].length).trim();
  const l = LABEL_PREFIX.exec(t);
  if (l && t.slice(l[0].length).trim()) t = t.slice(l[0].length).trim();
  // 最多剥一层装饰前缀，避免把「1.2万」的 1. 当序号。
  const m = LINE_PREFIX.exec(t);
  if (!m) return t;
  const rest = t.slice(m[0].length).trim();
  // 「1.2万（小王）」：若剥掉「1.」后剩下以小数点/数字单位开头，则不是序号。
  if (/^[.\d]/.test(rest) && /^\d+\s*[.．]/.test(t) && !/^\d+\s*[、)]/.test(t)) return t;
  return rest || t;
}

/**
 * 解析一行标准明细。这是快通道切分的唯一入口。
 */
export function parseStandardLine(line: string, context: 'standard-line' | 'free' = 'standard-line'): StandardLineResult {
  // R14-negated-makeup-strip：客户名抽取前先剥离否定补报短语。
  const text = stripNegatedMakeupPhrases(stripLinePrefix(stripTrailingReportEmoji(normalizeReportText(line).trim())));
  if (!text) return { status: 'none' };
  if (/[：:]/.test(text)) {
    const colon = /^(.+?)[：:]\s*/.exec(text);
    if (colon) {
      const rest = text.slice(colon[0].length);
      const body = new RegExp(String.raw`^${AMOUNT}\s*${EMPLOYEE}\s*(.*)$`).exec(rest);
      if (body && body[1] !== undefined && body[2] !== undefined && isAcceptableCustomerLabel(colon[1] ?? '')) {
        return expand(colon[1] ?? '', body[1], body[2], body[3] ?? '', false, context);
      }
      const selfBody = new RegExp(String.raw`^${AMOUNT}\s*(.*)$`).exec(rest);
      if (selfBody && selfBody[1] !== undefined && isOpenedSelfCustomerName((colon[1] ?? '').trim()) && openedSelfAmountOk((colon[1] ?? '').trim(), selfBody[1])) {
        const tail = (selfBody[2] ?? '').trim();
        if (!/^[（(]/.test(tail)) {
          return expand(colon[1] ?? '', selfBody[1], '', tail, true, context);
        }
      }
    }
  }
  if (/^\d|^[¥￥]|^[零〇一二两三四五六七八九十]/.test(text)) {
    const bare = new RegExp(String.raw`^${AMOUNT}\s*${EMPLOYEE}\s*(.*)$`).exec(text);
    if (bare && bare[1] !== undefined && bare[2] !== undefined) {
      return expand(null, bare[1], bare[2], bare[3] ?? '', false, context);
    }
  }
  const tight = new RegExp(String.raw`^([^\d\s()（）:：+＋.\-−－﹣负¥￥]{1,12}?)${AMOUNT}\s*${EMPLOYEE}\s*(.*)$`).exec(text);
  if (tight && tight[1] && tight[2] && tight[3] !== undefined && !/\s/.test(text.slice(0, text.indexOf(tight[2]!))) && isAcceptableCustomerLabel(tight[1])) {
    return expand(tight[1], tight[2], tight[3], tight[4] ?? '', false, context);
  }
  const spaced = new RegExp(String.raw`^(.+?)\s+${AMOUNT}\s*${EMPLOYEE}\s*(.*)$`).exec(text);
  if (spaced && spaced[1] && spaced[2] && spaced[3] !== undefined && isAcceptableCustomerLabel(spaced[1])) {
    return expand(spaced[1], spaced[2], spaced[3], spaced[4] ?? '', false, context);
  }
  const tightSelf = new RegExp(String.raw`^([^\d\s()（）:：+＋.\-−－﹣负¥￥]{1,12}?)${AMOUNT}\s*(.*)$`).exec(text);
  if (tightSelf && tightSelf[1] && tightSelf[2] && isOpenedSelfCustomerName(tightSelf[1]) && openedSelfAmountOk(tightSelf[1], tightSelf[2]) && !/\s/.test(text.slice(0, text.indexOf(tightSelf[2]!))) && !/^[（(]/.test((tightSelf[3] ?? '').trim())) {
    return expand(tightSelf[1], tightSelf[2], '', tightSelf[3] ?? '', true, context);
  }
  const spacedSelf = new RegExp(String.raw`^(.+?)\s+${AMOUNT}\s*(.*)$`).exec(text);
  if (spacedSelf && spacedSelf[1] && spacedSelf[2]) {
    const who = spacedSelf[1]!.trim();
    const tail = (spacedSelf[3] ?? '').trim();
    if (who && !/[()（）]/.test(who) && who.length <= 12 && isOpenedSelfCustomerName(who) && openedSelfAmountOk(who, spacedSelf[2]!) && !/^[（(]/.test(tail)) {
      return expand(who, spacedSelf[2], '', tail, true, context);
    }
  }
  return { status: 'none' };
}

function blankStore(value: string | undefined): string | null {
  const name = value?.trim() ?? '';
  return name ? name : null;
}

function validYmd(y: number, m: number, d: number): string | null {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d) || m < 1 || m > 12 || d < 1) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function splitStoreRest(remainder: string): { storeName: string | null; rest: string } {
  const text = remainder.trim();
  if (!text) return { storeName: null, rest: '' };
  const m = /^(\S*?店)(?:\s+|(?=[^\s店]))(.*)$/.exec(text);
  if (m) {
    const rest = (m[2] ?? '').trim();
    return { storeName: m[1]!, rest };
  }
  return { storeName: blankStore(text), rest: '' };
}

/** 日期前缀标题（与历史 parseHeaderSplit 同一份实现，放在本语法文件）。 */
export function parseHeaderSplit(line: string, businessDay: string): { businessDay: string; storeName: string | null; rest: string } | null {
  const text = normalizeReportText(line).trim();
  const yearIso = /^(20\d{2})[-/](\d{1,2})[-/](\d{1,2})\s*(.*)$/.exec(text);
  if (yearIso) {
    const resolved = validYmd(Number(yearIso[1]), Number(yearIso[2]), Number(yearIso[3]));
    if (!resolved) return null;
    const { storeName, rest } = splitStoreRest(yearIso[4] ?? '');
    return { businessDay: resolved, storeName, rest };
  }
  const yearCn = /^(20\d{2})年(\d{1,2})月(\d{1,2})日?\s*(.*)$/.exec(text);
  if (yearCn) {
    const resolved = validYmd(Number(yearCn[1]), Number(yearCn[2]), Number(yearCn[3]));
    if (!resolved) return null;
    const { storeName, rest } = splitStoreRest(yearCn[4] ?? '');
    return { businessDay: resolved, storeName, rest };
  }
  const monthForm = /^(\d{1,2})月(\d{1,2})日?\s*(.*)$/.exec(text);
  if (monthForm) {
    const resolved = resolveMonthDay(Number(monthForm[1]), Number(monthForm[2]), businessDay);
    if (!resolved) return null;
    const { storeName, rest } = splitStoreRest(monthForm[3] ?? '');
    return { businessDay: resolved, storeName, rest };
  }
  const dotted = /^(\d{1,2})[./](\d{1,2})\s*(.*)$/.exec(text);
  if (dotted) {
    const resolved = resolveMonthDay(Number(dotted[1]), Number(dotted[2]), businessDay);
    if (!resolved) return null;
    const { storeName, rest } = splitStoreRest(dotted[3] ?? '');
    return { businessDay: resolved, storeName, rest };
  }
  const dayForm = /^(\d{1,2})号\s*(.*)$/.exec(text);
  if (dayForm) {
    const resolved = resolveDayOnly(Number(dayForm[1]), businessDay);
    if (!resolved) return null;
    const { storeName, rest } = splitStoreRest(dayForm[2] ?? '');
    return { businessDay: resolved, storeName, rest };
  }
  return null;
}

/** D164：不把任意括号内容当作店名，必须是日期或以「店」结尾的单一店名。 */
export function parseBracketReportHeader(raw: string, businessDay: string): { businessDay: string; storeName: string | null } | null {
  const h = parseHeaderSplit(raw, businessDay);
  if (h && !h.rest && (!h.storeName || /^[^\s【】\[\]，,:：;；]+店$/.test(h.storeName))) {
    return { businessDay: h.businessDay, storeName: h.storeName };
  }
  if (/^[^\s【】\[\]，,:：;；]+店$/.test(raw)) return { businessDay, storeName: raw };
  return null;
}

export function parseHeader(line: string, businessDay: string): { businessDay: string; storeName: string | null } | null {
  const split = parseHeaderSplit(line, businessDay);
  return split ? { businessDay: split.businessDay, storeName: split.storeName } : null;
}

const PAST_WORD = /昨天|昨儿|昨日|昨晚|前天|前儿|大前天|明天|明日|明儿|后天|大后天|上周|上星期|下周|下星期/;

function explicitDay(flat: string, today: string): string | null {
  const ymd = /(?:(20\d{2})[-/年](\d{1,2})[-/月](\d{1,2})[日号]?)|(?:(\d{1,2})月(\d{1,2})[日号]?)/.exec(flat);
  if (!ymd) return null;
  const year = ymd[1] ? Number(ymd[1]) : Number(today.slice(0, 4));
  const month = Number(ymd[2] ?? ymd[4]), day = Number(ymd[3] ?? ymd[5]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * D124：去掉否定补报后，句中是否仍有非今天的日期（含被吞进客户名的「昨天」）。
 * 「不是补报」「不是补昨天」「今天的」在 mask 之后不应再命中。
 */
export function hasUnnegatedNonToday(text: string, today: string): boolean {
  const flat = maskNegatedPastDay(text.normalize('NFKC').replace(/\s+/g, ''));
  if (PAST_WORD.test(flat)) return true;
  const day = explicitDay(flat, today);
  return !!(day && day !== today);
}

function isHeaderOnlyLine(line: string, businessDay: string): boolean {
  const h = parseHeaderSplit(line, businessDay);
  return !!h && !h.rest;
}

/**
 * 整段话按同一份语法解析。有标题用标题营业日；无标题按给定营业日。
 * 任一行是否定/约数/小额小数 → ask。标题上的营业日按标题解析（可与参考日不同）；非今天拒在入口做。
 */
export function tryStandardReport(text: string, businessDay: string, opts?: {
  requireHeader?: boolean;
  /** D161 单闸用 free 读取分段结构；其金额授权必须另过 standard-line amount-guard。其他调用默认标准行口径。 */
  amountContext?: 'standard-line' | 'free';
}): StandardReportResult {
  if (typeof text !== 'string') return { status: 'none' };
  const raw = normalizeReportText(text);
  // D161：每段必须恰好一笔；不滤空段，不允许半张清单或自然抽取重排。
  if (/[；;]/.test(raw)) {
    const parts = raw.split(/[；;]/);
    if (parts.length > 50 || parts.some(p => !p.trim())) return { status: 'incomplete' };
    const entries: StandardEntry[] = [];
    let day: string | null = null;
    let storeName: string | null = null;
    for (const part of parts) {
      const result = tryStandardReport(part, businessDay, opts);
      if (result.status === 'ask') return result;
      if (result.status !== 'complete' || result.report.entries.length !== 1) return { status: 'incomplete' };
      if (day && day !== result.report.businessDay) return { status: 'incomplete' };
      day = result.report.businessDay;
      storeName ??= result.report.storeName;
      entries.push(...result.report.entries.map(entry => ({ ...entry, ...(result.report.storeName ? { storeName: result.report.storeName } : {}) })));
    }
    return { status: 'complete', report: { businessDay: day!, storeName, entries } };
  }
  // D165：先剥表内前缀，再拆行；标签后的换行也是分隔。
  const lines = stripLinePrefix(raw.trim()).split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
  if (!lines.length || lines.length > 50) return { status: 'none' };
  const first = lines[0]!;
  // D164：【…】只认表内标签或 D101 日期/日期＋店名/店名抬头。
  const bracket = /^【([^】]+)】\s*[:：，,]?\s*(.*)$/.exec(first);
  const bracketHeader = bracket ? parseBracketReportHeader(bracket[1]!, businessDay) : null;
  const header = bracketHeader ? { ...bracketHeader, rest: bracket![2]! } : parseHeaderSplit(first, businessDay);
  if (opts?.requireHeader && !header) return { status: 'none' };
  const body = header
    ? [...(header.rest ? [header.rest] : []), ...lines.slice(1)]
    : lines;
  if (header && !body.length) return { status: 'incomplete' };
  if (!header && opts?.requireHeader) return { status: 'none' };
  // 无标题时，若第一行是标题形态但日期解析失败，不当标准行。
  if (!header && parseHeader(first, businessDay) === null && /(?:\d{1,2}号|\d{1,2}月|20\d{2})\S*店/.test(first) && !/[（(]/.test(first)) {
    return { status: 'none' };
  }
  const entries: StandardEntry[] = [];
  let sawLine = false;
  let anyAsk: StandardLineAsk | null = null;
  for (const line of body) {
    if (isHeaderOnlyLine(line, businessDay)) continue;
    const parsed = parseStandardLine(line, opts?.amountContext ?? 'standard-line');
    if (parsed.status === 'ask') { anyAsk = parsed; break; }
    if (parsed.status === 'none') {
      // R11：已有报单行之后，确定的改账分句不当成整单失败，记到 compound 里由入口处理。
      // 其它非标准行仍让整单 incomplete，以免多行清单把杂句吞掉。
      const k = clauseKind(line);
      if (sawLine && k === 'correction') {
        const last = entries[entries.length - 1];
        if (last && !last.compound) last.compound = line;
        continue;
      }
      return (sawLine || !!header) ? { status: 'incomplete' } : { status: 'none' };
    }
    entries.push(...parsed.entries);
    sawLine = true;
  }
  // D124 不在解析层拦截：标题日期可以不是「传入的参考营业日」（parseReportText 用来解析历史清单）。
  // 非今天拒在员工入口用 hasUnnegatedNonToday 与 report.businessDay !== today 执行。
  if (anyAsk) return anyAsk;
  if (!entries.length) return header ? { status: 'incomplete' } : { status: 'none' };
  return {
    status: 'complete',
    report: { businessDay: header?.businessDay ?? businessDay, storeName: header?.storeName ?? null, entries },
  };
}

/** 是否整段都是标准行（含带良性备注、多行、变体）。否定/追问形态也算「认出是标准行」。 */
export function isStandardAmountLine(raw: string): boolean {
  const text = normalizeReportText(raw).trim();
  if (!text) return false;
  // 用一个占位营业日即可判断形态（日期标题是否今天不在这里判）。
  const todayGuess = /\b(20\d{2}-\d{2}-\d{2})\b/.exec(text)?.[1] ?? '2026-11-12';
  const r = tryStandardReport(text, todayGuess);
  if (r.status === 'complete' || r.status === 'ask' || r.status === 'not_today') return true;
  // 逐行：每行都能认出（用于「标题行 + 明细」在占位营业日对不上时）。
  const lines = text.split(/\n+/).map(l => l.trim()).filter(Boolean);
  let body = 0;
  for (const line of lines) {
    if (parseHeaderSplit(line, todayGuess) && !parseHeaderSplit(line, todayGuess)!.rest && !/[（(]/.test(line)) continue;
    const p = parseStandardLine(line);
    if (p.status === 'ok' || p.status === 'ask') { body += 1; continue; }
    return false;
  }
  return body > 0;
}

/**
 * D136：归属说法和复合请求（以及整段客套）剥掉以后剩下的备注。
 * 没有剩下的备注时返回空字符串——这一行不计入指标的分母和分子。
 */
export function remainingRemarkAfterPeel(text: string, businessDay = '2026-11-12'): string {
  if (typeof text !== 'string' || !text.trim()) return '';
  const r = tryStandardReport(text, businessDay);
  if (r.status === 'complete') {
    return r.report.entries.map(e => (e.note ?? '').trim()).filter(Boolean).join('；');
  }
  const lines = normalizeReportText(text).split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const notes: string[] = [];
  let any = false;
  for (const line of lines) {
    const parsed = parseStandardLine(line);
    if (parsed.status === 'ok') {
      any = true;
      const n = (parsed.remark ?? '').trim() || parsed.entries.map(e => (e.note ?? '').trim()).filter(Boolean).join('；');
      if (n) notes.push(n);
    }
  }
  return any ? notes.join('；') : '';
}

/** 把语法结果映到既有澄清原因名。 */
export function standardAskToReason(reason: StandardAskReason): 'vague_amount' | 'not_closed' | 'ask_wan' | 'negation' | 'multi_employee' | 'alternatives' | AmountIssue {
  if (reason === 'negation') return 'negation';
  if (reason === 'not_closed') return 'not_closed';
  if (reason === 'multi_employee') return 'multi_employee';
  if (reason === 'alternatives') return 'alternatives';
  if (reason === 'hedge' || reason === 'vague_amount') return 'vague_amount';
  return reason;
}
