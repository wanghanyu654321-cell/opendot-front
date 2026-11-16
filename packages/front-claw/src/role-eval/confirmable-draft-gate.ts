/**
 * R17 / D152：可确认报单草稿的唯一闸。
 * 只有两种情况能出可确认报单草稿：
 *   1. 整行通过 standard-line.ts，且是纯标准行（客户位、括号员工位都是正向形态）；
 *   2. 线上模型分类结果（非离线桩）。
 * 其他情况一律不出。离线桩永远不允许出可确认草稿。
 * 标记 R17-single-draft-gate：变异绕过本闸出草稿时必须被杀掉。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { customerNameLooksContaminated, hasUnseenNegatedMakeup, looksLikeContaminatedReportLine, LEFTOVER_FRAGMENT_ASK } from './negated-makeup.js';
import { clauseKind } from './scope-refusal.js';
import { guardUtteranceAmounts } from './amount-guard.js';
import { customerNamePolicyConfig, decideOpenedCustomerName, matchesCustomerNameStructure, NOT_A_CUSTOMER_NAME_ASK } from './customer-name-policy.js';
import { normalizeCustomerName } from './customer-conflict.js';
import { nameInRoster } from './store-customer-roster.js';
import { formatMaybeReportAsk } from './model-path-ask.js';
import {
  CUSTOMER_HONORIFIC,
  HONORIFIC,
  NOT_CUSTOMER_NAME,
  LINE_PREFIX_LABELS,
  LINE_PREFIX_GREETINGS,
  stripLinePrefix,
  stripTrailingReportEmoji,
  containsReportEmoji,
  hasNonCustomerStandardLabel,
  parseBracketReportHeader,
  isOpenedSelfCustomerName,
  stripNegatedMakeupPhrases,
  tryStandardReport,
  type StandardReportResult,
} from './standard-line.js';

const HONORIFIC_END = new RegExp(`(?:${HONORIFIC})$`);

export const GATE_MARKER = 'R17-single-draft-gate';

/**
 * R18 / D156：括号位第一道粗筛（身份、角色、时段、动作词）。词表在 config/bracket-not-name.json，冻结、不再加词。
 * 真正的校验是正向的：括号里的人必须是本店在职员工或别名（见 impureReason 的 employee-unknown）。
 */
const BRACKET_CONFIG_PATH = join(dirname(fileURLToPath(import.meta.url)), '../../config/bracket-not-name.json');
const BRACKET_CONFIG = JSON.parse(readFileSync(BRACKET_CONFIG_PATH, 'utf8')) as { frozen: boolean; words: string[] };
export const BRACKET_NOT_NAME_WORDS: readonly string[] = Object.freeze([...BRACKET_CONFIG.words]);
export const BRACKET_NOT_NAME = new RegExp(BRACKET_NOT_NAME_WORDS.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'));

export function isBracketNotName(raw: string): boolean {
  const flat = raw.normalize('NFKC').replace(/\s+/g, '');
  if (!flat) return false;
  return NOT_CUSTOMER_NAME.test(flat) || BRACKET_NOT_NAME.test(flat) || customerNameLooksContaminated(flat);
}

/** 整段恰好是「一或二字姓＋称谓」，不允许前面再挂残片。 */
export function isExactHonorificName(raw: string): boolean {
  const name = raw.normalize('NFKC').trim();
  if (/[\s【】\[\]]/.test(name)) return false;
  if (!name) return false;
  if (CUSTOMER_HONORIFIC.test(name)) return true;
  const honorific = HONORIFIC_END.exec(name)?.[0];
  // 二字姓必须是真实复姓；不能把「多余前导字＋单姓」当成复姓。
  return !!honorific && customerNamePolicyConfig().compounds.includes(name.slice(0, -honorific.length));
}

/** 客户位正向白名单：恰好姓＋称谓，或 D138 的 2–4 字干净形态（先过非名字表和残片）。 */
export function isCleanCustomerMorphology(raw: string): boolean {
  const name = raw.normalize('NFKC');
  if (/[\s【】\[\]]/.test(name)) return false;
  if (!name) return false;
  if (customerNameLooksContaminated(name) || hasUnstrippedReportPrefix(name)) return false;
  if (NOT_CUSTOMER_NAME.test(name)) return false;
  // D163 负责原客户位的空白/括号拒收；其后形态与 D139 名单使用相同的归一口径。
  const canonical = normalizeCustomerName(name);
  if (HONORIFIC_END.test(canonical)) return isExactHonorificName(canonical);
  return isOpenedSelfCustomerName(canonical);
}

export interface DraftGateInput {
  text: string;
  today: string;
  employeeNames: ReadonlySet<string>;
  /** 线上真模型且分类已通过校验时为 true；离线桩必须是 false。 */
  liveModelAllowsDraft?: boolean;
  /**
   * 调用方已按 standard-line 语法（D125：单行标准行或标准清单）解析出的条目。
   * 自然句抽取（extractReport）不算标准行，不得传入。
   */
  entries?: readonly GateEntry[];
  /** D139/D165：名单由本店已确认未作废账本和预约推导；单闸统一决定三档。 */
  knownCustomerNames?: ReadonlySet<string>;
  /** 本条「是新客户」追问被肯定的名字，仅本请求有效，不写入名单。 */
  confirmedNewNames?: readonly string[];
  /**
   * R18 / D155：条目来自哪条解析路径。只有标准行语法（D125 单行/标准清单）是 'standard'；
   * 自然句抽取（extractReport）是 'natural'，不算纯标准行，归模型路径，离线一律不开闸。
   * 不传时按 'standard' 处理（仅限直接给 text、由闸自己用 tryStandardReport 解析的调用）。
   */
  source?: 'standard' | 'natural';
}

export interface GateEntry {
  customer?: string | null;
  employeeName?: string | null;
  self?: boolean;
  compound?: string | null;
  storeName?: string | null;
}

/** 返回不纯的原因；null 表示纯标准行。 */
export function impureReason(entries: readonly GateEntry[], input: DraftGateInput): string | null {
  if (input.source === 'natural') return 'natural-sentence';
  const textLevel = textLevelImpurity(input.text, input.today);
  if (textLevel) return textLevel;
  if (!entries.length) return 'empty';
  for (const e of entries) {
    const customer = e.customer ?? '';
    const empRaw = (e.employeeName ?? '').trim();
    if (customer) {
      // D165：员工位不能放宽客户位。D163 在任何归一/名单匹配之前拒收。
      if (!isCleanCustomerMorphology(customer)) return `customer:${customer}`;
    }
    if (empRaw && !e.self) {
      // 括号内容：先过非名字表，再查本店员工名单，过了才算名字。
      const flat = empRaw.normalize('NFKC').replace(/\s+/g, '');
      const bare = e.storeName ? flat : flat.replace(/^.{1,8}?店/, '');
      if (bracketImpurity(bare)) return `employee-not-name:${empRaw}`;
      if (!input.employeeNames.has(bare) && !input.employeeNames.has(flat)) return `employee-unknown:${empRaw}`;
    }
    // R18 / D157：任何第二件请求（进度、查询、改账、预约、目标、宣传、复述、残片）都不是纯标准行：整句先问，不单独出报单草稿。
    // D130 b（报单＋查本人进度两件都办）留到接真模型后由模型路径恢复。
    if (e.compound && e.compound.replace(/[，,;；、。.\s]/g, '').trim()) return `compound:${e.compound}`;
  }
  return null;
}

export function isPureStandardReport(std: StandardReportResult, input: DraftGateInput): boolean {
  if (std.status !== 'complete') return false;
  return impureReason(std.report.entries, input) === null;
}

/**
 * R18 / D152：通行证。只有本模块能签发（brand 是模块私有 symbol），员工循环建可确认报单草稿必须出示它。
 * 结构性测试检查：员工循环里组装报单草稿的地方只有一个，且该处要求 ConfirmableDraftPass。
 */
declare const PASS_BRAND: unique symbol;
export interface ConfirmableDraftPass { readonly [PASS_BRAND]: true; readonly marker: typeof GATE_MARKER }
function issuePass(): ConfirmableDraftPass { return Object.freeze({ marker: GATE_MARKER }) as unknown as ConfirmableDraftPass; }

export type GateVerdict = { ok: true; pass: ConfirmableDraftPass } | { ok: false; reason: string; newCustomerNames?: string[] };

/**
 * 唯一闸：是否允许创建可确认报单草稿。返回不通过时，调用方必须先问、不得建草稿。
 * 离线桩（liveModelAllowsDraft 为 false/缺省）只有纯标准行能过。
 */
export function evaluateConfirmableReportDraft(input: DraftGateInput): GateVerdict {
  const marker = 'R17-single-draft-gate';
  if (marker !== GATE_MARKER) return { ok: true, pass: issuePass() };
  if (input.liveModelAllowsDraft) return { ok: true, pass: issuePass() };
  // D161：清单不能凭自然抽取或调用方提供的部分条目过闸。每段单独过同一闸与标准行金额收口。
  // 先逐段收口，再处理单行；不让整条解析/纯度判断提前遮住这里的实际判定。
  if (/[；;]/.test(input.text)) {
    const parts = input.text.split(/[；;]/);
    if (parts.length > 50 || (input.entries && input.entries.length !== parts.length)) return { ok: false, reason: 'not-standard-list' };
    const askNames: string[] = [];
    let segmentDay: string | null = null;
    for (const [index, part] of parts.entries()) {
      const amounts = guardUtteranceAmounts(part, 'standard-line');
      if (!amounts.ok) return { ok: false, reason: 'segment-amount' };
      // 结构读取不重复决定 D122；上面的 standard-line amount-guard 是本段金额的授权点。
      const segment = tryStandardReport(part, input.today, { amountContext: 'free' });
      if (segment.status !== 'complete' || segment.report.entries.length !== 1) return { ok: false, reason: 'not-standard-list' };
      if (segmentDay && segmentDay !== segment.report.businessDay) return { ok: false, reason: 'not-standard-list' };
      segmentDay = segment.report.businessDay;
      // 客户位、自报标记、复合残片必须来自本段原文；只接收宿主已唯一解析出的员工姓名。
      const parsed = segment.report.entries[0]!;
      const entry = { ...parsed, employeeName: input.entries?.[index]?.employeeName ?? parsed.employeeName, storeName: segment.report.storeName };
      const verdict = evaluateConfirmableReportDraft({ ...input, text: part, entries: [entry] });
      if (!verdict.ok) {
        if (!verdict.newCustomerNames) return verdict;
        askNames.push(...verdict.newCustomerNames);
      }
    }
    return askNames.length ? { ok: false, reason: 'new-customer', newCustomerNames: [...new Set(askNames)] } : { ok: true, pass: issuePass() };
  }
  const entries = input.entries ?? (() => {
    const std = tryStandardReport(input.text, input.today);
    return std.status === 'complete' ? std.report.entries : [];
  })();
  const reason = impureReason(entries, input);
  if (reason) return { ok: false, reason };
  const askNames: string[] = [];
  const known = new Set(input.knownCustomerNames);
  for (const entry of entries) {
    const customer = entry.customer ?? '';
    if (!customer || isExactHonorificName(customer)) continue;
    const inRoster = nameInRoster(known, customer);
    // D158/D165：未知客户不能只凭 2–4 字外形问成新客；先验证配置姓氏/昵称及名字长度。
    // 名单沿用 D139；本请求的新客肯定答复不能绕过这道结构检查。
    if (!inRoster && !matchesCustomerNameStructure(customer)) return { ok: false, reason: `customer:${customer}` };
    // 已知名字前的残片不能被整体问成新客户；单姓/复姓加名字的正常形态仍走 D139。
    if (!inRoster && [...known].some(name => {
      if (name.length < 2 || !customer.endsWith(name) || customer === name) return false;
      const leading = customer.slice(0, -name.length);
      const surnames = customerNamePolicyConfig();
      return !surnames.singles.has(leading) && !surnames.compounds.includes(leading);
    })) return { ok: false, reason: `customer:${customer}` };
    const decision = decideOpenedCustomerName(customer, { known: inRoster });
    if (decision === 'deny') return { ok: false, reason: `customer:${customer}` };
    if (decision === 'ask-new' && !input.confirmedNewNames?.includes(customer)) askNames.push(customer);
  }
  return askNames.length ? { ok: false, reason: 'new-customer', newCustomerNames: [...new Set(askNames)] } : { ok: true, pass: issuePass() };
}

/** 兼容旧调用：布尔版。 */
export function mayCreateConfirmableReportDraft(input: DraftGateInput): boolean {
  return evaluateConfirmableReportDraft(input).ok;
}

/**
 * R18 / 移交项 3：整句层面的不纯判断（只看文本，不读账本）。入口和循环在 D81 之前调用这里拿「先问」的结论和措辞，
 * 闸内 impureReason 用的是同一个函数——判断只有一处，入口/循环不再各自判。
 */
export type TextImpurity = 'unseen-makeup' | 'contaminated-line' | 'invalid-format' | 'not-customer-name';

/** D165：表内词未被语法剥掉说明没有分隔。表外残片由客户位的形态与名单结构判定，不列词。 */
function hasUnstrippedReportPrefix(text: string): boolean {
  return [...LINE_PREFIX_LABELS, ...LINE_PREFIX_GREETINGS].some(p => text.startsWith(p));
}
export function textLevelImpurity(text: string, today: string): TextImpurity | null {
  if (hasUnseenNegatedMakeup(text, stripNegatedMakeupPhrases)) return 'unseen-makeup';
  if (looksLikeContaminatedReportLine(stripNegatedMakeupPhrases(text))) return 'contaminated-line';
  // D165 顺序：先用同一语法剥固定前缀；不把前缀残留当作新客户。
  const raw = stripLinePrefix(text.normalize('NFKC').trim());
  for (const line of raw.split(/[；;\n]/)) {
    let body = stripLinePrefix(stripTrailingReportEmoji(line.trim()));
    if (!/\d|[千万元块]/.test(body)) continue;
    // 更正命令不是客户位前缀，保留既有更正路由；带报单主体的复合句仍由单闸拒收。
    if (clauseKind(body) === 'correction' && tryStandardReport(body, today).status !== 'complete') continue;
    const bracket = /^【([^】]+)】\s*[:：，,]?\s*(.*)$/.exec(body);
    if (bracket) {
      if (!parseBracketReportHeader(bracket[1]!, today)) return 'invalid-format';
      body = stripLinePrefix(bracket[2]!);
    }
    if (hasUnstrippedReportPrefix(body) || containsReportEmoji(body)) return 'invalid-format';
    if (hasNonCustomerStandardLabel(body)) return 'not-customer-name';
  }
  return null;
}

/** 括号位粗筛（D156 第一道）：非名字词 → 先问。像人名但对不上本店的，交给既有跨店/查无此人拒绝（语义不弱化）。 */
export function bracketImpurity(bareEmployee: string): 'employee-not-name' | null {
  return isBracketNotName(bareEmployee) ? 'employee-not-name' : null;
}

/** 闸不通过时的追问措辞（与 R16/R17 原措辞一致）：未见否定补报 → 模型路径追问；残片 → 残片追问（除非能给出确认句）。 */
export function askForTextImpurity(kind: TextImpurity, text: string, confirmedNames: ReadonlySet<string>): string {
  if (kind === 'not-customer-name') return NOT_A_CUSTOMER_NAME_ASK;
  const ask = formatMaybeReportAsk(text, confirmedNames);
  if (kind === 'unseen-makeup') return ask;
  return ask.includes('是不是要报') ? ask : LEFTOVER_FRAGMENT_ASK;
}
