import { capturePendingArrival } from './pending-order.js';
import { createHash } from 'node:crypto';
import { businessDate, DEFAULT_BUSINESS_CUTOFF, DEFAULT_TIME_ZONE } from './metrics.js';
import { classifyWithSemantic, decideRoute, hasSoftRoleWords, isStoreIntent, oralProjectReportLine, type Classification, type RouteDecision, type SemanticClassifier } from './intent-router.js';
import { createRequestBudget, type TerminalState, type WorkResult } from './request-budget.js';
import { createRouteLog, type RouteLogRecord } from './route-log.js';
import type { EmployeeMessage, EmployeeLoopResult, PreflightReply } from './employee-loop.js';
import type { HandleResult, WecomBotHandlerOptions } from './wecom-bot-unified-handler.js';
import { readPolicy, standing, type Capability } from './access-policy.js';
import { checkGateNow } from './commit-gate.js';
import { ACCESS_DENIED, REPORT_HINT, appointmentAskKey, appointmentTimeAskKey, isExplicitConfirmCommand } from './employee-loop.js';
import { parseAddNewChoice, parseAskManagerChoice, parseCorrectionPick, parseCorrectionCommand, parseTargetCommand } from './ledger-commands.js';
import { parseAppointmentRequest, parseStandaloneAppointmentTime } from './appointments.js';
import { extractReport, nonClosingReportReason } from './report-extract.js';
import { isStandardAmountLine } from './amount-guard.js';
import { parseLooseReport, parseReportText } from './report-parse.js';
import type { Person } from './performance-store.js';
import { isDeterministicStub } from './intent-classifier.js';
import {
  runModelClassifier, validateModelChain, isModelStub,
  createModelClassifier, loadModelRuntimeConfig,
  type ModelClassifier, type ModelClassification, type ModelRuntimeConfig,
} from './model-classify.js';

import { businessRead, courtesyReply, isManagedQueryPhrase, isSelfProgressQuery, isStorePerfQuery, NOT_TODAY_REPLY, otherStoreShortNames, pastDayReportPhrase, scopeRefusal } from './scope-refusal.js';
import { stripNegatedMakeupPhrases } from './standard-line.js';
import { textLevelImpurity } from './confirmable-draft-gate.js';

/** 营销能力端口：只有明确营销意图、enabled 且本人获 marketing 授权才调用；端口拿不到 store。 */
export interface MarketingPort {
  enabled: boolean;
  handle(input: { memberId: string; text: string; signal: AbortSignal; deadline: number }): Promise<string>;
}
export interface EmployeeRouterOptions {
  onObservation?: (record: MessageObservation & { requestId: string }) => void;
  /** 每请求统一截止时间，默认 15 秒。 */
  budgetMs?: number;
  /** 可选受限语义分类，默认不装配（=规则+澄清）。 */
  semantic?: SemanticClassifier;
  /**
   * R7 模型分类接口。默认关闭（确定性桩，不调真模型）。
   * 输出必须符合严格 schema，再过金额/权限/数据兜底校验链。
   * 不传时按 modelConfig / FC_MODEL_CONFIG 构造（配置切换桩/真模型，不改代码）。
   */
  modelClassify?: ModelClassifier;
  /** 模型运行配置或配置文件路径。也可用环境变量 FC_MODEL_CONFIG / FC_MODEL_MODE / FC_MODEL_TIMEOUT_MS。 */
  modelConfig?: string | Partial<ModelRuntimeConfig>;
  /** 模型调用超时（毫秒），超时走追问、不执行。默认取配置或 DEFAULT_MODEL_TIMEOUT_MS（8 秒）。 */
  modelClassifyTimeoutMs?: number;
  marketing?: MarketingPort;
  /**
   * OpenDot 桥接模式：当决策为 marketing 且本人具备 marketing 授权时，
   * 在完成 loop(input, '') 身份与挂起项预检及 marketingActor 复核后返回 pass: true、expiredReminder 与 actor，
   * 交由外层桥接器转交 OpenDot 原生 Agent（不再强制要求 router.marketing）。
   */
  passthroughMarketing?: boolean;
  onRoute?: (record: RouteLogRecord) => void;
}
export interface MessageObservation {
  route: '快通道' | '模型' | '追问'; gateReason: string; pendingSequence: string | null; modelMs: number; errorCategory: string;
}
export interface RoutedHandleResult extends HandleResult {
  requestId: string; state: TerminalState; target: RouteDecision['target']; duplicate: boolean;
  pass?: true;
  expiredReminder?: string;
  actor?: Person;
}

const F = 'Front Claw';
export const CHITCHAT_REPLY = `${F}：你好！我可以帮你报数（发标准清单）、查「我的进度」或「入账结果」。`;
export const CLARIFY_REPLY = `${F}：没太明白要办哪件事。报数请发标准清单，例如「11号测试A店\n380（小林）」；查进度发「我的进度」；需要营销文案请直接说明要写什么。没有写入任何账目。`;
export const MULTI_REPLY = `${F}：这条里有好几件事，请分开发，一次一件（例如先发报数清单，确认后再提营销文案）。没有写入任何账目。`;
export const MARKETING_UNAVAILABLE = `${F}：营销内容功能当前未开放，或你没有这项权限。这条没有处理，也没有写入任何账目。`;
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/**
 * M02 员工入口：分类 → 决策 → 交 M01 店务窄入口 / 闲聊 / 营销 / 澄清。
 * 外层统一截止、唯一终态、最终回复去重与分段日志。分类器与营销端口都不写库；写库只在 M01 入口。
 */
export function createEmployeeEntry(options: WecomBotHandlerOptions & { router?: EmployeeRouterOptions },
  loop: (input: EmployeeMessage, preflightReply?: PreflightReply) => Promise<EmployeeLoopResult>) {
  const router = { ...options.router };
  const passthroughMarketing = router.passthroughMarketing === true;
  type EntryWorkResult = WorkResult & { pass?: true; expiredReminder?: string; actor?: Person };
  type EntryTerminal = import('./request-budget.js').Terminal & { pass?: true; expiredReminder?: string; actor?: Person };
  const modelRuntime = router.modelClassify ? { mode: 'stub' as const, timeoutMs: 8000 } : loadModelRuntimeConfig(router.modelConfig);
  const modelClassifier = router.modelClassify ?? createModelClassifier(modelRuntime);
  const modelClassifyTimeoutMs = router.modelClassifyTimeoutMs ?? modelRuntime.timeoutMs;
  const budget = createRequestBudget({
    budgetMs: router.budgetMs,
    onLate: (requestId, outcome) => log.commit(requestId, { late: true, state: outcome.ok ? 'late-completed' : 'late-failed',
      ...(outcome.ok && outcome.result.operationId ? { operationId: outcome.result.operationId } : {}),
      ...(outcome.ok && outcome.result.ledgerSettled ? { ledgerSettled: true } : {}) }),
  });
  const log = createRouteLog(router.onRoute);
  let anonymous = 0;
  const cutoff = options.cutoff ?? DEFAULT_BUSINESS_CUTOFF;
  const timeZone = options.timeZone ?? DEFAULT_TIME_ZONE;

  /**
   * 营销授权。R1：策略模式下走与入账相同的入口门（策略版本/高水位、当前人员行、marketing 能力），
   * 生成前判一次、生成后发出前用生成前的身份快照再判一次（期间撤权/停用/调店 → 不发）。
   */
  async function marketingActor(memberId: string, expected?: Person): Promise<Person | null> {
    const person = await options.resolve(memberId);
    if (!person?.active || person.memberId !== memberId) return null;
    if (!(passthroughMarketing && options.accessPolicy === true)
        && !(Array.isArray(person.roles) && person.roles.includes('marketing'))) return null;
    const current = await options.store.getPersonByMember(memberId);
    if (!current || current.personId !== person.personId) return null;
    if (options.accessPolicy !== true) return current;
    const actor = expected ?? current;
    const gate = await checkGateNow(options.store, { actor, capability: 'marketing', storeIds: [actor.storeId], policyMode: true, platform: options.platformCapabilities, nowMs: () => options.now().getTime() });
    return gate.ok ? actor : null;
  }
  /** R1（M03-04）：缓存命中/重复到达时，按当前权限复核原回复依赖的能力。 */
  async function stillAllowed(memberId: string, access: NonNullable<WorkResult['access']>): Promise<boolean> {
    if (options.accessPolicy !== true) return true;
    const actor = await options.store.getPersonByMember(memberId);
    if (!actor) return false;
    if (access.identity) {
      const current = standing(await readPolicy(options.store), actor);
      if (!current.allowed || actor.personId !== access.identity.personId || current.version !== access.identity.policyVersion) return false;
    }
    const storeIds = access.storeIds.length ? access.storeIds : [actor.storeId];
    const policyVersion = access.additionalCapability ? standing(await readPolicy(options.store), actor).version ?? -1 : undefined;
    for (const capability of [access.capability, ...(access.additionalCapability ? [access.additionalCapability] : [])]) {
      if (!(await checkGateNow(options.store, { actor, capability, storeIds, policyVersion, policyMode: true, platform: options.platformCapabilities, nowMs: () => options.now().getTime() })).ok) return false;
    }
    return true;
  }

  /** R3：越权/跨店判定。身份按当前人员行；能力与入账门同一判定（非策略模式按档位：员工档无查他人/全店能力）。 */
  async function refusalFor(memberId: string, text: string, managedQuery = false): Promise<string | null> {
    const person = await options.resolve(memberId);
    if (!person?.active || person.memberId !== memberId) return null;
    const actor = await options.store.getPersonByMember(memberId);
    if (!actor || actor.personId !== person.personId) return null;
    // 策略缺失/损坏/无授权时不给「不能做」的细分原因（原流程按入口门统一拒绝或澄清）。
    if (options.accessPolicy === true && !(await checkGateNow(options.store, { actor, capability: null, storeIds: [actor.storeId], policyMode: true, platform: options.platformCapabilities, nowMs: () => options.now().getTime() })).ok) return null;
    if (managedQuery && !otherStoreShortNames(text, actor.storeName).length) return null;
    const people = await options.store.listPeople();
    if (managedQuery) {
      // 显式指定目录原名的管理查询仍由 M03 判定门店权限。
      const named = /^(?:经营汇总|门店汇总|本店汇总|本月汇总|(?:今天)?谁(?:还)?没报)\s+(\S+)$/.exec(text.trim())?.[1];
      if (named && people.some(p => p.storeName === named)) return null;
    }
    const allowed = async (capability: Capability, storeId: string) => options.accessPolicy === true
      ? (await checkGateNow(options.store, { actor, capability, storeIds: [storeId], policyMode: true, platform: options.platformCapabilities, nowMs: () => options.now().getTime() })).ok
      : actor.tier !== 'employee';
    return scopeRefusal(text, { actor, people, allowed });
  }

  return async (input: EmployeeMessage): Promise<RoutedHandleResult> => {
    const pendingArrival = input.pendingArrival ?? capturePendingArrival(options.store);
    void pendingArrival.catch(() => {});
    let pendingSequence: string | null = null;
    void pendingArrival.then(value => { pendingSequence = value.sequence; }, () => {});
    input = { ...input, pendingArrival };
    const requestId = typeof input.messageId === 'string' && input.messageId.trim() ? input.messageId : `anonymous-${++anonymous}`;
    const fingerprint = hash([input.memberId, input.sessionId ?? null, input.bindingVersion ?? null, input.text]);
    log.inbound(requestId);
    let decision: RouteDecision = { target: 'clarify', label: 'clarify', intents: [] };
    let modelCalled = false;
    let gateReason = 'not_applicable', modelMs = 0, errorCategory = 'none', modelAttempted = false;
    input = { ...input, onGate: reason => { gateReason = reason.split(':')[0]!; } };
    const run = await budget.run(requestId, fingerprint, { signal: input.signal, deadline: input.deadline }, async child => {
      await pendingArrival;
      if (child.signal.aborted || performance.now() >= child.deadline) throw Error('arrival_cancelled');
      const preflightResponse = async (reply: string, kind: 'ask' | 'reply' = 'reply'): Promise<WorkResult> => {
        const handled = await loop({ ...input, signal: child.signal, deadline: child.deadline }, { text: reply, kind });
        return { reply: handled.replies.join('\n'), target: 'store', ...(handled.access ? { access: handled.access } : {}) };
      };
      const today = businessDate(options.now(), cutoff, timeZone);
      if (businessRead(input.text, today)) {
        decision = { target: 'store', label: 'progress', intents: ['progress'] };
        const handled = await loop({ ...input, signal: child.signal, deadline: child.deadline });
        return { reply: handled.replies.join('\n'), target: 'store', ...(handled.access ? { access: handled.access } : {}) };
      }
      const clockReply = parseStandaloneAppointmentTime(input.text);
      const clockActor = clockReply && options.accessPolicy === true ? await options.store.getPersonByMember(input.memberId) : null;
      const askedTime = clockActor && (await options.store.getConfig(appointmentTimeAskKey(clockActor, input)))?.trim();
      const classified: Classification = askedTime
        ? { label: 'followup', intents: ['followup'], source: 'rule', reason: 'single' }
        : await classifyWithSemantic(input.text, {
          businessDay: today, semantic: router.semantic, signal: child.signal, deadline: child.deadline,
          preserveCrossDomainMultiIntent: true,
        });
      if ((classified.source === 'semantic' || classified.reason === 'semantic-rejected' || classified.reason === 'semantic-timeout') && !isDeterministicStub(router.semantic)) modelCalled = true;
      const marketing = router.marketing;
      const marketingEnabled = Boolean(marketing?.enabled || passthroughMarketing);
      let grantedActor = classified.label === 'marketing' && marketingEnabled ? await marketingActor(input.memberId) : null;
      decision = decideRoute(classified, { marketingEnabled, marketingGranted: !!grantedActor });
      log.classify(requestId, { label: decision.label, target: decision.target, source: classified.source, reason: classified.reason });
      // R3（D81 已定口径）：非今天的报数说法 → 固定一句，不追问、不写。
      // R15 / D146：没见过的否定补报（含带时间词前缀）先问，不走「只能报今天的单」，不出可确认草稿。
      {
        // 先认形状，不读账本；只有确定走模型追问时才取本店已确认名单（D146 收紧，D139「对」入账）。
        // R18 / 移交项 3：结论与措辞都来自单闸模块（与闸内同一个 textLevelImpurity），入口不自己判。
        const impurity = textLevelImpurity(input.text, today);
        if (impurity) {
          // D175：用同一 D152 文本结论先问，保留挂起项；宿主全局指纹仍先于本入口，budget 覆盖整轮。
          const handled = await loop({ ...input, signal: child.signal, deadline: child.deadline });
          return { reply: handled.replies.join('\n'), target: 'store', ...(handled.access ? { access: handled.access } : {}) };
        }
      }
      if ((decision.target === 'clarify' || decision.target === 'store') && pastDayReportPhrase(input.text, today)) return preflightResponse(NOT_TODAY_REPLY, 'ask');
      // R3/R4：越权/跨店/设目标 等 → 直接「不能做」+原因（店务路径进循环前也判一次）。
      const managedQuery = isManagedQueryPhrase(input.text);
      const hasStoreShorthand = otherStoreShortNames(input.text, '').length > 0;
      if (hasStoreShorthand || (!managedQuery && (decision.target === 'clarify' || decision.target === 'store'))) {
        const refused = await refusalFor(input.memberId, input.text, managedQuery);
        if (refused) return preflightResponse(refused);
      }
      // R4：待答的预约称呼、或「改 N」选笔 —— 分类器可能当成澄清，仍进店务循环，避免丢掉上下文。
      if (decision.target === 'clarify') {
        const actor = await options.store.getPersonByMember(input.memberId);
        const asked = actor ? (await options.store.getConfig(appointmentAskKey(actor, input)))?.trim() : '';
        const appt = parseAppointmentRequest(input.text, new Date(), 'Asia/Shanghai');
        if (asked || isExplicitConfirmCommand(input.text.trim()) || parseCorrectionPick(input.text) || parseAddNewChoice(input.text) || parseAskManagerChoice(input.text)
            || isSelfProgressQuery(input.text) || isStorePerfQuery(input.text)
            || isManagedQueryPhrase(input.text)
            || (appt && (appt.kind === 'request' || appt.kind === 'needs_time' || appt.kind === 'past' || appt.kind === 'invalid'))) {
          decision = { target: 'store', label: 'followup', intents: ['followup'] };
        }
      }
      // R7：规则快路径只保留抽取完整/标准行报单、已能直接办的查询模板、改账/目标命令、预约与跟进。
      // 仅关键词命中、入口实际办不成的，改走模型分类（不扩关键词表）。
      if (decision.target === 'store' && decision.label !== 'followup' && decision.label !== 'appointment') {
        const completeReport = oralProjectReportLine(input.text) !== null
          || extractReport(input.text).status === 'complete' || isStandardAmountLine(input.text)
          || parseReportText(input.text, today).status === 'complete'
          || parseLooseReport(input.text, today).status === 'complete';
        const knownQuery = isSelfProgressQuery(input.text) || isStorePerfQuery(input.text) || isManagedQueryPhrase(input.text)
          || /^入账结果(?:\s+\S+)?$/.test(input.text.trim());
        const corr = parseCorrectionCommand(input.text);
        const tgt = parseTargetCommand(input.text, today);
        const knownCorr = (corr !== null && corr !== 'invalid')
          || !!parseCorrectionPick(input.text)
          || parseAddNewChoice(input.text)
          || parseAskManagerChoice(input.text);
        const knownTarget = tgt !== null && tgt !== 'invalid';
        if (!completeReport && !knownQuery && !knownCorr && !knownTarget) {
          decision = { target: 'clarify', label: 'clarify', intents: decision.intents };
        }
      }
      let modelClassification: ModelClassification | undefined;
      const crossDomainMultiIntent = classified.reason === 'multi-intent'
        && classified.intents.some(isStoreIntent)
        && classified.intents.includes('marketing');
      const nonClosingReport = classified.unclear === 'not_closed'
        || classified.unclear === 'negation'
        || nonClosingReportReason(input.text) !== null;
      // 规则层已判定未成交/否定报单或明确跨类多意图时，不交模型分类器覆盖原判。
      if (decision.target === 'clarify' && !nonClosingReport && !crossDomainMultiIntent) {
        const classifier = modelClassifier;
        modelAttempted = true;
        const output = await runModelClassifier(input.text, classifier, child.signal, child.deadline, modelClassifyTimeoutMs, diagnostic => {
          modelMs = diagnostic.modelMs; errorCategory = diagnostic.errorCategory;
        });
        if (!isModelStub(classifier)) modelCalled = true;
        const chain = validateModelChain({ text: input.text, output });
        if (!chain.ok) {
          gateReason = chain.reason;
          if (errorCategory === 'none') errorCategory = chain.reason;
          if (chain.reason === 'amount') return preflightResponse(chain.ask, 'ask');
        } else {
          modelClassification = chain.classification;
          const label = chain.classification.intent === 'query' ? 'progress' as const
            : chain.classification.intent === 'amend' || chain.classification.intent === 'withdraw' ? 'correction' as const
            : chain.classification.intent === 'appointment' ? 'appointment' as const
            : chain.classification.intent === 'report' ? 'report' as const
            : chain.classification.intent === 'chitchat' ? 'chitchat' as const
            : chain.classification.intent === 'marketing' ? 'marketing' as const
            : 'progress' as const;
          if (label === 'chitchat') decision = { target: 'chitchat', label: 'chitchat', intents: ['chitchat'] };
          else if (label === 'marketing') {
            if (hasSoftRoleWords(input.text) && classified.intents.some(isStoreIntent) && !classified.intents.includes('marketing')) {
              return preflightResponse(MULTI_REPLY, 'ask');
            }
            if (!grantedActor && marketingEnabled) grantedActor = await marketingActor(input.memberId);
            decision = decideRoute({ label: 'marketing', intents: ['marketing'], source: 'semantic', reason: 'semantic' }, { marketingEnabled, marketingGranted: !!grantedActor });
          } else decision = { target: 'store', label, intents: [label === 'progress' ? 'progress' : label === 'correction' ? 'correction' : label === 'appointment' ? 'appointment' : 'report'] };
        }
      }
      switch (decision.target) {
        case 'store': {
          const handled = await loop({ ...input, signal: child.signal, deadline: child.deadline, ...(modelClassification ? { modelClassification } : {}) });
          // R3：M01 入口没认出要办的事（通用提示、零写入）→ 再判一次越权/跨店，越权就直接「不能做」+原因。
          if (handled.replies.length === 1 && handled.replies[0] === REPORT_HINT && !handled.ledgerSettled) {
            const refused = await refusalFor(input.memberId, input.text);
            if (refused) return { reply: refused };
          }
          return { reply: handled.replies.join('\n'), ...(handled.ledgerSettled ? { ledgerSettled: true } : {}), target: 'store', ...(handled.access ? { access: handled.access } : {}) };
        }
        // R3：客套话短答一句，不写账、不追问。
        case 'chitchat': return preflightResponse(courtesyReply(input.text) ?? CHITCHAT_REPLY);
        case 'marketing-unavailable': return preflightResponse(MARKETING_UNAVAILABLE);
        case 'marketing': {
          // D175/D179：沿用循环身份预检，只消费过期项；有效挂起项保留。
          const prepared = await loop(
            { ...input, signal: child.signal, deadline: child.deadline },
            passthroughMarketing ? { text: '', kind: 'reply', markInterleaved: true } : '',
          );
          if (!prepared.newMessagePrepared) return { reply: prepared.replies.join('\n'), target: 'store', ...(prepared.access ? { access: prepared.access } : {}) };
          const finish = (reply: string) => prepared.expiredReminder ? `${reply}\n${prepared.expiredReminder}` : reply;
          if (child.signal.aborted || performance.now() >= child.deadline) return { reply: finish(MARKETING_UNAVAILABLE) };
          // R1（M03-05）：发出/放行前同一入口门再判；预检期间撤权/停用 → 拒绝。
          const verifiedActor = await marketingActor(input.memberId, grantedActor!);
          if (!verifiedActor) return { reply: finish(MARKETING_UNAVAILABLE), target: 'marketing', access: { capability: 'marketing', storeIds: [grantedActor!.storeId] } };
          if (passthroughMarketing) {
            const work: EntryWorkResult = {
              reply: '',
              target: 'marketing',
              access: { capability: 'marketing', storeIds: [verifiedActor.storeId] },
              pass: true,
              actor: verifiedActor,
              ...(prepared.expiredReminder ? { expiredReminder: prepared.expiredReminder } : {}),
            };
            return work;
          }
          modelCalled = true;
          const text = await marketing!.handle({ memberId: input.memberId, text: input.text, signal: child.signal, deadline: child.deadline });
          // R1（M03-05）：生成后发出前再判一次；生成期间撤权/停用 → 不发出生成结果。
          if (!await marketingActor(input.memberId, verifiedActor)) return { reply: finish(MARKETING_UNAVAILABLE) };
          return { reply: finish(typeof text === 'string' && text.trim() ? text.trim() : `${F}：这次没有生成内容，没有写入任何账目。`), target: 'marketing', access: { capability: 'marketing', storeIds: [verifiedActor.storeId] } };
        }
        default: return preflightResponse(decision.ask ?? (decision.intents.length > 1 ? MULTI_REPLY : CLARIFY_REPLY), 'ask');
      }
    }, (state): WorkResult => ({
      reply: decision.target === 'store'
        ? `${F}：${state === 'cancelled' ? '请求已取消' : state === 'timeout' ? '这次没在时限内处理完' : '账本暂不可用'}，结果未知；请发「入账结果 ${requestId}」查原操作，不要另报一笔。`
        : `${F}：${state === 'timeout' ? '这次没在时限内处理完' : '这次没有处理成'}，没有写入任何账目，请稍后再发。`,
    }));
    const { duplicate } = run;
    let terminal = run.terminal as EntryTerminal;
    // R1（M03-04）：去重不等于授权。已完成结果被重复命中时，按当前权限复核原回复依赖的能力；不过则改回拒绝。
    if (duplicate && terminal.state === 'completed' && (terminal.target === 'store' || terminal.target === 'marketing') &&
      !await stillAllowed(input.memberId, terminal.access ?? { capability: null, storeIds: [] }).catch(() => false)) {
      const { pass: _pass, expiredReminder: _exp, actor: _actor, ...rest } = terminal;
      terminal = Object.freeze({ ...rest, reply: terminal.target === 'marketing' ? MARKETING_UNAVAILABLE : ACCESS_DENIED, ledgerSettled: false });
    }
    if (!duplicate) log.commit(requestId, { state: terminal.state, ...(terminal.ledgerSettled ? { ledgerSettled: true } : {}) });
    const deliver = budget.claimDelivery(terminal);
    log.deliver(requestId, { delivered: deliver, duplicate, state: terminal.state });
    // 投递与业务分开：投递失败不回滚已提交业务，异常照常抛给调用方；放行给外层 Agent 时不发空店务消息。
    if (deliver && !terminal.pass) options.onOutbound?.(terminal.reply);
    try { router.onObservation?.({ requestId, route: gateReason !== 'accepted' && (modelAttempted || decision.target === 'clarify') ? '追问' : modelAttempted ? '模型' : '快通道',
      gateReason, pendingSequence, modelMs, errorCategory }); } catch { /* No content is logged. */ }
    return {
      entry: 'unified',
      replies: terminal.pass ? [] : [terminal.reply],
      ...(terminal.access ? { access: structuredClone(terminal.access) } : {}),
      modelCalled,
      ...(terminal.ledgerSettled ? { ledgerSettled: true } : {}),
      requestId,
      state: terminal.state,
      target: decision.target,
      duplicate,
      ...(terminal.pass ? {
        pass: true as const,
        ...(terminal.expiredReminder ? { expiredReminder: terminal.expiredReminder } : {}),
        ...(terminal.actor ? { actor: terminal.actor } : {}),
      } : {}),
    };
  };
}
