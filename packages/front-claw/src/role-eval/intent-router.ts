import { ENTRY_LINE_PATTERN, normalizeReportText, parseLooseReport, parseReportText } from './report-parse.js';
import { looksLikeAppointment, parseAppointmentRequest, parseAppointmentUtterance, withoutAppointmentCoaching } from './appointments.js';
import { parseCorrectionCommand, parseCorrectionPick, parseTargetCommand } from './ledger-commands.js';
import { ambiguityOf, extractReport, HONORIFIC, type UnclearReason } from './report-extract.js';
import { clarifyQuestion } from './clarify.js';
import { compoundHead, compoundTail, courtesyKind, isSelfProgressQuery, isStorePerfQuery, isVent } from './scope-refusal.js';
import { classifyStandardRemark } from './standard-line.js';
import { projectNamesForStore } from './remark-whitelist.js';

/**
 * M02 意图路由：规则快路径 + 至多一次受限语义分类。
 * 纯函数，不持有 store、不写库；结果只决定交给哪个入口。
 */
export type Intent = 'report' | 'followup' | 'progress' | 'result' | 'appointment' | 'summary' | 'correction' | 'target' | 'chitchat' | 'marketing';
export type IntentLabel = Intent | 'clarify';
export const INTENT_LABELS: readonly IntentLabel[] = ['report', 'followup', 'progress', 'result', 'appointment', 'summary', 'correction', 'target', 'chitchat', 'marketing', 'clarify'];
export const STORE_INTENTS: readonly Intent[] = ['report', 'followup', 'progress', 'result', 'appointment', 'summary', 'correction', 'target'];

export interface Classification {
  label: IntentLabel;
  /** 命中的全部意图（去重、按固定顺序）；多于一个且冲突时 label 为 clarify。 */
  intents: Intent[];
  source: 'rule' | 'semantic';
  reason: 'single' | 'multi-intent' | 'no-signal' | 'semantic' | 'semantic-rejected' | 'semantic-timeout' | 'unclear';
  /** R2：结构化澄清的原因与要问的问题（高风险意图缺字段/有歧义时强制澄清，不交兜底分类器）。 */
  unclear?: UnclearReason | 'missing_customer';
  ask?: string;
  /** R1：兜底分类器抽出的字段（仅供观测/澄清提示，不用于写入；写入只认规则解析结果）。 */
  fields?: Record<string, string | number>;
}
export type RouteTarget = 'store' | 'chitchat' | 'marketing' | 'marketing-unavailable' | 'clarify';
export interface RouteDecision { target: RouteTarget; label: IntentLabel; intents: Intent[]; ask?: string; }
export interface MarketingPolicy { marketingEnabled: boolean; marketingGranted: boolean; }

const ORDER: readonly Intent[] = ['report', 'followup', 'progress', 'result', 'appointment', 'summary', 'correction', 'target', 'marketing', 'chitchat'];
// D172：否定新客户追问也进入原店务循环，由持久追问状态决定是否撤销。
const SHORT_CONFIRM = /^(?:对|对的|确认|确认入账|确认认账|确认保存|是|是的|不是|好|好的|嗯|嗯嗯|没错|可以|ok|取消|全部确认)[。.!！~～]*$/i;
const ENTRY_LINE = ENTRY_LINE_PATTERN;
const REPORT_WORDS = /报数|报一下|要报|报.{0,4}的?数|记一下|记上|帮我记|开单|做了\s*\d|成交\s*\d|报.{0,3}业绩/;
const RESULT_WORDS = /入账结果|入账了[吗没么]?|入账成功|入账.{0,2}[没吗]|那笔.{0,6}入账/;
const PROGRESS_WORDS = /^(?:今天)?进度$|^[^\s的]{1,12}的(?:今天|本月)?进度$|(?:我|本人)(?:的)?(?:今天|本月|这个月|这月)?(?:的)?(?:进度|业绩|目标|完成)|(?:我|本人).{0,6}(?:做了多少|完成多少|完成了多少|多少业绩)/;
const SUMMARY_WORDS = /汇总|经营汇总|门店.{0,6}(?:业绩|数据|情况)|全店|谁(?:还)?没报|排名|排行/;
const APPOINT_WORDS = /^预约|确认预约|预约列表|预约结果|约(?:今|明|后|周|下|星期|礼拜)|帮.{0,6}约|我的预约|登记的预约|^查.{0,8}预约$|^(?:今天|明天|本店)的?预约$/;
const LEGACY_MARKETING_WORDS = /文案|小红书|朋友圈|海报|种草|推广|营销|宣传|标语|口号|推文|公众号|抖音|短视频|脚本|活动方案|广告语/;
const SOFT_ROLE_WORDS = /话术|客诉|带教|家访|五步法|演练|课件|复盘建议|经营诊断|投流复盘|团购诊断/;
const MARKETING_WORDS = new RegExp(`${LEGACY_MARKETING_WORDS.source}|${SOFT_ROLE_WORDS.source}`);
export const hasSoftRoleWords = (text: string): boolean => SOFT_ROLE_WORDS.test(text.replace(/\s+/g, ''));
const CHITCHAT = /^(?:你好|您好|在吗|在不在|hi|hello|哈喽|早|早安|早上好|中午好|下午好|晚上好|晚安|谢谢|谢谢你|多谢|辛苦了|辛苦|哈+|呵呵|你是谁|你叫什么)[呀啊哈!！。.~～]*$/i;
const WEATHER = /天气/;

function today(): string { return new Date().toISOString().slice(0, 10); }

const ORAL_PROJECT_REPORT = new RegExp(`^([\\u4e00-\\u9fa5](?:${HONORIFIC}))[ \\t]*(?:(?:刚刚?)?做了[ \\t]*)?([\\u4e00-\\u9fa5]{1,32})[ \\t]*(\\d+[ \\t]*(?:元|块钱?)?)$`);

/** 只有客户称呼、白名单项目和一个金额组成的单笔口语，才转成标准行。 */
export function oralProjectReportLine(text: string): string | null {
  const match = ORAL_PROJECT_REPORT.exec(normalizeReportText(text).trim());
  if (!match) return null;
  const [, customer, project, amount] = match;
  if (!projectNamesForStore().some(name => project!.startsWith(name)) || classifyStandardRemark(project!) !== 'allow') return null;
  return `${customer}：${amount} ${project}`;
}

/** 规则分类：只看文本，不看库。 */
export function classifyIntent(raw: string, context: { businessDay?: string } = {}): Classification {
  const text = typeof raw === 'string' ? normalizeReportText(raw).trim() : '';
  const hits = new Set<Intent>();
  if (!text || text.length > 2000) return { label: 'clarify', intents: [], source: 'rule', reason: 'no-signal' };
  // R3a：吐槽/情绪类（无金额、无店务动作/客人/预约时间）→ 闲聊短答，先于其他判定（例如「客户真多」不当预约）。
  if (isVent(text)) return { label: 'chitchat', intents: ['chitchat'], source: 'rule', reason: 'single' };
  const body = oralProjectReportLine(text) ?? text.replace(/^报数\s*/, '');
  const strict = parseReportText(body, context.businessDay ?? today()).status;
  // R1：无日期标题的标准行（「王姨 1.2k（小林）」）同样按解析文法判定，不加关键词。
  const parsed = strict !== 'none' ? strict : parseLooseReport(body, context.businessDay ?? today()).status === 'complete' ? 'complete' : 'none';
  const flat = text.replace(/\s+/g, '');
  if (parsed !== 'none' || ENTRY_LINE.test(text) || REPORT_WORDS.test(flat)) hits.add('report');
  if (SHORT_CONFIRM.test(text)) hits.add('followup');
  if (parseCorrectionPick(text)) hits.add('correction');
  if (RESULT_WORDS.test(flat)) hits.add('result');
  if (PROGRESS_WORDS.test(flat) && !hits.has('result')) hits.add('progress');
  if (SUMMARY_WORDS.test(flat)) hits.add('summary');
  // M05：自然语言来店（「明天三点有个客人要来」）→ 预约；带「金额（员工）」行的仍是报数。
  const appointmentText = withoutAppointmentCoaching(text);
  const appointmentLike = looksLikeAppointment(appointmentText) && !ENTRY_LINE.test(text);
  if (parseAppointmentUtterance(appointmentText) || appointmentLike || APPOINT_WORDS.test(appointmentText.replace(/\s+/g, ''))) hits.add('appointment');
  if (appointmentLike) hits.delete('report');
  const legacyMarketing = LEGACY_MARKETING_WORDS.test(flat);
  if (legacyMarketing) hits.add('marketing');
  // R3：纯客套话（致谢/寒暄/道别，去掉语气词与表情后不剩别的）→ 闲聊，短答。
  if (CHITCHAT.test(flat) || courtesyKind(text) !== null || (WEATHER.test(flat) && hits.size === 0)) hits.add('chitchat');
  // M04：明确指向“刚才/上一笔/第N笔”的改账、撤回 → 更正；正文里的“报数/入账/进度”字眼只是对象，不另算意图。
  const correction = parseCorrectionCommand(text);
  if (correction) { hits.add('correction'); hits.delete('report'); hits.delete('result'); hits.delete('progress'); }
  // M04：带金额的目标设置 → target（不带金额的“目标”仍是进度查询）。
  const target = parseTargetCommand(text, context.businessDay ?? today());
  if (target) { hits.add('target'); hits.delete('progress'); hits.delete('report'); }
  if (!legacyMarketing && MARKETING_WORDS.test(flat) && !STORE_INTENTS.some(intent => hits.has(intent))) {
    const clauses = [compoundHead(text), compoundTail(text) ?? ''];
    if (clauses.some(isSelfProgressQuery)) hits.add('progress');
    else if (clauses.some(isStorePerfQuery)) hits.add('summary');
    else hits.add('marketing');
  }
  // 汇总明确时，“业绩”类进度不另算一个意图。
  if (hits.has('summary') && hits.has('progress') && !/我|本人/.test(flat)) hits.delete('progress');
  // 一份完整清单就是报数，正文里的其他字眼（如备注）不改变意图。
  if (parsed === 'complete' && !appointmentLike) return { label: 'report', intents: ['report'], source: 'rule', reason: 'single' };
  // R2：自然句报数（客人/项目 + 金额 + 可选括号员工）按通用文法抽取；不确定就强制澄清，不交兜底分类器。
  if (parsed === 'none' && !correction && !target) {
    const extracted = extractReport(text);
    if (extracted.status === 'complete') return { label: 'report', intents: ['report'], source: 'rule', reason: 'single' };
    if (extracted.status === 'unclear') return unclear(['report'], extracted.reason, extracted.detail);
  }
  const intents = ORDER.filter(intent => hits.has(intent));
  if (intents.length === 1) {
    const label = intents[0]!;
    // R2：店务意图（改账、查询、预约、目标…）有互斥候选/未定指代/发送人自述不确定 → 先问清楚。
    if (label !== 'marketing' && label !== 'chitchat' && label !== 'followup') {
      const ambiguous = ambiguityOf(text);
      if (ambiguous) return unclear(intents, ambiguous);
      // R4（D104）：缺客人称呼改由员工入口先问一次并记下待答状态，分类仍走店务，不当澄清丢掉上下文。
    }
    return { label, intents, source: 'rule', reason: 'single' };
  }
  if (intents.length > 1 && ambiguityOf(text)) return unclear(intents, ambiguityOf(text)!);
  if (intents.length === 0) return { label: 'clarify', intents, source: 'rule', reason: 'no-signal' };
  return { label: 'clarify', intents, source: 'rule', reason: 'multi-intent' };
}

function unclear(intents: Intent[], reason: UnclearReason | 'missing_customer', detail?: string): Classification {
  return { label: 'clarify', intents, source: 'rule', reason: 'unclear', unclear: reason, ask: clarifyQuestion(reason, detail) };
}
/** R2：预约必须能指认客人：「姓+称谓」或明说「客人/顾客/客户」（匿名来客）；都没有 → 问是哪位客人。 */
export function appointmentHasCustomer(text: string): boolean {
  // R4（D104）：有称呼 → 通过；明确说「有个客人/没留名」视为已回答不留名（可登记为未留名）；
  // 既无称呼也未声明 → 先问一次。不用光是「客人」两个字（避免「客人称呼没告诉你」被当成已声明）。
  const parsed = parseAppointmentRequest(text, new Date('2026-01-01T04:00:00Z'), 'Asia/Shanghai');
  if (!parsed || parsed.kind !== 'request') return true;
  if (parsed.item.customerNamed) return true;
  const flat = normalizeReportText(text).replace(/\s+/g, '');
  return /有个客人|有客人|有一位客人|没留名|未留名|没有名字|没有称呼/.test(flat);
}

/** 营销只在“明确营销意图 ∧ 已启用 ∧ 获权”时进入；店务和闲聊永远不进营销。 */
export function decideRoute(c: Classification, policy: MarketingPolicy): RouteDecision {
  const base = { label: c.label, intents: [...c.intents] };
  if (c.label === 'marketing') return { ...base, target: policy.marketingEnabled && policy.marketingGranted ? 'marketing' : 'marketing-unavailable' };
  if (c.label === 'chitchat') return { ...base, target: 'chitchat' };
  if (c.label === 'clarify') return { ...base, target: 'clarify', ...(c.ask ? { ask: c.ask } : {}) };
  return { ...base, target: 'store' };
}

export type SemanticClassifier = (input: { text: string; signal: AbortSignal }) => Promise<unknown>;
export const SEMANTIC_MIN_CONFIDENCE = 0.8;

/**
 * R1（M02）兜底意图分类：规则不是“单一高置信命中”（无信号/多意图）时，至多调用一次分类器。
 * 分类器输出 { route: 'act'|'clarify'|'marketing'|'chitchat', intent?, confidence, fields? }
 * （兼容旧端口 { label, confidence }）。端口拿不到 store；超时、取消、畸形输出、低置信度、未知 route 一律澄清。
 */
const ROUTES = ['act', 'clarify', 'marketing', 'chitchat'] as const;
function cleanFields(value: unknown): Record<string, string | number> | null | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const out: Record<string, string | number> = {};
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 12) return null;
  for (const [key, item] of entries) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(key)) return null;
    if (typeof item === 'string' && item.length <= 200) out[key] = item;
    else if (typeof item === 'number' && Number.isFinite(item)) out[key] = item;
    else return null;
  }
  return out;
}
function interpret(output: Record<string, unknown>): { label: Intent; fields?: Record<string, string | number> } | null {
  const confidence = output.confidence;
  if (typeof confidence !== 'number' || !(confidence >= SEMANTIC_MIN_CONFIDENCE && confidence <= 1)) return null;
  if ('route' in output) {
    const route = output.route;
    if (typeof route !== 'string' || !(ROUTES as readonly string[]).includes(route)) return null;
    const fields = cleanFields(output.fields);
    if (fields === null) return null;
    const label: IntentLabel | null = route === 'marketing' ? 'marketing' : route === 'chitchat' ? 'chitchat' : route === 'clarify' ? null
      : typeof output.intent === 'string' && (STORE_INTENTS as readonly string[]).includes(output.intent) ? output.intent as Intent : null;
    return label ? { label: label as Intent, ...(fields ? { fields } : {}) } : null;
  }
  const label = output.label;
  if (typeof label !== 'string' || !INTENT_LABELS.includes(label as IntentLabel) || label === 'clarify') return null;
  return { label: label as Intent };
}
export async function classifyWithSemantic(text: string, options: {
  businessDay?: string; semantic?: SemanticClassifier | undefined; signal?: AbortSignal | undefined; deadline?: number | undefined; now?: () => number;
}): Promise<Classification> {
  const rule = classifyIntent(text, options);
  if (rule.label !== 'clarify' || (rule.reason !== 'no-signal' && rule.reason !== 'multi-intent') || !options.semantic) return rule;
  const now = options.now ?? (() => performance.now());
  const remaining = Math.floor((options.deadline ?? now() + 3000) - now());
  if (remaining < 50 || options.signal?.aborted) return { ...rule, reason: 'semantic-timeout' };
  const child = new AbortController();
  const stop = () => child.abort();
  options.signal?.addEventListener('abort', stop, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<'timeout'>(resolve => { timer = setTimeout(() => { child.abort(); resolve('timeout'); }, remaining); });
    const aborted = new Promise<'timeout'>(resolve => child.signal.addEventListener('abort', () => resolve('timeout'), { once: true }));
    const output = await Promise.race([options.semantic({ text, signal: child.signal }).catch(() => undefined), timeout, aborted]);
    if (output === 'timeout') return { ...rule, reason: 'semantic-timeout' };
    if (!output || typeof output !== 'object' || Array.isArray(output)) return { ...rule, reason: 'semantic-rejected' };
    const picked = interpret(output as Record<string, unknown>);
    if (!picked) return { ...rule, reason: 'semantic-rejected' };
    // 多意图时分类器只能在规则已命中的意图里选一个，不能引入新意图。
    if (rule.reason === 'multi-intent' && !rule.intents.includes(picked.label)) return { ...rule, reason: 'semantic-rejected' };
    return { label: picked.label, intents: [picked.label], source: 'semantic', reason: 'semantic', ...(picked.fields ? { fields: picked.fields } : {}) };
  } finally {
    if (timer) clearTimeout(timer);
    options.signal?.removeEventListener('abort', stop);
    child.abort();
  }
}

export const isStoreIntent = (label: IntentLabel): boolean => (STORE_INTENTS as readonly string[]).includes(label);
