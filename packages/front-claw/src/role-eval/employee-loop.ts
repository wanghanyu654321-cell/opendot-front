import { capturePendingArrival, confirmationSequence, sequenceBefore, type PendingArrival } from './pending-order.js';
import { pausePoint } from './pause-points.js';
import { createHash } from 'node:crypto';
import { createAssistantTools } from './assistant-tools.js';
import { businessDate, DEFAULT_BUSINESS_CUTOFF, DEFAULT_TIME_ZONE, zonedDateTime } from './metrics.js';
import { matchPerson } from './people-match.js';
import { parseLooseReport, parseReportText, type ParsedEntry } from './report-parse.js';
import { ambiguityOf, extractReport, HONORIFIC, moneyIssueOf, splitStore } from './report-extract.js';
import { clarifyQuestion } from './clarify.js';
import {
  confirmEntryId, correctionNoticeId, entryVersion, revisionIdFor, type CommitGuard, type CorrectionChange, type CorrectionPayload, type Draft,
  type EmployeeDraftContext, type LedgerCommit, type LedgerEntry, type Notification, type Person, type ReportDraftItem, type TargetPayload,
  type Appointment, type AppointmentPayload, type CorrectionPickItem,
} from './performance-store.js';
import { parseAddNewChoice, parseAskManagerChoice, parseCorrectionCommand, parseCorrectionPick, parseTargetCommand } from './ledger-commands.js';
import {
  APPOINTMENT_RECIPIENTS_KEY, appointmentContentId, appointmentReminderId, askConfirmTodayReply, describeWhen, designatedRecipient, parseAppointmentRequest, parseStandaloneAppointmentTime, reminderBody, shortAppointmentNo, UNNAMED_CUSTOMER,
} from './appointments.js';
import { monthKey } from './metrics.js';
import type { HandleResult, WecomBotHandlerOptions } from './wecom-bot-unified-handler.js';
import { ACCESS_POLICY_KEY, authorize, authorizedStores, decideAccess, policyFrom, readPolicy, standing, type Capability } from './access-policy.js';
import { checkGateNow, commitGuard, policyVersionOf, type GateSpec, type GateTarget } from './commit-gate.js';
import type { Fence } from './fencing.js';
import { appointmentClause, clauseKind, compoundHead, compoundTail, isSelfProgressQuery, isStorePerfQuery, leftoverNote, NOT_TODAY_REPLY, selfProgressPhrase, type ClauseKind } from './scope-refusal.js';
import { consumerWrites } from './consumer-writes.js';
import { CommitContentionRejected, FencedWriteRejected } from './performance-store.js';
import { resolveStoreHours } from './store-hours.js';
import { ranking, storeById, storeByName, storeSummary, unreported } from './store-queries.js';
import { formatYuan } from './money.js';
import { cannot } from './scope-refusal.js';
import { guardUtteranceAmounts, guardIssueToReason, sealDraftAmounts, UnvalidatedAmountError, isStandardAmountLine } from './amount-guard.js';
import { tryStandardReport, standardAskToReason, hasUnnegatedNonToday, classifyStandardRemark, ownershipConflictDetail, stripNegatedMakeupPhrases, NOT_CUSTOMER_NAME } from './standard-line.js';
import { formatMaybeReportAsk } from './model-path-ask.js';
import { askForTextImpurity, bracketImpurity, evaluateConfirmableReportDraft, textLevelImpurity, type ConfirmableDraftPass, type GateEntry } from './confirmable-draft-gate.js';
import { collectConfirmedLedgerNames, collectKnownCustomerNames } from './store-customer-roster.js';
import { isYesNewCustomerReply, newCustomerAskKey, newCustomerAskReply, notCustomerNameAskReply } from './customer-name-policy.js';
import { customerNameConflicts } from './customer-conflict.js';
import { advancePendingSlot, pendingConfirmationReminder, pendingExpired, reportLabels, type SavedNewCustomerAsk, type PendingReportAdmission } from './pending-slot.js';
import { validateModelChain, isReadOnlyQuery, type ModelClassification } from './model-classify.js';
import { modelReportCandidate } from './model-report-candidate.js';
import { oralProjectReportLine } from './intent-router.js';


export const EMPLOYEE_LOOP_CONFIG = 'employee-loop:m01';
export interface EmployeeMessage {
  onGate?: (reason: string) => void;
  memberId: string; text: string;
  /** 可信入口最早接收时刻；不能取排队后的处理时刻。 */
  arrivedAt?: string | undefined;
  pendingArrival?: Promise<Readonly<PendingArrival>> | undefined;
  /** 由已认证入口传入，不能从聊天正文构造。 */
  messageId?: string; sessionId?: string; bindingVersion?: number;
  signal?: AbortSignal; deadline?: number;
  binding?: Readonly<import('./wecom-bot-bindings.js').WecomBotBinding>;
  validateBinding?: () => Promise<boolean>;
  channelActive?: () => boolean;
  /** R1（M07）：消费租约 fencing；带上时所有入账在提交事务里核对租约 owner+epoch 未变、未到期。 */
  fence?: Fence;
  /** R7：入口分类接口已通过 schema 的结果；循环内再过校验链。默认桩不会把执行结果送到这里。 */
  modelClassification?: ModelClassification;
}
/** 仅入口内部使用：新消息已完成挂起位迁移，才可启动后续非店务工作。 */
export type PreflightReply = string | { text: string; kind: 'ask' | 'reply'; markInterleaved?: boolean };
export type EmployeeLoopResult = HandleResult & { newMessagePrepared?: boolean; expiredReminder?: string };
type Access = NonNullable<HandleResult['access']>;
interface Tag { access?: Access }
/** R3：消费租约已不属于本实例时的结果（适配器不会把它发出去）。 */
/** M01 入口的通用提示（没认出要办的店务）；R3：统一入口据此再判一次越权/跨店。 */
/** R18 / D157：原 shouldHandCompoundToModel（改账/预约/目标/宣传/复述保留草稿）已删除——复合句一律整句先问，由单闸判定。 */

const newerPendingReply = (labels: string[]) => labels.map(label => `上一笔已作废，新的一笔「${label}」请看清后再回「对」。`).join('\n');
export const REPORT_HINT = 'Front Claw：请发标准清单，例如「11号测试A店\n380（小林）」，括号里写业绩归属的本店员工；可发送「我的进度」。没有写入任何账目。';
export const STALE_CONSUMER = 'Front Claw：本实例已不再负责这条消息，没有写入。';
export interface EmployeeTrace {
  messageId: string; operationId?: string; elapsedMs: number;
  outcome: 'reply' | 'unavailable'; ledgerSettled: boolean;
}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const valid = (value: unknown): value is string => typeof value === 'string' && !!value.trim() && value.length <= 512;
const complete = (person: Person | null): person is Person => !!person?.active &&
  [person.personId, person.accountId, person.memberId, person.displayName, person.storeId, person.storeName].every(valid);
const itemsDigest = (items: readonly { employeeId?: string | null | undefined; employeeName: string; amount: number; customer: string | null; note: string }[]) =>
  hash(items.map(item => [item.employeeId ?? null, item.employeeName, item.amount, item.customer, item.note]));
const meta = (draft: Draft): EmployeeDraftContext | undefined =>
  draft.payload.type === 'report' || draft.payload.type === 'target' || draft.payload.type === 'correction' || draft.payload.type === 'appointment' ? draft.payload.employeeContext : undefined;
/** M04：目标/更正草稿内容摘要（确认前复核，防止内容被改写）。 */
const ledgerDigest = (draft: Draft): string | undefined =>
  draft.payload.type === 'target' ? hash(['target', draft.payload.target, draft.payload.before])
    : draft.payload.type === 'correction' ? hash(['correction', draft.payload.action, draft.payload.scope, draft.payload.changes, draft.payload.awaitingPick ?? null])
    : draft.payload.type === 'appointment' && draft.payload.employeeContext ? hash(['appointment', draft.payload.items]) : undefined;
const LOOP_KINDS: readonly Draft['kind'][] = ['report', 'target', 'correction', 'appointment'];
/** M05 提醒状态的如实说法：不把“已排队/通道已接受”说成“店长已读”。 */
const REMINDER_STATE: Record<Notification['status'], string> = {
  pending: '已排队，尚未发送', sent: '企微通道已接受（不代表店长已读）', not_sent: '发送失败，未送达', unknown: '发送结果未知，未确认送达',
};
/** M06：按出站箱派发信息如实显示（发送中/退避重试/未发送原因）；基本词不变。 */
function reminderState(notice: Notification): string {
  const d = notice.delivery;
  if (notice.status === 'pending' && d?.phase === 'sending') return '正在发送，结果待确认';
  if (notice.status === 'pending' && d && d.attempts > 0) return `上次发送未成功，稍后自动重试（已试 ${d.attempts} 次）`;
  if (notice.status === 'not_sent' && d?.error && /^(recipient_|related_gone)/.test(d.error)) return '未发送：指定店长当前不能接收或已更换，预约不受影响';
  if (notice.status === 'not_sent' && d?.error?.startsWith('stale_')) return '未发送：预约时间已过';
  if (notice.status === 'unknown' && d?.resends) return `发送结果未知（已人工补发 ${d.resends} 次），未确认送达`;
  return REMINDER_STATE[notice.status];
}
/** M04 重发判定键：同店同日同归属人同金额同客户同备注。 */
const dupKey = (item: { ownerPersonId: string; amount: number; customer: string | null; note: string }) => JSON.stringify([item.ownerPersonId, item.amount, item.customer, item.note]);
const AMBIGUOUS_RECENT = 'Front Claw：“刚才那笔”对应的入账不唯一（同一时刻有多批），无法确定，没有写入；请查「入账结果」后找店长更正。';
const CONFLICT = 'Front Claw：对象在你确认前已被改动（可能别人刚改过或刚入账），这次没有写入，请重新发起。';
const NO_DRAFT = 'Front Claw：没有待确认的本人草稿，请先发送报数清单。';
/** D143：过期草稿回「对」的固定回复；请重新报，未入账。 */
export const DRAFT_EXPIRED_REREPORT = 'Front Claw：这笔已过期，请重新报。（未入账）';
/** R18 / D160：重复回「对」只回这一句；不含「已入账」，也不多记一笔。 */
export const ALREADY_CONFIRMED_TEXT = 'Front Claw：这笔已经入账了，不用重复确认。';
export const ALREADY_SETTLED_REPLY = (_id?: string) => ALREADY_CONFIRMED_TEXT;
const d160Key = (personId: string, sessionId: string) => `employee-loop:d160-last-confirm:${personId}:${sessionId}`;
export const d175InterleavedKey = (personId: string, sessionId: string) => `employee-loop:d175-interleaved:${personId}:${sessionId}`;
export const D175_INTERLEAVED_GUIDANCE =
  '刚才穿插了其他对话，为避免误入账，单字「对」暂不直接确认；请回复「确认入账」或「全部确认」入账，或回复「取消」。';
export const isExplicitConfirmCommand = (text: string): boolean => text === '确认入账' || text === '确认认账' || text === '全部确认';
const isConfirmCommand = (text: string): boolean => text === '对' || isExplicitConfirmCommand(text);
export const DENIED = 'Front Claw：仅支持本人或同店同事的报数、本人确认与进度；当前身份或对象不符合要求（跨店不能代报），没有写入。';
/** R7：找店长改——只提示、零写入。 */
export const ASK_MANAGER_HINT = 'Front Claw：请联系本店店长修改已有的那笔单。这条不会改账，也没有写入。';
export const PEER_ENTRY_HINT = 'Front Claw：那笔是别人报的，请找店长改。没有写入。';

const DISABLED = 'Front Claw：本人报数未启用，已有账目和草稿保留。';
/** M03：策略拒绝或配置异常。不区分原因，也不透露对象是否存在。 */
export const ACCESS_DENIED = 'Front Claw：当前权限不允许这项操作（或权限配置异常），没有读取或写入任何数据。';
function yuanAmt(n: number | undefined): string { return n === undefined ? '' : formatYuan(n); }
const OWNER_CANNOT_REPORT = cannot('老板不能报单');

/** R7 二选一文案：按可见性裁剪。普通员工看不到别人的金额/归属/reporterPersonId。 */
function formatDuplicateChoice(choice: NonNullable<import('./performance-store.js').ReportPayload['awaitingDuplicateChoice']>): string {
  const visible = choice.listed.filter(row => row.visibility !== 'peer-redacted');
  const peers = choice.listed.filter(row => row.visibility === 'peer-redacted');
  const amt = formatYuan(choice.newAmount);
  const formatFull = (row: import('./performance-store.js').CorrectionPickItem) => {
    const amount = row.amount !== undefined ? `${formatYuan(row.amount)}元` : '';
    const when = row.reportedAt ? `，报于 ${formatReportTime(row.reportedAt)}` : '';
    const owner = row.ownerName ? `，归属 ${row.ownerName}` : '';
    return `${row.index}. ${row.customerName ?? '（无客户名）'} ${amount}${when}（营业日 ${row.businessDay}${owner}）`;
  };
  if (visible.length === 0 && peers.length > 0) {
    const n = peers.length;
    const who = n === 1 ? '这位客户今天已有一笔别人报的单' : `这位客户今天已有 ${n} 笔别人报的单`;
    return `Front Claw：${who}。\n请回复「新增一笔」把它作为今天的另一笔，或回复「找店长改」（不会改账，会告诉你怎么找店长），或回「取消」。不要直接回「对」。`;
  }
  const lines = visible.map(formatFull);
  const peerNote = peers.length ? `\n另有 ${peers.length} 笔别人报的单（不显示金额和归属），要改请回复「找店长改」。` : '';
  const first = visible[0]?.index ?? 1;
  const amend = visible.length ? `或回复「改 ${first}」改已有的那笔（改成 ${amt}元），` : '';
  const managerOpt = peers.length ? '或回复「找店长改」，' : '';
  return `Front Claw：${choice.reason}\n本店今天已有记录：\n${lines.join('\n')}${peerNote}\n请回复「新增一笔」把它作为今天的另一笔，${amend}${managerOpt}或回「取消」。不要直接回「对」。`;
}
function formatReportTime(iso: string): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(iso)).map(p => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

/** D130：只判断真正的行尾备注。归属/复合/客套已在 interpretStandardTail 剥过。
 * 标准行尾部剩下的内容，不管 clauseKind 判成什么，都必须过 D130，不得用分句判断掏空。 */
function remarkForDraftPolicy(note: string): string {
  return note.normalize('NFKC').trim().replace(/^[，,;；、]+/, '').trim();
}

function withLeftover(reply: string, text: string, handled: ClauseKind): string {
  const note = leftoverNote(text, handled);
  return note ? `${reply}\n${note}` : reply;
}
function isNoNameAnswer(text: string): boolean {
  const flat = text.normalize('NFKC').replace(/[\s，,。.!！？?啊呀吧了呢哦嘛哈～~]+/g, '');
  if (!flat || flat.length > 40) return false;
  // 第二次明确说按未留名登记（「就按没留名登记」）也算回答。
  if (/没留名|未留名|没有名字|没有称呼|不知道名字|不记得名字|客人没说|没告诉/.test(flat)) return true;
  return /^(?:不知道|不清楚|没告诉|客人没说|不记得|无名)+$/.test(flat);
}
function customerAnswer(text: string): string | null {
  const flat = text.normalize('NFKC').trim().replace(/[。.!！]/g, '');
  if (!flat || flat.length > 8) return null;
  if (new RegExp(`^[\\u4e00-\\u9fa5](?:${HONORIFIC})$`).test(flat)) return flat;
  if (/^[\u4e00-\u9fa5]{2,3}$/.test(flat)) return flat;
  return null;
}
export const appointmentAskKey = (actor: Person, input: { sessionId?: string }) => `employee-loop:appointment-ask:${actor.personId}:${input.sessionId ?? ''}`;
export const appointmentTimeAskKey = (actor: Person, input: { sessionId?: string }) => `employee-loop:appointment-time-ask:${actor.personId}:${input.sessionId ?? ''}`;
type AppointmentTimeAsk = {
  text: string;
  issuedSequence: string;
  issuedAt: string;
  bindingVersion: number;
  accountId: string;
  storeId: string;
};

function readAppointmentTimeAsk(raw: string | null): AppointmentTimeAsk | null {
  if (!raw?.trim()) return null;
  try {
    const ask = JSON.parse(raw) as AppointmentTimeAsk | null;
    return typeof ask?.text === 'string' && typeof ask.issuedSequence === 'string' && Number.isFinite(Date.parse(ask.issuedAt))
      ? ask : null;
  } catch { return null; }
}
const DONT_REGISTER = /不用登记|不要登记|不用改单|不要改单|不用改(?:单|了)?|别登记|不用办|不要办|只是?吐槽|我就吐槽|我就说说/;

const NOT_FOUND_OR_DENIED = 'Front Claw：查不到，或你没有权限查看。';
class AccessRevoked extends Error { constructor() { super('access_revoked'); } }
/** R2：预检后策略被改（版本变化），本次未入账，草稿仍待确认。 */
export const POLICY_CHANGED = 'Front Claw：权限配置刚刚更新，这次没有入账，草稿还在；请按新权限重新回复「对」确认（无权限则会被拒绝）。';
const pinnedVersion = new WeakMap<object, number>();
const gateReasons = new WeakMap<object, string>();

export const STORE_HOURS_BROKEN = 'Front Claw：本店营业时间配置异常（时区或打烊时间），这次没有读取或写入，请联系管理员。';
/**
 * M01 的窄入口：业务事务仍由 PerformanceStore 承担，不运行旧入口的全局维护。
 * R1（M06-06）：按提交人门店读营业配置（时区/打烊），同一配置复用同一个处理核心；配置损坏 → 不读写。
 */
export function createEmployeeLoop(options: WecomBotHandlerOptions) {
  const defaults = { cutoff: options.cutoff ?? DEFAULT_BUSINESS_CUTOFF, timeZone: options.timeZone ?? DEFAULT_TIME_ZONE };
  const cores = new Map<string, (input: EmployeeMessage, preflightReply?: PreflightReply) => Promise<EmployeeLoopResult>>();
  return async (input: EmployeeMessage, preflightReply?: PreflightReply): Promise<EmployeeLoopResult> => {
    const pendingArrival = input.pendingArrival ?? capturePendingArrival(options.store);
    input = { ...input, pendingArrival };
    const arrival = structuredClone(await pendingArrival);
    let hours: { cutoff: string; timeZone: string } | null = defaults;
    try {
      const person = await options.resolve(input.memberId);
      if (person?.storeId) hours = resolveStoreHours(arrival.hours, person.storeId, defaults);
    } catch { hours = defaults; /* 解析失败交核心按原规则拒绝/报不可用 */ }
    if (!hours) {
      try { options.onEmployeeTrace?.({ messageId: input.messageId ?? '', elapsedMs: 0, outcome: 'reply', ledgerSettled: false }); } catch { /* 观测 */ }
      options.onOutbound?.(STORE_HOURS_BROKEN);
      return { entry: 'unified', replies: [STORE_HOURS_BROKEN], modelCalled: false };
    }
    const key = `${hours.timeZone}|${hours.cutoff}`;
    let core = cores.get(key);
    if (!core) { core = createLoopCore(options, hours.cutoff, hours.timeZone); cores.set(key, core); }
    return core(input, preflightReply);
  };
}

function createLoopCore(options: WecomBotHandlerOptions, cutoff: string, timeZone: string) {
  const { store, resolve, now, onOutbound, onEmployeeTrace } = options;
  /** R3（A-P1-1）：本条消息的全部消费者写入都经这里（带 M07 epoch）。 */
  const writesFor = (input?: EmployeeMessage) => consumerWrites(store, input?.fence, () => now().getTime());
  const appointmentTimeWrites = new Map<string, Promise<'saved' | 'superseded' | 'cancelled'>>();
  const tools = createAssistantTools({ store, now, cutoff, timeZone });
  const policyMode = options.accessPolicy === true;
  const platform = options.platformCapabilities;
  /** M03 统一鉴权：策略模式每次读最新策略；未启用策略时只保留 M01/M02 的本人/同店能力，不开放任何管理能力。 */
  async function can(actor: Person, capability: Capability, storeId = actor.storeId): Promise<boolean> {
    if (!policyMode) return capability === 'report_self' || capability === 'report_proxy' || capability === 'progress_self';
    return (await authorize(store, actor, capability, storeId, platform)).allowed;
  }
  const capFor = (draft: Draft): Capability => meta(draft)?.proxy ? 'report_proxy' : 'report_self';

  async function actorFor(memberId: string): Promise<Person | null> {
    const resolved = structuredClone(await resolve(memberId));
    if (!complete(resolved) || resolved.memberId !== memberId) return null;
    const current = structuredClone(await store.getPersonByAccount(resolved.accountId));
    if (!complete(current) || current.personId !== resolved.personId || current.memberId !== memberId || current.storeId !== resolved.storeId) return null;
    const member = structuredClone(await store.getPersonByMember(memberId));
    return member?.personId === current.personId && member.accountId === current.accountId ? current : null;
  }
  async function enabled(actor: Person): Promise<boolean> {
    try {
      const config = JSON.parse(await store.getConfig(EMPLOYEE_LOOP_CONFIG) ?? 'null') as unknown;
      if (!config || typeof config !== 'object') return false;
      const c = config as Record<string, unknown>;
      return c.enabled === true && c.storeId === actor.storeId && Array.isArray(c.memberIds) &&
        c.memberIds.every(valid) && c.memberIds.includes(actor.memberId);
    } catch { return false; }
  }
  function owned(draft: Draft, actor: Person, input: EmployeeMessage): boolean {
    const context = meta(draft);
    if (!context || draft.kind !== draft.payload.type || !LOOP_KINDS.includes(draft.kind)) return false;
    return draft.reporterPersonId === actor.personId && draft.storeId === actor.storeId &&
      context.accountId === actor.accountId && context.memberId === actor.memberId &&
      context.sessionId === input.sessionId && context.bindingVersion === input.bindingVersion &&
      (draft.payload.type === 'report' ? itemsIntact(draft, actor) : context.itemsDigest === ledgerDigest(draft));
  }
  /** M04：草稿所需能力与门店（确认前、提交事务内都按最新策略重判）。 */
  function needs(draft: Draft): { capability: Capability; storeIds: string[] } {
    if (draft.payload.type === 'target') return { capability: 'target_set', storeIds: [draft.payload.target.storeId] };
    if (draft.payload.type === 'correction') return { capability: draft.payload.scope === 'own' ? 'correct_own' : 'correct_store', storeIds: [...new Set(draft.payload.changes.map(change => change.storeId))] };
    if (draft.payload.type === 'appointment') return { capability: 'appointment_submit', storeIds: [draft.storeId] };
    return { capability: capFor(draft), storeIds: [draft.storeId] };
  }
  async function draftAllowed(actor: Person, draft: Draft): Promise<boolean> {
    const { capability, storeIds } = needs(draft);
    for (const storeId of storeIds) if (!await can(actor, capability, storeId)) return false;
    return true;
  }
  /** R1 入账门规格：能力/门店 + 被代报人（同店在职）/目标对象 + fencing。提交事务内与事务外用同一个。 */
  function specFor(draft: Draft, actor: Person, input?: EmployeeMessage): GateSpec {
    const { capability, storeIds } = needs(draft);
    const targets: GateTarget[] = draft.payload.type === 'report'
      ? draft.payload.added.map(item => ({ personId: item.employeeId ?? '', displayName: item.employeeName, storeId: draft.storeId }))
      : draft.payload.type === 'target' && draft.payload.target.kind !== 'store' ? [{ personId: draft.payload.target.personId, displayName: draft.payload.target.personName, storeId: draft.payload.target.storeId }] : [];
    const pinned = input ? pinnedVersion.get(input) : undefined;
    return { actor, capability, storeIds, targets, policyMode, platform, fence: input?.fence, binding: input?.binding, validate: input?.validateBinding, active: input ? () => !input.signal?.aborted && performance.now() < (input.deadline ?? Infinity) && (input.channelActive?.() ?? true) : undefined, nowMs: () => now().getTime(), ...(pinned !== undefined ? { policyVersion: pinned } : {}) };
  }
  function guardFor(draft: Draft, actor: Person, input?: EmployeeMessage, observe: readonly string[] = []): CommitGuard {
    return commitGuard({ ...specFor(draft, actor, input), observe }, reason => { if (input) gateReasons.set(input, reason); });
  }
  /** R2：确认预检时钉住策略版本（读不到/损坏钉 -1，提交时必不相等 → 拒绝）。 */
  async function pinPolicy(input: EmployeeMessage): Promise<void> {
    if (!policyMode) return;
    pinnedVersion.set(input, policyVersionOf(await store.getConfig(ACCESS_POLICY_KEY)) ?? -1);
  }
  /** R1：事务外同一判定（重放/缓存/查询发出前）。不带 fencing（只读回复，回复前由宿主再核对租约）。 */
  async function gateNow(draft: Draft, actor: Person): Promise<boolean> {
    return (await checkGateNow(store, specFor(draft, actor))).ok;
  }
  /** 有摘要：条目须与创建时一致（同店代报）；无摘要（M01 旧草稿）：只能是本人。 */
  function itemsIntact(draft: Draft, actor: Person): boolean {
    if (draft.payload.type !== 'report' || !draft.payload.added.length) return false;
    const digest = meta(draft)?.itemsDigest;
    if (digest === undefined) return draft.payload.added.every(item => item.employeeId === actor.personId);
    return digest === itemsDigest(draft.payload.added) && draft.payload.added.every(item => valid(item.employeeId));
  }
  /** 入账对象必须是本店在职、档案完整的人员；跨店或离职一律拒绝。 */
  async function targetsInStore(draft: Draft, actor: Person): Promise<boolean> {
    if (draft.payload.type !== 'report') return false;
    const people = await store.listPeople();
    return draft.payload.added.every(item => {
      const target = people.find(person => person.personId === item.employeeId);
      return complete(target ?? null) && target!.storeId === actor.storeId && target!.storeName === actor.storeName && target!.displayName === item.employeeName;
    });
  }
  function resultText(draft: Draft): string {
    const payload = draft.payload;
    if (draft.status === 'confirmed') return meta(draft)?.finalReply ?? 'Front Claw：已入账，可查本人进度。';
    if (draft.status === 'void') {
      if ('outcome' in payload && payload.outcome === 'conflict') return CONFLICT;
      if (payload.type === 'appointment' && payload.outcome === 'duplicate') return 'Front Claw：同样的预约已经登记过（另一条消息先确认了），这次没有重复登记。发「我的预约」可查预约号。';
      return payload.type === 'report' ? 'Front Claw：这张本人草稿已取消，没有入账。' : 'Front Claw：这张草稿已取消，没有写入。';
    }
    if (draft.status === 'confirming') return `Front Claw：结果未知，请查「入账结果 ${draft.draftId}」，或重发原确认消息。`;
    const tail = `操作号 ${draft.draftId}，回复「对」或「取消」。`;
    if (payload.type === 'target') {
      const t = payload.target;
      const label = t.kind === 'store' ? `${t.storeName} ${t.periodMonth} 门店月目标` : `${t.storeName} ${t.personName} ${t.periodMonth} 月目标`;
      return `Front Claw：目标还没生效：${label} ${formatYuan(t.amount)}元（原${payload.before ? ` ${formatYuan(payload.before.amount)}元` : '未设置'}）。\n${tail}`;
    }
    if (payload.type === 'appointment') {
      const item = payload.items[0]!;
      const who = payload.recipient ? `登记后提醒指定店长 ${payload.recipient.name}（仅提醒，无需回复）` : '登记后不排店长提醒（未配置指定店长、对方不能接收，或你就是指定店长），预约照样成立';
      return `Front Claw：预约还没登记：${payload.storeName ? `${payload.storeName} ` : ''}${describeWhen({ date: item.date!, time: item.time! })}，顾客 ${item.customer}${item.note ? `，项目 ${item.note}` : ''}。\n${who}。\n${tail}`;
    }
    if (payload.type === 'correction') {
      if (payload.awaitingPick) {
        const listed = payload.awaitingPick.listed.map(row =>
          `${row.index}. ${row.customerName ?? '（无客户名）'} ${formatYuan(row.amount ?? 0)}元，报于 ${formatReportTime(row.reportedAt ?? '')}（营业日 ${row.businessDay}，归属 ${row.ownerName ?? ''}）`);
        const first = payload.awaitingPick.listed[0]?.index ?? 1;
        return `Front Claw：${payload.awaitingPick.reason}\n你今天已报：\n${listed.join('\n')}\n请回复「改 ${first}」指定要改哪一笔（改成 ${formatYuan(payload.awaitingPick.newAmount)}元），或回「取消」。`;
      }
      const lines = payload.changes.map(change => {
        const customer = change.customerName ?? '';
        const when = change.reportedAt ? formatReportTime(change.reportedAt) : '';
        const identity = `原记录：${customer} ${formatYuan(change.before.amount)}元${when ? `，报于 ${when}` : ''}（营业日 ${change.businessDay}，归属 ${change.ownerName}）`;
        if (payload.action === 'withdraw') return `${identity}\n将作废：不再计入业绩\n${change.ownerName} ${formatYuan(change.before.amount)}元（${change.businessDay}）`;
        return `${identity}\n改为：${customer} ${yuanAmt(change.patch.amount)}元\n${change.ownerName}（${change.businessDay}）${formatYuan(change.before.amount)}元 → ${yuanAmt(change.patch.amount)}元`;
      });
      const head = payload.action === 'withdraw' ? `还没撤回：将作废以下 ${payload.changes.length} 笔，作废后不再计入业绩` : '还没改账（请核对原记录，不对请回「取消」）';
      return `Front Claw：${head}：\n${lines.join('\n')}\n${tail}`;
    }
    if (payload.type === 'report' && payload.awaitingDuplicateChoice) {
      return formatDuplicateChoice(payload.awaitingDuplicateChoice);
    }
    const items = payload.type === 'report' ? payload.added : [];
    const proxy = meta(draft)?.proxy ? '（同店代报，业绩记给括号里的员工）' : '';
    // D139-display：所有报单草稿单独一行显示「客户：X」（无客户名时「客户：（未写）」）。
    const formatReportLine = (item: ReportDraftItem): string => {
      const who = item.customer?.trim() ? item.customer.trim() : '（未写）';
      const money = `${item.employeeName} ${formatYuan(item.amount)}元${item.amountText ? `（${item.amountText} → ${formatYuan(item.amount)}）` : ''}${item.note ? `（备注：${item.note}）` : ''}`;
      return `客户：${who}\n${money}`;
    };
    const dup = payload.type === 'report' && payload.duplicates?.length
      ? `\n另有 ${payload.duplicates.length} 笔与今天已入账相同，已跳过：${payload.duplicates.map(item => `客户：${item.customer?.trim() || '（未写）'} ${item.employeeName} ${formatYuan(item.amount)}元`).join('、')}（如确是新的一笔，请在客户名或备注里写明区别后重发）` : '';
    return `Front Claw：还没入账${proxy}，${draft.businessDay}：\n${items.map(item => formatReportLine(item)).join('\n')}${dup}\n${tail}`;
  }
  function interleavedConfirmGuardReply(draft: Draft): string {
    const payload = draft.payload;
    let summary: string;
    if (payload.type === 'report') {
      summary = payload.added.map(item => `客户：${item.customer?.trim() || '（未写）'} ${formatYuan(item.amount)}元（${item.employeeName}）`).join('；');
    } else if (payload.type === 'target') {
      const t = payload.target;
      summary = `${t.storeName} ${t.kind === 'store' ? '门店' : t.personName} ${t.periodMonth} 目标 ${formatYuan(t.amount)}元`;
    } else if (payload.type === 'appointment') {
      summary = payload.items.map(item => `${item.customer} ${item.date && item.time ? describeWhen({ date: item.date, time: item.time }) : item.whenText}`).join('；');
    } else {
      summary = payload.changes.map(c => `${c.customerName ?? '（未写）'} ${formatYuan(c.before.amount)}元${c.patch.amount !== undefined ? ` → ${formatYuan(c.patch.amount)}元` : '（作废）'}`).join('；');
    }
    return `Front Claw：${D175_INTERLEAVED_GUIDANCE}\n待确认内容：${summary}\n操作号 ${draft.draftId}。`;
  }
  /** M04：今天本店已入账（未撤回）的行按多重集合抵扣：重发不增、追加只记新增、一份清单里同金额两笔都保留。 */
  async function splitDuplicates(storeId: string, businessDay: string, items: readonly ReportDraftItem[]): Promise<{ fresh: ReportDraftItem[]; duplicates: ReportDraftItem[] }> {
    const counts = new Map<string, number>();
    for (const row of await store.listEntries({ storeId, businessDay, status: 'confirmed' })) {
      const key = dupKey({ ownerPersonId: row.ownerPersonId, amount: row.amount, customer: row.customerName, note: row.note });
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const fresh: ReportDraftItem[] = [], duplicates: ReportDraftItem[] = [];
    for (const item of items) {
      const key = dupKey({ ownerPersonId: item.employeeId ?? '', amount: item.amount, customer: item.customer, note: item.note });
      const left = counts.get(key) ?? 0;
      if (left > 0) { counts.set(key, left - 1); duplicates.push(item); } else fresh.push(item);
    }
    return { fresh, duplicates };
  }
  /** R2：文本点名了目录里的其他门店（跨店）。 */
  function otherStoreMentioned(text: string, people: readonly Person[], actor: Person): boolean {
    const names = [...new Set(people.map(p => p.storeName).filter(name => valid(name) && name !== actor.storeName))];
    return names.some(name => text.includes(name) && !actor.storeName.includes(name));
  }
  /** R2：测试专用暂停点（读完数据之后、提交事务之前）；生产无操作。 */
  async function beforeCommit(draft: Draft): Promise<void> { const paused = pausePoint('commit-gate:before-commit', draft.draftId); if (paused) await paused; }
  /** R17 / D151：本次是否真的把 confirming 改成 confirmed（written>0）。按调用返回，不用跨请求共享状态。 */
  async function finish(draft: Draft, actor?: Person, input?: EmployeeMessage): Promise<Draft> {
    return (await finishReport(draft, actor, input)).saved;
  }
  async function finishReport(draft: Draft, actor?: Person, input?: EmployeeMessage): Promise<{ saved: Draft; changed: boolean }> {
    if (draft.payload.type !== 'report') throw Error('employee_draft');
    const total = draft.payload.added.reduce((sum, item) => sum + item.amount, 0);
    const finalReply = `Front Claw：已入账 ${draft.payload.added.length} 笔，共 ${formatYuan(total)}元。操作号 ${draft.draftId}。`;
    const next: Draft = { ...draft, status: 'confirmed', closedAt: now().toISOString(), payload: {
      ...draft.payload, employeeContext: { ...draft.payload.employeeContext!, finalReply },
    } };
    const entries: LedgerEntry[] = draft.payload.added.map((item, index) => ({
      entryId: confirmEntryId(draft.draftId, index), storeId: draft.storeId, businessDay: draft.businessDay,
      customerName: item.customer, amount: item.amount, amountType: 'consultant', ownerPersonId: item.employeeId!,
      ownerName: item.employeeName, reporterPersonId: draft.reporterPersonId, note: item.note,
      status: 'confirmed', disputed: false, createdAt: new Date(Date.parse(meta(draft)?.reportedAt ?? draft.createdAt) + index).toISOString(),
      sourceDraftId: draft.draftId, sourceOrdinal: index,
    }));
    // M03：策略模式下在提交事务内锁读策略行并按最新策略重判；被撤权则草稿退回待确认、零入账。
    const guard = actor ? guardFor(draft, actor, input) : undefined;
    await beforeCommit(draft);
    const written = await store.commitConfirmingDraft(next, entries, guard);
    if (written === -1) throw new AccessRevoked();
    const saved = (await store.getDraft(draft.draftId))!;
    return { saved, changed: written > 0 }; // R17-confirm-once
  }
  /** M04：目标/更正提交。草稿须已是 confirming；结果 denied → 草稿退回待确认（AccessRevoked）。 */
  async function finishLedger(draft: Draft, actor: Person, input?: EmployeeMessage): Promise<Draft> {
    const closedAt = now().toISOString();
    const payload = draft.payload;
    let result: LedgerCommit;
    if (payload.type === 'target') {
      const t = payload.target;
      const label = t.kind === 'store' ? `${t.storeName} ${t.periodMonth} 门店月目标` : `${t.storeName} ${t.personName} ${t.periodMonth} 月目标`;
      const finalReply = `Front Claw：已设目标：${label} ${formatYuan(t.amount)}元。操作号 ${draft.draftId}。`;
      const next: Draft = { ...draft, status: 'confirmed', closedAt, payload: { ...payload, employeeContext: { ...payload.employeeContext, finalReply } } };
      await beforeCommit(draft);
      if (t.kind === 'store') {
        const expected = payload.before ? { amount: payload.before.amount, setBy: payload.before.updatedBy, updatedAt: payload.before.updatedAt } : null;
        result = await store.commitConfirmingStoreTarget(next, { storeId: t.storeId, periodMonth: t.periodMonth, amount: t.amount, setBy: actor.personId, updatedAt: closedAt }, expected, guardFor(draft, actor, input));
      } else {
        result = await store.commitConfirmingTarget(next, { storeId: t.storeId, personId: t.personId, periodMonth: t.periodMonth, amount: t.amount, updatedBy: actor.personId, updatedAt: closedAt }, payload.before, guardFor(draft, actor, input));
      }
    } else if (payload.type === 'correction') {
      const total = payload.changes.length;
      const finalReply = payload.action === 'withdraw'
        ? `Front Claw：已撤回 ${total} 笔，不再计入业绩，修改记录已保存。操作号 ${draft.draftId}。`
        : `Front Claw：已改账：${payload.changes.map(c => `${c.ownerName} ${formatYuan(c.before.amount)}元 → ${yuanAmt(c.patch.amount)}元`).join('；')}，修改记录已保存。操作号 ${draft.draftId}。`;
      const next: Draft = { ...draft, status: 'confirmed', closedAt, payload: { ...payload, employeeContext: { ...payload.employeeContext, finalReply } } };
      const reason = payload.action === 'withdraw' ? `撤回（操作号 ${draft.draftId}）` : `更正金额（操作号 ${draft.draftId}）`;
      const recipients = [...new Set(payload.changes.flatMap(c => [c.ownerPersonId, c.reporterPersonId]))].filter(id => id !== actor.personId);
      const notices: Notification[] = recipients.map(recipientPersonId => ({
        notificationId: correctionNoticeId(draft.draftId, recipientPersonId), kind: 'correction', recipientPersonId, status: 'pending', relatedId: draft.draftId,
        body: `Front Claw：${actor.displayName}${payload.action === 'withdraw' ? '撤回了' : '更正了'}业绩：${payload.changes.map(c => payload.action === 'withdraw' ? `${c.ownerName} ${formatYuan(c.before.amount)}元（${c.businessDay}）` : `${c.ownerName}（${c.businessDay}）${formatYuan(c.before.amount)}元 → ${yuanAmt(c.patch.amount)}元`).join('；')}。操作号 ${draft.draftId}。`,
        createdAt: closedAt, sentAt: null,
      }));
      await beforeCommit(draft);
      result = await store.commitConfirmingCorrection(next, payload.changes.map(c => ({ entryId: c.entryId, beforeJson: c.beforeJson, patch: { ...c.patch }, revisionId: revisionIdFor(draft.draftId, c.entryId) })),
        { editorPersonId: actor.personId, reason, createdAt: closedAt }, notices, guardFor(draft, actor, input));
    } else throw Error('ledger_draft');
    if (result === 'denied') throw new AccessRevoked();
    return (await store.getDraft(draft.draftId))!;
  }
  /**
   * M05 指定店长：PG config 指定的本店一人，须在职、档案完整、仍在该店，且当前策略授予 appointment_receive。
   * 不合格或未配置 → null（预约照样成立，提醒待配置）。登记人本人就是指定店长 → 不给自己发。
   */
  async function recipientFor(storeId: string, actor: Person): Promise<{ person: Person | null; reason: 'ok' | 'self' | 'unset' | 'ineligible' }> {
    const personId = designatedRecipient(await store.getConfig(APPOINTMENT_RECIPIENTS_KEY), storeId);
    if (!personId) return { person: null, reason: 'unset' };
    if (personId === actor.personId) return { person: null, reason: 'self' };
    const person = await store.getPerson(personId);
    // R2（D5 已定）：指定收件人当前档位必须是店长（老板不提醒）。
    if (!complete(person) || person.storeId !== storeId || person.tier !== 'manager') return { person: null, reason: 'ineligible' };
    return await can(person, 'appointment_receive', storeId) ? { person, reason: 'ok' } : { person: null, reason: 'ineligible' };
  }
  const NO_RECIPIENT: Record<'self' | 'unset' | 'ineligible', string> = {
    self: '你就是本店指定店长，不另发提醒。',
    unset: '本店还没有配置指定店长，提醒待配置；预约不受影响。',
    ineligible: '指定店长当前不能接收提醒（不在本店或权限不符），提醒待配置；预约不受影响。',
  };
  const appointmentRows = (draft: Draft, payload: AppointmentPayload): Appointment[] => payload.items.map(item => ({
    appointmentId: appointmentContentId({ storeId: draft.storeId, employeePersonId: draft.reporterPersonId, whenText: item.whenText, customer: item.customer, note: item.note }),
    storeId: draft.storeId, employeePersonId: draft.reporterPersonId, customerName: item.customer, whenText: item.whenText, note: item.note,
    status: 'registered', createdAt: draft.createdAt,
  }));
  /**
   * M05 登记即成立：同一事务内 策略 FOR SHARE（登记人仍有 appointment_submit）→ 草稿 confirming→confirmed →
   * 预约 INSERT（内容确定 ID）→ 收件人资格按锁住的策略重判 → 待发提醒 INSERT（pending，不发送）。
   * 收件人不合格只丢提醒，不回滚预约；写提醒失败则整体回滚（不吞失败、不谎称已登记）。
   */
  async function finishAppointment(draft: Draft, actor: Person, input?: EmployeeMessage): Promise<Draft> {
    const payload = draft.payload;
    if (payload.type !== 'appointment') throw Error('appointment_draft');
    const closedAt = now().toISOString();
    const rows = appointmentRows(draft, payload);
    const found = await recipientFor(draft.storeId, actor);
    const recipient = found.person;
    const notices: Notification[] = recipient ? rows.map(row => ({
      notificationId: appointmentReminderId(row.appointmentId, recipient.personId), kind: 'appointment', recipientPersonId: recipient.personId,
      body: reminderBody({ storeName: actor.storeName, employeeName: actor.displayName, item: { date: payload.items[0]!.date!, time: payload.items[0]!.time!, customer: row.customerName, note: row.note }, appointmentId: row.appointmentId }),
      status: 'pending', relatedId: row.appointmentId, createdAt: closedAt, sentAt: null,
    })) : [];
    const no = rows.map(row => shortAppointmentNo(row.appointmentId)).join('、');
    const replyFor = (queued: boolean) => `Front Claw：预约已登记（登记即成立），预约号 ${no}。${queued && recipient
      ? `已排队提醒指定店长 ${recipient.displayName}（仅提醒，无需回复；尚未发送，送达情况发「我的预约」查）。`
      : NO_RECIPIENT[found.reason === 'ok' ? 'ineligible' : found.reason]}`;
    const next: Draft = { ...draft, status: 'confirmed', closedAt, payload: { ...payload, recipient: recipient ? { personId: recipient.personId, name: recipient.displayName } : null,
      employeeContext: { ...payload.employeeContext!, finalReply: replyFor(notices.length > 0) } } };
    await beforeCommit(draft);
    const result = await store.commitConfirmingAppointments(next, rows, {
      notices, guard: guardFor(draft, actor, input, recipient ? [recipient.personId] : []),
      // R1：收件人按事务内锁读的当前人员行判定（停用/调店/换绑 → 不排提醒，预约照样成立）。
      noticeAllowed: (_raw, notice, snapshot) => {
        if (!recipient || notice.recipientPersonId !== recipient.personId) return false;
        const current = snapshot ? snapshot.people[recipient.personId] ?? null : recipient;
        if (!complete(current) || current.storeId !== draft.storeId || current.memberId !== recipient.memberId) return false;
        return !policyMode || decideAccess(snapshot ? policyFrom(snapshot.config) : null, current, 'appointment_receive', draft.storeId, platform).allowed;
      },
    });
    if (result.outcome === 'denied') throw new AccessRevoked();
    // 收件人在提交事务内被判不合格（与撤权竞态）：预约已成立，提醒未排队——如实改写最终回复。
    if (result.outcome === 'committed' && notices.length && result.noticesWritten === 0) {
      const saved = (await store.getDraft(draft.draftId))!;
      if (saved.payload.type === 'appointment' && saved.payload.employeeContext) {
        await writesFor(input).rewriteDraft({ ...saved, payload: { ...saved.payload, recipient: null, employeeContext: { ...saved.payload.employeeContext, finalReply: replyFor(false) } } });
      }
    }
    return (await store.getDraft(draft.draftId))!;
  }
  const finishAny = (draft: Draft, actor: Person, input: EmployeeMessage) => draft.kind === 'report' ? finish(draft, actor, input) : draft.kind === 'appointment' ? finishAppointment(draft, actor, input) : finishLedger(draft, actor, input);
  /**
   * R18 / D152：员工循环里组装报单草稿的唯一地方。必须出示单闸签发的通行证（ConfirmableDraftPass）；
   * 二选一草稿（选「新增」后会变成可确认草稿）也从这里出。结构性测试钉住：本文件里报单草稿 payload 的字面量只出现在这里。
   */
  function buildConfirmableReportDraft(pass: ConfirmableDraftPass, args: {
    actor: Person; input: EmployeeMessage; fingerprint: string; operationId: string; businessDay: string;
    added: ReportDraftItem[]; duplicates: ReportDraftItem[];
    awaitingDuplicateChoice?: NonNullable<import('./performance-store.js').ReportPayload['awaitingDuplicateChoice']>;
  }): Draft {
    if (pass.marker !== 'R17-single-draft-gate') throw Error('confirmable_draft_without_gate_pass');
    const { actor, input, fingerprint, operationId, businessDay, added, duplicates, awaitingDuplicateChoice } = args;
    const proxy = added.some(item => item.employeeId !== actor.personId);
    return {
      draftId: operationId, reporterPersonId: actor.personId, storeId: actor.storeId, businessDay,
      expiresAt: zonedDateTime(businessDate(now(), cutoff, timeZone), cutoff, timeZone).toISOString(), kind: 'report',
      payload: { type: 'report', added, missing: [], skipped: duplicates.length, ...(duplicates.length ? { duplicates } : {}),
        ...(awaitingDuplicateChoice ? { awaitingDuplicateChoice } : {}),
        employeeContext: { sessionId: input.sessionId, bindingVersion: input.bindingVersion!, accountId: actor.accountId,
          memberId: actor.memberId, version: fingerprint, messageId: input.messageId, fingerprint,
          itemsDigest: itemsDigest(added), ...(proxy ? { proxy: true } : {}) } },
      status: 'pending', reminder: 'none', voidNotice: 'none', createdAt: now().toISOString(), closedAt: null,
    } as Draft;
  }
  async function finishAndReply(draft: Draft, actor: Person, input: EmployeeMessage): Promise<{ reply: string; settled: boolean; saved: Draft }> {
    if (draft.kind === 'report') {
      const { saved, changed } = await finishReport(draft, actor, input);
      if (!changed) return { reply: ALREADY_SETTLED_REPLY(saved.draftId), settled: false, saved };
      return { reply: resultText(saved), settled: saved.status === 'confirmed', saved };
    }
    const saved = await finishAny(draft, actor, input);
    return { reply: resultText(saved), settled: saved.status === 'confirmed', saved };
  }

  /** M05 预约查询：本人（appointment_submit）或本店（appointment_receive）；提醒状态如实取自通知表。 */
  async function appointmentQuery(actor: Person, text: string, memberId: string, tag: Tag): Promise<string | undefined> {
    const confirmCommand = /^确认预约(?:\s*\S+)?$/.test(text);
    if (confirmCommand) return 'Front Claw：现在预约登记即成立，店长只收提醒，不需要确认或回复。这条没有写入。';
    const mine = /^(?:我的预约|预约结果|我登记的预约|查.{0,8}预约)$/.test(text);
    const storeList = /^(?:预约列表|(?:今天|明天|本店)(?:的)?预约)$/.test(text);
    if (!mine && !storeList) return undefined;
    if (!policyMode) return 'Front Claw：预约登记当前未开放，没有读取或写入。';
    const today = businessDate(now(), cutoff, timeZone);
    const wantStore = storeList && await can(actor, 'appointment_receive', actor.storeId);
    if (!wantStore && !await can(actor, 'appointment_submit', actor.storeId)) return ACCESS_DENIED;
    const day = /^明天/.test(text) ? addDay(today, 1) : /^今天/.test(text) ? today : null;
    const all = await store.listAppointments(wantStore ? { storeId: actor.storeId, status: 'registered' } : { storeId: actor.storeId, employeePersonId: actor.personId, status: 'registered' });
    const rows = all.filter(row => day ? row.whenText.startsWith(day) : row.whenText.slice(0, 10) >= today).sort((a, b) => a.whenText.localeCompare(b.whenText));
    const notices = await store.listNotifications();
    const people = wantStore ? await store.listPeople() : [];
    const lines = rows.map(row => {
      const notice = notices.find(n => n.kind === 'appointment' && n.relatedId === row.appointmentId);
      const [date, time] = row.whenText.split(' ');
      const who = wantStore ? `${people.find(p => p.personId === row.employeePersonId)?.displayName ?? '同事'}登记，` : '';
      return `${describeWhen({ date: date!, time: time! })} ${row.customerName}${row.note ? ` ${row.note}` : ''}（${who}预约号 ${shortAppointmentNo(row.appointmentId)}；提醒：${notice ? reminderState(notice) : '待配置/未排队'}）`;
    });
    const reply = rows.length ? `Front Claw ${wantStore ? `${actor.storeName}预约` : '你登记的预约'}（登记即成立，店长无需回复）：\n${lines.join('\n')}` : `Front Claw：${wantStore ? '本店' : '你'}${day ? '这天' : '今天及以后'}没有登记的预约。`;
    // 发送前再验身份与授权。
    const current = await actorFor(memberId);
    if (!current || current.personId !== actor.personId) return DENIED;
    if (!await can(current, wantStore ? 'appointment_receive' : 'appointment_submit', actor.storeId)) return ACCESS_DENIED;
    tag.access = { capability: wantStore ? 'appointment_receive' : 'appointment_submit', storeIds: [actor.storeId] };
    return reply;
  }
  const addDay = (date: string, days: number) => { const [y, m, d] = date.split('-').map(Number); return new Date(Date.UTC(y!, m! - 1, d! + days)).toISOString().slice(0, 10); };
  /** M05：预约草稿（回显日期/星期/时间/顾客/项目/提醒对象），「对」后才登记。 */
  async function appointmentDraft(actor: Person, text: string, input: EmployeeMessage, fingerprint: string, today: string,
    parsed = parseAppointmentRequest(text, now(), timeZone)): Promise<Draft | string | undefined> {
    if (!parsed) return undefined;
    if (!policyMode) return 'Front Claw：预约登记当前未开放，没有写入。';
    // 先鉴权：无登记能力者不读预约表、不读指定店长配置。
    if (!await can(actor, 'appointment_submit', actor.storeId)) return ACCESS_DENIED;
    if (parsed.kind === 'ask_confirm_today') return askConfirmTodayReply(parsed.customer);
    if (parsed.kind === 'needs_time') {
      const { sequence } = await input.pendingArrival!;
      const ask: AppointmentTimeAsk = {
        text, issuedSequence: sequence, issuedAt: now().toISOString(), bindingVersion: input.bindingVersion!,
        accountId: actor.accountId, storeId: actor.storeId,
      };
      const key = appointmentTimeAskKey(actor, input);
      const previous = appointmentTimeWrites.get(key);
      const write = (async () => {
        await previous?.catch(() => {});
        const current = readAppointmentTimeAsk(await store.getConfig(key));
        if (current && !sequenceBefore(current.issuedSequence, sequence)) return 'superseded';
        if (input.signal?.aborted || performance.now() >= (input.deadline ?? Infinity)) return 'cancelled';
        await writesFor(input).putOperationRecord(key, JSON.stringify(ask));
        return 'saved';
      })();
      appointmentTimeWrites.set(key, write);
      try {
        const result = await write;
        if (result === 'cancelled') return 'Front Claw：请求已取消或超时，未开始新写入。';
        if (result === 'superseded') return 'Front Claw：已有更新的预约追问，请按最新提示回复时间。没有登记。';
      } finally {
        if (appointmentTimeWrites.get(key) === write) appointmentTimeWrites.delete(key);
      }
      return 'Front Claw：预约要说清几点，例如「明天下午3点王姐来做护理」。没有登记。';
    }
    if (parsed.kind === 'invalid') return 'Front Claw：预约的日期或时间写法不对，例如「11月20号下午3点」。没有登记。';
    if (parsed.kind === 'past') return `Front Claw：${describeWhen(parsed)} 已经过了，没有登记。请说清日期，例如「明天下午3点」。`;
    const item = parsed.item;
    const id = appointmentContentId({ storeId: actor.storeId, employeePersonId: actor.personId, whenText: item.whenText, customer: item.customer, note: item.note });
    if ((await store.listAppointments({ storeId: actor.storeId, employeePersonId: actor.personId })).some(row => row.appointmentId === id)) {
      return `Front Claw：这条预约已经登记过（${describeWhen(item)} ${item.customer}，预约号 ${shortAppointmentNo(id)}），没有重复登记。如是另一位顾客，请写上称呼或项目后重发。`;
    }
    const recipient = (await recipientFor(actor.storeId, actor)).person;
    const draft: Draft = {
      draftId: hash(['employee-loop:m05:appointment', input.sessionId, input.messageId]), reporterPersonId: actor.personId, storeId: actor.storeId, businessDay: today,
      expiresAt: zonedDateTime(today, cutoff, timeZone).toISOString(), kind: 'appointment',
      payload: { type: 'appointment', items: [item], storeName: actor.storeName, recipient: recipient ? { personId: recipient.personId, name: recipient.displayName } : null,
        employeeContext: contextFor(actor, input, fingerprint) },
      status: 'pending', reminder: 'none', voidNotice: 'none', createdAt: now().toISOString(), closedAt: null,
    };
    (draft.payload as AppointmentPayload).employeeContext!.itemsDigest = ledgerDigest(draft)!;
    return draft;
  }
  /**
   * M03 管理查询（仅策略模式）。门店范围由策略逐店判定后显式传入查询；
   * 拒绝与查无此人同一句话，不泄露对象是否存在；发送前再验身份与授权。
   */
  async function managementQuery(actor: Person, text: string, memberId: string, tag: Tag): Promise<string | undefined> {
    const day = businessDate(now(), cutoff, timeZone);
    const finalCheck = async (capability: Capability, storeIds: readonly string[], reply: string): Promise<string> => {
      const current = await actorFor(memberId);
      if (!current || current.personId !== actor.personId) return DENIED;
      for (const storeId of storeIds) if (!await can(current, capability, storeId)) return ACCESS_DENIED;
      tag.access = { capability, storeIds: [...storeIds] };
      return reply;
    };
    const other = /^(\S{1,12}?)的(?:今天|本月)?进度$/.exec(text);
    if (other && !/^(?:我|本人)$/.test(other[1]!)) {
      // 先按策略算出可查门店，再只在这些门店里匹配名字；无权者不读目录、不读账本。
      const stores = await authorizedStores(store, actor, 'progress_other', platform);
      if (!stores.length) return NOT_FOUND_OR_DENIED;
      const people = await store.listPeople();
      const allowed: Person[] = [];
      for (const storeId of stores) {
        const found = matchPerson(people, await store.listAliases(storeId), storeId, other[1]!);
        if (found && found.personId !== actor.personId && await can(actor, 'progress_other', storeId)) allowed.push(found);
      }
      if (allowed.length !== 1) return allowed.length ? 'Front Claw：这个名字对上不止一位，请说全名。' : NOT_FOUND_OR_DENIED;
      const target = allowed[0]!;
      const reply = (await tools.myProgress(target.accountId)).reply.replace(/^Front Claw/, `Front Claw ${target.displayName}`);
      return finalCheck('progress_other', [target.storeId], reply);
    }
    if (!/^(?:经营汇总|门店汇总|本店汇总|本月汇总)/.test(text) && isStorePerfQuery(text)) {
      const capability: Capability = 'store_summary';
      const people = await store.listPeople();
      const scope = storeById(people, actor.storeId);
      if (!scope || !await can(actor, capability, scope.storeId)) return ACCESS_DENIED;
      const reply = await storeSummary(store, scope, day);
      return finalCheck(capability, [scope.storeId], reply);
    }
    const summary = /^(?:经营汇总|门店汇总|本店汇总|本月汇总)(?:\s+(\S+))?$/.exec(text);
    const missing = /^(?:今天)?谁(?:还)?没报(?:\s+(\S+))?$/.exec(text);
    if (summary || missing) {
      const capability: Capability = summary ? 'store_summary' : 'unreported';
      const people = await store.listPeople();
      const named = (summary ?? missing)![1];
      const scope = named ? storeByName(people, named) : storeById(people, actor.storeId);
      if (!scope || !await can(actor, capability, scope.storeId)) return named ? NOT_FOUND_OR_DENIED : ACCESS_DENIED;
      const reply = summary ? await storeSummary(store, scope, day) : await unreported(store, scope, day);
      return finalCheck(capability, [scope.storeId], reply);
    }
    if (/^门店(?:排名|排行)$/.test(text)) {
      const storeIds = await authorizedStores(store, actor, 'stores_ranking', platform);
      if (!storeIds.length) return ACCESS_DENIED;
      const people = await store.listPeople();
      const scopes = storeIds.map(storeId => storeById(people, storeId) ?? { storeId, storeName: storeId });
      return finalCheck('stores_ranking', storeIds, await ranking(store, scopes, day));
    }
    return undefined;
  }
  /** M04：按策略算出可用门店，再只在这些门店里按名字匹配在职完整人员；无权者不读目录。 */
  async function findInStores(actor: Person, capability: Capability, name: string): Promise<Person | string> {
    const stores = await authorizedStores(store, actor, capability, platform);
    if (!stores.length) return ACCESS_DENIED;
    const people = await store.listPeople();
    const found: Person[] = [];
    for (const storeId of stores) {
      const person = matchPerson(people, await store.listAliases(storeId), storeId, name);
      if (person && complete(person) && person.storeId === storeId && !found.some(p => p.personId === person.personId)) found.push(person);
    }
    if (found.length !== 1) return found.length ? 'Front Claw：这个名字对上不止一位，请说全名。没有写入。' : NOT_FOUND_OR_DENIED;
    return found[0]!;
  }
  function contextFor(actor: Person, input: EmployeeMessage, fingerprint: string): EmployeeDraftContext {
    return { sessionId: input.sessionId!, bindingVersion: input.bindingVersion!, accountId: actor.accountId, memberId: actor.memberId,
      version: fingerprint, messageId: input.messageId!, fingerprint };
  }
  function ledgerDraft(kind: 'target' | 'correction', actor: Person, input: EmployeeMessage, today: string, payload: TargetPayload | CorrectionPayload): Draft {
    const draft: Draft = {
      draftId: hash([`employee-loop:m04:${kind}`, input.sessionId, input.messageId]), reporterPersonId: actor.personId, storeId: actor.storeId, businessDay: today,
      expiresAt: zonedDateTime(today, cutoff, timeZone).toISOString(), kind, payload,
      status: 'pending', reminder: 'none', voidNotice: 'none', createdAt: now().toISOString(), closedAt: null,
    };
    payload.employeeContext.itemsDigest = ledgerDigest(draft)!;
    return draft;
  }
  /** M04 目标：只生成草稿（回显姓名/门店/周期/金额/原值），「对」后才写。 */
  async function targetDraft(actor: Person, command: Exclude<ReturnType<typeof parseTargetCommand>, null>, input: EmployeeMessage, fingerprint: string, today: string): Promise<Draft | string> {
    if (command === 'invalid') return 'Front Claw：目标没说清。请按「给小赵定本月目标3万」或「本月目标 5w」发，金额支持 30000 / 3万 / 5w。没有写入。';
    const peopleNow = await store.listPeople();
    const namedStore = command.personName === null ? null
      : (command.personName === '本店' || command.personName === actor.storeName)
        ? { storeId: actor.storeId, storeName: actor.storeName }
        : storeByName(peopleNow, command.personName);
    if (namedStore) {
      if (!await can(actor, 'target_set', namedStore.storeId)) return ACCESS_DENIED;
      if (command.periodMonth < monthKey(today)) return 'Front Claw：只能设本月或以后的目标，没有写入。';
      const current = await store.getStoreTarget(namedStore.storeId, command.periodMonth);
      if (current?.amount === command.amount) return `Front Claw：${namedStore.storeName} ${command.periodMonth} 门店月目标已经是 ${formatYuan(command.amount)}元，没有变化，没有写入。`;
      return ledgerDraft('target', actor, input, today, {
        type: 'target', employeeContext: contextFor(actor, input, fingerprint),
        target: { storeId: namedStore.storeId, storeName: namedStore.storeName, personId: '', personName: namedStore.storeName, periodMonth: command.periodMonth, amount: command.amount, kind: 'store' },
        before: current ? { amount: current.amount, updatedBy: current.setBy, updatedAt: current.updatedAt } : null,
      });
    }
    let person: Person;
    if (command.personName === null) {
      if (!await can(actor, 'target_set', actor.storeId)) return ACCESS_DENIED;
      person = actor;
    } else {
      const found = await findInStores(actor, 'target_set', command.personName);
      if (typeof found === 'string') return found;
      person = found;
    }
    if (command.periodMonth < monthKey(today)) return 'Front Claw：只能设本月或以后的目标，没有写入。';
    const current = await store.getTarget(person.storeId, person.personId, command.periodMonth);
    if (current?.amount === command.amount) return `Front Claw：${person.displayName} ${command.periodMonth} 月目标已经是 ${formatYuan(command.amount)}元，没有变化，没有写入。`;
    return ledgerDraft('target', actor, input, today, {
      type: 'target', employeeContext: contextFor(actor, input, fingerprint),
      target: { storeId: person.storeId, storeName: person.storeName, personId: person.personId, personName: person.displayName, periodMonth: command.periodMonth, amount: command.amount },
      before: current ? { amount: current.amount, updatedBy: current.updatedBy, updatedAt: current.updatedAt } : null,
    });
  }
  function toPickItem(row: LedgerEntry, index: number, viewer: Person): CorrectionPickItem {
    const sameStoreManager = viewer.tier === 'manager' && viewer.storeId === row.storeId;
    const isOwn = row.reporterPersonId === viewer.personId;
    const base = { index, customerName: row.customerName, businessDay: row.businessDay, storeId: row.storeId, status: row.status };
    if (sameStoreManager) {
      return {
        ...base, visibility: isOwn ? 'own' as const : 'manager-full' as const,
        entryId: row.entryId, amount: row.amount, reportedAt: row.createdAt,
        ownerName: row.ownerName, ownerPersonId: row.ownerPersonId,
        beforeJson: entryVersion(row), reporterPersonId: row.reporterPersonId,
      };
    }
    if (isOwn) {
      // 普通员工看自己的单：可改 N，可见数据不含 reporterPersonId。
      return {
        ...base, visibility: 'own' as const,
        entryId: row.entryId, amount: row.amount, reportedAt: row.createdAt,
        ownerName: row.ownerName, ownerPersonId: row.ownerPersonId,
        beforeJson: entryVersion(row),
      };
    }
    return { ...base, visibility: 'peer-redacted' as const };
  }
  function changesFrom(rows: readonly LedgerEntry[], command: Exclude<ReturnType<typeof parseCorrectionCommand>, null | 'invalid'>): CorrectionChange[] {
    return rows.map(row => ({
      entryId: row.entryId, storeId: row.storeId, businessDay: row.businessDay, ownerPersonId: row.ownerPersonId, ownerName: row.ownerName,
      reporterPersonId: row.reporterPersonId, beforeJson: entryVersion(row), before: { amount: row.amount, status: row.status },
      patch: command.action === 'amend' ? { amount: command.amount } : { status: 'voided' as const },
      customerName: row.customerName, reportedAt: row.createdAt,
    }));
  }
  /**
   * M04/R4 更正：点名客户时按「客户名＋营业日＋报单人」唯一命中才选定；
   * 说了原金额则作附加核对（不符则拒绝）；0 或多项列出今天已报请「改 N」。
   * 无人名「刚才那笔」仍按本人最近批次（既有口径）。
   */
  async function correctionDraft(actor: Person, command: Exclude<ReturnType<typeof parseCorrectionCommand>, null>, input: EmployeeMessage, fingerprint: string, today: string): Promise<Draft | string> {
    if (command === 'invalid') return 'Front Claw：改账没说清。请说「把刚才那笔改成600」「把刚才第2笔改成600」或「把许姐那笔改成860」。没有写入。';
    const pickDraft = (listed: LedgerEntry[], reason: string, amount: number): Draft => {
      const awaitingPick = { newAmount: amount, listed: listed.map((row, i) => toPickItem(row, i + 1, actor)), reason };
      return ledgerDraft('correction', actor, input, today, {
        type: 'correction', employeeContext: contextFor(actor, input, fingerprint), action: 'amend', scope: 'own', changes: [], awaitingPick,
      });
    };
    let rows: LedgerEntry[];
    if (command.customerName) {
      if (!await can(actor, 'correct_own') && !await can(actor, 'correct_store')) return ACCESS_DENIED;
      const canStore = await can(actor, 'correct_store', actor.storeId);
      const todayRows = (await store.listEntries({ storeId: actor.storeId, businessDay: today, status: 'confirmed' }))
        .filter(row => row.status === 'confirmed' && row.storeId === actor.storeId && (canStore || row.reporterPersonId === actor.personId));
      const named = todayRows.filter(row => row.customerName === command.customerName);
      if (command.originalAmount != null) {
        const amt = named.filter(row => row.amount === command.originalAmount);
        if (named.length > 0 && amt.length === 0) {
          const actual = named.length === 1 ? `账上是 ${formatYuan(named[0]!.amount)}元` : `账上有 ${named.map(r => `${formatYuan(r.amount)}元`).join('、')}`;
          return `Front Claw：不能改——你说「${command.customerName}」原金额是 ${formatYuan(command.originalAmount)}元，但${actual}，对不上。没有写入。`;
        }
        if (amt.length === 1) rows = amt;
        else if (amt.length > 1) {
          if (command.action !== 'amend') return 'Front Claw：对上多笔，撤回请指定「改 N」或写清哪一笔。没有写入。';
          return pickDraft(amt, `「${command.customerName}」${canStore ? '今天本店' : '今天由你报的'}有 ${amt.length} 笔，金额都是 ${formatYuan(command.originalAmount)}元，不能确定是哪一笔。`, command.amount);
        } else {
          if (command.action !== 'amend') return `Front Claw：没有找到客户「${command.customerName}」今天由你报的记录，没有写入。`;
          return pickDraft(todayRows, `没有找到客户「${command.customerName}」${canStore ? '今天本店' : '今天由你报'}的记录。`, command.amount);
        }
      } else if (named.length === 1) {
        rows = named;
      } else {
        if (command.action !== 'amend') return `Front Claw：${named.length ? '对上多笔' : `没有找到该客户${canStore ? '今天本店' : '今天由你报'}的记录`}，没有写入。`;
        const listed = named.length ? named : todayRows;
        const reason = named.length
          ? `「${command.customerName}」${canStore ? '今天本店' : '今天由你报的'}有 ${named.length} 笔，不能确定是哪一笔。`
          : `没有找到客户「${command.customerName}」${canStore ? '今天本店' : '今天由你报'}的记录。`;
        return pickDraft(listed, reason, command.amount);
      }
    } else if (command.personName !== null) {
      if (command.index !== null) return 'Front Claw：指名更正只改该员工最近一笔，请不要同时写第几笔。没有写入。';
      const found = await findInStores(actor, 'correct_store', command.personName);
      if (typeof found === 'string') return found;
      const recent = await store.listEntries({ storeId: found.storeId, ownerPersonId: found.personId, status: 'confirmed' });
      const last = recent.at(-1);
      if (!last) return `Front Claw：${found.displayName} 没有可更正的账目，没有写入。`;
      // 入账时刻相同则“最近一笔”不唯一，不猜。
      if (recent.filter(row => row.createdAt === last.createdAt).length > 1) return AMBIGUOUS_RECENT;
      rows = [last];
    } else {
      // 无本人更正或门店更正能力者，不读本人批次与账目。
      if (!await can(actor, 'correct_own') && !await can(actor, 'correct_store')) return ACCESS_DENIED;
      const batches = (await store.listDrafts({ kind: 'report', status: 'confirmed', reporterPersonId: actor.personId, storeId: actor.storeId }))
        .filter(d => d.payload.type === 'report' && !!d.payload.employeeContext)
        .sort((a, b) => (a.closedAt ?? a.createdAt).localeCompare(b.closedAt ?? b.createdAt));
      const batch = batches.at(-1);
      if (batch && batches.filter(d => (d.closedAt ?? d.createdAt) === (batch.closedAt ?? batch.createdAt)).length > 1) return AMBIGUOUS_RECENT;
      if (!batch || batch.payload.type !== 'report') return 'Front Claw：没有找到你最近入账的报数，没有写入。';
      const all: (LedgerEntry | null)[] = [];
      for (let i = 0; i < batch.payload.added.length; i++) all.push(await store.getEntry(confirmEntryId(batch.draftId, i)));
      if (command.index !== null && !all[command.index - 1]) return `Front Claw：刚才那批没有第${command.index}笔，没有写入。`;
      rows = (command.index !== null ? [all[command.index - 1]!] : all.filter((row): row is LedgerEntry => !!row)).filter(row => row.status === 'confirmed');
      if (!rows.length) return 'Front Claw：刚才那批已经没有可更正的账目（可能已撤回），没有写入。';
      if (command.action === 'amend' && rows.length !== 1) return `Front Claw：刚才那批有 ${rows.length} 笔，请说「把刚才第2笔改成600」指明哪一笔。没有写入。`;
    }
    if (rows.some(row => row.status !== 'confirmed')) return 'Front Claw：这笔已经撤回，没有写入。';
    if (command.action === 'amend' && rows[0]!.amount === command.amount) return `Front Claw：金额已经是 ${formatYuan(command.amount)}元，没有变化，没有写入。`;
    const own = command.personName === null && rows.every(row => row.reporterPersonId === actor.personId && row.businessDay === today && row.storeId === actor.storeId);
    const changes: CorrectionChange[] = changesFrom(rows, command);
    const draft = ledgerDraft('correction', actor, input, today, { type: 'correction', employeeContext: contextFor(actor, input, fingerprint), action: command.action, scope: own ? 'own' : 'store', changes });
    return await draftAllowed(actor, draft) ? draft : ACCESS_DENIED;
  }

  async function dispatchClassifiedQuery(actor: Person, c: ModelClassification, memberId: string, tag: Tag): Promise<string> {
    const object = c.object;
    if (object === 'progress' || object === 'entry') {
      if (!await can(actor, 'progress_self')) return ACCESS_DENIED;
      const result = await tools.myProgress(actor.accountId);
      const current = await actorFor(memberId);
      if (!current || current.personId !== actor.personId) return DENIED;
      if (!await can(current, 'progress_self')) return ACCESS_DENIED;
      tag.access = { capability: 'progress_self', storeIds: [actor.storeId] };
      return result.reply;
    }
    if (object === 'performance' || object === 'summary' || object === 'completion' || object === 'target') {
      if (!policyMode) return ACCESS_DENIED;
      const capability: Capability = 'store_summary';
      const people = await store.listPeople();
      const scope = storeById(people, actor.storeId);
      if (!scope || !await can(actor, capability, scope.storeId)) return ACCESS_DENIED;
      const day = businessDate(now(), cutoff, timeZone);
      const reply = await storeSummary(store, scope, day);
      const current = await actorFor(memberId);
      if (!current || current.personId !== actor.personId) return DENIED;
      if (!await can(current, capability, scope.storeId)) return ACCESS_DENIED;
      tag.access = { capability, storeIds: [scope.storeId] };
      return reply;
    }
    if (object === 'ranking') {
      if (!policyMode) return ACCESS_DENIED;
      const storeIds = await authorizedStores(store, actor, 'stores_ranking', platform);
      if (!storeIds.length) return ACCESS_DENIED;
      const people = await store.listPeople();
      const scopes = storeIds.map(id => storeById(people, id) ?? { storeId: id, storeName: id });
      const day = businessDate(now(), cutoff, timeZone);
      const reply = await ranking(store, scopes, day);
      const current = await actorFor(memberId);
      if (!current || current.personId !== actor.personId) return DENIED;
      tag.access = { capability: 'stores_ranking', storeIds: [...storeIds] };
      return reply;
    }
    if (object === 'appointment') {
      const got = await appointmentQuery(actor, '我的预约', memberId, tag);
      return got ?? ACCESS_DENIED;
    }
    return ACCESS_DENIED;
  }
  async function handleClassified(
    actor: Person, text: string, input: EmployeeMessage, tag: Tag,
    fingerprint: string, today: string, pending: Draft[], drafts: Draft[],
  ): Promise<{ reply: string; kind?: 'ask'; operationId?: string; access?: Access } | undefined> {
    const raw = input.modelClassification;
    if (!raw) return undefined;
    const chain = validateModelChain({ text, output: raw, context: isStandardAmountLine(text) ? 'standard-line' : 'free' });
    if (!chain.ok) return { reply: chain.ask, kind: 'ask' };
    const c = chain.classification;
    if (isReadOnlyQuery(c)) {
      const q = await dispatchClassifiedQuery(actor, c, input.memberId, tag);
      return { reply: q, ...(tag.access ? { access: tag.access } : {}) };
    }
    const amend = c.intent === 'amend' || c.action === 'amend';
    const withdraw = c.intent === 'withdraw' || c.action === 'cancel' || c.action === 'delete';
    if (!amend && !withdraw) return undefined;
    if (!policyMode) return { reply: 'Front Claw：目标设置和改账当前未开放，没有写入。' };
    if (pending.length || drafts.some(d => d.status === 'confirming')) {
      return { reply: 'Front Claw：请先确认或取消当前草稿，结果未知时查原操作号。' };
    }
    if (withdraw) {
      const command = { action: 'withdraw' as const, index: c.slots.index ?? null, personName: null, customerName: c.slots.customer ?? null };
      const built = await correctionDraft(actor, command, input, fingerprint, today);
      return await submitClassifiedDraft(built, actor, input, fingerprint, text, tag);
    }
    if (chain.amountCents === undefined) return { reply: clarifyQuestion('missing_amount'), kind: 'ask' };
    const command = { action: 'amend' as const, amount: chain.amountCents, index: c.slots.index ?? null, personName: null, customerName: c.slots.customer ?? null };
    const built = await correctionDraft(actor, command, input, fingerprint, today);
    return await submitClassifiedDraft(built, actor, input, fingerprint, text, tag);
  }
  async function submitClassifiedDraft(
    built: Draft | string, actor: Person, input: EmployeeMessage, fingerprint: string, text: string, tag: Tag,
  ): Promise<{ reply: string; operationId?: string; access?: Access }> {
    if (typeof built === 'string') return { reply: built };
    const latest = await actorFor(input.memberId);
    if (!latest || !owned(built, latest, input) || !await enabled(latest)) return { reply: DENIED };
    if (!await draftAllowed(latest, built)) return { reply: ACCESS_DENIED };
    await writesFor(input).createDraft(built);
    const saved = await store.getDraft(built.draftId);
    if (!saved || !owned(saved, latest, input) || meta(saved)?.fingerprint !== fingerprint) {
      return { reply: 'Front Claw：同一消息内容冲突，未写入。' };
    }
    const interleavedKey = d175InterleavedKey(latest.personId, input.sessionId ?? '');
    if ((await store.getConfig(interleavedKey))?.trim()) {
      await writesFor(input).putOperationRecord(interleavedKey, '');
    }
    tag.access = needs(saved);
    return { reply: withLeftover(resultText(saved), text, 'correction'), operationId: saved.draftId, access: needs(saved) };
  }
  return async (original: EmployeeMessage, preflightReply?: PreflightReply): Promise<EmployeeLoopResult> => {
    const input = { ...original };
    const started = performance.now();
    let operationId: string | undefined;
    let outcome: EmployeeTrace['outcome'] = 'reply';
    let ledgerSettled = false;
    let newMessagePrepared = false;
    const tag: Tag = {};
    const active = () => !input.signal?.aborted && performance.now() < (input.deadline ?? Infinity);
    let abandonedPendingReminder = '';
    let expiredPendingReminder = '';
    let pendingSnapshot: { actorId: string; drafts: Draft[]; ask: SavedNewCustomerAsk | null } | undefined;
    const response: { kind: 'ask' | 'reply'; occupiesPending: boolean } = { kind: 'reply', occupiesPending: false };
    const askReply = (reply: string) => { response.kind = 'ask'; return reply; };
    let askRaw: string | null | undefined;
    let askRead = false;
    const readAsk = async (key: string) => {
      if (!askRead) { askRaw = await store.getConfig(key); askRead = true; }
      return askRaw;
    };
    const advance = async (actor: Person, drafts: Draft[], admission?: PendingReportAdmission, expireOnly = false) => {
      const askKey = newCustomerAskKey(actor.personId, input.sessionId ?? '');
      const slot = await advancePendingSlot({ drafts, askKey, text: input.text.trim(), ...(admission ? { admission } : {}),
        readAsk: () => readAsk(askKey), writes: writesFor(input), now, active, expiredReply: DRAFT_EXPIRED_REREPORT, arrivedAt: input.arrivedAt, arrivedSequence: (await input.pendingArrival!).sequence, expireOnly });
      if (slot.reminder) abandonedPendingReminder = slot.reminder;
      if (slot.expiredReminder) expiredPendingReminder += (expiredPendingReminder ? '\n' : '') + slot.expiredReminder;
      if (!slot.pendingAsk) askRaw = '';
      return slot;
    };
    const clearInterleaved = async (actor: Person): Promise<void> => {
      const key = d175InterleavedKey(actor.personId, input.sessionId ?? '');
      if ((await store.getConfig(key))?.trim()) {
        await writesFor(input).putOperationRecord(key, '');
      }
    };
    const saveReport = async (actor: Person, draft?: Draft, ask?: { key: string; value: string }, expectedAsk?: SavedNewCustomerAsk) => {
      const at = now().toISOString();
      if (expectedAsk && !askRaw) return false;
      if (draft) {
        if (meta(draft)) {
          meta(draft)!.reportedAt = draft.createdAt;
          if (input.arrivedAt) meta(draft)!.platformIssuedAt = input.arrivedAt;
        }
        draft.createdAt = at;
        if (expiredPendingReminder && meta(draft)) meta(draft)!.replacedPending = true;
      }
      const expected = expectedAsk && askRaw ? { key: newCustomerAskKey(actor.personId, input.sessionId!), value: askRaw,
        arrivedSequence: confirmationSequence(expectedAsk.platformIssuedAt ?? expectedAsk.issuedAt ?? '', input.arrivedAt, !!expectedAsk.replacedPending, (await input.pendingArrival!).sequence) } : undefined;
      const result = await writesFor(input).savePendingReport({ reporterPersonId: actor.personId, at, ...(draft ? { draft } : {}), ...(ask ? { ask } : {}), ...(expected ? { expectedAsk: expected } : {}) });
      if (result.saved) await clearInterleaved(actor);
      const notices = result.drafts.flatMap(d => reportLabels(d).map(n => `上一笔「${n}」没有确认，已作废，需要的话请重新报。`));
      for (const raw of result.asks) for (const name of (JSON.parse(raw) as SavedNewCustomerAsk).names) notices.push(`上一条「${name}」没有记，需要的话请重新报。`);
      if (notices.length) abandonedPendingReminder = notices.join('\n');
      return result.saved;
    };
    const run = async (): Promise<string> => {
      if (!valid(input.messageId) || !valid(input.sessionId) || !Number.isSafeInteger(input.bindingVersion) || input.bindingVersion! < 1) return DENIED;
      const actor = await actorFor(input.memberId);
      if (!actor) return DENIED;
      let text = input.text.trim();
      // M03 入口鉴权：策略缺失、损坏、无授权、停用或角色不符时，在任何业务读写前拒绝。
      if (policyMode && !standing(await readPolicy(store), actor).allowed) return ACCESS_DENIED;
      // D179 统一过期收尾：先生成本请求私有快照并关闭过期项，所有正常分支共用；
      // 回复只在循环出口追加。expireOnly 不消费有效追问，正常确认仍复用这一次 config 读取。
      let drafts = structuredClone(await store.listDrafts({ reporterPersonId: actor.personId, storeId: actor.storeId }))
        .filter(d => owned(d, actor, input));
      const expiredSlot = await advance(actor, drafts, undefined, true);
      if (expiredSlot.blocked) return 'Front Claw：请求已取消或草稿版本已变化，请查原操作结果。';
      drafts = expiredSlot.drafts;
      if (expiredSlot.expired.length > 0 && active()) await clearInterleaved(actor);
      pendingSnapshot = structuredClone({ actorId: actor.personId, drafts, ask: expiredSlot.pendingAsk });
      const replay = drafts.find(d => meta(d)?.messageId === input.messageId || meta(d)?.actionMessageId === input.messageId);
      const timeAskKey = appointmentTimeAskKey(actor, input);
      const askedTimeRaw = policyMode && !replay ? await store.getConfig(timeAskKey) : null;
      const timeAsk = readAppointmentTimeAsk(askedTimeRaw);
      let clockReply: string | null = null;
      const arrivedSequence = (await input.pendingArrival!).sequence;
      if (timeAsk && sequenceBefore(timeAsk.issuedSequence, arrivedSequence)) {
        if (!active()) return 'Front Claw：请求已取消或超时，未开始新写入。';
        const { compareAndSetPendingAsk } = writesFor(input);
        const consumed = await compareAndSetPendingAsk(timeAskKey, askedTimeRaw!, '', { arrivedSequence });
        if (consumed && preflightReply === undefined && timeAsk.bindingVersion === input.bindingVersion
            && timeAsk.accountId === actor.accountId && timeAsk.storeId === actor.storeId) {
          clockReply = parseStandaloneAppointmentTime(text);
        }
      }
      // D185：过期追问的肯定答复只返回已消费的 D176；不落入通用提示或 D143。
      if (expiredSlot.expiredAsk && (isYesNewCustomerReply(text) || /^(?:好的?)[。.!！]?$/.test(text.normalize('NFKC')))) {
        const reply = expiredPendingReminder; expiredPendingReminder = ''; return reply;
      }
      // D181-4：过期草稿收到确认词只回 D143。
      if (isConfirmCommand(text) && expiredSlot.expiredReminder) { expiredPendingReminder = ''; return DRAFT_EXPIRED_REREPORT; }
      if (preflightReply !== undefined) {
        if (!active()) return 'Front Claw：请求已取消或超时，未开始新写入。';
        const markInterleaved = typeof preflightReply === 'object' && preflightReply.markInterleaved === true;
        if (markInterleaved) {
          const activePending = drafts.filter(d => d.status === 'pending' && !pendingExpired(d.expiresAt, now()));
          if (activePending.length === 1) {
            await writesFor(input).putOperationRecord(d175InterleavedKey(actor.personId, input.sessionId!), activePending[0]!.draftId);
          }
        }
        newMessagePrepared = true;
        return typeof preflightReply === 'string' ? preflightReply : preflightReply.kind === 'ask' ? askReply(preflightReply.text) : preflightReply.text;
      }
      const same = (current: Person | null) => !!current && current.personId === actor.personId && current.accountId === actor.accountId && current.storeId === actor.storeId;
      // D175：查询和入口预检不迁移有效挂起位；D179 过期收尾已完成。开关关闭仍可查本人历史。
      if (['我的进度', '今天进度', '进度'].includes(text) || isSelfProgressQuery(text)) {
        if (!await can(actor, 'progress_self')) return ACCESS_DENIED;
        const result = await tools.myProgress(actor.accountId);
        const current = await actorFor(input.memberId);
        // 查询发送前再验身份与授权。
        if (!same(current)) return DENIED;
        if (!await can(current!, 'progress_self')) return ACCESS_DENIED;
        tag.access = { capability: 'progress_self', storeIds: [actor.storeId] };
        return result.reply;
      }
      if (policyMode) {
        const managed = await managementQuery(actor, text, input.memberId, tag);
        if (managed !== undefined) return managed;
      }
      const appointmentAnswer = await appointmentQuery(actor, text, input.memberId, tag);
      if (appointmentAnswer !== undefined) return appointmentAnswer;
      const query = /^入账结果(?:\s+(\S+))?$/.exec(text);
      if (query) {
        const ref = query[1];
        const found = ref ? drafts.find(d => d.draftId === ref || meta(d)?.messageId === ref || meta(d)?.actionMessageId === ref) : drafts.at(-1);
        if (!found) return 'Front Claw：没有可查的本人操作结果。';
        const current = await actorFor(input.memberId);
        if (!current || !owned(found, current, input)) return DENIED;
        if (!await can(current, 'progress_self')) return ACCESS_DENIED;
        operationId = found.draftId; ledgerSettled = found.status === 'confirmed';
        tag.access = { capability: 'progress_self', storeIds: [actor.storeId] };
        return resultText(found);
      }
      // R18 / D160：确认指令保留「刚确认过」标记，其余消息清掉。
      if (!isConfirmCommand(text) && (await store.getConfig(d160Key(actor.personId, input.sessionId)))?.trim()) {
        await writesFor(input).putOperationRecord(d160Key(actor.personId, input.sessionId), '');
      }
      const fingerprint = hash([text]);
      if (replay) {
        operationId = replay.draftId;
        const context = meta(replay)!;
        const expected = context.messageId === input.messageId ? context.fingerprint : context.actionFingerprint;
        if (expected !== fingerprint) return 'Front Claw：同一消息内容冲突，未写入。';
        if (replay.status === 'confirming' && context.actionMessageId === input.messageId && active() && await enabled(actor)) {
          const latest = await actorFor(input.memberId);
          if (!latest || !owned(replay, latest, input)) return DENIED;
          // R1（M03-03）：恢复分支与正常确认同样复核被代报人同店在职；提交事务内入账门再判一次。
          if (replay.kind === 'report' && !await targetsInStore(replay, latest)) return DENIED;
          await pinPolicy(input);
          if (!await draftAllowed(latest, replay)) return ACCESS_DENIED;
          const done = await finishAndReply(replay, latest, input);
          if (done.settled) await clearInterleaved(actor);
          ledgerSettled = done.settled; tag.access = needs(replay); return done.reply;
        }
        // R1（M03-04）：去重不等于授权——返回历史结果前按当前数据过同一入账门（不含 fencing）。
        if (policyMode && !await gateNow(replay, actor)) return ACCESS_DENIED;
        ledgerSettled = replay.status === 'confirmed'; tag.access = needs(replay); return resultText(replay);
      }
      if (!await enabled(actor)) return DISABLED;
      if (!active()) return 'Front Claw：请求已取消或超时，未开始新写入。';
      const slot = await advance(actor, drafts);
      if (slot.blocked) return 'Front Claw：请求已取消或草稿版本已变化，请查原操作结果。';
      drafts = slot.drafts;
      if (slot.expired.length > 0 && active()) await clearInterleaved(actor);
      if (slot.staleAsk) return slot.staleAsk.replacedPending ? newerPendingReply(slot.staleAsk.listed.map(i => `${i.customer ?? '未留名'} ${formatYuan(i.amount)}元`)) : newCustomerAskReply(slot.staleAsk.names);
      const expiredClosed = [...expiredSlot.expired, ...slot.expired];
      const pending = drafts.filter(d => d.status === 'pending');
      if (expiredClosed.length && pending.length === 0 && (isConfirmCommand(text) || text === '取消')) {
        if (text === '取消') return resultText(expiredClosed[expiredClosed.length - 1]!);
        return DRAFT_EXPIRED_REREPORT;
      }
      if (parseAskManagerChoice(text)) {
        const waitingMgr = pending.find(d => d.payload.type === 'report' && d.payload.awaitingDuplicateChoice);
        if (!waitingMgr || waitingMgr.payload.type !== 'report' || !waitingMgr.payload.awaitingDuplicateChoice) {
          return 'Front Claw：当前没有待选择的新增或改单。没有写入。';
        }
        return ASK_MANAGER_HINT;
      }
      if (parseAddNewChoice(text)) {
        const waiting = pending.find(d => d.payload.type === 'report' && d.payload.awaitingDuplicateChoice);
        if (!waiting || waiting.payload.type !== 'report' || !waiting.payload.awaitingDuplicateChoice) {
          return 'Front Claw：当前没有待选择的新增或改单。没有写入。';
        }
        const latestAdd = await actorFor(input.memberId);
        if (!latestAdd || !owned(waiting, latestAdd, input) || !await enabled(latestAdd) || !active()) return DENIED;
        const ctxAdd = waiting.payload.employeeContext;
        if (!ctxAdd) return DENIED;
        const { awaitingDuplicateChoice: _drop, ...restAdd } = waiting.payload;
        const nextPayloadAdd = { ...restAdd, explicitNew: true as const, employeeContext: { ...ctxAdd, fingerprint: hash([text]), messageId: input.messageId! } };
        const nextAdd: Draft = { ...waiting, payload: nextPayloadAdd };
        const digestAdd = ledgerDigest(nextAdd);
        if (digestAdd) nextAdd.payload.employeeContext = { ...nextAdd.payload.employeeContext!, itemsDigest: digestAdd };
        if (!await draftAllowed(latestAdd, nextAdd)) return ACCESS_DENIED;
        await writesFor(input).rewriteDraft(nextAdd);
        await clearInterleaved(actor);
        const savedAdd = await store.getDraft(nextAdd.draftId);
        if (!savedAdd) return 'Front Claw：草稿版本已变化，请查原操作结果。';
        operationId = savedAdd.draftId; tag.access = needs(savedAdd);
        return resultText(savedAdd);
      }
      const waitingReportPreview = pending.find(d => d.payload.type === 'report' && d.payload.awaitingDuplicateChoice);
      const previewListed = waitingReportPreview && waitingReportPreview.payload.type === 'report' && waitingReportPreview.payload.awaitingDuplicateChoice
        ? waitingReportPreview.payload.awaitingDuplicateChoice.listed : undefined;
      const visibleCount = previewListed?.filter(r => r.visibility !== 'peer-redacted').length;
      const pickCmd = parseCorrectionPick(text, visibleCount || previewListed?.length);
      if (pickCmd) {
        const waitingReport = pending.find(d => d.payload.type === 'report' && d.payload.awaitingDuplicateChoice);
        if (waitingReport && waitingReport.payload.type === 'report' && waitingReport.payload.awaitingDuplicateChoice) {
          const listedChoice = waitingReport.payload.awaitingDuplicateChoice.listed;
          const rowChoice = listedChoice.find(item => item.index === pickCmd.index);
          if (!rowChoice || rowChoice.visibility === 'peer-redacted' || !rowChoice.entryId || rowChoice.amount === undefined || !rowChoice.beforeJson) {
            if (listedChoice.some(r => r.visibility === 'peer-redacted')) return PEER_ENTRY_HINT;
            return `Front Claw：没有第${pickCmd.index}笔，请从清单里选一个编号回复「改 ${listedChoice.filter(r => r.visibility !== 'peer-redacted')[0]?.index ?? 1}」。没有写入。`;
          }
          if (!policyMode) return 'Front Claw：目标设置和改账当前未开放，没有写入。';
          const latestChoice = await actorFor(input.memberId);
          if (!latestChoice || !owned(waitingReport, latestChoice, input) || !await enabled(latestChoice) || !active()) return DENIED;
          const newAmount = waitingReport.payload.awaitingDuplicateChoice.newAmount;
          if (rowChoice.amount === newAmount) return `Front Claw：金额已经是 ${formatYuan(rowChoice.amount)}元，没有变化，没有写入。`;
          const commandChoice = { action: 'amend' as const, amount: newAmount, index: null, personName: null, customerName: rowChoice.customerName };
          const entryChoice = await store.getEntry(rowChoice.entryId);
          if (!entryChoice || entryChoice.status !== 'confirmed' || entryVersion(entryChoice) !== rowChoice.beforeJson) return 'Front Claw：这笔在你指定前已被改动，这次没有写入，请重新发起。';
          const changesChoice = changesFrom([entryChoice], commandChoice);
          const ownChoice = entryChoice.reporterPersonId === latestChoice.personId && entryChoice.businessDay === businessDate(now(), cutoff, timeZone) && entryChoice.storeId === latestChoice.storeId;
          const ctxChoice = waitingReport.payload.employeeContext;
          if (!ctxChoice) return DENIED;
          const nextPayloadChoice: CorrectionPayload = {
            type: 'correction', employeeContext: { ...ctxChoice, fingerprint: hash([text]), messageId: input.messageId!, itemsDigest: '' },
            action: 'amend', scope: ownChoice ? 'own' : 'store', changes: changesChoice,
          };
          const nextChoice: Draft = { ...waitingReport, kind: 'correction', payload: nextPayloadChoice };
          nextPayloadChoice.employeeContext.itemsDigest = ledgerDigest(nextChoice)!;
          if (!await draftAllowed(latestChoice, nextChoice)) return ACCESS_DENIED;
          await writesFor(input).rewriteDraft(nextChoice);
          await clearInterleaved(actor);
          const savedChoice = await store.getDraft(nextChoice.draftId);
          if (!savedChoice) return 'Front Claw：草稿版本已变化，请查原操作结果。';
          operationId = savedChoice.draftId; tag.access = needs(savedChoice);
          return resultText(savedChoice);
        }
        const waiting = pending.find(d => d.payload.type === 'correction' && d.payload.awaitingPick);
        if (!waiting || waiting.payload.type !== 'correction' || !waiting.payload.awaitingPick) {
          return 'Front Claw：当前没有待指定的改账清单。请先说明要改哪一笔。没有写入。';
        }
        const listed = waiting.payload.awaitingPick.listed;
        const row = listed.find(item => item.index === pickCmd.index);
        if (!row || !row.entryId || row.amount === undefined || !row.beforeJson) return `Front Claw：没有第${pickCmd.index}笔，请从清单里选一个编号回复「改 N」。没有写入。`;
        if (row.amount === waiting.payload.awaitingPick.newAmount) return `Front Claw：金额已经是 ${formatYuan(row.amount)}元，没有变化，没有写入。`;
        if (!policyMode) return 'Front Claw：目标设置和改账当前未开放，没有写入。';
        const latest = await actorFor(input.memberId);
        if (!latest || !owned(waiting, latest, input) || !await enabled(latest) || !active()) return DENIED;
        const command = { action: 'amend' as const, amount: waiting.payload.awaitingPick.newAmount, index: null, personName: null, customerName: row.customerName };
        const entry = await store.getEntry(row.entryId);
        if (!entry || entry.status !== 'confirmed' || entryVersion(entry) !== row.beforeJson) return 'Front Claw：这笔在你指定前已被改动，这次没有写入，请重新发起。';
        const changes = changesFrom([entry], command);
        const own = entry.reporterPersonId === latest.personId && entry.businessDay === businessDate(now(), cutoff, timeZone) && entry.storeId === latest.storeId;
        const ctx = waiting.payload.employeeContext;
        if (!ctx) return DENIED;
        const nextPayload: CorrectionPayload = {
          type: 'correction', employeeContext: { ...ctx, fingerprint: hash([text]), messageId: input.messageId!, itemsDigest: '' },
          action: 'amend', scope: own ? 'own' : 'store', changes,
        };
        const next: Draft = { ...waiting, payload: nextPayload };
        nextPayload.employeeContext.itemsDigest = ledgerDigest(next)!;
        if (!await draftAllowed(latest, next)) return ACCESS_DENIED;
        await writesFor(input).rewriteDraft(next);
        await clearInterleaved(actor);
        const saved = await store.getDraft(next.draftId);
        if (!saved) return 'Front Claw：草稿版本已变化，请查原操作结果。';
        operationId = saved.draftId; tag.access = needs(saved);
        return resultText(saved);
      }
      // D172 / D174：读取、过期与消费均由统一挂起位负责；肯定答复仍须重过 D152。
      const savedAsk = slot.ask;
      if (savedAsk) {
        if (/^(?:不是|取消)[。.!！]?$/.test(text.normalize('NFKC'))) return 'Front Claw：好的，这条没有记。';
        if (isYesNewCustomerReply(text)) {
          if (pending.length || drafts.some(d => d.status === 'confirming')) {
            return 'Front Claw：请先确认或取消当前草稿，结果未知时查原操作号。';
          }
          // R18 / D152：回「是」后再过一次单闸（原句与条目随追问一起存下）；不过就先问，不出草稿。
          const gateYes = evaluateConfirmableReportDraft({ text: savedAsk.text ?? '', today: savedAsk.businessDay, employeeNames: new Set([...(await store.listPeople()).filter(p => p.active && p.storeId === actor.storeId).map(p => p.displayName), ...(await store.listAliases(actor.storeId)).map(a => a.alias)]),
            liveModelAllowsDraft: false, entries: savedAsk.gateEntries ?? savedAsk.listed.map(i => ({ customer: i.customer ?? null, employeeName: i.employeeId === actor.personId ? '' : i.employeeName, compound: null })), source: savedAsk.source ?? 'standard', confirmedNewNames: savedAsk.names, knownCustomerNames: await collectKnownCustomerNames(store, actor.storeId) });
          if (!gateYes.ok) return askReply(gateYes.reason.startsWith('customer:') ? notCustomerNameAskReply([]) : formatMaybeReportAsk(savedAsk.text ?? '', await collectConfirmedLedgerNames(store, actor.storeId)));
          // D139-roster: 回「是」只出草稿，不把名字写入任何名单状态；已知客户只在「对」确认入账后从本店已确认账本推导。
          // D131：回「是」当天若已有同名确认单，仍走二选一，不直接出新草稿。
          const todayConfirmedYes = (await store.listEntries({ storeId: actor.storeId, businessDay: savedAsk.businessDay, status: 'confirmed' }))
            .filter(row => row.status === 'confirmed' && row.storeId === actor.storeId && row.businessDay === savedAsk.businessDay);
          const reportCustomersYes = new Set(savedAsk.listed.map(i => i.customer).filter((c): c is string => !!c));
          const existingYes = todayConfirmedYes.map(row => row.customerName).filter((n): n is string => !!n);
          const conflictNamesYes = new Set([
            ...[...reportCustomersYes].filter(name => existingYes.includes(name)),
            ...customerNameConflicts(text, existingYes, [...reportCustomersYes]),
          ]);
          // 回「是」的正文不是原报单行，customerNameConflicts 对正文可能无命中；整词相等已覆盖。
          const conflictsYes = todayConfirmedYes.filter(row => row.customerName && conflictNamesYes.has(row.customerName));
          if (conflictsYes.length) {
            const names = [...new Set(conflictsYes.map(r => r.customerName))].join('、');
            const listedPicks = conflictsYes
              .slice()
              .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.entryId.localeCompare(b.entryId))
              .map((row, i) => toPickItem(row, i + 1, actor));
            const matching = savedAsk.listed.find(i => conflictsYes.some(c => c.customerName === i.customer));
            const newAmount = matching?.amount ?? savedAsk.listed[0]!.amount;
            const reason = `本店今天已经有「${names}」的单（任意报单人都算），这次不能直接当成新的一笔入账。`;
            const proxyChoice = savedAsk.listed.some(item => item.employeeId !== actor.personId);
            operationId = hash(['employee-loop:m01', input.sessionId, input.messageId]);
            const choiceDraft = buildConfirmableReportDraft(gateYes.pass, { actor, input, fingerprint, operationId, businessDay: savedAsk.businessDay,
              added: [...savedAsk.listed], duplicates: [], awaitingDuplicateChoice: { listed: listedPicks, reason, newAmount } });
            const latestChoice = await actorFor(input.memberId);
            if (!latestChoice || !owned(choiceDraft, latestChoice, input) || !await targetsInStore(choiceDraft, latestChoice) || !await enabled(latestChoice) || !active()) return DENIED;
            if (latestChoice.tier === 'owner') return OWNER_CANNOT_REPORT;
            if (!await can(latestChoice, proxyChoice ? 'report_proxy' : 'report_self')) return ACCESS_DENIED;
            // D143/D172：异步重读和鉴权耗时也在原确认窗口内，不顺延旧追问。
            if (pendingExpired(savedAsk.expiresAt, now())) {
              await advance(actor, drafts, undefined, true);
              const reply = expiredPendingReminder || DRAFT_EXPIRED_REREPORT; expiredPendingReminder = ''; return reply;
            }
            response.occupiesPending = true;
            if (savedAsk.replacedPending) meta(choiceDraft)!.replacedPending = true;
            if (!await saveReport(actor, choiceDraft, undefined, savedAsk)) return 'Front Claw：草稿版本已变化，请查原操作结果。';
            const savedChoice = await store.getDraft(operationId);
            if (!savedChoice || !owned(savedChoice, latestChoice, input) || meta(savedChoice)?.fingerprint !== fingerprint) return 'Front Claw：同一消息内容冲突，未写入。';
            tag.access = needs(savedChoice);
            return `${actor.storeName}\n${resultText(savedChoice)}`;
          }
          const { fresh: addedYes, duplicates: dupYes } = await splitDuplicates(actor.storeId, savedAsk.businessDay, savedAsk.listed);
          if (!addedYes.length) return `Front Claw：这份清单的 ${dupYes.length} 笔今天都已入账，没有新增，没有写入。如确是新的一笔，请在客户名或备注里写明区别后重发。`;
          const proxyYes = addedYes.some(item => item.employeeId !== actor.personId);
          operationId = hash(['employee-loop:m01', input.sessionId, input.messageId]);
          const draftYes = buildConfirmableReportDraft(gateYes.pass, { actor, input, fingerprint, operationId, businessDay: savedAsk.businessDay, added: addedYes, duplicates: dupYes });
          const latestYes = await actorFor(input.memberId);
          if (!latestYes || !owned(draftYes, latestYes, input) || !await targetsInStore(draftYes, latestYes) || !await enabled(latestYes) || !active()) return DENIED;
          if (latestYes.tier === 'owner') return OWNER_CANNOT_REPORT;
          if (!await can(latestYes, proxyYes ? 'report_proxy' : 'report_self')) return ACCESS_DENIED;
          if (pendingExpired(savedAsk.expiresAt, now())) {
            await advance(actor, drafts, undefined, true);
            const reply = expiredPendingReminder || DRAFT_EXPIRED_REREPORT; expiredPendingReminder = ''; return reply;
          }
          response.occupiesPending = true;
          if (savedAsk.replacedPending) meta(draftYes)!.replacedPending = true;
          if (!await saveReport(actor, draftYes, undefined, savedAsk)) return 'Front Claw：草稿版本已变化，请查原操作结果。';
          const savedYes = await store.getDraft(operationId);
          if (!savedYes || !owned(savedYes, latestYes, input) || meta(savedYes)?.fingerprint !== fingerprint) return 'Front Claw：同一消息内容冲突，未写入。';
          tag.access = needs(savedYes);
          return `${actor.storeName}\n${resultText(savedYes)}`;
        }
      }
      const interleavedDraftId = (text === '对' || text === '确认') && pending.length === 1
        ? (await store.getConfig(d175InterleavedKey(actor.personId, input.sessionId)))?.trim() : null;
      const interleaved = !!interleavedDraftId && interleavedDraftId === pending[0]?.draftId;
      if (isConfirmCommand(text) || (text === '确认' && interleaved) || text === '取消') {
        // R4：上一消费者失权后补偿不能改当前持有者的草稿，可能留下 confirming。
        // 当前持有者回「对」接手提交、「取消」关闭，避免草稿卡死；提交仍走同一入账门。
        if (pending.length === 0) {
          const leftover = drafts.filter(d => d.status === 'confirming' && owned(d, actor, input));
          if (leftover.length === 1) {
            const stale = leftover[0]!;
            operationId = stale.draftId;
            const latest = await actorFor(input.memberId);
            if (!latest || !owned(stale, latest, input) || (stale.kind === 'report' && !await targetsInStore(stale, latest)) || !await enabled(latest) || !active()) return DENIED;
            if (text === '取消') {
              const next = { ...stale, status: 'void' as const, closedAt: now().toISOString() };
              await writesFor(input).rewriteDraft(next);
              await clearInterleaved(actor);
              const saved = await store.getDraft(next.draftId);
              return resultText(saved ?? next);
            }
            await pinPolicy(input);
            if (!await draftAllowed(latest, stale)) return ACCESS_DENIED;
            const done = await finishAndReply(stale, latest, input);
            ledgerSettled = done.settled;
            tag.access = needs(stale);
            if (done.settled) await clearInterleaved(actor);
            if (done.settled && stale.kind === 'report') await writesFor(input).putOperationRecord(d160Key(actor.personId, input.sessionId), stale.draftId);
            return done.reply;
          }
        }
        // R18 / D160：没有待确认草稿时重复回「对」，若本人本会话最近一张报单草稿已确认入账，只回一次「已经入账了」。
        // 只认「上一条消息就是把报单确认入账的那条」：确认成功时记下标记，任何别的消息都会清掉它。
        if (pending.length === 0 && text !== '取消') {
          const lastId = (await store.getConfig(d160Key(actor.personId, input.sessionId)))?.trim();
          const lastReport = lastId ? drafts.find(d => d.draftId === lastId) : undefined;
          if (lastReport?.kind === 'report' && lastReport.status === 'confirmed' && Date.parse(lastReport.expiresAt) > now().getTime()) return ALREADY_CONFIRMED_TEXT;
          // D162：只在无待确认草稿路径读/清标记；不改变并发确认路径的存储时序。
          if (lastId) await writesFor(input).putOperationRecord(d160Key(actor.personId, input.sessionId), '');
        }
        if (pending.length !== 1) return NO_DRAFT;
        const draft = pending[0]!; operationId = draft.draftId;
        // D183：所有报单使用同一严格序号条件；普通草稿被拦时重显已有草稿，不声称旧项作废。
        const guardArrival = text !== '取消' && draft.kind === 'report';
        const arrivedSequence = confirmationSequence(meta(draft)?.platformIssuedAt ?? draft.createdAt, input.arrivedAt, meta(draft)?.replacedPending === true, (await input.pendingArrival!).sequence);
        if (pendingExpired(draft.expiresAt, now())) {
          const lateSlot = await advance(actor, [draft]);
          if (!lateSlot.blocked && lateSlot.expired.length > 0 && active()) await clearInterleaved(actor);
          const leftoverExpired = lateSlot.expired;
          if (text === '取消' && leftoverExpired.length) return resultText(leftoverExpired[leftoverExpired.length - 1]!);
          return DRAFT_EXPIRED_REREPORT;
        }
        if (text !== '取消' && draft.payload.type === 'correction' && draft.payload.awaitingPick) {
          return `${resultText(draft)}
请回复「改 N」指定要改哪一笔，或回「取消」。不要直接回「对」。`;
        }
        if (text !== '取消' && draft.payload.type === 'report' && draft.payload.awaitingDuplicateChoice) {
          return `${resultText(draft)}
请回复「新增一笔」或「改 N」，或回「取消」。不要直接回「对」。`;
        }
        // D175：穿插软对话后的 pending 草稿，禁止单字「对」直接落账，要求「确认入账」或「全部确认」。
        if (text === '对' && interleaved) return interleavedConfirmGuardReply(draft);
        const next = { ...draft, status: text === '取消' ? 'void' : 'confirming',
          closedAt: text === '取消' ? now().toISOString() : null,
          payload: { ...draft.payload, employeeContext: {
            ...meta(draft)!, actionMessageId: input.messageId, actionFingerprint: fingerprint,
          } },
        } as Draft;
        const latest = await actorFor(input.memberId);
        if (!latest || !owned(draft, latest, input) || (draft.kind === 'report' && !await targetsInStore(draft, latest)) || !await enabled(latest) || !active()) return DENIED;
        // M04：个人目标对象须仍是该门店在职完整人员（调店/离职后旧目标草稿不能确认）。
        // R5：门店月目标没有人员对象，只复核门店仍存在且草稿上的店名一致。
        if (next.status !== 'void' && draft.payload.type === 'target') {
          const t = draft.payload.target;
          if (t.kind === 'store') {
            const people = await store.listPeople();
            const scope = storeById(people, t.storeId) ?? storeByName(people, t.storeName);
            if (!scope || scope.storeId !== t.storeId || scope.storeName !== t.storeName) return DENIED;
          } else {
            const person = await store.getPerson(t.personId);
            if (!complete(person) || person.storeId !== t.storeId || person.displayName !== t.personName) return DENIED;
          }
        }
        // M03 草稿确认：旧草稿按当前策略重判（例如代报能力已撤销）。取消只关闭本人草稿、不入账，
        // 能力被收窄但仍在职有效（入口已校验）时允许取消，避免草稿卡到过期（默认，待拍板）。
        if (next.status !== 'void') await pinPolicy(input);
        if (next.status !== 'void' && !await draftAllowed(latest, draft)) return ACCESS_DENIED;
        // M05：回显后预约时间已过 → 不登记（草稿保留，可「取消」后重发）。
        if (next.status !== 'void' && draft.payload.type === 'appointment') {
          const item = draft.payload.items[0]!;
          if (!item.date || !item.time || zonedDateTime(item.date, item.time, timeZone).getTime() <= now().getTime()) return `Front Claw：预约时间已经过了，没有登记。请回复「取消」后重发。`;
        }
        // M04：报数确认前再查一次重发——清单里的行在回显后已被别人入账，则作废本草稿、零入账。
        const duplicateCheck = next.status !== 'void' && draft.payload.type === 'report' && !draft.payload.explicitNew
          ? await splitDuplicates(draft.storeId, draft.businessDay, draft.payload.added) : null;
        // 异步鉴权/查重也消耗原确认窗口；正常路径只多做本地判断，不增加数据库读写。
        if (!active()) return 'Front Claw：请求已取消或超时，未开始新写入。';
        if (pendingExpired(draft.expiresAt, now())) {
          const lateSlot = await advance(actor, [draft]);
          if (lateSlot.blocked) return 'Front Claw：草稿版本已变化，请查原操作结果。';
          if (lateSlot.expired.length > 0) await clearInterleaved(actor);
          if (text === '取消' && lateSlot.expired.length) return resultText(lateSlot.expired[0]!);
          return DRAFT_EXPIRED_REREPORT;
        }
        if (duplicateCheck?.duplicates.length) {
          const voided = { ...next, status: 'void', closedAt: now().toISOString(), payload: { ...next.payload, outcome: 'conflict' } } as Draft;
          if (!await writesFor(input).transitionPending(draft, voided)) return 'Front Claw：草稿版本已变化，请查原操作结果。';
          await clearInterleaved(actor);
          return CONFLICT;
        }
        if (!await writesFor(input).transitionPending(draft, next, next.status !== 'void' ? { ...(guardArrival ? { arrivedSequence } : {}), unexpiredAt: now().toISOString() } : undefined)) {
          // R18 / D160：并发回「对」的输家——对方已把这张草稿推进到确认中/已确认，只回「已经入账了」，不多记一笔、不出「已入账」。
          if (next.status !== 'void' && draft.kind === 'report') {
            const now2 = await store.getDraft(draft.draftId);
            if (now2 && (now2.status === 'confirmed' || now2.status === 'confirming')) return ALREADY_CONFIRMED_TEXT;
            const currentArrival = now2 ? confirmationSequence(meta(now2)?.platformIssuedAt ?? now2.createdAt, input.arrivedAt, meta(now2)?.replacedPending === true, (await input.pendingArrival!).sequence) : arrivedSequence;
            if (now2?.status === 'pending' && !sequenceBefore(meta(now2)?.pendingSequence, currentArrival)) return meta(now2)?.replacedPending ? newerPendingReply(reportLabels(now2)) : resultText(now2);
          }
          return 'Front Claw：草稿版本已变化，请查原操作结果。';
        }
        if (next.status === 'void') {
          await clearInterleaved(actor);
          return resultText(next);
        }
        const done = await finishAndReply(next, latest, input); ledgerSettled = done.settled; tag.access = needs(next);
        if (done.settled) await clearInterleaved(actor);
        if (done.settled && next.kind === 'report') await writesFor(input).putOperationRecord(d160Key(actor.personId, input.sessionId), next.draftId);
        return done.reply;
      }
      const today = businessDate(now(), cutoff, timeZone);
      if (input.modelClassification?.intent === 'report') {
        const candidate = modelReportCandidate(text, input.modelClassification, actor, today);
        if (!candidate) {
          input.onGate?.('model_candidate_rejected');
          return askReply(REPORT_HINT);
        }
        text = candidate;
      }
      // R8：标准行先走同一份语法（D125）。否定/小额小数追问（D122/D123），非今天拒（D124）。
      const oralProjectLine = oralProjectReportLine(text);
      const std = tryStandardReport(oralProjectLine ?? text, today);
      const modelAsk = async () => askReply(formatMaybeReportAsk(text, await collectConfirmedLedgerNames(store, actor.storeId)));
      // R18 / 移交项 3：D146 未见否定补报、D147 客户位残片的「先问」结论来自单闸模块（textLevelImpurity，与闸内同一函数），
      // 这里只负责在 D81 之前给出原措辞，不自己判断。
      {
        const impurity = textLevelImpurity(text, today);
        if (impurity) {
          return askReply(askForTextImpurity(impurity, text, await collectConfirmedLedgerNames(store, actor.storeId)));
        }
      }
      // R16 / D145 撤销：不是纯标准行（标准行＋进度/查询/认不出的残片）整句交模型，报单也不单独出草稿。
      // 改账、预约、宣传等既有「草稿＋后半句没办」口径仍保留在规则层（D145 撤销说明由模型路径在实测达成，这些组合本轮不改）。
      // R17 / D152：原 R16 在此处单独堵复合进度；现统一由建草稿前的单闸 mayCreateConfirmableReportDraft 判定，不在分支各自堵。
      // D124：认出是报单后，非今天（含标题日、句中「昨天」）按 D81 拒；解析层本身仍返回完整/追问，以免伤历史清单解析。
      const recognized = std.status === 'complete' || std.status === 'ask';
      // D134：非今天只看报单这一半；后半句「登记明天…」不让整句被 D124 拒掉。
      const nonToday = (std.status === 'complete' && std.report.businessDay !== today) || hasUnnegatedNonToday(compoundHead(text), today);
      if (recognized && nonToday) return askReply(withLeftover(NOT_TODAY_REPLY, text, 'report'));
      if (std.status === 'ask') return askReply(clarifyQuestion(standardAskToReason(std.reason), std.detail));
      // R4：模糊金额 / 未成交 优先于清单解析和「还没定」类笼统澄清，必须先问清或拒绝，不出可确认草稿。
      // 同一份语法已经收下的标准行，不再让自然抽取把归属/行尾结构误当成约数。
      const amountGuard = std.status === 'complete' ? { status: 'none' as const } : extractReport(text);
      if (amountGuard.status === 'unclear' && (amountGuard.reason === 'vague_amount' || amountGuard.reason === 'not_closed' || amountGuard.reason === 'ask_wan' || amountGuard.reason === 'negation')) {
        return askReply(clarifyQuestion(amountGuard.reason, amountGuard.detail));
      }
      // R7：整句金额收口（所有路径同一函数）。句中有不安全金额（出头/亏/无单位歧义小数）→ 追问，不出草稿。无金额跨度（issue=bad）放过，以免拦截查询。
      const utteranceGuard = guardUtteranceAmounts(text, isStandardAmountLine(text) ? 'standard-line' : 'free');
      if (!utteranceGuard.ok && utteranceGuard.issue !== 'bad') {
        return askReply(clarifyQuestion(guardIssueToReason(utteranceGuard.issue), utteranceGuard.text));
      }
      // R2：互斥候选/未定指代/自述不确定 → 先问清楚（任何店务动作都不猜）。
      const vague = ambiguityOf(text);
      if (vague) return askReply(clarifyQuestion(vague));
      // R2：自然句报数（客人/项目 + 金额 + 可选括号员工）；有金额的报数优先于预约。
      // R2：宽松行解析会把同一行里的第二笔（「张姐680（小王）；李姐980（小美）」）吞进备注 → 这种情况改用自然句抽取，抽不清就澄清，绝不静默丢笔。
      const looseFirst = parseReportText(text, today).status === 'none' ? parseLooseReport(text, today) : { status: 'none' as const };
      const looseSwallowed = looseFirst.status === 'complete' && looseFirst.report.entries.some(item => /\d/.test(item.note ?? ''));
      const natural = !oralProjectLine && parseReportText(text, today).status === 'none' && (looseFirst.status !== 'complete' || looseSwallowed) ? extractReport(text) : { status: 'none' as const };
      // R4（D104）：上次问过客人称呼，本次是回答。
      const askedRaw = (await store.getConfig(appointmentAskKey(actor, input)))?.trim();
      if (askedRaw && !clockReply) {
        await writesFor(input).putOperationRecord(appointmentAskKey(actor, input), '');
        const noName = isNoNameAnswer(text);
        const named = noName ? null : customerAnswer(text);
        if (noName || named) {
          if (!policyMode) return 'Front Claw：预约登记当前未开放，没有写入。';
          if (pending.length || drafts.some(d => d.status === 'confirming')) return 'Front Claw：请先确认或取消当前草稿，结果未知时查原操作号。';
          let item: AppointmentPayload['items'][number];
          try { item = JSON.parse(askedRaw) as AppointmentPayload['items'][number]; }
          catch { item = { customer: '', whenText: '', note: '' }; }
          item = { ...item, customer: noName ? UNNAMED_CUSTOMER : named!, customerNamed: !noName };
          const built = await appointmentDraft(actor, `${item.whenText} ${item.customer}${item.note ? `做${item.note}` : ''}`, input, fingerprint, today);
          // 上面用合成句可能解析失败（时间已过等）；直接组草稿。
          const forced = typeof built === 'object' && built ? built : await (async () => {
            if (!await can(actor, 'appointment_submit', actor.storeId)) return ACCESS_DENIED;
            const recipient = (await recipientFor(actor.storeId, actor)).person;
            const draft: Draft = {
              draftId: hash(['employee-loop:m05:appointment', input.sessionId, input.messageId]), reporterPersonId: actor.personId, storeId: actor.storeId, businessDay: today,
              expiresAt: zonedDateTime(today, cutoff, timeZone).toISOString(), kind: 'appointment',
              payload: { type: 'appointment', items: [item], storeName: actor.storeName, recipient: recipient ? { personId: recipient.personId, name: recipient.displayName } : null,
                employeeContext: contextFor(actor, input, fingerprint) },
              status: 'pending', reminder: 'none', voidNotice: 'none', createdAt: now().toISOString(), closedAt: null,
            };
            (draft.payload as AppointmentPayload).employeeContext!.itemsDigest = ledgerDigest(draft)!;
            return draft;
          })();
          if (typeof forced === 'string') return forced;
          operationId = forced.draftId;
          const latest = await actorFor(input.memberId);
          if (!latest || !owned(forced, latest, input) || !await enabled(latest) || !active()) return DENIED;
          if (!await draftAllowed(latest, forced)) return ACCESS_DENIED;
          response.occupiesPending = true;
          await writesFor(input).createDraft(forced);
          await clearInterleaved(actor);
          const saved = await store.getDraft(forced.draftId);
          if (!saved || !owned(saved, latest, input)) return 'Front Claw：同一消息内容冲突，未写入。';
          tag.access = needs(saved); return resultText(saved);
        }
        // 不是称呼回答：已清掉待问状态，按新消息继续。
      }
      // M05 预约：标准报数清单优先（带「金额（员工）」行的不当预约）。
      if (clockReply || (natural.status === 'none' && parseReportText(text, today).status === 'none' && parseLooseReport(text, today).status !== 'complete')) {
        const timeFollowup = clockReply && timeAsk ? { clock: clockReply, originalText: timeAsk.text, requestedAt: new Date(timeAsk.issuedAt) } : undefined;
        const src = timeFollowup ? `${timeFollowup.originalText} ${timeFollowup.clock}` : appointmentClause(text);
        const flatSrc = (clockReply ? src : text).normalize('NFKC').replace(/\s+/g, '');
        const parsedApptAsk = parseAppointmentRequest(src, now(), timeZone, timeFollowup);
        if (DONT_REGISTER.test(flatSrc) && (parsedApptAsk || /约/.test(flatSrc))) {
          return 'Front Claw：好的，没有登记或改单。';
        }
        if (/取消/.test(flatSrc) && /约/.test(flatSrc) && !/重新约|再约|改约/.test(flatSrc) && text.trim() !== '取消') {
          return 'Front Claw：已了解取消意向，这条没有登记或改单。如需改已登记预约请单独说明。';
        }
        // R4/R6（D104）：没写客人称呼 → 先问一次。「有个客人」不算已回答；必须写出称呼或明确「没留名」。
        // 先鉴权/策略：无权限或未开放时不提问、不写待问状态（与 appointmentDraft 一致）。
        if (parsedApptAsk && (pending.length || drafts.some(d => d.status === 'confirming'))) return 'Front Claw：请先确认或取消当前草稿，结果未知时查原操作号。';
        if (parsedApptAsk?.kind === 'request' && !parsedApptAsk.item.customerNamed) {
          const alreadyUnnamed = /没留名|未留名|没有名字|没有称呼/.test(src.normalize('NFKC').replace(/\s+/g, ''));
          if (!alreadyUnnamed) {
            if (!policyMode) return 'Front Claw：预约登记当前未开放，没有写入。';
            if (!await can(actor, 'appointment_submit', actor.storeId)) return ACCESS_DENIED;
            await writesFor(input).putOperationRecord(appointmentAskKey(actor, input), JSON.stringify(parsedApptAsk.item));
            return askReply(clarifyQuestion('missing_customer'));
          }
        }
        const built = await appointmentDraft(actor, src, input, fingerprint, today, parsedApptAsk);
        if (typeof built === 'string') return built;
        if (built) {
          operationId = built.draftId;
          const latest = await actorFor(input.memberId);
          if (!latest || !owned(built, latest, input) || !await enabled(latest) || !active()) return DENIED;
          if (!await draftAllowed(latest, built)) return ACCESS_DENIED;
          response.occupiesPending = true;
          await writesFor(input).createDraft(built);
          await clearInterleaved(actor);
          const saved = await store.getDraft(built.draftId);
          if (!saved || !owned(saved, latest, input) || meta(saved)?.fingerprint !== fingerprint) return 'Front Claw：同一消息内容冲突，未写入。';
          tag.access = needs(saved); return withLeftover(resultText(saved), text, 'appointment');
        }
      }
      const targetCommand = parseTargetCommand(text, today);
      const correctionCommand = targetCommand ? null : parseCorrectionCommand(text);
      // R11：报单和改账同时出现时，不能只走改账把报单丢掉。
      // 已认出完整报单则先出报单草稿，改账由 leftover 明说没办。
      const reportHolds = std.status === 'complete';
      if ((targetCommand || correctionCommand) && !reportHolds) {
        // M04：目标与更正只在策略模式开放，且每一步都过 M03 鉴权；非策略模式不扩大权限。
        if (!policyMode) return 'Front Claw：目标设置和改账当前未开放，没有写入。';
        if (pending.length || drafts.some(d => d.status === 'confirming')) return 'Front Claw：请先确认或取消当前草稿，结果未知时查原操作号。';
        const built = targetCommand ? await targetDraft(actor, targetCommand, input, fingerprint, today) : await correctionDraft(actor, correctionCommand!, input, fingerprint, today);
        if (typeof built === 'string') return built;
        operationId = built.draftId;
        const latest = await actorFor(input.memberId);
        if (!latest || !owned(built, latest, input) || !await enabled(latest) || !active()) return DENIED;
        if (!await draftAllowed(latest, built)) return ACCESS_DENIED;
        response.occupiesPending = true;
        await writesFor(input).createDraft(built);
        await clearInterleaved(actor);
        const saved = await store.getDraft(built.draftId);
        if (!saved || !owned(saved, latest, input) || meta(saved)?.fingerprint !== fingerprint) return 'Front Claw：同一消息内容冲突，未写入。';
        tag.access = needs(saved);
        return withLeftover(resultText(saved), text, targetCommand ? 'target' : 'correction');
      }
      const strict = parseReportText(text, today);
      // M04：没有日期标题、但每行都是标准行（如「张姐 680（小王）」）→ 按今天营业日、本人门店直接进待确认。
      const loose = strict.status === 'none' ? parseLooseReport(text, today) : strict;
      const people = await store.listPeople();
      // R2（D5 已定：跨店不行）：报数句里点名了他店（目录里的门店名）→ 拒绝，零写入。
      // 无论能否解析成报数：点名他店的店务请求一律拒绝（不读、不写）。
      if (otherStoreMentioned(text, people, actor)) return withLeftover(DENIED, text, 'report');
      if (natural.status === 'unclear') return askReply(clarifyQuestion(natural.reason, natural.detail));
      if (looseSwallowed && natural.status !== 'complete') return askReply(clarifyQuestion('orphan_amount'));
      const parsed = std.status === 'complete' ? { status: 'complete' as const, report: std.report }
        : loose.status === 'complete' && !looseSwallowed ? loose
        : natural.status === 'complete' ? { status: 'complete' as const, report: { businessDay: today, storeName: null, entries: natural.entries as (ParsedEntry & { self?: boolean; storeName?: string | null })[] } } : loose;
      if (parsed.status !== 'complete') {
        // R2：金额带角分/负数/零/超上限 → 明确澄清，不取整。
        const issue = moneyIssueOf(text);
        if (issue) return askReply(clarifyQuestion(issue.issue, issue.text));
        const fromModel = await handleClassified(actor, text, input, tag, fingerprint, today, pending, drafts);
        if (fromModel !== undefined) {
          if (fromModel.operationId) operationId = fromModel.operationId;
          if (fromModel.access) tag.access = fromModel.access;
          return fromModel.kind === 'ask' ? askReply(fromModel.reply) : fromModel.reply;
        }
        return askReply(REPORT_HINT);
      }
      const report = parsed.report;
      // R18 / D155：记下条目来源；自然句抽取不是纯标准行。
      const parsedSource: 'standard' | 'natural' = std.status === 'complete' || (loose.status === 'complete' && !looseSwallowed) ? 'standard' : 'natural';
      // R3（D81 已定口径）：非今天的单 → 固定一句，不追问；是否开放补报待 hanyu 拍板。
      if (report.businessDay !== today) return askReply(withLeftover(NOT_TODAY_REPLY, text, 'report'));
      if (report.storeName && report.storeName !== actor.storeName) return withLeftover(DENIED, text, 'report');
      const aliases = await store.listAliases(actor.storeId);
      // M02 同店代报：括号里的员工必须能在本店唯一匹配到在职完整人员，业绩记给该员工；匹配不到（含他店员工）即拒绝，零写入。
      // R2：无括号的自然句报数记给本人；「X店小王」里的门店名必须是本店。
      const entryStore = (item: ParsedEntry & { storeName?: string | null }) => item.storeName ?? splitStore(item.employeeName).storeName;
      const bareEmployee = (item: ParsedEntry & { storeName?: string | null }) => (item.storeName ? item.employeeName : splitStore(item.employeeName).employeeName).normalize('NFKC').replace(/\s+/g, '');
      // R18 / D159：括号里写「姓＋店长」——本店店长也是本店员工。本店在职店长里按姓唯一对上就记给他；对不上或不止一个 → 先问。
      // 「老板」不算员工位（D156 粗筛表里有），先问。跨店、代报的拒绝语义不变（只在本店店长里找）。
      const managerTitle = (item: ParsedEntry & { storeName?: string | null }) => {
        if ((item as { self?: boolean }).self || !item.employeeName.trim() || item.storeName) return null;
        return /^([\u4e00-\u9fa5]{1,2})店长$/.exec(item.employeeName.normalize('NFKC').replace(/\s+/g, ''));
      };
      const managerAsk = report.entries.some(item => {
        const m = managerTitle(item);
        if (!m) return false;
        const hits = people.filter(p => p.active && p.storeId === actor.storeId && p.tier === 'manager' && p.displayName.startsWith(m[1]!));
        return hits.length !== 1;
      });
      if (managerAsk) return await modelAsk();
      if (report.entries.some(item => { if (managerTitle(item)) return false; const named = entryStore(item); return named !== null && named !== actor.storeName; })) return withLeftover(DENIED, text, 'report');
      const targets = report.entries.map(item => {
        if ((item as { self?: boolean }).self || !item.employeeName.trim()) return actor;
        const m = managerTitle(item);
        if (m) return people.find(p => p.active && p.storeId === actor.storeId && p.tier === 'manager' && p.displayName.startsWith(m[1]!)) ?? null;
        return matchPerson(people, aliases, actor.storeId, (item as { storeName?: string | null }).storeName ? item.employeeName : splitStore(item.employeeName).employeeName);
      });
      // R18 / D156 + 移交项 3：括号先过单闸模块的粗筛（bracketImpurity），非名字 → 通用先问（不是跨店拒绝）；
      // 像人名但对不上本店的，仍按 M02 跨店/查无此人拒绝。判断在闸模块，这里只决定在跨店拒绝之前给追问。
      if (report.entries.some((item, index) => !(item as { self?: boolean }).self && !!item.employeeName.trim() && !targets[index] && bracketImpurity(bareEmployee(item)))) {
        return await modelAsk();
      }
      if (targets.some(target => !complete(target) || target!.storeId !== actor.storeId || target!.storeName !== actor.storeName)) return withLeftover(DENIED, text, 'report');
      if (pending.some(d => d.kind !== 'report') || drafts.some(d => d.status === 'confirming')) return 'Front Claw：请先确认或取消当前草稿，结果未知时查原操作号。';
      operationId = hash(['employee-loop:m01', input.sessionId, input.messageId]);
      const listed = report.entries.map((item, index) => {
        const { ownership: _own, ownershipText: _ot, compound: _c, attributedName: _an, ...base } = item;
        return { ...base, employeeId: targets[index]!.personId, employeeName: targets[index]!.displayName, amountType: 'consultant' as const };
      });
      // 先鉴权再读本店账本做重发比对：无报数/代报能力者不读账本。
      if (actor.tier === 'owner') return withLeftover(OWNER_CANNOT_REPORT, text, 'report');
      if (!await can(actor, listed.some(item => item.employeeId !== actor.personId) ? 'report_proxy' : 'report_self')) return withLeftover(ACCESS_DENIED, text, 'report');
      try {
        sealDraftAmounts({ utterance: text, items: listed.map(i => ({ amount: i.amount, ...(i.amountText ? { amountText: i.amountText } : {}) })), context: isStandardAmountLine(text) ? 'standard-line' : 'free' });
      } catch (err) {
        if (err instanceof UnvalidatedAmountError) return askReply(clarifyQuestion(guardIssueToReason(err.issue), err.text));
        throw err;
      }
      // D133：归属说法与括号员工核对。一致或互补继续；冲突追问、零写入。
      for (let i = 0; i < report.entries.length; i++) {
        const item = report.entries[i]!;
        const target = targets[i]!;
        const detail = ownershipConflictDetail({
          ownership: item.ownership,
          ...(item.ownershipText ? { ownershipText: item.ownershipText } : {}),
          employeeName: target.displayName,
          employeeIsReporter: target.personId === actor.personId,
          hasExplicitEmployee: !item.self && !!item.employeeName.trim(),
          ...(item.attributedName ? { attributedName: item.attributedName } : {}),
        });
        if (detail) {
          return withLeftover(`Front Claw：${detail}没有写入任何账目。`, text, 'report');
        }
      }
      // D130：只判断语法剥完（归属/客套/复合）之后剩下的备注；非白名单交给模型，桩一律追问。
      const modelNotes = report.entries
        .map(item => remarkForDraftPolicy(item.note?.trim() ?? ''))
        .filter(note => note && classifyStandardRemark(note) === 'model');
      if (modelNotes.length) {
        const fromModel = await handleClassified(actor, text, input, tag, fingerprint, today, pending, drafts);
        if (fromModel !== undefined) {
          if (fromModel.operationId) operationId = fromModel.operationId;
          if (fromModel.access) tag.access = fromModel.access;
          return fromModel.kind === 'ask' ? askReply(fromModel.reply) : fromModel.reply;
        }
        return askReply(withLeftover(`Front Claw：行尾备注「${modelNotes[0]}」需要确认后再记（请去掉该备注直接重发「客户 金额」，单回「确认」不会入账）。没有写入任何账目。`, text, 'report'));
      }
      // R18 / D152 单闸（唯一出口）：在 D131 二选一、D139 新客户追问、建草稿之前算一次。二选一草稿（选「新增」后变成可确认草稿）、
      // 「是新客户」回「是」后出的草稿、以及直接出的草稿，都必须拿着这张通行证组装；闸不过一律先问。
      // D155：自由叙述抽取仍属 natural。已完整匹配单笔口语格式的项目报数沿用标准行校验。
      const gateEntriesFor = (): GateEntry[] => report.entries.map((item, i) => ({
        customer: item.customer,
        employeeName: (item as { self?: boolean }).self || !item.employeeName.trim() ? item.employeeName : (managerTitle(item) ? targets[i]!.displayName : item.employeeName),
        ...((item as { self?: boolean }).self ? { self: true } : {}),
        compound: item.compound ?? null,
        storeName: (item as { storeName?: string | null }).storeName ?? null,
      }));
      const gateEmployeeNames = new Set<string>([
        ...people.filter(p => p.active && p.storeId === actor.storeId).map(p => p.displayName),
        ...aliases.filter(a => a.storeId === actor.storeId).map(a => a.alias),
      ]);
      const gate = evaluateConfirmableReportDraft({ text, today, employeeNames: gateEmployeeNames, liveModelAllowsDraft: false, entries: gateEntriesFor(), source: parsedSource, knownCustomerNames: await collectKnownCustomerNames(store, actor.storeId) });
      input.onGate?.(gate.ok ? 'accepted' : gate.reason);
      // R6 数据兜底 + D131 包含匹配宁可多触发：已有客户名出现在这一行里就进二选一。
      const todayConfirmed = (await store.listEntries({ storeId: actor.storeId, businessDay: report.businessDay, status: 'confirmed' }))
        .filter(row => row.status === 'confirmed' && row.storeId === actor.storeId && row.businessDay === report.businessDay);
      const reportCustomers = new Set(listed.map(i => i.customer).filter((c): c is string => !!c));
      const existingNames = todayConfirmed.map(row => row.customerName).filter((n): n is string => !!n);
      const conflictNames = new Set([
        ...[...reportCustomers].filter(name => existingNames.includes(name)),
        ...customerNameConflicts(text, existingNames, [...reportCustomers]),
      ]);
      const conflicts = todayConfirmed.filter(row => row.customerName && conflictNames.has(row.customerName));
      if (conflicts.length && gate.ok) {
        const names = [...new Set(conflicts.map(r => r.customerName))].join('、');
        const listedPicks = conflicts
          .slice()
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.entryId.localeCompare(b.entryId))
          .map((row, i) => toPickItem(row, i + 1, actor));
        const matching = listed.find(i => conflicts.some(c => c.customerName === i.customer));
        const newAmount = matching?.amount ?? listed[0]!.amount;
        const reason = `本店今天已经有「${names}」的单（任意报单人都算），这次不能直接当成新的一笔入账。`;
        const proxyChoice = listed.some(item => item.employeeId !== actor.personId);
        const choiceDraft = buildConfirmableReportDraft(gate.pass, { actor, input, fingerprint, operationId, businessDay: report.businessDay,
          added: [...listed], duplicates: [], awaitingDuplicateChoice: { listed: listedPicks, reason, newAmount } });
        const latestChoice = await actorFor(input.memberId);
        if (!latestChoice || !owned(choiceDraft, latestChoice, input) || !await targetsInStore(choiceDraft, latestChoice) || !await enabled(latestChoice) || !active()) return DENIED;
        if (latestChoice.tier === 'owner') return OWNER_CANNOT_REPORT;
        if (!await can(latestChoice, proxyChoice ? 'report_proxy' : 'report_self')) return ACCESS_DENIED;

        response.occupiesPending = true;
        if (!await saveReport(actor, choiceDraft)) return 'Front Claw：草稿版本已变化，请查原操作结果。';
        const savedChoice = await store.getDraft(operationId);
        if (!savedChoice || !owned(savedChoice, latestChoice, input) || meta(savedChoice)?.fingerprint !== fingerprint) return 'Front Claw：同一消息内容冲突，未写入。';
        tag.access = needs(savedChoice);
        return withLeftover(`${actor.storeName}\n${resultText(savedChoice)}`, text, 'report');
      }
      // D139/D153/D165：客户三档只读单闸结论；入口/循环不另判。
      if (!gate.ok && !gate.newCustomerNames) {
        return gate.reason.startsWith('customer:') ? askReply(notCustomerNameAskReply([])) : await modelAsk();
      }
      if (!gate.ok && gate.newCustomerNames) {
        // R18：回「是」时按原句与条目再过一次单闸（通行证不能跨消息保存）。
        const askPayload = { names: gate.newCustomerNames, listed, businessDay: report.businessDay,
          expiresAt: zonedDateTime(report.businessDay, cutoff, timeZone).toISOString(), text, gateEntries: gateEntriesFor(), source: parsedSource };
        const latestAsk = await actorFor(input.memberId);
        if (!latestAsk || !same(latestAsk) || !await enabled(latestAsk) || !active()) return DENIED;
        if (!await can(latestAsk, listed.some(item => item.employeeId !== actor.personId) ? 'report_proxy' : 'report_self')) return ACCESS_DENIED;

        response.occupiesPending = true;
        if (!await saveReport(actor, undefined, { key: newCustomerAskKey(actor.personId, input.sessionId), value: JSON.stringify({ ...askPayload, version: operationId, issuedAt: now().toISOString(), ...(input.arrivedAt ? { platformIssuedAt: input.arrivedAt } : {}), ...(expiredPendingReminder ? { replacedPending: true } : {}) }) })) return 'Front Claw：草稿版本已变化，请查原操作结果。';
        return newCustomerAskReply(gate.newCustomerNames);
      }
      if (!gate.ok) return await modelAsk();
      const { fresh: added, duplicates } = await splitDuplicates(actor.storeId, report.businessDay, listed);
      if (!added.length) return `Front Claw：这份清单的 ${duplicates.length} 笔今天都已入账，没有新增，没有写入。如确是新的一笔，请在客户名或备注里写明区别后重发。`;
      const proxy = added.some(item => item.employeeId !== actor.personId);
      const draft = buildConfirmableReportDraft(gate.pass, { actor, input, fingerprint, operationId, businessDay: report.businessDay, added, duplicates });
      const latest = await actorFor(input.memberId);
      if (!latest || !owned(draft, latest, input) || !await targetsInStore(draft, latest) || !await enabled(latest) || !active()) return DENIED;
      if (latest.tier === 'owner') return OWNER_CANNOT_REPORT;
      if (!await can(latest, proxy ? 'report_proxy' : 'report_self')) return ACCESS_DENIED;

      response.occupiesPending = true;
      if (!await saveReport(actor, draft)) return 'Front Claw：草稿版本已变化，请查原操作结果。';
      const saved = await store.getDraft(operationId);
      if (!saved || !owned(saved, latest, input) || meta(saved)?.fingerprint !== fingerprint) return 'Front Claw：同一消息内容冲突，未写入。';
      tag.access = needs(saved);
      const head = `${actor.storeName}\n${resultText(saved)}`;
      // R3/R4：报单＋本人进度仍办完（D96）；其余未办部分必须明说，不因带数字而跳过。
      const tail = compoundTail(text) ?? report.entries.map(e => e.compound).find(Boolean) ?? null;
      if (tail && (selfProgressPhrase(tail) || isSelfProgressQuery(tail))) {
        const current = await actorFor(input.memberId);
        if (!same(current) || !await can(current!, 'progress_self')) return `${head}\n后半句「${tail}」没有办：你当前没有查进度的权限。`;
        const progress = await tools.myProgress(actor.accountId);
        return `${head}\n后半句「${tail}」——已查（上面这笔还没确认，不算在内）：\n${progress.reply.replace(/^Front Claw[：:]?/, '')}`;
      }
      return withLeftover(head, text, 'report');
    };
    let text: string;
    let pendingReminder = '';
    try {
      text = await run();
      // D182：追问未占用新挂起位时，回显原挂起项使用的确认口令。
      if (response.kind === 'ask' && !response.occupiesPending && pendingSnapshot) {
        const { actorId, drafts, ask } = pendingSnapshot;
        const at = now();
        const pendingReports = drafts.filter(d => d.status === 'pending' && d.kind === 'report' && !pendingExpired(d.expiresAt, at));
        const interleavedId = pendingReports.length ? (await store.getConfig(d175InterleavedKey(actorId, input.sessionId ?? '')))?.trim() : null;
        pendingReminder = [
          ...pendingReports.map(draft => {
            const reply = pendingConfirmationReminder([draft], null, at);
            return draft.draftId === interleavedId ? reply.replaceAll('还在等你回「对」确认。', '还在等你回「确认入账」或「全部确认」确认。') : reply;
          }),
          pendingConfirmationReminder([], ask, at),
        ].filter(Boolean).join('\n');
      }
    }
    catch (error) {
      if (error instanceof AccessRevoked) text = gateReasons.get(input) === 'policy_changed' ? POLICY_CHANGED : ACCESS_DENIED;
      // R3（A-P1-1）：消费租约已被接管/过期 → 统一入口拒绝写入（零写入）；适配器同样不回复。
      else if (error instanceof FencedWriteRejected) { ledgerSettled = false; text = STALE_CONSUMER; }
      else if (error instanceof CommitContentionRejected) {
        outcome = 'unavailable'; ledgerSettled = false;
        text = 'Front Claw：本次提交因争用已回滚，请查原操作结果；不要另报一笔。';
      }
      else {
      outcome = 'unavailable';
      text = `Front Claw：账本暂不可用，结果未知；请查「入账结果 ${operationId ?? input.messageId ?? ''}」，不要另报一笔。`;
      }
    }
    if (isConfirmCommand(input.text.trim()) && text === DRAFT_EXPIRED_REREPORT) expiredPendingReminder = '';
    if (abandonedPendingReminder) text = `${abandonedPendingReminder}\n${text}`;
    if (pendingReminder) text += `\n${pendingReminder}`;
    if (expiredPendingReminder) text += `${text ? '\n' : ''}${expiredPendingReminder}`;
    try { onEmployeeTrace?.({ messageId: input.messageId ?? '', ...(operationId ? { operationId } : {}), elapsedMs: performance.now() - started, outcome, ledgerSettled }); } catch { /* 观测故障不改变账目 */ }
    // 生成最终回复与平台投递分开；投递中断不能回滚已提交业务。
    onOutbound?.(text);
    return { entry: 'unified', replies: [text], modelCalled: false, ...(newMessagePrepared ? { newMessagePrepared: true } : {}),
      ...(expiredPendingReminder ? { expiredReminder: expiredPendingReminder } : {}),
      ...(ledgerSettled ? { ledgerSettled: true } : {}), access: tag.access ?? { capability: null, storeIds: [] } };
  };
}
