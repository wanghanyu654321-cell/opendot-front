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
import { clarifyQuestion } from './clarify.js';
import { parseRuleReadQuery } from './read-query.js';
import { isStandardAmountLine } from './amount-guard.js';
import { hasNonCustomerStandardLabel } from './standard-line.js';
import { parseLooseReport, parseReportText } from './report-parse.js';
import type { Person } from './performance-store.js';
import { isDeterministicStub } from './intent-classifier.js';
import {
  runModelClassifier, validateModelChain, isModelStub,
  createModelClassifier, loadModelRuntimeConfig,
  type ModelClassifier, type ModelClassification, type ModelRuntimeConfig,
} from './model-classify.js';
import {
  classifySoftRoleRule,
  decisionFromModelClassification,
  hasCrossDomainStoreAndSoftRole,
  hasPendingDeferralClause,
  isStandalonePendingDeferral,
  resolveTriageMode,
  triageAuditOf,
  tryFastPathTriage,
  type TriageAuditInfo,
  type TriageDecision,
  type TriageMode,
  type TriageSessionHint,
  type TriageSoftRole,
  type TriageSource,
} from './triage.js';

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
  /** OpenDot 桥接模式：当决策为 marketing 且本人具备 marketing 授权时，
   * 在完成 loop(input, '') 身份与挂起项预检及 marketingActor 复核后返回 pass: true、expiredReminder 与 actor，
   * 交由外层桥接器转交 OpenDot 原生 Agent（不再强制要求 router.marketing）。
   */
  passthroughMarketing?: boolean;
  /** Issue #21 仅切分诊入口的回退开关（v2 = 路线 A 单决策分诊台；legacy = 旧规则前置回退）。草稿强确认契约两模式一致。 */
  triageMode?: TriageMode;
  onRoute?: (record: RouteLogRecord) => void;
}
export interface MessageObservation {
  route: '快通道' | '模型' | '追问'; gateReason: string; pendingSequence: string | null; modelMs: number; errorCategory: string;
  triageVersion?: string;
  routeLayer?: TriageSource;
  finalIntent?: string;
  softRole?: TriageSoftRole;
}
export interface RoutedHandleResult extends HandleResult {
  requestId: string; state: TerminalState; target: RouteDecision['target']; duplicate: boolean;
  pass?: true;
  softRole?: TriageSoftRole;
  triageAudit?: TriageAuditInfo;
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
  const triageMode: TriageMode = router.triageMode ?? resolveTriageMode();
  type EntryWorkResult = WorkResult & { pass?: true; softRole?: TriageSoftRole; triageAudit?: TriageAuditInfo; expiredReminder?: string; actor?: Person };
  type EntryTerminal = import('./request-budget.js').Terminal & { pass?: true; softRole?: TriageSoftRole; triageAudit?: TriageAuditInfo; expiredReminder?: string; actor?: Person };
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
    let triageAudit: TriageAuditInfo | undefined;
    input = { ...input, onGate: reason => { gateReason = reason.split(':')[0]!; } };
    const run = await budget.run(requestId, fingerprint, { signal: input.signal, deadline: input.deadline }, async child => {
      await pendingArrival;
      if (child.signal.aborted || performance.now() >= child.deadline) throw Error('arrival_cancelled');
      const preflightResponse = async (reply: string, kind: 'ask' | 'reply' = 'reply', markInterleaved = false): Promise<EntryWorkResult> => {
        const handled = await loop(
          { ...input, signal: child.signal, deadline: child.deadline },
          { text: reply, kind, ...(markInterleaved ? { markInterleaved: true } : {}) },
        );
        return {
          reply: handled.replies.join('\n'),
          target: 'store',
          ...(handled.access ? { access: handled.access } : {}),
          ...(triageAudit ? { triageAudit } : {}),
        };
      };
      const today = businessDate(options.now(), cutoff, timeZone);
      const marketing = router.marketing;
      const marketingEnabled = Boolean(marketing?.enabled || passthroughMarketing);

      const buildSessionHint = async (): Promise<{ hint: TriageSessionHint; askedCustomer: boolean }> => {
        const actor = await options.store.getPersonByMember(input.memberId);
        if (!actor?.active) {
          return {
            hint: { hasActivePendingDraft: false, pendingDraftKind: null, hasPendingAppointmentTimeAsk: false },
            askedCustomer: false,
          };
        }
        const drafts = await options.store.listDrafts({ reporterPersonId: actor.personId, storeId: actor.storeId });
        const nowMs = options.now().getTime();
        const activePending = drafts.find(d => d.status === 'pending' && Date.parse(d.expiresAt) > nowMs);
        let hasPendingAppointmentTimeAsk = false;
        let askedCustomer = false;
        if (options.accessPolicy === true && input.sessionId) {
          hasPendingAppointmentTimeAsk = Boolean((await options.store.getConfig(appointmentTimeAskKey(actor, input)))?.trim());
          askedCustomer = Boolean((await options.store.getConfig(appointmentAskKey(actor, input)))?.trim());
        }
        return {
          hint: {
            hasActivePendingDraft: Boolean(activePending),
            pendingDraftKind: activePending ? activePending.kind : null,
            hasPendingAppointmentTimeAsk,
          },
          askedCustomer,
        };
      };

      const executeTriageDecision = async (td: TriageDecision): Promise<EntryWorkResult> => {
        triageAudit = triageAuditOf(td, triageMode);
        if (td.kind === 'confirm_or_cancel' || td.kind === 'appointment_time_reply' || td.kind === 'choice_followup' || td.kind === 'hold_pending') {
          decision = { target: 'store', label: 'followup', intents: ['followup'] };
          const handled = await loop({ ...input, signal: child.signal, deadline: child.deadline, triageDecision: td });
          return {
            reply: handled.replies.join('\n'),
            ...(handled.ledgerSettled ? { ledgerSettled: true } : {}),
            target: 'store',
            ...(handled.access ? { access: handled.access } : {}),
            triageAudit,
          };
        }
        if (td.kind === 'read_query') {
          decision = { target: 'store', label: 'progress', intents: ['progress'] };
          const handled = await loop({ ...input, signal: child.signal, deadline: child.deadline, triageDecision: td });
          return {
            reply: handled.replies.join('\n'),
            target: 'store',
            ...(handled.access ? { access: handled.access } : {}),
            triageAudit,
          };
        }
        if (td.kind === 'chitchat') {
          decision = { target: 'chitchat', label: 'chitchat', intents: ['chitchat'] };
          return preflightResponse(courtesyReply(input.text) ?? CHITCHAT_REPLY);
        }
        if (td.kind === 'multi_intent') {
          decision = { target: 'clarify', label: 'clarify', intents: ['report', 'marketing'], ask: td.ask };
          return preflightResponse(td.ask, 'ask', true);
        }
        if (td.kind === 'clarify') {
          decision = { target: 'clarify', label: 'clarify', intents: [], ask: td.ask };
          return preflightResponse(td.ask, td.suppressReminder ? 'reply' : 'ask', td.markInterleaved);
        }
        if (td.kind === 'soft_role') {
          const granted = marketingEnabled ? await marketingActor(input.memberId) : null;
          if (!marketingEnabled || !granted) {
            gateReason = 'permission';
            decision = { target: 'marketing-unavailable', label: 'marketing', intents: ['marketing'] };
            return preflightResponse(MARKETING_UNAVAILABLE);
          }
          decision = { target: 'marketing', label: 'marketing', intents: ['marketing'] };
          const prepared = await loop(
            { ...input, signal: child.signal, deadline: child.deadline },
            passthroughMarketing ? { text: '', kind: 'reply', markInterleaved: true } : '',
          );
          if (!prepared.newMessagePrepared) {
            return {
              reply: prepared.replies.join('\n'),
              target: 'store',
              ...(prepared.access ? { access: prepared.access } : {}),
              triageAudit,
            };
          }
          const finish = (reply: string) => prepared.expiredReminder ? `${reply}\n${prepared.expiredReminder}` : reply;
          if (child.signal.aborted || performance.now() >= child.deadline) {
            return { reply: finish(MARKETING_UNAVAILABLE), triageAudit };
          }
          const verifiedActor = await marketingActor(input.memberId, granted);
          if (!verifiedActor) {
            return {
              reply: finish(MARKETING_UNAVAILABLE),
              target: 'marketing',
              access: { capability: 'marketing', storeIds: [granted.storeId] },
              triageAudit,
            };
          }
          if (passthroughMarketing) {
            return {
              reply: '',
              target: 'marketing',
              access: { capability: 'marketing', storeIds: [verifiedActor.storeId] },
              pass: true,
              softRole: td.softRole,
              triageAudit,
              actor: verifiedActor,
              ...(prepared.expiredReminder ? { expiredReminder: prepared.expiredReminder } : {}),
            };
          }
          modelCalled = true;
          const text = await marketing!.handle({ memberId: input.memberId, text: input.text, signal: child.signal, deadline: child.deadline });
          if (!await marketingActor(input.memberId, verifiedActor)) {
            return {
              reply: finish(MARKETING_UNAVAILABLE),
              target: 'marketing',
              access: { capability: 'marketing', storeIds: [verifiedActor.storeId] },
              triageAudit,
            };
          }
          return {
            reply: finish(typeof text === 'string' && text.trim() ? text.trim() : `${F}：这次没有生成内容，没有写入任何账目。`),
            target: 'marketing',
            access: { capability: 'marketing', storeIds: [verifiedActor.storeId] },
            triageAudit,
          };
        }
        // td.kind === 'store_write'
        const writeLabel = td.writeKind === 'report' ? 'report' as const
          : td.writeKind === 'appointment' ? 'appointment' as const
          : td.writeKind === 'target' ? 'target' as const
          : 'correction' as const;
        decision = { target: 'store', label: writeLabel, intents: [writeLabel] };
        const impurity = td.writeKind === 'report' ? textLevelImpurity(input.text, today) : null;
        if (!impurity) {
          if (td.writeKind === 'report' && pastDayReportPhrase(input.text, today)) {
            return preflightResponse(NOT_TODAY_REPLY, 'ask');
          }
          const refused = await refusalFor(input.memberId, input.text, false);
          if (refused) return preflightResponse(refused);
        }
        const handled = await loop({
          ...input,
          signal: child.signal,
          deadline: child.deadline,
          triageDecision: td,
          ...(td.classification ? { modelClassification: td.classification } : {}),
        });
        if (handled.replies.length === 1 && handled.replies[0] === REPORT_HINT && !handled.ledgerSettled) {
          const refused = await refusalFor(input.memberId, input.text);
          if (refused) return { reply: refused, triageAudit };
        }
        return {
          reply: handled.replies.join('\n'),
          ...(handled.ledgerSettled ? { ledgerSettled: true } : {}),
          target: 'store',
          ...(handled.access ? { access: handled.access } : {}),
          triageAudit,
        };
      };

      // 第 1 层（v2 与 legacy 共享）：超长输入防截断 + 独立挂起保护 + 待答钟点。
      const clockReply = parseStandaloneAppointmentTime(input.text);
      const clockActor = clockReply && options.accessPolicy === true ? await options.store.getPersonByMember(input.memberId) : null;
      const askedTime = clockActor && (await options.store.getConfig(appointmentTimeAskKey(clockActor, input)))?.trim();
      const fastDecision = tryFastPathTriage(input.text, {
        businessDay: today,
        sessionHint: {
          hasActivePendingDraft: false,
          pendingDraftKind: null,
          hasPendingAppointmentTimeAsk: Boolean(askedTime),
        },
      });
      if (fastDecision) {
        const fastLabel = fastDecision.kind === 'chitchat' ? 'chitchat'
          : fastDecision.kind === 'store_write' ? fastDecision.writeKind
          : fastDecision.kind === 'read_query' ? 'progress'
          : fastDecision.kind === 'clarify' ? 'clarify'
          : 'followup';
        const fastTarget = fastDecision.kind === 'chitchat' ? 'chitchat'
          : fastDecision.kind === 'clarify' ? 'clarify'
          : 'store';
        log.classify(requestId, { label: fastLabel, target: fastTarget, source: 'rule', reason: 'single' });
        return executeTriageDecision(fastDecision);
      }

      // 路线 A（v2，存在真实或注入分类器时）：复杂自然长句不再被 8 层前置正则拦截，直接由统一分诊模型产出唯一决策。
      if (triageMode === 'v2' && !isModelStub(modelClassifier)) {
        const { hint: sessionHint, askedCustomer } = await buildSessionHint();
        if (askedCustomer && input.text.trim().length <= 16 && !hasPendingDeferralClause(input.text) && !parseRuleReadQuery(input.text, today)) {
          return executeTriageDecision({ kind: 'choice_followup', source: 'fast_path' });
        }
        modelAttempted = true;
        const output = await runModelClassifier(
          input.text,
          modelClassifier,
          child.signal,
          child.deadline,
          modelClassifyTimeoutMs,
          diagnostic => { modelMs = diagnostic.modelMs; errorCategory = diagnostic.errorCategory; },
          sessionHint,
        );
        modelCalled = true;
        const chain = validateModelChain({ text: input.text, output });
        if (chain.ok) {
          let modelDecision = decisionFromModelClassification(input.text, chain.classification, today, {
            multiReply: MULTI_REPLY,
            clarifyReply: CLARIFY_REPLY,
          });
          if (modelDecision.kind === 'soft_role' && hasCrossDomainStoreAndSoftRole(input.text, today)) {
            modelDecision = { kind: 'multi_intent', source: 'guard', ask: MULTI_REPLY };
          }
          if (modelDecision.kind !== 'clarify' && modelDecision.kind !== 'multi_intent') {
            gateReason = 'accepted';
          }
          log.classify(requestId, {
            label: modelDecision.kind === 'soft_role' ? 'marketing' : modelDecision.kind === 'chitchat' ? 'chitchat' : modelDecision.kind === 'clarify' || modelDecision.kind === 'multi_intent' ? 'clarify' : 'progress',
            target: modelDecision.kind === 'soft_role' ? 'marketing' : modelDecision.kind === 'chitchat' ? 'chitchat' : modelDecision.kind === 'clarify' || modelDecision.kind === 'multi_intent' ? 'clarify' : 'store',
            source: 'semantic',
            reason: 'semantic',
          });
          return executeTriageDecision(modelDecision);
        }
        // 模型返回 unknown / 超时 / 畸形 JSON / 脏金额：绝不回退到猜预约或猜报单写流！
        gateReason = chain.reason;
        if (errorCategory === 'none') errorCategory = chain.reason;
        if (chain.reason === 'amount') {
          return executeTriageDecision({
            kind: 'clarify',
            source: 'guard',
            reason: 'amount',
            ask: chain.ask,
            markInterleaved: true,
          });
        }
        if (isStandalonePendingDeferral(input.text)) {
          return executeTriageDecision({ kind: 'hold_pending', source: 'guard' });
        }
        const safeReadSpec = parseRuleReadQuery(input.text, today);
        if (safeReadSpec) {
          return executeTriageDecision({
            kind: 'read_query',
            source: 'rule_fallback',
            spec: safeReadSpec,
            ...(hasPendingDeferralClause(input.text) ? { holdPending: true } : {}),
          });
        }
        const directDenied = nonClosingReportReason(input.text);
        if (directDenied) {
          return executeTriageDecision({
            kind: 'clarify',
            source: 'guard',
            reason: 'non_closing',
            ask: clarifyQuestion(directDenied),
            markInterleaved: true,
            suppressReminder: true,
          });
        }
        if (hasCrossDomainStoreAndSoftRole(input.text, today)) {
          return executeTriageDecision({ kind: 'multi_intent', source: 'guard', ask: MULTI_REPLY });
        }
        const refused = await refusalFor(input.memberId, input.text, isManagedQueryPhrase(input.text));
        if (refused) {
          triageAudit = { triageVersion: triageMode, routeLayer: 'guard', finalIntent: 'refusal' };
          return preflightResponse(refused);
        }
        return executeTriageDecision({
          kind: 'clarify',
          source: 'model',
          reason: chain.reason === 'schema' ? 'schema' : 'uncertain',
          ask: CLARIFY_REPLY,
          markInterleaved: true,
        });
      }

      // 离线 stub 模式或 FC_TRIAGE_MODE=legacy 回退路径：仍收敛到同一 executeTriageDecision，且保持 Phase 0 强确认不变量。
      const ruleReadSpec = parseRuleReadQuery(input.text, today);
      if (ruleReadSpec) {
        return executeTriageDecision({
          kind: 'read_query',
          source: 'rule_fallback',
          spec: ruleReadSpec,
          ...(hasPendingDeferralClause(input.text) ? { holdPending: true } : {}),
        });
      }
      const classified: Classification = askedTime
        ? { label: 'followup', intents: ['followup'], source: 'rule', reason: 'single' }
        : await classifyWithSemantic(input.text, {
          businessDay: today, semantic: router.semantic, signal: child.signal, deadline: child.deadline,
          preserveCrossDomainMultiIntent: true,
        });
      if ((classified.source === 'semantic' || classified.reason === 'semantic-rejected' || classified.reason === 'semantic-timeout') && !isDeterministicStub(router.semantic)) modelCalled = true;
      let grantedActor = classified.label === 'marketing' && marketingEnabled ? await marketingActor(input.memberId) : null;
      decision = decideRoute(classified, { marketingEnabled, marketingGranted: !!grantedActor });
      log.classify(requestId, { label: decision.label, target: decision.target, source: classified.source, reason: classified.reason });
      // 明确的未成交/否定报单优先于残片追问与模型兜底：绝不建草稿，并在存在活跃待确认草稿时启用 D175 显式口令保护。
      const nonClosingReason = classified.unclear === 'not_closed' || classified.unclear === 'negation'
        ? classified.unclear
        : nonClosingReportReason(input.text);
      if (nonClosingReason && (decision.target === 'clarify' || decision.target === 'store')) {
        return executeTriageDecision({
          kind: 'clarify',
          source: 'guard',
          reason: 'non_closing',
          ask: clarifyQuestion(nonClosingReason),
          markInterleaved: true,
          suppressReminder: true,
        });
      }
      {
        const impurity = textLevelImpurity(input.text, today);
        if (impurity) {
          triageAudit = { triageVersion: triageMode, routeLayer: 'rule_fallback', finalIntent: 'write:report' };
          const handled = await loop({ ...input, signal: child.signal, deadline: child.deadline });
          return { reply: handled.replies.join('\n'), target: 'store', ...(handled.access ? { access: handled.access } : {}), triageAudit };
        }
      }
      if ((decision.target === 'clarify' || decision.target === 'store') && pastDayReportPhrase(input.text, today)) return preflightResponse(NOT_TODAY_REPLY, 'ask');
      const managedQuery = isManagedQueryPhrase(input.text);
      const hasStoreShorthand = otherStoreShortNames(input.text, '').length > 0;
      if (hasStoreShorthand || (!managedQuery && (decision.target === 'clarify' || decision.target === 'store'))) {
        const refused = await refusalFor(input.memberId, input.text, managedQuery);
        if (refused) return preflightResponse(refused);
      }
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
      const crossDomainMultiIntent = classified.reason === 'multi-intent'
        && classified.intents.some(isStoreIntent)
        && classified.intents.includes('marketing');
      if (decision.target === 'clarify' && !nonClosingReason && !crossDomainMultiIntent && !isModelStub(modelClassifier)) {
        const { hint: sessionHint } = await buildSessionHint();
        modelAttempted = true;
        const output = await runModelClassifier(
          input.text,
          modelClassifier,
          child.signal,
          child.deadline,
          modelClassifyTimeoutMs,
          diagnostic => { modelMs = diagnostic.modelMs; errorCategory = diagnostic.errorCategory; },
          sessionHint,
        );
        modelCalled = true;
        const chain = validateModelChain({ text: input.text, output });
        if (!chain.ok) {
          gateReason = chain.reason;
          if (errorCategory === 'none') errorCategory = chain.reason;
          if (chain.reason === 'amount') return preflightResponse(chain.ask, 'ask');
        } else {
          let modelDecision = decisionFromModelClassification(input.text, chain.classification, today, {
            multiReply: MULTI_REPLY,
            clarifyReply: CLARIFY_REPLY,
          });
          if (modelDecision.kind === 'soft_role' && hasCrossDomainStoreAndSoftRole(input.text, today)) {
            modelDecision = { kind: 'multi_intent', source: 'guard', ask: MULTI_REPLY };
          }
          if (modelDecision.kind !== 'clarify' && modelDecision.kind !== 'multi_intent') {
            gateReason = 'accepted';
          }
          return executeTriageDecision(modelDecision);
        }
      }
      switch (decision.target) {
        case 'store': {
          triageAudit = { triageVersion: triageMode, routeLayer: 'rule_fallback', finalIntent: `store:${decision.label}` };
          const handled = await loop({ ...input, signal: child.signal, deadline: child.deadline });
          if (handled.replies.length === 1 && handled.replies[0] === REPORT_HINT && !handled.ledgerSettled) {
            const refused = await refusalFor(input.memberId, input.text);
            if (refused) return { reply: refused, triageAudit };
          }
          return { reply: handled.replies.join('\n'), ...(handled.ledgerSettled ? { ledgerSettled: true } : {}), target: 'store', ...(handled.access ? { access: handled.access } : {}), triageAudit };
        }
        case 'chitchat': return executeTriageDecision({ kind: 'chitchat', source: 'rule_fallback' });
        case 'marketing-unavailable': return preflightResponse(MARKETING_UNAVAILABLE);
        case 'marketing': return executeTriageDecision({ kind: 'soft_role', source: 'rule_fallback', softRole: classifySoftRoleRule(input.text) });
        default: {
          const isD153StandardFormatAttempt = isStandardAmountLine(input.text)
            || hasNonCustomerStandardLabel(input.text)
            || /^[\u4e00-\u9fa5]{1,8}\s*[:：]\s*\d+(?:\.\d+)?(?:\s*[（(][^（）()]{1,16}[）)])?$/.test(input.text.trim());
          if (decision.ask || isD153StandardFormatAttempt) {
            // 格式/金额类或 D153/D171 标准行格式澄清保留原有 D182 提醒；未知或跨类多意图统一开启强确认保护。
            triageAudit = { triageVersion: triageMode, routeLayer: 'rule_fallback', finalIntent: 'clarify:format' };
            return preflightResponse(decision.ask ?? CLARIFY_REPLY, 'ask', false);
          }
          if (decision.intents.length > 1) {
            return executeTriageDecision({ kind: 'multi_intent', source: 'rule_fallback', ask: MULTI_REPLY });
          }
          return executeTriageDecision({
            kind: 'clarify',
            source: 'rule_fallback',
            reason: 'no_signal',
            ask: CLARIFY_REPLY,
            markInterleaved: true,
          });
        }
      }
    }, (state): EntryWorkResult => ({
      reply: decision.target === 'store'
        ? `${F}：${state === 'cancelled' ? '请求已取消' : state === 'timeout' ? '这次没在时限内处理完' : '账本暂不可用'}，结果未知；请发「入账结果 ${requestId}」查原操作，不要另报一笔。`
        : `${F}：${state === 'timeout' ? '这次没在时限内处理完' : '这次没有处理成'}，没有写入任何账目，请稍后再发。`,
    }));
    const { duplicate } = run;
    let terminal = run.terminal as EntryTerminal;
    // R1（M03-04）：去重不等于授权。已完成结果被重复命中时，按当前权限复核原回复依赖的能力；不过则改回拒绝。
    if (duplicate && terminal.state === 'completed' && (terminal.target === 'store' || terminal.target === 'marketing') &&
      !await stillAllowed(input.memberId, terminal.access ?? { capability: null, storeIds: [] }).catch(() => false)) {
      const { pass: _pass, softRole: _softRole, expiredReminder: _exp, actor: _actor, ...rest } = terminal;
      terminal = Object.freeze({ ...rest, reply: terminal.target === 'marketing' ? MARKETING_UNAVAILABLE : ACCESS_DENIED, ledgerSettled: false });
    }
    if (!duplicate) log.commit(requestId, { state: terminal.state, ...(terminal.ledgerSettled ? { ledgerSettled: true } : {}) });
    const deliver = budget.claimDelivery(terminal);
    log.deliver(requestId, { delivered: deliver, duplicate, state: terminal.state });
    // 投递与业务分开：投递失败不回滚已提交业务，异常照常抛给调用方；放行给外层 Agent 时不发空店务消息。
    if (deliver && !terminal.pass) options.onOutbound?.(terminal.reply);
    const effectiveAudit = terminal.triageAudit ?? triageAudit;
    try {
      router.onObservation?.({
        requestId,
        route: gateReason !== 'accepted' && (modelAttempted || decision.target === 'clarify') ? '追问' : modelAttempted ? '模型' : '快通道',
        gateReason,
        pendingSequence,
        modelMs,
        errorCategory,
        ...(effectiveAudit ? {
          triageVersion: effectiveAudit.triageVersion,
          routeLayer: effectiveAudit.routeLayer,
          finalIntent: effectiveAudit.finalIntent,
          ...(effectiveAudit.softRole ? { softRole: effectiveAudit.softRole } : {}),
        } : {}),
      });
    } catch { /* No content is logged. */ }
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
        ...(terminal.softRole ? { softRole: terminal.softRole } : {}),
        ...(terminal.expiredReminder ? { expiredReminder: terminal.expiredReminder } : {}),
        ...(terminal.actor ? { actor: terminal.actor } : {}),
      } : {}),
      ...(effectiveAudit ? { triageAudit: effectiveAudit } : {}),
    };
  };
}
