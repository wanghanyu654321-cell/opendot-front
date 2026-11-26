import type { ModelClassification, ModelEntryMode } from './model-classify.js';
import { isReadOnlyQuery } from './model-classify.js';
import {
  extractScopeConstraints,
  hasUnsupportedHistoricalPeriod,
  isIdentityScopeQuery,
  isSelfProgressQuery,
  isStorePerfQuery,
  isUnsupportedHistoricalPeriodSlot,
  labelledStoreTargets,
  missingReportsCommand,
  otherProgressCommand,
  otherStoreShortNames,
  parseAppointmentReadQuery,
  parseSelfAndStoreQuery,
  storeRankingCommand,
  type AppointmentReadSpec,
} from './scope-refusal.js';

/**
 * 纯 Core 只读查询中间表示（IR）：零数据库、零 SDK、零网络依赖。
 * 规则解析器（parseRuleReadQuery）与模型适配层（fromModelReadQuery）必须共同产出此结构体，
 * 交由员工循环中唯一的执行器（executeReadQuery）完成权限裁决与只读查询，消除“两套解释”。
 */
export type AppointmentDay = NonNullable<AppointmentReadSpec['day']>;

export type ReadQuerySpec =
  | { readonly kind: 'identity'; readonly source: 'rule' | 'model' }
  | { readonly kind: 'historical_unsupported'; readonly source: 'rule' | 'model' }
  | { readonly kind: 'unsupported'; readonly source: 'rule' | 'model' }
  | { readonly kind: 'denied_scope'; readonly source: 'rule' | 'model' }
  | {
      readonly kind: 'clarify_query';
      readonly reason: 'appointment_missing_scope';
      readonly message: string;
      readonly source: 'rule' | 'model';
    }
  | {
      readonly kind: 'self_progress';
      readonly source: 'rule' | 'model';
      readonly wantsTarget: boolean;
    }
  | {
      readonly kind: 'other_progress';
      readonly source: 'rule' | 'model';
      readonly employee: string;
      readonly wantsTarget: boolean;
      readonly strictCommand?: boolean;
    }
  | {
      readonly kind: 'store_summary';
      readonly source: 'rule' | 'model';
      readonly store?: string;
      readonly wantsTarget: boolean;
      readonly mentionsReturningCustomer?: boolean;
      readonly ownStoreOnly?: boolean;
      readonly excludedOtherStores?: readonly string[];
    }
  | {
      readonly kind: 'self_and_summary';
      readonly source: 'rule' | 'model';
      readonly store?: string;
      readonly wantsTarget: boolean;
      readonly ownStoreOnly?: boolean;
      readonly excludedOtherStores?: readonly string[];
    }
  | {
      readonly kind: 'unreported';
      readonly source: 'rule' | 'model';
      readonly store?: string;
      readonly ownStoreOnly?: boolean;
      readonly excludedOtherStores?: readonly string[];
      readonly strictCommand?: boolean;
    }
  | {
      readonly kind: 'ranking';
      readonly source: 'rule' | 'model';
      readonly store?: string;
      readonly employeeRanking?: boolean;
      readonly ownStoreOnly?: boolean;
      readonly onlyAuthorized?: boolean;
      readonly excludedOtherStores?: readonly string[];
      readonly strictCommand?: boolean;
    }
  | {
      readonly kind: 'appointment';
      readonly source: 'rule' | 'model';
      readonly scope: 'own' | 'store' | 'other';
      readonly day?: AppointmentDay;
      readonly target?: string;
      readonly detailMode: 'count' | 'list';
      readonly explicitStoreWide?: boolean;
    }
  | {
      readonly kind: 'entry_result';
      readonly source: 'rule' | 'model';
      readonly mode: ModelEntryMode;
      readonly ref?: string;
    };

const flatOf = (text: string) => text.normalize('NFKC').replace(/\s+/g, '');

const WRITE_OR_SOFT_BLOCK = /(?:报单|报数|记账|改账|设目标|定目标|改目标|撤回|撤销|作废|确认入账|文案|小红书|朋友圈|海报|话术|复盘|带教|演练|课件|投流|美团|大众点评)/;

const TARGET_METRIC_HINT = /目标|完成率|差额|差距|还差/;
const RETURNING_CUSTOMER_HINT = /老客户|老顾客|老客(?:消费|业绩|明细|占比)?/;

const NON_PERSON_TARGET = /^(?:我|本人|自己|我们|大家|所有人|全部人|本店|全店|门店|我们店|店里|老客|老客户|老顾客|老板|小计|小红书|小红|小程序|今天|今日|本月|这个月|这月|上个月|上月|昨天|明天|后天|预约|入账|操作|系统|当前|目前|这里|这个|那个|最近|最新|业绩|进度|汇总|排名|目标|名单|员工|同事)$/;

/** 剥离题号、自称与显式否定写动作外框，保留正向查询与范围约束原文。 */
function stripReadFraming(text: string): string {
  const negWriteAtom = '(?:我)?(?:先|暂)?(?:不是补报|不是补录|不是报单|不是要报业绩|不(?:要|用|想)?(?:报单|报数|创建门店|改权限|扩权|预约|改账|改目标|设目标|定目标|调目标|发布|登记|改单|入账|改排班|外发|发给客户))';
  const trailingAtom = `(?:${negWriteAtom}|查不到就直接说|没有就直接说)`;
  return text
    .normalize('NFKC')
    .trim()
    .replace(/^[A-Za-z]+-[A-Za-z]*\d+\s*:\s*/, '')
    .replace(/^我(?:现在)?自称[^。！？!?\n]+[。！？!?]\s*/, '')
    .replace(/^只读(?:查询|核对)\s*:?\s*/, '')
    .replace(
      new RegExp(`^${negWriteAtom}(?:(?:[、，,\\s]*也?|[、，,\\s]+)${negWriteAtom})*[，,。；;\\s]+(?=\\S)`),
      '',
    )
    .replace(
      new RegExp(`[?？。;；，,]\\s*${trailingAtom}(?:(?:[、，,\\s]*也?|[、，,\\s]+)${trailingAtom})*[。.!！?？]*$`),
      '',
    )
    .replace(/[?？。;；]+$/, '')
    .trim();
}

function isAppointmentQueryClarification(text: string): boolean {
  const flat = flatOf(text);
  if (!/(?:预约查询|查预约|看预约)/.test(flat)) return false;
  if (/\d{1,2}[:：点时号日月]|\d{2,}/.test(flat)) return false;
  return /(?:刚才|刚刚|前面|本来)?问的是.{0,6}(?:预约查询|查预约|看预约)/.test(flat)
    || /^(?:我)?(?:只(?:是|想)问|是要问|想问)(?:预约查询|查预约)/.test(flat)
    || (/不是(?:要|来)?报(?:业绩|单|数)/.test(flat) && /(?:预约查询|查预约|看预约)/.test(flat));
}

function extractEntryRef(text: string): string | undefined {
  const normalized = text.normalize('NFKC').trim();
  const cmd = /^入账结果\s+(\S+)$/.exec(normalized);
  if (cmd?.[1]) return cmd[1];
  const labelled = /(?:操作号|单号|编号|草稿号|流水号|ID)\s*[:：]?\s*([A-Za-z0-9][A-Za-z0-9_.:-]{2,63})/i.exec(normalized);
  if (labelled?.[1]) return labelled[1];
  const token = /(?:^|[\s「『“"'（(里中有没查])([A-Za-z][A-Za-z0-9]*(?:[-_][A-Za-z0-9]+)+|[0-9a-f]{16,64})(?=$|[\s」』”"'）)，,。；;？?这那])/i.exec(normalized);
  return token?.[1];
}

export function parseEntryResultReadQuery(text: string): Extract<ReadQuerySpec, { kind: 'entry_result' }> | null {
  const normalized = text.normalize('NFKC').trim();
  const stripped = stripReadFraming(normalized);
  const exact = /^入账结果(?:\s+(\S+))?$/.exec(stripped);
  if (exact) {
    return exact[1]
      ? { kind: 'entry_result', mode: 'by_ref', ref: exact[1], source: 'rule' }
      : { kind: 'entry_result', mode: 'latest_operation', source: 'rule' };
  }
  const flat = flatOf(stripped);
  if (/(?:改账|撤回|撤销|作废|设目标|预约|文案|小红书|朋友圈|海报|复盘)/.test(flat)) return null;
  if (!/(?:入账结果|入账记录|操作结果|已入账|入账了[吗没么]?|入账成功|最近一笔入账|最新一笔入账|最近入账)/.test(flat)) {
    return null;
  }
  const ref = extractEntryRef(normalized);
  if (ref) {
    return { kind: 'entry_result', mode: 'by_ref', ref, source: 'rule' };
  }
  if (/\d+(?:\.\d+)?\s*(?:元|块|[kKwW千万])|\d{2,}/.test(flat)) return null;
  if (/(?:全店|本店|各店|门店汇总|所有人|大家)/.test(flat)) return null;
  if (/(?:操作结果|草稿结果|最近一次操作|最新操作)/.test(flat)) {
    return { kind: 'entry_result', mode: 'latest_operation', source: 'rule' };
  }
  if (/(?:最近|最新|最后)(?:一[笔条]|的)?(?:已)?入账|已入账(?:的)?(?:最近|最新|最后|结果|记录)|入账结果/.test(flat)) {
    return { kind: 'entry_result', mode: 'latest_confirmed', source: 'rule' };
  }
  return null;
}

function normalizeStoreCandidate(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const cleaned = raw
    .normalize('NFKC')
    .trim()
    .replace(/^(?:(?:我|本人)?(?:已|获|被)?授权(?:访问|查看|管理)?的?|当前|现在|今天|今日|本月|这个月|这月|我们|咱们)+/, '')
    .replace(/(?:的|里|里面|中|内)+$/, '')
    .trim();
  if (!cleaned) return undefined;
  if (/^(?:本店|全店|我们店|咱们店|咱店|门店|各店|各门店|所有门店|全部门店|已授权门店|获授权门店|授权门店|店里)$/.test(cleaned)) {
    return undefined;
  }
  return cleaned;
}

function parseUnreportedQuery(
  positive: string,
  constraints: ReturnType<typeof extractScopeConstraints>,
  explicitRead: boolean,
): Extract<ReadQuerySpec, { kind: 'unreported' }> | null {
  const exact = missingReportsCommand.exec(positive.trim());
  if (exact) {
    const store = normalizeStoreCandidate(exact[1]);
    return {
      kind: 'unreported',
      source: 'rule',
      strictCommand: true,
      ...(store ? { store } : {}),
      ...(constraints.ownStoreOnly ? { ownStoreOnly: true } : {}),
      ...(constraints.excludedOtherStores.length ? { excludedOtherStores: constraints.excludedOtherStores } : {}),
    };
  }
  const flat = flatOf(positive);
  if (WRITE_OR_SOFT_BLOCK.test(flat) || /预约/.test(flat)) return null;
  if (/\d{2,}|\d+(?:\.\d+)?[kKwW千万元块]/.test(flat)) return null;
  const unreportedCue = /(?:谁(?:还|目前)?没(?:有)?报|还有谁没(?:有)?报|(?:今天|今日)?(?:还)?没(?:有)?报(?:单|数|业绩)?的(?:人|员工|同事|成员|名单)|未报(?:单|数|业绩)?(?:的)?(?:人|员工|同事|成员|名单))/;
  if (!unreportedCue.test(flat)) return null;
  const withoutLead = positive
    .replace(/^(?:请)?(?:帮我|给我)?(?:只(?:想|是|要)?)?(?:查询|查看|查查|看看|查一下|看一下|看下|查|看|列出|列一下)\s*/, '')
    .trim();
  const storeMatch = /^(?:(?:[\p{Script=Han}]{1,12}的)?门店\s*)?([\w.-]+(?!店)|(?:(?!店|和|与|及|今|谁|还|没|未)[\p{Script=Han}A-Za-z0-9]){1,20}店)\s*(?:的|里|里面|中|内)?(?:今天|今日|目前|还|谁|没|未)/u.exec(withoutLead);
  const store = normalizeStoreCandidate(storeMatch?.[1]) ?? otherStoreShortNames(positive, '')[0];
  return {
    kind: 'unreported',
    source: 'rule',
    ...(explicitRead ? { strictCommand: true } : {}),
    ...(store ? { store } : {}),
    ...(constraints.ownStoreOnly ? { ownStoreOnly: true } : {}),
    ...(constraints.excludedOtherStores.length ? { excludedOtherStores: constraints.excludedOtherStores } : {}),
  };
}

function parseRankingQuery(
  positive: string,
  constraints: ReturnType<typeof extractScopeConstraints>,
  explicitRead: boolean,
): Extract<ReadQuerySpec, { kind: 'ranking' }> | null {
  const flat = flatOf(positive);
  if (storeRankingCommand.test(flat)) {
    return {
      kind: 'ranking',
      source: 'rule',
      strictCommand: true,
      ...(constraints.ownStoreOnly ? { ownStoreOnly: true } : {}),
      ...(constraints.onlyAuthorized ? { onlyAuthorized: true } : {}),
      ...(constraints.excludedOtherStores.length ? { excludedOtherStores: constraints.excludedOtherStores } : {}),
    };
  }
  if (WRITE_OR_SOFT_BLOCK.test(flat) || /预约/.test(flat)) return null;
  if (/\d{2,}|\d+(?:\.\d+)?[kKwW千万元块]/.test(flat)) return null;
  if (!/(?:排名|排行)/.test(flat)) return null;
  if (!/(?:店|员工|店员|顾问)/.test(flat)) return null;
  const employeeRanking = /(?:店内)?(?:员工|店员|顾问|个人)(?:业绩)?(?:排名|排行)/.test(flat);
  const body = positive
    .replace(/^(?:请)?(?:把|将)?(?:帮我|给我)?(?:只(?:想|是|要)?)?(?:查询|查看|查查|看看|查一下|看一下|看下|查|看|拉一下|列出)?\s*/, '')
    .replace(/(?:给我|帮我)?(?:看看|看一下|看下|查一下|查查看|发来|发我|拉出来|列出来|是多少|怎么样|排第几)[?？。！!]*$/, '')
    .trim();
  const storeMatch = /(?:(?:我|本人)?(?:已|获|被)?授权(?:访问|查看|管理)?的?)?(?:门店\s*)?([\w.-]+(?!店)|(?:(?!店|和|与|及|的|把|将|看|查|给|在)[\p{Script=Han}A-Za-z0-9]){1,20}店)/u.exec(body);
  const store = normalizeStoreCandidate(storeMatch?.[1]) ?? otherStoreShortNames(positive, '')[0];
  return {
    kind: 'ranking',
    source: 'rule',
    ...(explicitRead ? { strictCommand: true } : {}),
    ...(store ? { store } : {}),
    ...(employeeRanking ? { employeeRanking: true } : {}),
    ...(constraints.ownStoreOnly ? { ownStoreOnly: true } : {}),
    ...(constraints.onlyAuthorized ? { onlyAuthorized: true } : {}),
    ...(constraints.excludedOtherStores.length ? { excludedOtherStores: constraints.excludedOtherStores } : {}),
  };
}

function parseReturningCustomerSummaryQuery(
  positive: string,
  constraints: ReturnType<typeof extractScopeConstraints>,
  wantsTarget: boolean,
): Extract<ReadQuerySpec, { kind: 'store_summary' }> | null {
  const flat = flatOf(positive);
  if (WRITE_OR_SOFT_BLOCK.test(flat) || /预约/.test(flat)) return null;
  if (/\d{2,}|\d+(?:\.\d+)?[kKwW千万元块]/.test(flat)) return null;
  if (!RETURNING_CUSTOMER_HINT.test(flat)) return null;
  if (!/(?:全店|本店|门店|我们店|[\p{Script=Han}A-Za-z0-9]{1,12}店)/u.test(flat)) return null;
  if (!/(?:小计|汇总|业绩|总额|收入|数据)/.test(flat)) return null;
  const withoutLead = positive
    .replace(/^(?:请)?(?:帮我|给我)?(?:只(?:想|是|要)?)?(?:查询|查看|查查|看看|查一下|看一下|看下|查|看)\s*/, '')
    .trim();
  const namedStore = /^((?:(?!店|和|与|及|老)[\p{Script=Han}A-Za-z0-9]){1,20}店)/u.exec(withoutLead);
  const store = normalizeStoreCandidate(namedStore?.[1]);
  return {
    kind: 'store_summary',
    source: 'rule',
    ...(store ? { store } : {}),
    wantsTarget,
    mentionsReturningCustomer: true,
    ...(constraints.ownStoreOnly ? { ownStoreOnly: true } : {}),
    ...(constraints.excludedOtherStores.length ? { excludedOtherStores: constraints.excludedOtherStores } : {}),
  };
}

function parseOtherProgressQuery(
  positive: string,
  wantsTarget: boolean,
): Extract<ReadQuerySpec, { kind: 'other_progress' }> | null {
  const strict = otherProgressCommand.exec(positive.trim());
  if (strict?.[1] && !NON_PERSON_TARGET.test(strict[1]) && !strict[1].endsWith('店')) {
    return {
      kind: 'other_progress',
      source: 'rule',
      employee: strict[1],
      wantsTarget,
      strictCommand: true,
    };
  }
  const flat = flatOf(positive);
  if (WRITE_OR_SOFT_BLOCK.test(flat) || /预约|老客|小计|全店|本店|门店|汇总|排名|排行|没报/.test(flat)) return null;
  if (/\d/.test(flat)) return null;
  const natural = /^(?:请)?(?:帮我|给我)?(?:只(?:想|是|要)?)?(?:查询|查看|查查|看看|查一下|看一下|看下|查|看)(?:一?下)?([\u4e00-\u9fa5]{2,4}?)(?:的)?(?:今天|今日|本月|这个月|这月)?(?:的)?(?:个人)?(?:业绩(?:进度)?|进度|目标|完成率|已完成金额|做了多少|干了多少|报了多少)(?:是多少|多少|怎样|怎么样)?[?？。！!]*$/.exec(flat);
  const candidate = natural?.[1];
  if (!candidate || NON_PERSON_TARGET.test(candidate) || candidate.endsWith('店')) return null;
  if (/^(?:一下|今天|今日|本月|这个|那个|我的|本人|自己|同事|员工)/.test(candidate)) return null;
  return {
    kind: 'other_progress',
    source: 'rule',
    employee: candidate,
    wantsTarget,
  };
}

/** 规则层统一只读查询解析：产出标准 ReadQuerySpec。 */
export function parseRuleReadQuery(text: string, businessDay?: string): ReadQuerySpec | undefined {
  const request = stripReadFraming(text);
  const constraints = extractScopeConstraints(request);
  const positive = constraints.positiveText;
  const flatPos = flatOf(positive);

  // 0. 预约只读查询（优先于 meta 澄清与门店汇总）
  const appt = parseAppointmentReadQuery(text) ?? parseAppointmentReadQuery(positive);
  if (appt) {
    return {
      kind: 'appointment',
      source: 'rule',
      scope: appt.scope,
      ...(appt.day ? { day: appt.day } : {}),
      ...(appt.target ? { target: appt.target } : {}),
      detailMode: appt.countOnly ? 'count' : 'list',
      ...(appt.explicitStoreWide ? { explicitStoreWide: true } : {}),
    };
  }

  // 0b. 明确澄清「我刚才问的是预约查询，不是要报业绩」（无日期/范围时直接短澄清，零追问、零草稿）
  if (isAppointmentQueryClarification(text)) {
    return {
      kind: 'clarify_query',
      reason: 'appointment_missing_scope',
      message: 'Front Claw：好的，不报业绩，也没有写入任何账目。请说明要查哪天的本人预约，例如「查我今天的预约」或「我明天有几个预约」。',
      source: 'rule',
    };
  }

  // 1. 身份与授权门店查询
  if (isIdentityScopeQuery(positive)) return { kind: 'identity', source: 'rule' };

  // 2. 历史月份显式不支持
  if (
    hasUnsupportedHistoricalPeriod(positive, businessDay)
    && !/\d{2,}|\d+(?:\.\d+)?[kKwW千万元块]/.test(flatPos)
    && /(?:业绩|进度|汇总|完成率|目标|经营)/.test(flatPos)
    && !/(?:报单|报数|记账|改账|预约|设目标|定目标|改目标|撤回|确认入账|文案|小红书|朋友圈|海报)/.test(flatPos)
  ) {
    return { kind: 'historical_unsupported', source: 'rule' };
  }

  // 3. 入账结果 / 操作号查询（自然句 + 显式命令）
  const entryRead = parseEntryResultReadQuery(text);
  if (entryRead) return entryRead;

  const wantsTarget = TARGET_METRIC_HINT.test(flatPos);
  const explicitRead = /^(?:[A-Za-z]+-[A-Za-z]*\d+[：:]\s*)?只读(?:查询|核对)/.test(text.trim());

  // 4. 未报名单（自然句 + 显式命令）
  const unreportedRead = parseUnreportedQuery(positive, constraints, explicitRead);
  if (unreportedRead) return unreportedRead;

  // 5. 门店排名（自然句 + 显式命令）
  const rankingRead = parseRankingQuery(positive, constraints, explicitRead);
  if (rankingRead) return rankingRead;

  // 6. 本人 + 本店双段查询
  const selfAndStore = parseSelfAndStoreQuery(positive);
  if (selfAndStore) {
    return {
      kind: 'self_and_summary',
      source: 'rule',
      ...(selfAndStore.store ? { store: selfAndStore.store } : {}),
      wantsTarget,
      ...(constraints.ownStoreOnly ? { ownStoreOnly: true } : {}),
      ...(constraints.excludedOtherStores.length ? { excludedOtherStores: constraints.excludedOtherStores } : {}),
    };
  }

  // 7. 本店老客消费 + 全店业绩小计复合查询
  const returningSummary = parseReturningCustomerSummaryQuery(positive, constraints, wantsTarget);
  if (returningSummary) return returningSummary;

  // 8. 本人业绩 / 目标 / 完成率 / 差额查询（含条件式目标/差额读，允许条件提及「或是0」，但严拒赋值动词或金额写目标）
  const isConditionalSelfTargetRead = ((): boolean => {
    if (!/目标/.test(flatPos)) return false;
    if (!/(?:我|本人|自己)/.test(flatPos) || /(?:本店|全店|门店|我们店|他|她|同事|全员)/.test(flatPos)) return false;
    if (/(?:报单|报数|记账|改账|预约|撤回|撤销|作废|确认入账|文案|小红书|朋友圈|海报|话术|复盘)/.test(flatPos)) return false;
    // 含写目标赋值动作（如「如果没设就帮我设成一万」「帮我定成0」）或正金额数字绝不归为只读！
    if (/(?:帮我|给我|替我|帮|给|替)(?:定|设|改|调|设置|设定)|(?:定|设|改|调|设置|设定)(?:成|为|到|一个|新)|[1-9]\d*(?:\.\d+)?\s*(?:元|块|[kKwW千万])|[1-9]\d{2,}|[一二两三四五六七八九十百千万]+[元块万千]/.test(flatPos)) {
      return false;
    }
    // 除条件判零（如「是0/为0/等于0/或是0」）外的其他阿拉伯数字同样拒绝
    const withoutConditionalZero = flatPos.replace(/(?:或是|还是|是|为|等于)0(?=$|[^\d])/g, '');
    if (/\d/.test(withoutConditionalZero)) return false;
    const hasUnsetCondition = /(?:还没设|未设置|未设定|未设|没有设|没设|有没有设|设了没|是否设|如果|要是|若)/.test(flatPos);
    const hasReadGoal = /(?:差额|差距|还差|完成率|已完成|进度|口径|说清楚|告诉我|说明|就说|提示|告知|查|看|多少)/.test(flatPos);
    return hasUnsetCondition && hasReadGoal;
  })();
  if (
    isConditionalSelfTargetRead
    || isSelfProgressQuery(positive)
    || /^我(?:本月|今天)?的?(?:个人)?(?:业绩(?:进度)?|进度)(?:是多少|多少)?$/.test(positive)
  ) {
    return { kind: 'self_progress', source: 'rule', wantsTarget: wantsTarget || isConditionalSelfTargetRead };
  }

  // 9. 本店 / 点名门店汇总与目标查询
  const query = positive.replace(/^(?:请|帮我|给我)?(?:只(?:想|是|要)?)?(?:查一下|查询|查看|核对|看看|查|看)\s*/, '');
  const named = /^(?:(?:[\p{Script=Han}]{1,12}的)?门店\s*)?([\w.-]+(?!店)|(?:(?!店|和|与|及)[\p{Script=Han}A-Za-z0-9]){1,20}店)\s*的?\s*(?:本月|这个月|这月|今日|今天)?(?:全店的?)?(?:业绩(?:汇总|小计)?|汇总|小计|进度|目标|完成率|差额)(?:是多少|多少)?$/u.exec(query);
  const command = /^(?:经营汇总|门店汇总|本店汇总|本月汇总)(?:\s+([^\s]+))?$/.exec(positive);
  if (isStorePerfQuery(positive) && !command?.[1]) {
    return {
      kind: 'store_summary',
      source: 'rule',
      wantsTarget,
      ...(constraints.ownStoreOnly ? { ownStoreOnly: true } : {}),
      ...(constraints.excludedOtherStores.length ? { excludedOtherStores: constraints.excludedOtherStores } : {}),
    };
  }
  if (named) {
    const store = normalizeStoreCandidate(named[1]);
    return {
      kind: 'store_summary',
      source: 'rule',
      ...(store ? { store } : {}),
      wantsTarget,
      ...(constraints.ownStoreOnly ? { ownStoreOnly: true } : {}),
      ...(constraints.excludedOtherStores.length ? { excludedOtherStores: constraints.excludedOtherStores } : {}),
    };
  }
  if (command) {
    const store = normalizeStoreCandidate(command[1]);
    return {
      kind: 'store_summary',
      source: 'rule',
      ...(store ? { store } : {}),
      wantsTarget,
      ...(constraints.ownStoreOnly ? { ownStoreOnly: true } : {}),
      ...(constraints.excludedOtherStores.length ? { excludedOtherStores: constraints.excludedOtherStores } : {}),
    };
  }
  if (
    /^(?:(?:我(?:想|要))?(?:看|查|核对)|门店|分店)/.test(positive)
    && /业绩|经营情况/.test(positive)
    && !/报单|报数|记账|改账|预约|设目标|撤回|确认入账/.test(positive)
  ) {
    const targets = labelledStoreTargets(positive);
    if (!targets || targets.length > 1) return { kind: 'unsupported', source: 'rule' };
    if (targets[0]) {
      return {
        kind: 'store_summary',
        source: 'rule',
        store: targets[0],
        wantsTarget,
        ...(constraints.ownStoreOnly ? { ownStoreOnly: true } : {}),
        ...(constraints.excludedOtherStores.length ? { excludedOtherStores: constraints.excludedOtherStores } : {}),
      };
    }
  }

  // 10. 指定员工 / 同名本人进度查询
  const otherProg = parseOtherProgressQuery(positive, wantsTarget);
  if (otherProg) return otherProg;

  // 11. 显式「只读查询/只读核对」但未命中已支持只读项
  if (/^(?:[A-Za-z]+-[A-Za-z]*\d+[：:]\s*)?只读(?:查询|核对)/.test(text.trim())) {
    return { kind: 'unsupported', source: 'rule' };
  }
  return undefined;
}

/**
 * 模型分类结果到统一 ReadQuerySpec 的纯适配转换：
 * - 不再拼装字符串重写命令，完整保留范围、日期、数量/明细、单号与原文门店约束；
 * - 原文显式点名门店与模型 slots.store 冲突或遗漏时，由原文约束兜底。
 */
export function fromModelReadQuery(
  c: ModelClassification,
  text: string,
  businessDay: string,
): ReadQuerySpec | undefined {
  if (!isReadOnlyQuery(c)) return undefined;
  const object = c.object;
  if (!object) return undefined;

  const constraints = extractScopeConstraints(text);
  const positive = constraints.positiveText;
  const flatText = flatOf(positive);

  if (object !== 'appointment' && (isUnsupportedHistoricalPeriodSlot(c.slots.period, businessDay) || hasUnsupportedHistoricalPeriod(positive, businessDay))) {
    return { kind: 'historical_unsupported', source: 'model' };
  }

  const explicit = labelledStoreTargets(positive);
  if (!explicit || explicit.length > 1 || (explicit[0] && c.slots.store && explicit[0] !== c.slots.store)) {
    return { kind: 'denied_scope', source: 'model' };
  }
  const shortStores = otherStoreShortNames(positive, '');
  const positiveBody = positive.replace(
    /^(?:请|麻烦|帮我|给我)?(?:只(?:想|是|要)?)?(?:查一下|查询|查看|核对|看看|拉一下|拉下|拉出|问一下|问下|统计|想了解|了解|查|看|拉)\s*/,
    '',
  );
  const namedInTextMatch = /(?:^|[\s，,；;和与及的下看查拉])((?:(?!店|和|与|及|的|把|将|看|查|给|在|本|全|门|我|咱|这|该|想|了|解|麻|烦|拉|下|问|统|计|列|出|找|有|没|是|要|能|会|去|到|来|进)[\p{Script=Han}A-Za-z0-9]){1,16}店)(?!里|内|中|长|员|务|铺|面|外)/u.exec(positiveBody);
  const namedInText = normalizeStoreCandidate(namedInTextMatch?.[1]);
  const normalizedSlotStore = normalizeStoreCandidate(c.slots.store);
  const named = explicit[0] ?? normalizedSlotStore ?? shortStores[0] ?? namedInText;
  const storesCompatible = (slotStore: string, textStore: string): boolean => {
    const s = slotStore.toLowerCase().replace(/^测试/, '');
    const t = textStore.toLowerCase().replace(/^测试/, '');
    return s.includes(t) || t.includes(s);
  };
  if (
    explicit[0] === undefined
    && normalizedSlotStore
    && (
      shortStores.some((short) => !storesCompatible(normalizedSlotStore, short))
      || (namedInText && !storesCompatible(normalizedSlotStore, namedInText))
    )
  ) {
    return { kind: 'denied_scope', source: 'model' };
  }
  const wantsTarget = object === 'target' || object === 'completion' || TARGET_METRIC_HINT.test(flatText);

  if (object === 'identity') {
    return { kind: 'identity', source: 'model' };
  }

  if (object === 'unreported') {
    return {
      kind: 'unreported',
      source: 'model',
      ...(named ? { store: named } : {}),
      ...(constraints.ownStoreOnly ? { ownStoreOnly: true } : {}),
      ...(constraints.excludedOtherStores.length ? { excludedOtherStores: constraints.excludedOtherStores } : {}),
    };
  }

  if (object === 'ranking') {
    const employeeRanking = /(?:店内)?(?:员工|店员|顾问|个人)(?:业绩)?(?:排名|排行)/.test(flatText);
    return {
      kind: 'ranking',
      source: 'model',
      ...(named ? { store: named } : {}),
      ...(employeeRanking ? { employeeRanking: true } : {}),
      ...(constraints.ownStoreOnly ? { ownStoreOnly: true } : {}),
      ...(constraints.onlyAuthorized ? { onlyAuthorized: true } : {}),
      ...(constraints.excludedOtherStores.length ? { excludedOtherStores: constraints.excludedOtherStores } : {}),
    };
  }

  if (object === 'self_and_summary') {
    return {
      kind: 'self_and_summary',
      source: 'model',
      ...(named ? { store: named } : {}),
      wantsTarget,
      ...(constraints.ownStoreOnly ? { ownStoreOnly: true } : {}),
      ...(constraints.excludedOtherStores.length ? { excludedOtherStores: constraints.excludedOtherStores } : {}),
    };
  }

  if (object === 'entry') {
    const ref = c.slots.ref ?? extractEntryRef(text);
    const mode: ModelEntryMode = ref
      ? 'by_ref'
      : c.slots.entryMode
        ?? (/(?:操作结果|草稿结果|最近一次操作|最新操作)/.test(flatText) ? 'latest_operation' : 'latest_confirmed');
    return {
      kind: 'entry_result',
      source: 'model',
      mode,
      ...(ref ? { ref } : {}),
    };
  }

  if (object === 'appointment') {
    const ruleAppt = parseAppointmentReadQuery(text) ?? parseAppointmentReadQuery(positive);
    if (ruleAppt) {
      const forceStore = ruleAppt.scope !== 'other' && c.slots.scope === 'store';
      return {
        kind: 'appointment',
        source: 'model',
        scope: forceStore ? 'store' : ruleAppt.scope,
        ...(ruleAppt.day ? { day: ruleAppt.day } : {}),
        ...(ruleAppt.target ? { target: ruleAppt.target } : {}),
        detailMode: c.slots.countOnly === true || ruleAppt.countOnly ? 'count' : 'list',
        ...(forceStore || ruleAppt.explicitStoreWide ? { explicitStoreWide: true } : {}),
      };
    }
    const periodFlat = flatOf(c.slots.period ?? '');
    const day: AppointmentDay | undefined = /(?<!大)后天/.test(flatText) || /(?<!大)后天/.test(periodFlat)
      ? 'day_after_tomorrow'
      : /明天|明日/.test(flatText) || /明天|明日/.test(periodFlat)
        ? 'tomorrow'
        : ((/今天|今日/.test(flatText) && !/今天及以后/.test(flatText)) || /今天|今日/.test(periodFlat)
          ? 'today'
          : undefined);
    const detailMode: 'count' | 'list' = c.slots.countOnly === true
      || /(?:有几[个条笔]|一共几[个条笔]|总共几[个条笔]|共有?几[个条笔]|多少[个条笔]?|几[个条笔]|数量|条数|个数|只(?:问|看|要|查)(?:数量|条数|个数))/.test(flatText)
      ? 'count'
      : 'list';
    const otherShorts = otherStoreShortNames(positive, '');
    if (named) {
      return {
        kind: 'appointment',
        source: 'model',
        scope: 'other',
        target: named,
        ...(day ? { day } : {}),
        detailMode,
      };
    }
    if (otherShorts.length > 0) {
      return {
        kind: 'appointment',
        source: 'model',
        scope: 'other',
        target: otherShorts[0]!,
        ...(day ? { day } : {}),
        detailMode,
      };
    }
    if (c.slots.employee && !/^(?:我|本人|自己)$/.test(c.slots.employee)) {
      return {
        kind: 'appointment',
        source: 'model',
        scope: 'other',
        target: c.slots.employee,
        ...(day ? { day } : {}),
        detailMode,
      };
    }
    const explicitStoreWide = c.slots.scope === 'store'
      || (c.slots.scope !== 'self' && /(?:本店|全店|门店|店里|全体|全员|全部|所有|大家)/.test(flatText) && !/(?:我|本人|自己|名下)/.test(flatText));
    return {
      kind: 'appointment',
      source: 'model',
      scope: explicitStoreWide ? 'store' : 'own',
      ...(day ? { day } : {}),
      detailMode,
      ...(explicitStoreWide ? { explicitStoreWide: true } : {}),
    };
  }

  // progress / performance / summary / target / completion
  if (named !== undefined) {
    return {
      kind: 'store_summary',
      source: 'model',
      store: named,
      wantsTarget,
      ...(RETURNING_CUSTOMER_HINT.test(flatText) ? { mentionsReturningCustomer: true } : {}),
      ...(constraints.ownStoreOnly ? { ownStoreOnly: true } : {}),
      ...(constraints.excludedOtherStores.length ? { excludedOtherStores: constraints.excludedOtherStores } : {}),
    };
  }

  if (c.slots.employee && !/^(?:我|本人|自己)$/.test(c.slots.employee) && !NON_PERSON_TARGET.test(c.slots.employee)) {
    return {
      kind: 'other_progress',
      source: 'model',
      employee: c.slots.employee,
      wantsTarget,
    };
  }
  // 原文明确点名同事查个人业绩而模型粗分成了 summary/progress 且省略 employee 时，保留精确同事目标。
  const explicitOther = parseOtherProgressQuery(positive, wantsTarget);
  if (explicitOther) {
    return { ...explicitOther, source: 'model' };
  }

  if (c.slots.scope === 'store' && object !== 'progress') {
    return {
      kind: 'store_summary',
      source: 'model',
      wantsTarget,
      ...(RETURNING_CUSTOMER_HINT.test(flatText) ? { mentionsReturningCustomer: true } : {}),
      ...(constraints.ownStoreOnly ? { ownStoreOnly: true } : {}),
      ...(constraints.excludedOtherStores.length ? { excludedOtherStores: constraints.excludedOtherStores } : {}),
    };
  }

  const wantsSelfScope = c.slots.scope === 'self'
    || (c.slots.scope !== 'store' && /(?:我|本人|自己)/.test(flatText) && !/(?:本店|全店|门店|店里|我们店)/.test(flatText));
  if (object === 'progress' || (wantsSelfScope && (object === 'target' || object === 'completion' || object === 'performance'))) {
    return { kind: 'self_progress', source: 'model', wantsTarget };
  }

  return {
    kind: 'store_summary',
    source: 'model',
    wantsTarget,
    ...(RETURNING_CUSTOMER_HINT.test(flatText) ? { mentionsReturningCustomer: true } : {}),
    ...(constraints.ownStoreOnly ? { ownStoreOnly: true } : {}),
    ...(constraints.excludedOtherStores.length ? { excludedOtherStores: constraints.excludedOtherStores } : {}),
  };
}
