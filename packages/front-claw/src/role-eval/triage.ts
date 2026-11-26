import { clarifyQuestion } from './clarify.js';
import {
  onlyNegatedAppointment,
  parseAppointmentUtterance,
  parseStandaloneAppointmentTime,
} from './appointments.js';
import { oralProjectReportLine } from './intent-router.js';
import {
  parseAddNewChoice,
  parseAskManagerChoice,
  parseCorrectionCommand,
  parseCorrectionPick,
  parseTargetCommand,
} from './ledger-commands.js';
import {
  isReadOnlyQuery,
  type ModelClassification,
  type ModelSoftRole,
} from './model-classify.js';
import {
  fromModelReadQuery,
  parseRuleReadQuery,
  type ReadQuerySpec,
} from './read-query.js';
import { extractReport, nonClosingReportReason } from './report-extract.js';
import { parseLooseReport, parseReportText } from './report-parse.js';
import {
  compoundHead,
  compoundTail,
  courtesyKind,
  isSelfProgressQuery,
  isVent,
} from './scope-refusal.js';
import { classifyIntent, hasSoftRoleWords, isStoreIntent } from './intent-router.js';

/**
 * Pure Core 单决策分诊模块（Issue #21，路线 A）：
 * - 零数据库、零 SDK、零网络依赖；
 * - 硬格式快通道与自然语言分诊模型共同产出唯一的 TriageDecision；
 * - 下游执行器（employee-loop 与 wecom-front-claw-bridge）直接消费该决定，不再二次覆盖意图；
 * - 所有写操作、数据权限、原文门店/人名/金额/未成交校验仍由确定性安全门守卫。
 */
export const TRIAGE_VERSION = 'v2';
export const TRIAGE_MAX_INPUT_CHARS = 2000;

export const TOO_LONG_INPUT_REPLY =
  'Front Claw：这条消息太长（超过 2000 字），为避免截断误判，请拆分简短后再发。没有写入任何账目。';
export const HOLD_PENDING_KEEP_REPLY =
  'Front Claw：好的，当前待确认草稿已先保留（没有入账，也没有取消）。后续如需处理请明确发「确认入账」或「取消」。';
export const HOLD_PENDING_EMPTY_REPLY =
  'Front Claw：你当前没有待确认草稿，没有做任何确认、取消或写入。';

export type TriageMode = 'v2' | 'legacy';
export type TriageSoftRole = ModelSoftRole;
export type TriageSource = 'fast_path' | 'model' | 'rule_fallback' | 'guard';

export interface TriageSessionHint {
  readonly hasActivePendingDraft: boolean;
  readonly pendingDraftKind: 'report' | 'appointment' | 'target' | 'correction' | null;
  readonly hasPendingAppointmentTimeAsk: boolean;
}

export type TriageDecision =
  | { readonly kind: 'confirm_or_cancel'; readonly source: 'fast_path' }
  | { readonly kind: 'appointment_time_reply'; readonly source: 'fast_path'; readonly clock: string }
  | { readonly kind: 'choice_followup'; readonly source: 'fast_path' }
  | { readonly kind: 'hold_pending'; readonly source: TriageSource; readonly readQuery?: ReadQuerySpec }
  | { readonly kind: 'read_query'; readonly source: TriageSource; readonly spec: ReadQuerySpec; readonly holdPending?: boolean }
  | { readonly kind: 'soft_role'; readonly source: TriageSource; readonly softRole: TriageSoftRole }
  | {
      readonly kind: 'store_write';
      readonly source: TriageSource;
      readonly writeKind: 'report' | 'appointment' | 'target' | 'correction';
      readonly classification?: ModelClassification;
    }
  | { readonly kind: 'chitchat'; readonly source: TriageSource }
  | { readonly kind: 'multi_intent'; readonly source: TriageSource; readonly ask: string }
  | {
      readonly kind: 'clarify';
      readonly source: TriageSource;
      readonly reason: 'uncertain' | 'too_long' | 'non_closing' | 'amount' | 'schema' | 'no_signal';
      readonly ask: string;
      readonly markInterleaved: boolean;
      readonly suppressReminder?: boolean;
    };

export interface TriageAuditInfo {
  readonly triageVersion: string;
  readonly routeLayer: TriageSource;
  readonly finalIntent: string;
  readonly softRole?: TriageSoftRole;
}

const flatOf = (text: string) => text.normalize('NFKC').replace(/\s+/g, '');

export function resolveTriageMode(
  env: Readonly<Record<string, string | undefined>> = process.env,
): TriageMode {
  const raw = env.FC_TRIAGE_MODE?.trim().toLowerCase();
  return raw === 'legacy' ? 'legacy' : 'v2';
}

const STANDALONE_CONFIRM_OR_CANCEL =
  /^(?:对|对的|确认|确认入账|确认认账|确认保存|是|是的|不是|好|好的|嗯|嗯嗯|没错|可以|ok|取消|全部确认)[。.!！~～]*$/i;

const STRICT_EXACT_READ_COMMAND =
  /^(?:我的进度|今天进度|进度|我的业绩|本月业绩|本店汇总|全店汇总|经营汇总|门店汇总|本月汇总|预约列表|我的预约|今天谁没报|谁没报|门店排名|员工排名|入账结果(?:\s+\S+)?)$/;

const PENDING_REF = '(?:(?:刚才|刚刚|之前|上一?笔?)?(?:那笔|这笔|当前|前面)?(?:待确认|未确认)(?:的)?(?:草稿|报单|单子?)?|(?:刚才|刚刚|之前|上一?笔?)?(?:那笔|这笔|当前)(?:的)?(?:草稿|报单))';
const HOLD_ACTION = '(?:先放着|先放一放|放着|放一放|先不管|先不处理|暂不处理|先别管|先别动|先不确认|先别确认|先留着|留着|暂缓(?:处理|确认)?|晚点再(?:处理|确认)|等会(?:儿)?再(?:处理|确认)|先不动)';

const STANDALONE_HOLD_PENDING = new RegExp(
  `^(?:请)?(?:帮我|给我)?(?:把|将)?${PENDING_REF}(?:都)?(?:先|暂)?${HOLD_ACTION}(?:吧|哈|好吗|行吗|先)?[。.!！?？~～]*$`,
);

const LEADING_HOLD_PENDING = new RegExp(
  `^(?:请)?(?:帮我|给我)?(?:把|将)?${PENDING_REF}(?:都)?(?:先|暂)?${HOLD_ACTION}(?:[，,。；;\\s]+)`,
);

const INLINE_HOLD_PENDING = new RegExp(
  `${PENDING_REF}.{0,4}${HOLD_ACTION}`,
);

/** 判断整句是否为独立的「待确认草稿先放着/暂不处理」语义。 */
export function isStandalonePendingDeferral(text: string): boolean {
  const flat = flatOf(text);
  if (!flat || flat.length > 60) return false;
  if (/(?:确认入账|确认认账|全部确认|^\s*取消\s*$)/.test(flat)) return false;
  if (/\d{2,}|\d+(?:\.\d+)?[kKwW千万元块]/.test(flat)) return false;
  return STANDALONE_HOLD_PENDING.test(flat);
}

/** 判断句子是否带有「待确认草稿先放着/暂不处理」分句（含独立句与「先放着 + 查询」复合句）。 */
export function hasPendingDeferralClause(text: string): boolean {
  const flat = flatOf(text);
  if (!flat) return false;
  return STANDALONE_HOLD_PENDING.test(flat) || LEADING_HOLD_PENDING.test(flat) || INLINE_HOLD_PENDING.test(flat);
}

/**
 * 统一的软岗默认分类（仅在模型未显式给出 softRole 或降级兜底时使用）。
 * 注意：此函数只选软岗工作区，经营快照与门店数据仍严格由 M03 授权门控制。
 */
export function classifySoftRoleRule(text: string): TriageSoftRole {
  if (
    /培训|带教|家访|五步法|企业诊断|指导员|考核|试卷|演练|新人怎么|教新人|课程|课件|作战地图|鱼骨图|热力图|客户盘点|信念|U字形/i.test(
      text,
    )
  ) {
    return 'training';
  }
  if (
    /经营复盘|门店复盘|店长复盘|业绩复盘|店务复盘|经营诊断|经营分析|门店诊断|日报建议|周报建议|旬总结建议|怎么提升业绩|业绩怎么抓|目标怎么拆|挂零怎么管/.test(
      text,
    )
  ) {
    return 'manager_ops';
  }
  if (
    /接待.{0,4}话术|欢迎话术|欢迎语|欢迎词|怎么接待|到店.{0,4}接待|客诉|嫌贵|异议|怎么回复客户|退卡安抚|质检|投流|美团|大众点评|团购|\bROI\b|点击率|线索转化/i.test(
      text,
    )
  ) {
    return 'reception_ads';
  }
  if (/复盘/.test(text)) {
    return 'manager_ops';
  }
  return 'marketing';
}

const FAST_PATH_COMPLEX_BLOCK = /[?？]|如果|要是|假如|若|不要|不用|别|不是|先放着|文案|小红书|朋友圈|海报|话术|欢迎语|草稿|复盘|带教|培训|投流|美团|团购/;

/**
 * 第 1 层：极薄确定性快通道（只认无歧义硬格式，绝不抢猜自然语言长句）。
 * 返回 null 表示交由第 2 层统一分诊模型（或 stub 规则兜底）。
 */
export function tryFastPathTriage(
  rawText: string,
  options: {
    businessDay: string;
    sessionHint?: TriageSessionHint;
  },
): TriageDecision | null {
  const trimmed = rawText.trim();
  if (!trimmed) return null;

  // 超长输入防截断护栏：绝不截断前半句启动写流程。
  if (trimmed.length > TRIAGE_MAX_INPUT_CHARS) {
    return {
      kind: 'clarify',
      source: 'guard',
      reason: 'too_long',
      ask: TOO_LONG_INPUT_REPLY,
      markInterleaved: true,
      suppressReminder: true,
    };
  }

  // 1. 独立「待确认先放着」：确定性进入会话挂起保护，零模型依赖。
  if (isStandalonePendingDeferral(trimmed)) {
    return { kind: 'hold_pending', source: 'fast_path' };
  }

  // 1b. 明确元澄清（「我刚才问的是预约查询，不是要报业绩」）与纯否定预约（「明天下午三点别给我约张女士」）：
  // 零写零追问消费，防止恶意/错误报单模型将其错当成缺金额报单。
  const metaSpec = parseRuleReadQuery(trimmed, options.businessDay);
  if (metaSpec?.kind === 'clarify_query') {
    return { kind: 'read_query', source: 'fast_path', spec: metaSpec };
  }
  if (onlyNegatedAppointment(trimmed) && !metaSpec) {
    return {
      kind: 'clarify',
      source: 'fast_path',
      reason: 'non_closing',
      ask: 'Front Claw：没有登记预约。',
      markInterleaved: false,
      suppressReminder: true,
    };
  }

  // 2. 精确短口令（执行器仍按实时草稿/绑定/租约状态复核）。
  if (STANDALONE_CONFIRM_OR_CANCEL.test(trimmed)) {
    return { kind: 'confirm_or_cancel', source: 'fast_path' };
  }

  // 3. 待补时间的纯钟点答复。
  if (options.sessionHint?.hasPendingAppointmentTimeAsk) {
    const clock = parseStandaloneAppointmentTime(trimmed);
    if (clock) {
      return { kind: 'appointment_time_reply', source: 'fast_path', clock };
    }
  }

  // 4. 二选一/改 N 显式跟进命令。
  if (parseCorrectionPick(trimmed) || parseAddNewChoice(trimmed) || parseAskManagerChoice(trimmed)) {
    return { kind: 'choice_followup', source: 'fast_path' };
  }

  // 5. 极简精确只读命令（不含复杂自然子句）或无条件/无否定的简单本人进度短句。
  const flat = flatOf(trimmed);
  if (
    STRICT_EXACT_READ_COMMAND.test(trimmed.normalize('NFKC'))
    || (!FAST_PATH_COMPLEX_BLOCK.test(flat) && !/[，,。；;！!]/.test(trimmed) && isSelfProgressQuery(trimmed))
  ) {
    const spec = parseRuleReadQuery(trimmed, options.businessDay);
    if (spec) {
      return { kind: 'read_query', source: 'fast_path', spec };
    }
  }

  // 6. 严格标准报单清单、严格目标/改账指令（无问号/条件/否定/软岗词）或明确标准预约命令。
  if (!FAST_PATH_COMPLEX_BLOCK.test(flat)) {
    const targetCmd = parseTargetCommand(trimmed, options.businessDay);
    if (targetCmd && targetCmd !== 'invalid') {
      return { kind: 'store_write', source: 'fast_path', writeKind: 'target' };
    }
    const corrCmd = parseCorrectionCommand(trimmed);
    if (corrCmd && corrCmd !== 'invalid') {
      return { kind: 'store_write', source: 'fast_path', writeKind: 'correction' };
    }
    const strippedReport = trimmed.replace(/^报数\s*/, '');
    const oral = oralProjectReportLine(trimmed);
    const strictComplete = parseReportText(strippedReport, options.businessDay).status === 'complete';
    const simpleLooseComplete = !/[，,。；;！!]/.test(trimmed)
      && !nonClosingReportReason(trimmed)
      && (
        parseLooseReport(strippedReport, options.businessDay).status === 'complete'
        || extractReport(strippedReport).status === 'complete'
      );
    if (oral || strictComplete || simpleLooseComplete) {
      return { kind: 'store_write', source: 'fast_path', writeKind: 'report' };
    }
    if (parseAppointmentUtterance(trimmed)) {
      return { kind: 'store_write', source: 'fast_path', writeKind: 'appointment' };
    }
    // 无歧义的点名客人预约/到店简句（如「明天张女士要来店」「王姐明天下午补水预约」），不含任何软岗/查询/否定词。
    if (
      trimmed.length <= 24
      && !/[，,。；;！!]/.test(trimmed)
      && !/(?:几条|几个|多少|查|看|列|统计|汇总|有没|还有)/.test(flat)
      && (
        /^(?:今天|今日|明天|明日|后天|大后天).{0,6}[\u4e00-\u9fa5](?:先生|女士|小姐|阿姨|老师|姐|哥|叔|总)(?:要)?(?:来店|到店|过来)$/.test(flat)
        || (
          /[\u4e00-\u9fa5](?:先生|女士|小姐|阿姨|老师|姐|哥|叔|总)/.test(flat)
          && /(?:今天|今日|明天|明日|后天|大后天|周[一二三四五六日天]|星期[一二三四五六日天])/.test(flat)
          && /(?:预约|约一下|约个|来店|到店|过来)/.test(flat)
          && !parseRuleReadQuery(trimmed, options.businessDay)
        )
      )
    ) {
      return { kind: 'store_write', source: 'fast_path', writeKind: 'appointment' };
    }
  }

  // 7. 极简纯客套/吐槽。
  if (courtesyKind(trimmed) !== null || isVent(trimmed)) {
    return { kind: 'chitchat', source: 'fast_path' };
  }

  return null;
}

/**
 * 将已通过 strict schema 与金额校验链的 ModelClassification 转换为唯一的 TriageDecision。
 * 写意图（尤其 report）仍叠加确定性原文未成交/否定保护，绝不盲信模型启动写草稿。
 */
export function decisionFromModelClassification(
  rawText: string,
  c: ModelClassification,
  businessDay: string,
  options: { multiReply: string; clarifyReply: string },
): TriageDecision {
  const deferral = c.slots.holdPending === true || hasPendingDeferralClause(rawText);

  if (c.intent === 'hold_pending') {
    const attachedRead = parseRuleReadQuery(rawText, businessDay);
    return attachedRead
      ? { kind: 'read_query', source: 'model', spec: attachedRead, holdPending: true }
      : { kind: 'hold_pending', source: 'model' };
  }

  if (c.intent === 'multi_intent') {
    return { kind: 'multi_intent', source: 'model', ask: options.multiReply };
  }

  if (c.intent === 'chitchat') {
    return { kind: 'chitchat', source: 'model' };
  }

  if (c.intent === 'marketing') {
    const softRole: TriageSoftRole = c.softRole ?? classifySoftRoleRule(rawText);
    return { kind: 'soft_role', source: 'model', softRole };
  }

  if (c.intent === 'query' || (c.intent === 'appointment' && c.action === 'query')) {
    const queryModel: ModelClassification = c.intent === 'appointment'
      ? { ...c, intent: 'query', object: 'appointment', action: 'query' }
      : c;
    if (!isReadOnlyQuery(queryModel)) {
      return {
        kind: 'clarify',
        source: 'model',
        reason: 'uncertain',
        ask: options.clarifyReply,
        markInterleaved: true,
      };
    }
    const spec = fromModelReadQuery(queryModel, rawText, businessDay);
    if (!spec) {
      return {
        kind: 'clarify',
        source: 'model',
        reason: 'uncertain',
        ask: options.clarifyReply,
        markInterleaved: true,
      };
    }
    return {
      kind: 'read_query',
      source: 'model',
      spec,
      ...(deferral ? { holdPending: true } : {}),
    };
  }

  if (c.intent === 'report') {
    const denied = nonClosingReportReason(rawText, { requireAmount: false });
    if (denied) {
      return {
        kind: 'clarify',
        source: 'guard',
        reason: 'non_closing',
        ask: clarifyQuestion(denied),
        markInterleaved: true,
        suppressReminder: true,
      };
    }
    return { kind: 'store_write', source: 'model', writeKind: 'report', classification: c };
  }

  if (c.intent === 'appointment') {
    if (onlyNegatedAppointment(rawText)) {
      return {
        kind: 'clarify',
        source: 'guard',
        reason: 'non_closing',
        ask: 'Front Claw：没有登记预约。',
        markInterleaved: true,
        suppressReminder: true,
      };
    }
    return { kind: 'store_write', source: 'model', writeKind: 'appointment', classification: c };
  }

  if (c.intent === 'target') {
    return { kind: 'store_write', source: 'model', writeKind: 'target', classification: c };
  }

  if (c.intent === 'amend' || c.intent === 'withdraw') {
    return { kind: 'store_write', source: 'model', writeKind: 'correction', classification: c };
  }

  return {
    kind: 'clarify',
    source: 'model',
    reason: 'uncertain',
    ask: options.clarifyReply,
    markInterleaved: true,
  };
}

/**
 * 确定性跨类多意图守卫：防止模型把「查进度/报单 + 顺便写文案/给复盘建议」压缩成单软岗放行。
 * 纯软岗单句（例如「写两句今天下午到店客人可用的接待欢迎话术草稿」）不含店务动作/查账子句，不受影响。
 */
export function hasCrossDomainStoreAndSoftRole(rawText: string, businessDay: string): boolean {
  const c = classifyIntent(rawText, { businessDay });
  if (c.reason === 'multi-intent' && c.intents.some(isStoreIntent) && c.intents.includes('marketing')) {
    return true;
  }
  if (hasSoftRoleWords(rawText) && c.intents.some(isStoreIntent) && !c.intents.includes('marketing')) {
    const tail = compoundTail(rawText);
    const head = compoundHead(rawText);
    if (tail && head !== rawText) return true;
  }
  return false;
}

export function triageAuditOf(decision: TriageDecision, mode: TriageMode): TriageAuditInfo {
  const finalIntent = decision.kind === 'read_query'
    ? `query:${decision.spec.kind}`
    : decision.kind === 'store_write'
      ? `write:${decision.writeKind}`
      : decision.kind === 'clarify'
        ? `clarify:${decision.reason}`
        : decision.kind;
  return {
    triageVersion: mode === 'legacy' ? 'legacy' : TRIAGE_VERSION,
    routeLayer: decision.source,
    finalIntent,
    ...(decision.kind === 'soft_role' ? { softRole: decision.softRole } : {}),
  };
}
