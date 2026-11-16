import { formatYuan } from './money.js';
import { sameBinding, type WecomBotBinding } from './wecom-bot-bindings.js';
import { sequenceBefore, type PendingArrival } from './pending-order.js';
import { createHash } from 'node:crypto';
import { assertStatus, bumpFence, decodeStatus, dueRaw, encodeStatus, outboxManaged, resultFenceHolds, type DeliveryMeta } from './notification-status.js';
import { assertWritableConfigKey } from './protected-config.js';
import { fenceHolds, parseLeaseRecord } from './fencing.js';
import type { WorkbenchRole } from './workbench-access.js';

/** Stable ledger id for one confirmed draft line. A replay inserts the same row. */
export function confirmEntryId(draftId: string, index: number): string {
  return createHash('sha256').update(`front-claw-confirm\n${draftId}\n${index}`).digest('hex');
}
/** Stable id for one appointment line on an employee-confirmed draft. A replay does not create another row. */
export function appointmentLineId(draftId: string, index: number): string {
  return createHash('sha256').update(`front-claw-appointment\n${draftId}\n${index}`).digest('hex');
}

export type Tier = 'employee' | 'manager' | 'owner';

export interface Person {
  personId: string;
  accountId: string;
  memberId: string;
  displayName: string;
  storeId: string;
  storeName: string;
  tier: Tier;
  roles: WorkbenchRole[];
  active: boolean;
}

/** R1 入账门快照：同一事务内锁读的配置行与人员行（不存在为 null）。 */
export interface GateSnapshot { config: Record<string, string | null>; people: Record<string, Person | null>; binding?: WecomBotBinding | null }
/**
 * M03：提交时的授权判定，raw 为事务内读到的配置原文。
 * R1：带 extraKeys/personIds/checkSnapshot 时，store 在同一事务里 FOR SHARE 锁读这些配置键与人员行，交 checkSnapshot 统一判定。
 */
export interface CommitGuard {
  binding?: Readonly<WecomBotBinding>;
  validate?: () => Promise<boolean>;
  active?: () => boolean;
  key: string;
  check(raw: string | null): boolean;
  extraKeys?: readonly string[];
  personIds?: readonly string[];
  checkSnapshot?(snapshot: GateSnapshot): boolean;
  /**
   * R2：M07 消费租约 fence。store 把“比对 owner/epoch/未到期”并进关闭草稿的那条条件 UPDATE（WHERE … AND EXISTS 租约行匹配），
   * 0 行 = 被挡（草稿退回待确认、零入账）。nowMs 在提交时取值。
   */
  fence?: { key: string; owner: string; epoch: number; nowMs: () => number };
}
/** 读取 guard 需要的全部配置键（空键忽略）。 */
export const guardKeys = (guard: CommitGuard): string[] => [...new Set([guard.key, ...(guard.extraKeys ?? [])].filter(key => !!key))];
/** store 共用：按快照或旧单键判定。 */
export function guardPasses(guard: CommitGuard, snapshot: GateSnapshot): boolean {
  if (guard.active && !guard.active()) return false;
  if (guard.binding && !sameBinding(guard.binding, snapshot.binding)) return false;
  return guard.checkSnapshot ? guard.checkSnapshot(snapshot) : guard.check(snapshot.config[guard.key] ?? null);
}

/** Final report text is derived inside the commit from this draft's persisted rows. */
export function settledReportDraft(draft: Draft, entries: readonly LedgerEntry[]): Draft {
  if (draft.payload.type !== 'report' || !draft.payload.employeeContext) return draft;
  return { ...draft, payload: { ...draft.payload, employeeContext: { ...draft.payload.employeeContext,
    finalReply: `Front Claw：已入账 ${entries.length} 笔，共 ${formatYuan(entries.reduce((sum, row) => sum + row.amount, 0))}元。操作号 ${draft.draftId}。`,
  } } };
}

export interface AliasRecord { storeId: string; alias: string; personId: string; }

export interface LedgerEntry {
  entryId: string;
  storeId: string;
  businessDay: string;
  customerName: string | null;
  /** 整数分（1 元 = 100）。加减与存储不得经 JS 浮点。 */
  amount: number;
  /** R5：开单业绩，值固定为 consultant（复用 amount_type 列）。 */
  amountType: 'consultant';
  ownerPersonId: string;
  ownerName: string;
  reporterPersonId: string;
  note: string;
  /** R5：confirmed=已确认入账（原 recorded）；voided=已作废（原 void）。CHECK 还允许 pending。 */
  status: 'pending' | 'confirmed' | 'voided';
  disputed: boolean;
  createdAt: string;
  /** R6 / M04-01：来源草稿 ID。唯一约束是 (sourceDraftId, sourceOrdinal)，不是客户+金额。 */
  sourceDraftId?: string;
  sourceOrdinal?: number;
}

export interface EntryPatch {
  customerName?: string | null;
  amount?: number;
  ownerPersonId?: string;
  ownerName?: string;
  note?: string;
  status?: 'pending' | 'confirmed' | 'voided';
  disputed?: boolean;
}

export interface Revision {
  revisionId: string;
  entryId: string;
  editorPersonId: string;
  beforeJson: string;
  afterJson: string;
  reason: string;
  createdAt: string;
}

export interface RevisionMeta { editorPersonId: string; reason: string; createdAt: string; revisionId: string; }

export interface Target {
  storeId: string;
  personId: string;
  periodMonth: string;
  /** 整数分。 */
  amount: number;
  updatedBy: string;
  updatedAt: string;
}

/** R5：门店月目标，独立表，不用特殊 person_id。 */
export interface StoreTarget {
  storeId: string;
  periodMonth: string;
  /** 整数分。 */
  amount: number;
  setBy: string;
  updatedAt: string;
}

export interface ReportDraftItem {
  customer: string | null;
  amount: number;
  employeeName: string;
  employeeId: string | null;
  note: string;
  /** R5：开单业绩，值固定为 consultant（复用 amount_type 列）。 */
  amountType: 'consultant';
  /** R1（M02）：原文金额写法（带单位/小数时），只用于确认回显。 */
  amountText?: string;
}

export interface MissingItem {
  entryId: string;
  customer: string | null;
  amount: number;
  employeeName: string;
  note: string;
}

export interface EmployeeDraftContext {
  sessionId: string; bindingVersion: number; accountId: string; memberId: string;
  version: string; messageId: string; fingerprint: string;
  actionMessageId?: string; actionFingerprint?: string; finalReply?: string;
  /** M02：草稿条目摘要（员工ID/姓名/金额/客户/备注），确认前复核，防止条目被改写；无摘要的旧草稿只允许本人。 */
  itemsDigest?: string;
  /** M02：同店代报（括号员工不是发送人）。 */
  proxy?: boolean;
  /** D183：本项曾替换旧项（包括过期项）；保留平台到达时间下界，严格比较覆盖全部报单。 */
  replacedPending?: boolean;
  reportedAt?: string;
  pendingSequence?: string;
  platformIssuedAt?: string;
}

export interface ReportPayload {
  type: 'report'; employeeContext?: EmployeeDraftContext; added: ReportDraftItem[]; missing: MissingItem[]; skipped: number;
  /** M04：与今天已入账完全相同而跳过的行（重发/追加时只记新增）。 */
  duplicates?: ReportDraftItem[];
  /** M04：确认前发现清单内容已被入账 → 作废，不入账。 */
  outcome?: 'conflict';
  /**
   * R6 数据兜底：本店今天已有该客户的单时，草稿不能只问「对不对」，
   * 必须让员工二选一（「新增一笔」或「改第 N 笔」）。此时不能用「对」提交。
   */
  awaitingDuplicateChoice?: { listed: CorrectionPickItem[]; reason: string; newAmount: number };
  /** 员工已明确选择「新增一笔」：同客户当天再来一次合法，确认时不再按内容查重拒绝。 */
  explicitNew?: boolean;
}
export interface AppointmentPayload {
  type: 'appointment'; items: { customer: string; whenText: string; note: string; date?: string; time?: string; customerNamed?: boolean }[];
  /** M05：员工入口预约草稿（登记即成立）。旧入口草稿没有这些字段。 */
  employeeContext?: EmployeeDraftContext;
  /** M05：回显时的指定店长（null = 待配置）；确认时按当前配置与策略重判。 */
  recipient?: { personId: string; name: string } | null;
  storeName?: string;
  /** M05：conflict = 回显后对象变化；duplicate = 同内容预约已由另一张草稿登记，本草稿作废、零写。 */
  outcome?: 'conflict' | 'duplicate';
}
/** M04：目标草稿。回显后确认才写 performance_targets；before 为回显时的原值（null=未设置），确认时比对。 */
export interface TargetPayload {
  type: 'target'; employeeContext: EmployeeDraftContext;
  target: { storeId: string; storeName: string; personId: string; personName: string; periodMonth: string; amount: number; kind?: 'person' | 'store' };
  before: { amount: number; updatedBy: string; updatedAt: string } | null;
  outcome?: 'conflict';
}
/** M04：一笔要更正的账目。beforeJson 为回显时账目原文（版本），确认时在行锁内比对。 */
export interface CorrectionChange {
  entryId: string; storeId: string; businessDay: string; ownerPersonId: string; ownerName: string; reporterPersonId: string;
  beforeJson: string; before: { amount: number; status: LedgerEntry['status'] }; patch: { amount?: number; status?: 'voided' };
  /** R4：确认回显用（原记录身份），不进入 entryVersion。 */
  customerName?: string | null;
  reportedAt?: string;
}
/** R7 二选一可见性：own=本人单；manager-full=店长看全貌；peer-redacted=别人的单，对普通员工抹掉金额/归属/报单人。 */
export type PickVisibility = 'own' | 'manager-full' | 'peer-redacted';
export interface CorrectionPickItem {
  index: number; customerName: string | null; businessDay: string; storeId: string; status: LedgerEntry['status'];
  visibility?: PickVisibility;
  /** 以下字段在 peer-redacted 时省略；普通员工可见草稿里不得出现 reporterPersonId。 */
  entryId?: string; amount?: number; reportedAt?: string;
  ownerName?: string; ownerPersonId?: string; reporterPersonId?: string;
  beforeJson?: string;
}
export interface CorrectionPayload {
  type: 'correction'; employeeContext: EmployeeDraftContext;
  action: 'amend' | 'withdraw'; scope: 'own' | 'store'; changes: CorrectionChange[];
  /** R4：0 或多项匹配时列出今天已报，等员工回「改 N」。此时 changes 为空，不能用「对」提交。 */
  awaitingPick?: { newAmount: number; listed: CorrectionPickItem[]; reason: string };
  outcome?: 'conflict';
}
export type DraftPayload = ReportPayload | AppointmentPayload | TargetPayload | CorrectionPayload;
/** M04 提交结果：committed=本次写入；already=草稿已不在 confirming（他人/重放已完成），本次零写；denied=提交时授权不通过，草稿退回待确认；conflict=对象已被改动，草稿作废、零写。 */
export type LedgerCommit = 'committed' | 'already' | 'denied' | 'conflict';
/** M05 预约提交选项与结果。 */
export interface AppointmentCommitOptions {
  guard?: CommitGuard;
  notices: readonly Notification[];
  /** 在提交事务内对锁住的策略原文判定收件人资格；不通过只丢该提醒，不回滚预约。 */
  noticeAllowed?: (raw: string | null, notice: Notification, snapshot?: GateSnapshot) => boolean;
}
export interface AppointmentCommit { total: number; claimed: boolean; outcome: LedgerCommit | 'duplicate'; noticesWritten: number }
export interface CorrectionWrite { entryId: string; beforeJson: string; patch: EntryPatch; revisionId: string; }
/** M04：账目版本 = 固定字段顺序的完整原文；更正确认时在行锁内比对，任何字段变化都算冲突。 */
export function entryVersion(entry: LedgerEntry): string {
  return JSON.stringify([entry.entryId, entry.storeId, entry.businessDay, entry.customerName, entry.amount, entry.amountType, entry.ownerPersonId,
    entry.ownerName, entry.reporterPersonId, entry.note, entry.status, entry.disputed, entry.createdAt]);
}
export function revisionIdFor(draftId: string, entryId: string): string {
  return createHash('sha256').update(`front-claw-revision\n${draftId}\n${entryId}`).digest('hex');
}
export function correctionNoticeId(draftId: string, recipientPersonId: string): string {
  return createHash('sha256').update(`front-claw-correction-notice\n${draftId}\n${recipientPersonId}`).digest('hex');
}

export interface Draft {
  draftId: string;
  reporterPersonId: string;
  storeId: string;
  businessDay: string;
  expiresAt: string;
  kind: 'report' | 'appointment' | 'target' | 'correction';
  payload: DraftPayload;
  status: 'pending' | 'confirming' | 'confirmed' | 'void';
  reminder: 'none' | 'claimed' | 'sent' | 'unknown';
  voidNotice: 'none' | 'claimed' | 'sent' | 'unknown';
  createdAt: string;
  closedAt: string | null;
}

export interface Appointment {
  appointmentId: string;
  storeId: string;
  employeePersonId: string;
  customerName: string;
  whenText: string;
  note: string;
  /** M05：registered = 登记即成立（员工入口）；pending_manager/confirmed 为旧入口状态机。 */
  status: 'pending_manager' | 'confirmed' | 'registered';
  createdAt: string;
}

export interface Notification {
  notificationId: string;
  kind: 'reminder' | 'void' | 'correction' | 'dispute' | 'appointment' | 'appointment_confirmed';
  recipientPersonId: string;
  body: string;
  status: 'pending' | 'sent' | 'not_sent' | 'unknown';
  relatedId: string;
  createdAt: string;
  sentAt: string | null;
  /** M06：出站箱派发信息（status 列带编码时才有；纯基本词的行没有此字段）。status 始终是基本词。 */
  delivery?: DeliveryMeta;
}
/** M06 出站箱领取参数。 */
export interface NotificationClaimOptions {
  nowIso: string;
  leaseUntil: string;
  limit: number;
  kinds: readonly Notification['kind'][];
  worker: string;
  tokenFor(notificationId: string): string;
}
/** M06 发送前判定：在锁住的配置（策略、指定店长）与锁住的行上决定进入“发送中”或直接结束。 */
export type SendDecision = { ok: true; nextRaw: string } | { ok: false; nextRaw: string | null };
/** R1 出口 (b)：发送前同一事务内重读（FOR SHARE）的收件人档案与关联草稿/预约。 */
export interface SendSnapshot { people: Record<string, Person | null>; drafts: Record<string, Draft | null>; appointments: Record<string, Appointment | null> }
export interface BeginSendOptions {
  lockKeys: readonly string[];
  personIds?: readonly string[];
  draftIds?: readonly string[];
  appointmentIds?: readonly string[];
  decide(config: Record<string, string | null>, row: Notification, current: SendSnapshot): SendDecision;
}
/** R1：写通知结果时的 fencing（领取时的 f 与当前时间）。 */
export interface ResultFence { epoch: number; nowIso: string }

export interface EntryFilter {
  storeId?: string;
  businessDay?: string;
  reporterPersonId?: string;
  ownerPersonId?: string;
  status?: LedgerEntry['status'];
}

/**
 * R3（A-P1-1）：消费者写入凭据——M07 消费租约行 key + 领取时的 owner/epoch，nowMs 在写入时取值。
 * 带上它的写入都经 store 内唯一入口 fencedWrite：同一事务里先条件锁读租约行（owner+epoch 相等且 until>now，FOR SHARE），
 * 0 行 = 拒绝（抛 FencedWriteRejected，什么都不写）；写 SQL 本身也带 EXISTS(租约匹配) 条件。
 */
export interface WriteFence { key: string; owner: string; epoch: number; nowMs: () => number }
export class FencedWriteRejected extends Error { constructor() { super('fenced_write_rejected'); this.name = 'FencedWriteRejected'; } }
/** A guarded row was busy. Propagate through the transaction rollback; never retry a business write automatically. */
export class CommitContentionRejected extends Error {
  readonly code = '55P03';
  constructor() { super('commit_contention_rejected'); this.name = 'CommitContentionRejected'; }
}

export interface PendingConditions { expiredAt?: string; arrivedAt?: string; unexpiredAt?: string; arrivedSequence?: string }
export interface PendingReportWrite {
  reporterPersonId: string; at: string; draft?: Draft; ask?: { key: string; value: string };
  expectedAsk?: { key: string; value: string; arrivedSequence: string };
}
export interface PendingReportResult { saved: boolean; drafts: Draft[]; asks: string[] }
export interface PerformanceStore {
  capturePendingArrival(): Promise<PendingArrival>;
  replacePendingReport(write: PendingReportWrite, fence?: WriteFence): Promise<PendingReportResult>;
  savePerson(person: Person): Promise<void>;
  getPerson(personId: string): Promise<Person | null>;
  getPersonByAccount(accountId: string): Promise<Person | null>;
  getPersonByMember(memberId: string): Promise<Person | null>;
  listPeople(): Promise<Person[]>;
  saveAlias(alias: AliasRecord): Promise<void>;
  /** Insert an alias copied from the base SQLite file. Existing store+alias rows stay. */
  importAlias(alias: AliasRecord): Promise<boolean>;
  listAliases(storeId?: string): Promise<AliasRecord[]>;
  insertEntries(entries: LedgerEntry[]): Promise<void>;
  listEntries(filter?: EntryFilter): Promise<LedgerEntry[]>;
  getEntry(entryId: string): Promise<LedgerEntry | null>;
  reviseEntry(entryId: string, patch: EntryPatch, meta: RevisionMeta): Promise<LedgerEntry>;
  listRevisions(entryId: string): Promise<Revision[]>;
  saveTarget(target: Target): Promise<void>;
  getTarget(storeId: string, personId: string, periodMonth: string): Promise<Target | null>;
  listTargets(storeId?: string): Promise<Target[]>;
  saveStoreTarget(target: StoreTarget): Promise<void>;
  getStoreTarget(storeId: string, periodMonth: string): Promise<StoreTarget | null>;
  listStoreTargets(storeId?: string): Promise<StoreTarget[]>;
  commitConfirmingStoreTarget(draft: Draft, target: StoreTarget, expectedBefore: { amount: number; setBy: string; updatedAt: string } | null, guard?: CommitGuard): Promise<LedgerCommit>;
  /** R3：options.fence 存在 → 经 fencedWrite（租约不符抛 FencedWriteRejected，不写）。 */
  saveDraft(draft: Draft, options?: { ifAbsent: boolean; fence?: WriteFence | undefined; pendingReport?: PendingReportWrite }): Promise<void | PendingReportResult>;
  /** 仅匹配原始待确认版本时转换状态，避免旧会话/旧版本覆盖。 */
  transitionPendingDraft(expected: Draft, next: Draft, fence?: WriteFence, conditions?: PendingConditions): Promise<boolean>;
  /** One caller wins the none -> claimed transition. A lost claim must not send. */
  claimDraftNotice(draftId: string, field: 'reminder' | 'voidNotice'): Promise<boolean>;
  /** One caller moves a pending draft to confirming. A lost claim must not insert again. */
  claimPendingDraft(draftId: string): Promise<Draft | null>;
  /**
   * Insert these entries and store the draft's next status in one step.
   * Repeating the same entry ids does not add rows. The draft update runs only while it is confirming.
   * M03：带 guard 时，同一事务内先以共享锁读取 guard.key 的配置并判定；
   * 判定拒绝则把草稿从 confirming 退回 pending、不写 entries，返回 -1。
   */
  commitConfirmingDraft(draft: Draft, entries: readonly LedgerEntry[], guard?: CommitGuard): Promise<number>;
  /**
   * Insert employee-submitted appointments and store the draft's next status.
   * Existing ids stay as they are, including a manager confirmation already recorded.
   * claimed is true only for the caller that moved the draft out of confirming.
   */
  /**
   * M05：带 options 时（员工入口“登记即成立”）同一事务：guard（策略行 FOR SHARE）→ 草稿 confirming→confirmed →
   * 预约 INSERT（内容确定 ID；已存在 = 另一张草稿已登记 → 整体回滚、草稿作废 outcome=duplicate）→
   * 按锁住的策略过滤待发提醒（noticeAllowed）→ 提醒 INSERT（pending，不派发）。
   * 不带 options 时为旧入口语义（不变）：总是插入、claimed 表示本次关闭了草稿。
   */
  commitConfirmingAppointments(draft: Draft, appointments: readonly Appointment[], options?: AppointmentCommitOptions): Promise<AppointmentCommit>;
  /** Move one pending_manager row to confirmed. A second call does not create a row. */
  confirmPendingAppointment(appointmentId: string): Promise<'confirmed' | 'already' | 'missing'>;
  getDraft(draftId: string): Promise<Draft | null>;
  getOpenDraft(reporterPersonId: string): Promise<Draft | null>;
  listDrafts(filter?: { status?: Draft['status']; kind?: Draft['kind']; reporterPersonId?: string; storeId?: string }): Promise<Draft[]>;
  saveAppointment(appointment: Appointment): Promise<void>;
  listAppointments(filter?: { storeId?: string; status?: Appointment['status']; employeePersonId?: string }): Promise<Appointment[]>;
  insertNotification(notification: Notification): Promise<void>;
  updateNotificationStatus(notificationId: string, status: Notification['status'], sentAt: string | null): Promise<void>;
  listNotifications(): Promise<Notification[]>;
  /** M06：按确定性 ID 入队，已存在则不动（返回是否新写入）。 */
  enqueueNotification(notification: Notification): Promise<boolean>;
  /**
   * M06：单事务领取到期行（PG：FOR UPDATE SKIP LOCKED），并发派发者互不重复。
   * 排队/已领取且到期 → 改为 claimed（新令牌、新租约，不计次数）；
   * 发送中且租约到期（发送阶段崩溃）→ 改为 unknown（不重发），放在 expired 里返回。
   */
  claimDueNotifications(options: NotificationClaimOptions): Promise<{ claimed: Notification[]; expired: Notification[] }>;
  /** M06：同一事务内 FOR SHARE 锁配置键 → FOR UPDATE 锁行 → 原文不符为 lost → decide 决定进入发送中（sending）或结束（refused）。 */
  beginNotificationSend(notificationId: string, expectedRaw: string, options: BeginSendOptions): Promise<'sending' | 'refused' | 'lost'>;
  /**
   * M06：仅当 status 原文仍等于 expectedRaw 时改写。R1：nextRaw 必须是合法编码；带 fence 时还要求
   * 当前领取（claimed/sending）的 fencing 版本号一致且租约未到期——过期的旧领取者即使没人接管也写不进去。
   */
  transitionNotification(notificationId: string, expectedRaw: string, nextRaw: string, sentAt: string | null, fence?: ResultFence): Promise<boolean>;
  /** R1（M06-05）：人工补发——同一事务内条件改状态并写审计（审计键已存在则整体不生效）。返回是否由本次生效。 */
  requeueNotificationWithAudit(notificationId: string, expectedRaw: string, nextRaw: string, audit: { key: string; value: string }): Promise<boolean>;
  getConfig(key: string): Promise<string | null>;
  setConfig(key: string, value: string, fence?: WriteFence): Promise<void>;
  compareAndSetPendingAsk(key: string, expected: string, value: string, conditions: PendingConditions, fence?: WriteFence): Promise<boolean>;
  /**
   * M04：目标确认。同一事务：guard（策略行 FOR SHARE）→ 草稿 confirming→confirmed → 目标行 FOR UPDATE 比对 expectedBefore → 写入。
   * 比对不符（回显后被改/并发插入）整体回滚并把草稿作废（outcome=conflict）。
   */
  commitConfirmingTarget(draft: Draft, target: Target, expectedBefore: TargetPayload['before'], guard?: CommitGuard): Promise<LedgerCommit>;
  /**
   * M04：更正确认。同一事务：guard → 草稿 confirming→confirmed → 账目行按 ID 排序 FOR UPDATE 比对 beforeJson → 改账 + revisions（确定性 ID）+ 改账通知意图（pending，不派发）。
   * 任一账目已变 → 整体回滚、草稿作废（outcome=conflict）。
   */
  commitConfirmingCorrection(draft: Draft, writes: readonly CorrectionWrite[], meta: { editorPersonId: string; reason: string; createdAt: string }, notices: readonly Notification[], guard?: CommitGuard): Promise<LedgerCommit>;
  /** M03：事务内排他锁定 key（及 extraKeys）后读出当前值，mutate 返回要写的键值（null=不写）。返回是否写入。 */
  updateConfigLocked(key: string, extraKeys: readonly string[], mutate: (current: Record<string, string | null>) => Record<string, string> | null): Promise<boolean>;
  /** M07：键不存在才写入（INSERT … ON CONFLICT DO NOTHING），已存在不覆盖。返回是否本次写入。 */
  insertConfigIfAbsent(key: string, value: string): Promise<boolean>;
}

/** M06：读出时把编码的 status 拆成基本词 + delivery（纯基本词的行原样返回，旧调用方/旧断言不受影响）。 */
export function withDelivery(row: Notification): Notification {
  const copy = clone(row);
  const raw = copy.status as string;
  if (!raw.includes('|')) return copy;
  const decoded = decodeStatus(raw);
  return { ...copy, status: decoded.status, delivery: decoded.delivery };
}
/** M06：领取时的状态转换（PG 与内存共用）。 */
/**
 * R3：claimed 的 raw 是“不含 f 的模板”（bumpFence=true）——f 由存储在同一条写里按当前行 f+1 补上（PG：f = f + 1 的 regexp_replace），
 * 应用层不再计算 f。sending 过期 → unknown 保留原 f（bumpFence=false）。
 */
export function claimTransition(raw: string, options: NotificationClaimOptions, notificationId: string): { raw: string; expired: boolean; bumpFence: boolean } | null {
  const { delivery } = decodeStatus(raw);
  // R1：畸形原文不领取（隔离，保留原文作证据）。
  if (delivery.error === 'malformed_status') return null;
  if (delivery.phase === 'sending') {
    return { raw: encodeStatus('unknown', { attempts: delivery.attempts, resends: delivery.resends, fence: delivery.fence, error: 'lease_expired_during_send' }), expired: true, bumpFence: false };
  }
  return { raw: encodeStatus('pending', { phase: 'claimed', dueAt: options.leaseUntil, attempts: delivery.attempts, resends: delivery.resends, token: options.tokenFor(notificationId), worker: options.worker, error: delivery.error }), expired: false, bumpFence: true };
}
export function clone<T>(value: T): T {
  return structuredClone(value);
}

function matchesEntry(entry: LedgerEntry, filter: EntryFilter | undefined): boolean {
  if (!filter) return true;
  if (filter.storeId !== undefined && entry.storeId !== filter.storeId) return false;
  if (filter.businessDay !== undefined && entry.businessDay !== filter.businessDay) return false;
  if (filter.reporterPersonId !== undefined && entry.reporterPersonId !== filter.reporterPersonId) return false;
  if (filter.ownerPersonId !== undefined && entry.ownerPersonId !== filter.ownerPersonId) return false;
  if (filter.status !== undefined && entry.status !== filter.status) return false;
  return true;
}

export class MemoryPerformanceStore implements PerformanceStore {
  private pendingSequence = 0n;
  async capturePendingArrival(): Promise<PendingArrival> {
    return { sequence: String(++this.pendingSequence), hours: await this.getConfig('front-claw-store-hours') };
  }
  private people: Person[] = [];
  private aliases: AliasRecord[] = [];
  private entries: LedgerEntry[] = [];
  private revisions: Revision[] = [];
  private targets: Target[] = [];
  private storeTargets: StoreTarget[] = [];
  private drafts: Draft[] = [];
  private appointments: Appointment[] = [];
  private notifications: Notification[] = [];
  private config = new Map<string, string>();

  async savePerson(person: Person): Promise<void> {
    const next = clone(person);
    const index = this.people.findIndex(row => row.personId === next.personId);
    if (index >= 0) this.people[index] = next;
    else this.people.push(next);
  }
  async getPerson(personId: string): Promise<Person | null> {
    return clone(this.people.find(row => row.personId === personId) ?? null);
  }
  async getPersonByAccount(accountId: string): Promise<Person | null> {
    const rows = this.people.filter(row => row.accountId === accountId);
    return rows.length === 1 ? clone(rows[0]!) : null;
  }
  async getPersonByMember(memberId: string): Promise<Person | null> {
    const rows = this.people.filter(row => row.memberId === memberId);
    return rows.length === 1 ? clone(rows[0]!) : null;
  }
  async listPeople(): Promise<Person[]> {
    return clone(this.people);
  }
  async saveAlias(alias: AliasRecord): Promise<void> {
    const person = this.people.find(row => row.personId === alias.personId);
    if (!person || person.storeId !== alias.storeId) throw Error('alias_person');
    const next = clone(alias);
    const index = this.aliases.findIndex(row => row.storeId === next.storeId && row.alias === next.alias);
    if (index >= 0) this.aliases[index] = next;
    else this.aliases.push(next);
  }
  async importAlias(alias: AliasRecord): Promise<boolean> {
    const index = this.aliases.findIndex(row => row.storeId === alias.storeId && row.alias === alias.alias);
    if (index >= 0) return false;
    this.aliases.push(clone(alias));
    return true;
  }
  async listAliases(storeId?: string): Promise<AliasRecord[]> {
    return clone(this.aliases.filter(row => storeId === undefined || row.storeId === storeId));
  }
  async insertEntries(entries: LedgerEntry[]): Promise<void> {
    for (const entry of entries) this.entries.push(clone(entry));
  }
  async listEntries(filter?: EntryFilter): Promise<LedgerEntry[]> {
    return clone(this.entries.filter(entry => matchesEntry(entry, filter)).sort(byCreated));
  }
  async getEntry(entryId: string): Promise<LedgerEntry | null> {
    return clone(this.entries.find(entry => entry.entryId === entryId) ?? null);
  }
  async reviseEntry(entryId: string, patch: EntryPatch, meta: RevisionMeta): Promise<LedgerEntry> {
    const index = this.entries.findIndex(entry => entry.entryId === entryId);
    const current = this.entries[index];
    if (!current) throw Error('missing_entry');
    const beforeJson = JSON.stringify(current);
    const next: LedgerEntry = { ...current, ...definedPatch(patch) };
    const afterJson = JSON.stringify(next);
    this.entries[index] = next;
    this.revisions.push({
      revisionId: meta.revisionId,
      entryId,
      editorPersonId: meta.editorPersonId,
      beforeJson,
      afterJson,
      reason: meta.reason,
      createdAt: meta.createdAt,
    });
    return clone(next);
  }
  async listRevisions(entryId: string): Promise<Revision[]> {
    return clone(this.revisions.filter(row => row.entryId === entryId));
  }
  async saveTarget(target: Target): Promise<void> {
    const next = clone(target);
    const index = this.targets.findIndex(row => row.storeId === next.storeId && row.personId === next.personId && row.periodMonth === next.periodMonth);
    if (index >= 0) this.targets[index] = next;
    else this.targets.push(next);
  }
  async getTarget(storeId: string, personId: string, periodMonth: string): Promise<Target | null> {
    return clone(this.targets.find(row => row.storeId === storeId && row.personId === personId && row.periodMonth === periodMonth) ?? null);
  }
  async listTargets(storeId?: string): Promise<Target[]> {
    return clone(this.targets.filter(row => storeId === undefined || row.storeId === storeId));
  }
  async saveStoreTarget(target: StoreTarget): Promise<void> {
    const next = clone(target);
    const index = this.storeTargets.findIndex(row => row.storeId === next.storeId && row.periodMonth === next.periodMonth);
    if (index >= 0) this.storeTargets[index] = next;
    else this.storeTargets.push(next);
  }
  async getStoreTarget(storeId: string, periodMonth: string): Promise<StoreTarget | null> {
    return clone(this.storeTargets.find(row => row.storeId === storeId && row.periodMonth === periodMonth) ?? null);
  }
  async listStoreTargets(storeId?: string): Promise<StoreTarget[]> {
    return clone(this.storeTargets.filter(row => storeId === undefined || row.storeId === storeId));
  }
  async commitConfirmingStoreTarget(draft: Draft, target: StoreTarget, expectedBefore: { amount: number; setBy: string; updatedAt: string } | null, guard?: CommitGuard): Promise<LedgerCommit> {
    if (this.guardDenied(draft, guard)) return 'denied';
    const index = this.drafts.findIndex(row => row.draftId === draft.draftId);
    if (index < 0 || this.drafts[index]!.status !== 'confirming') return 'already';
    const current = this.storeTargets.find(row => row.storeId === target.storeId && row.periodMonth === target.periodMonth) ?? null;
    const same = expectedBefore === null ? current === null
      : !!current && current.amount === expectedBefore.amount && current.setBy === expectedBefore.setBy && current.updatedAt === expectedBefore.updatedAt;
    if (!same) { this.voidConflict(draft.draftId, draft.closedAt, guard); return 'conflict'; }
    this.drafts[index] = clone(draft);
    await this.saveStoreTarget(target);
    return 'committed';
  }
  /** R3（A-P1-1）：内存版唯一带 epoch 写入入口——与 PG 同一判定（fenceHolds），不成立即拒绝、不写。 */
  private fencedWrite<T>(fence: WriteFence | undefined, write: () => T): T {
    if (fence && !fenceHolds(parseLeaseRecord(this.config.get(fence.key) ?? null), fence, fence.nowMs())) throw new FencedWriteRejected();
    return write();
  }
  async saveDraft(draft: Draft, options?: { ifAbsent: boolean; fence?: WriteFence | undefined; pendingReport?: PendingReportWrite }): Promise<void | PendingReportResult> {
    if (options?.pendingReport) return this.replacePendingReport(options.pendingReport, options.fence);
    this.fencedWrite(options?.fence, () => this.saveDraftNow(draft, options));
  }
  private saveDraftNow(draft: Draft, options?: { ifAbsent: boolean }): void {
    const next = clone(draft);
    const index = this.drafts.findIndex(row => row.draftId === next.draftId);
    if (index >= 0 && options?.ifAbsent) return;
    // D174：与 PG 部分唯一索引同义，跨门店、跨会话按员工约束。
    if (next.status === 'pending' && this.drafts.some(row => row.reporterPersonId === next.reporterPersonId && row.status === 'pending' && row.draftId !== next.draftId)) throw Error('pending_reporter_unique');
    if (index >= 0) { if (!options?.ifAbsent) this.drafts[index] = next; }
    else this.drafts.push(next);
  }
  async replacePendingReport(write: PendingReportWrite, fence?: WriteFence): Promise<PendingReportResult> {
    const w = clone(write);
    return this.fencedWrite(fence, () => {
      const no = { saved: false, drafts: [], asks: [] };
      if (w.draft && this.drafts.some(d => d.draftId === w.draft!.draftId)) return no;
      if (w.expectedAsk) {
        const e = w.expectedAsk, raw = this.config.get(e.key);
        if (raw !== e.value) return no;
        const ask = JSON.parse(raw) as { issuedSequence?: string; expiresAt?: string };
        if (!(sequenceBefore(ask.issuedSequence, e.arrivedSequence)) || !(Date.parse(ask.expiresAt ?? '') > Date.parse(w.at))) return no;
      }
      const drafts = this.drafts.filter(d => d.reporterPersonId === w.reporterPersonId && d.status === 'pending');
      const asks = [...this.config].filter(([k, v]) => k.startsWith(`employee-loop:new-customer-ask:${w.reporterPersonId}:`) && !!v);
      const previousDrafts = clone(drafts);
      // D174：消费旧项与挂上新项在同一个同步写区间内，肯定答复必须仍持有原追问版本。
      for (const d of drafts) { d.status = 'void'; d.closedAt = w.at; }
      for (const [k] of asks) this.config.set(k, '');
      const replaced = drafts.length > 0 || asks.some(([k]) => k !== w.expectedAsk?.key);
      if (w.draft) {
        if ('employeeContext' in w.draft.payload && w.draft.payload.employeeContext) w.draft.payload.employeeContext.pendingSequence = String(++this.pendingSequence);
        if (replaced && 'employeeContext' in w.draft.payload && w.draft.payload.employeeContext) w.draft.payload.employeeContext.replacedPending = true;
        this.saveDraftNow(w.draft, { ifAbsent: true });
      }
      if (w.ask) {
        const value = JSON.parse(w.ask.value);
        value.issuedAt = w.at;
        value.issuedSequence = String(++this.pendingSequence);
        if (replaced) value.replacedPending = true;
        this.config.set(w.ask.key, JSON.stringify(value));
      }
      return { saved: true, drafts: previousDrafts, asks: asks.filter(([k]) => k !== w.expectedAsk?.key).map(([, v]) => v) };
    });
  }
  async transitionPendingDraft(expected: Draft, next: Draft, fence?: WriteFence, conditions?: PendingConditions): Promise<boolean> {
    return this.fencedWrite(fence, () => this.transitionPendingNow(expected, next, conditions));
  }
  private transitionPendingNow(expected: Draft, next: Draft, conditions?: PendingConditions): boolean {
    const row = this.drafts.find(draft => draft.draftId === expected.draftId);
    if (!row || row.status !== 'pending' || row.reporterPersonId !== expected.reporterPersonId || row.storeId !== expected.storeId || JSON.stringify(row.payload) !== JSON.stringify(expected.payload)) return false;
    if (conditions?.expiredAt && !(Date.parse(row.expiresAt) <= Date.parse(conditions.expiredAt))) return false;
    if (conditions?.arrivedAt && !(Date.parse(row.createdAt) < Date.parse(conditions.arrivedAt))) return false;
    if (conditions?.arrivedSequence && !sequenceBefore('employeeContext' in row.payload ? row.payload.employeeContext?.pendingSequence : undefined, conditions.arrivedSequence)) return false;
    if (conditions?.unexpiredAt && !(Date.parse(row.expiresAt) > Date.parse(conditions.unexpiredAt))) return false;
    row.status = next.status;
    row.payload = clone(next.payload);
    row.closedAt = next.closedAt;
    return true;
  }
  async claimDraftNotice(draftId: string, field: 'reminder' | 'voidNotice'): Promise<boolean> {
    const draft = this.drafts.find(row => row.draftId === draftId);
    if (!draft || draft[field] !== 'none') return false;
    draft[field] = 'claimed';
    return true;
  }
  async claimPendingDraft(draftId: string): Promise<Draft | null> {
    const draft = this.drafts.find(row => row.draftId === draftId);
    if (!draft || draft.status !== 'pending') return null;
    draft.status = 'confirming';
    return clone(draft);
  }
  private snapshotFor(guard: CommitGuard): GateSnapshot {
    const config: Record<string, string | null> = {};
    for (const key of guardKeys(guard)) config[key] = this.config.get(key) ?? null;
    const people: Record<string, Person | null> = {};
    for (const id of guard.personIds ?? []) people[id] = clone(this.people.find(row => row.personId === id) ?? null);
    return { config, people };
  }
  /** R4：补偿只在本消费者仍是当前持有者时才把 confirming 退回 pending。 */
  private fenceHeld(guard?: CommitGuard): boolean {
    if (!guard?.fence) return true;
    return fenceHolds(parseLeaseRecord(this.config.get(guard.fence.key) ?? null), guard.fence, guard.fence.nowMs());
  }
  private revertIfCurrentHolder(draft: Draft, guard?: CommitGuard): boolean {
    const current = this.drafts.find(row => row.draftId === draft.draftId);
    if (current?.status !== 'confirming') return false;
    if (guard?.fence && !this.fenceHeld(guard)) return false;
    if (this.drafts.some(d => d.draftId !== current.draftId && d.reporterPersonId === current.reporterPersonId && d.status === 'pending')) return false;
    current.status = 'pending'; current.closedAt = null;
    return true;
  }
  async commitConfirmingDraft(draft: Draft, entries: readonly LedgerEntry[], guard?: CommitGuard): Promise<number> {
    const current = this.drafts.find(row => row.draftId === draft.draftId);
    if (guard && !guardPasses(guard, this.snapshotFor(guard))) {
      this.revertIfCurrentHolder(draft, guard);
      return -1;
    }
    if (guard?.fence && !this.fenceHeld(guard)) {
      // 补偿仍走比对当前持有者的入口：失权则 0 行，不打扰新持有者。
      this.revertIfCurrentHolder(draft, guard);
      return -1;
    }
    if (current?.status !== 'confirming') {
      // R17 / D151：不是本次把 confirming 改成 confirmed，返回 0，不把已有行数当成这次写入。
      return 0;
    }
    const explicitNew = draft.payload.type === 'report' && draft.payload.explicitNew === true;
    const contentKey = (row: { storeId: string; businessDay: string; ownerPersonId: string; amount: number; customerName: string | null; note: string }) =>
      JSON.stringify([row.storeId, row.businessDay, row.ownerPersonId, row.amount, row.customerName, row.note]);
    const remaining = new Map<string, number>();
    for (const row of this.entries) {
      if (row.status !== 'confirmed') continue;
      const key = contentKey(row);
      remaining.set(key, (remaining.get(key) ?? 0) + 1);
    }
    for (const entry of entries) {
      const sourceConflict = entry.sourceDraftId != null && this.entries.some(row =>
        row.sourceDraftId === entry.sourceDraftId && (row.sourceOrdinal ?? 0) === (entry.sourceOrdinal ?? 0));
      const idConflict = this.entries.some(row => row.entryId === entry.entryId);
      const key = contentKey(entry);
      const left = remaining.get(key) ?? 0;
      const contentConflict = !explicitNew && left > 0;
      if (contentConflict) remaining.set(key, left - 1);
      if (!sourceConflict && !idConflict && !contentConflict) this.entries.push(clone(entry));
    }
    const index = this.drafts.findIndex(row => row.draftId === draft.draftId);
    const persisted = entries.filter(entry => this.entries.some(row => row.entryId === entry.entryId));
    this.drafts[index] = clone(settledReportDraft(draft, persisted));
    const total = persisted.length;
    return Math.max(1, total);
  }
  private voidConflict(draftId: string, closedAt: string | null, guard?: CommitGuard): void {
    const row = this.drafts.find(item => item.draftId === draftId);
    if (row?.status !== 'confirming') return;
    if (guard?.fence && !this.fenceHeld(guard)) return;
    row.status = 'void'; row.closedAt = closedAt;
    row.payload = { ...row.payload, outcome: 'conflict' } as DraftPayload;
  }
  private guardDenied(draft: Draft, guard?: CommitGuard): boolean {
    if (guard && !guardPasses(guard, this.snapshotFor(guard))) {
      this.revertIfCurrentHolder(draft, guard);
      return true;
    }
    if (guard?.fence && !this.fenceHeld(guard)) return true;
    return false;
  }
  async commitConfirmingTarget(draft: Draft, target: Target, expectedBefore: TargetPayload['before'], guard?: CommitGuard): Promise<LedgerCommit> {
    if (this.guardDenied(draft, guard)) return 'denied';
    const index = this.drafts.findIndex(row => row.draftId === draft.draftId);
    if (index < 0 || this.drafts[index]!.status !== 'confirming') return 'already';
    const current = this.targets.find(row => row.storeId === target.storeId && row.personId === target.personId && row.periodMonth === target.periodMonth) ?? null;
    const same = expectedBefore === null ? current === null
      : !!current && current.amount === expectedBefore.amount && current.updatedBy === expectedBefore.updatedBy && current.updatedAt === expectedBefore.updatedAt;
    if (!same) { this.voidConflict(draft.draftId, draft.closedAt, guard); return 'conflict'; }
    this.drafts[index] = clone(draft);
    await this.saveTarget(target);
    return 'committed';
  }
  async commitConfirmingCorrection(draft: Draft, writes: readonly CorrectionWrite[], meta: { editorPersonId: string; reason: string; createdAt: string }, notices: readonly Notification[], guard?: CommitGuard): Promise<LedgerCommit> {
    if (this.guardDenied(draft, guard)) return 'denied';
    const index = this.drafts.findIndex(row => row.draftId === draft.draftId);
    if (index < 0 || this.drafts[index]!.status !== 'confirming') return 'already';
    for (const write of writes) {
      const row = this.entries.find(entry => entry.entryId === write.entryId);
      if (!row || entryVersion(row) !== write.beforeJson) { this.voidConflict(draft.draftId, draft.closedAt, guard); return 'conflict'; }
    }
    this.drafts[index] = clone(draft);
    for (const write of [...writes].sort((a, b) => a.entryId.localeCompare(b.entryId))) {
      if (this.revisions.some(row => row.revisionId === write.revisionId)) continue;
      await this.reviseEntry(write.entryId, write.patch, { ...meta, revisionId: write.revisionId });
    }
    for (const notice of notices) if (!this.notifications.some(row => row.notificationId === notice.notificationId)) this.notifications.push(clone(notice));
    return 'committed';
  }
  async commitConfirmingAppointments(draft: Draft, appointments: readonly Appointment[], options?: AppointmentCommitOptions): Promise<AppointmentCommit> {
    if (options) {
      if (this.guardDenied(draft, options.guard)) return { total: 0, claimed: false, outcome: 'denied', noticesWritten: 0 };
      const index = this.drafts.findIndex(row => row.draftId === draft.draftId);
      if (index < 0 || this.drafts[index]!.status !== 'confirming') return { total: 0, claimed: false, outcome: 'already', noticesWritten: 0 };
      if (appointments.some(appointment => this.appointments.some(row => row.appointmentId === appointment.appointmentId))) {
        const row = this.drafts[index]!;
        row.status = 'void'; row.closedAt = draft.closedAt; row.payload = { ...row.payload, outcome: 'duplicate' } as DraftPayload;
        return { total: 0, claimed: false, outcome: 'duplicate', noticesWritten: 0 };
      }
      this.drafts[index] = clone(draft);
      for (const appointment of appointments) this.appointments.push(clone(appointment));
      const snapshot = options.guard ? this.snapshotFor(options.guard) : { config: {}, people: {} };
      const raw = options.guard ? snapshot.config[options.guard.key] ?? null : null;
      let noticesWritten = 0;
      for (const notice of options.notices) {
        if (options.noticeAllowed && !options.noticeAllowed(raw, notice, snapshot)) continue;
        if (!this.notifications.some(row => row.notificationId === notice.notificationId)) { this.notifications.push(clone(notice)); noticesWritten += 1; }
      }
      return { total: appointments.length, claimed: true, outcome: 'committed', noticesWritten };
    }
    const current = this.drafts.find(row => row.draftId === draft.draftId);
    const claimed = current?.status === 'confirming';
    if (claimed) {
      for (const appointment of appointments) {
        if (!this.appointments.some(row => row.appointmentId === appointment.appointmentId)) this.appointments.push(clone(appointment));
      }
      const index = this.drafts.findIndex(row => row.draftId === draft.draftId);
      this.drafts[index] = clone(draft);
    }
    return { total: appointments.filter(appointment => this.appointments.some(row => row.appointmentId === appointment.appointmentId)).length, claimed, outcome: claimed ? 'committed' : 'already', noticesWritten: 0 };
  }
  async confirmPendingAppointment(appointmentId: string): Promise<'confirmed' | 'already' | 'missing'> {
    const row = this.appointments.find(appointment => appointment.appointmentId === appointmentId);
    if (!row) return 'missing';
    if (row.status === 'confirmed') return 'already';
    if (row.status !== 'pending_manager') return 'missing';
    row.status = 'confirmed';
    return 'confirmed';
  }
  async getDraft(draftId: string): Promise<Draft | null> {
    return clone(this.drafts.find(row => row.draftId === draftId) ?? null);
  }
  async getOpenDraft(reporterPersonId: string): Promise<Draft | null> {
    const rows = this.drafts.filter(row => row.reporterPersonId === reporterPersonId && row.status === 'pending');
    return rows.length ? clone(rows[rows.length - 1]!) : null;
  }
  async listDrafts(filter?: { status?: Draft['status']; kind?: Draft['kind']; reporterPersonId?: string; storeId?: string }): Promise<Draft[]> {
    return clone(this.drafts.filter(row => (filter?.status === undefined || row.status === filter.status) && (filter?.kind === undefined || row.kind === filter.kind) && (filter?.reporterPersonId === undefined || row.reporterPersonId === filter.reporterPersonId) && (filter?.storeId === undefined || row.storeId === filter.storeId)));
  }
  async saveAppointment(appointment: Appointment): Promise<void> {
    const next = clone(appointment);
    const index = this.appointments.findIndex(row => row.appointmentId === next.appointmentId);
    if (index >= 0) this.appointments[index] = next;
    else this.appointments.push(next);
  }
  async listAppointments(filter?: { storeId?: string; status?: Appointment['status']; employeePersonId?: string }): Promise<Appointment[]> {
    return clone(this.appointments.filter(row => {
      if (filter?.storeId !== undefined && row.storeId !== filter.storeId) return false;
      if (filter?.status !== undefined && row.status !== filter.status) return false;
      if (filter?.employeePersonId !== undefined && row.employeePersonId !== filter.employeePersonId) return false;
      return true;
    }).sort(byCreated));
  }
  async insertNotification(notification: Notification): Promise<void> {
    assertStatus(notification.status);
    this.notifications.push(clone(notification));
  }
  async updateNotificationStatus(notificationId: string, status: Notification['status'], sentAt: string | null): Promise<void> {
    const row = this.notifications.find(item => item.notificationId === notificationId);
    if (!row) throw Error('missing_notification');
    row.status = status;
    row.sentAt = sentAt;
  }
  async listNotifications(): Promise<Notification[]> {
    return this.notifications.map(withDelivery);
  }
  async enqueueNotification(notification: Notification): Promise<boolean> {
    assertStatus(notification.status);
    if (this.notifications.some(row => row.notificationId === notification.notificationId)) return false;
    this.notifications.push(clone(notification));
    return true;
  }
  async claimDueNotifications(options: NotificationClaimOptions): Promise<{ claimed: Notification[]; expired: Notification[] }> {
    const due = this.notifications.filter(row => options.kinds.includes(row.kind) && outboxManaged(row.notificationId) && dueRaw(row.status, options.nowIso))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.notificationId.localeCompare(right.notificationId)).slice(0, options.limit);
    const claimed: Notification[] = [], expired: Notification[] = [];
    for (const row of due) {
      const next = claimTransition(row.status, options, row.notificationId);
      if (!next) continue;
      const raw = next.bumpFence ? bumpFence(next.raw, row.status) : next.raw;
      if (raw === null) continue; // f 到顶：不领取
      assertStatus(raw);
      row.status = raw as Notification['status'];
      (next.expired ? expired : claimed).push(withDelivery(row));
    }
    return { claimed, expired };
  }
  async beginNotificationSend(notificationId: string, expectedRaw: string, options: BeginSendOptions): Promise<'sending' | 'refused' | 'lost'> {
    const config: Record<string, string | null> = {};
    for (const key of options.lockKeys) config[key] = this.config.get(key) ?? null;
    const current: SendSnapshot = { people: {}, drafts: {}, appointments: {} };
    for (const id of options.personIds ?? []) current.people[id] = clone(this.people.find(item => item.personId === id) ?? null);
    for (const id of options.draftIds ?? []) current.drafts[id] = clone(this.drafts.find(item => item.draftId === id) ?? null);
    for (const id of options.appointmentIds ?? []) current.appointments[id] = clone(this.appointments.find(item => item.appointmentId === id) ?? null);
    const row = this.notifications.find(item => item.notificationId === notificationId);
    if (!row || row.status !== expectedRaw) return 'lost';
    const decision = options.decide(config, withDelivery(row), current);
    if (decision.nextRaw !== null) { assertStatus(decision.nextRaw); row.status = decision.nextRaw as Notification['status']; }
    return decision.ok ? 'sending' : decision.nextRaw === null ? 'lost' : 'refused';
  }
  async transitionNotification(notificationId: string, expectedRaw: string, nextRaw: string, sentAt: string | null, fence?: ResultFence): Promise<boolean> {
    assertStatus(nextRaw);
    const row = this.notifications.find(item => item.notificationId === notificationId);
    if (!row || row.status !== expectedRaw) return false;
    if (fence && !resultFenceHolds(row.status, expectedRaw, fence)) return false;
    row.status = nextRaw as Notification['status'];
    row.sentAt = sentAt;
    return true;
  }
  async requeueNotificationWithAudit(notificationId: string, expectedRaw: string, nextRaw: string, audit: { key: string; value: string }): Promise<boolean> {
    assertStatus(nextRaw);
    const row = this.notifications.find(item => item.notificationId === notificationId);
    if (!row || row.status !== expectedRaw || this.config.has(audit.key)) return false;
    row.status = nextRaw as Notification['status'];
    row.sentAt = null;
    this.config.set(audit.key, audit.value);
    return true;
  }
  async getConfig(key: string): Promise<string | null> {
    return this.config.get(key) ?? null;
  }
  async setConfig(key: string, value: string, fence?: WriteFence): Promise<void> {
    assertWritableConfigKey(key);
    this.fencedWrite(fence, () => this.config.set(key, value));
  }
  async compareAndSetPendingAsk(key: string, expected: string, value: string, conditions: PendingConditions, fence?: WriteFence): Promise<boolean> {
    assertWritableConfigKey(key);
    return this.fencedWrite(fence, () => {
      if (this.config.get(key) !== expected) return false;
      const ask = (conditions.expiredAt || conditions.arrivedAt || conditions.arrivedSequence || conditions.unexpiredAt ? JSON.parse(expected) : {}) as { expiresAt?: string; issuedAt?: string; issuedSequence?: string };
      if (conditions.expiredAt && !(Date.parse(ask.expiresAt ?? '') <= Date.parse(conditions.expiredAt))) return false;
      if (conditions.arrivedAt && !(Date.parse(ask.issuedAt ?? '') < Date.parse(conditions.arrivedAt))) return false;
      if (conditions.arrivedSequence && !sequenceBefore(ask.issuedSequence, conditions.arrivedSequence)) return false;
      if (conditions.unexpiredAt && !(Date.parse(ask.expiresAt ?? '') > Date.parse(conditions.unexpiredAt))) return false;
      this.config.set(key, value);
      return true;
    });
  }
  async updateConfigLocked(key: string, extraKeys: readonly string[], mutate: (current: Record<string, string | null>) => Record<string, string> | null): Promise<boolean> {
    const current: Record<string, string | null> = {};
    for (const name of [key, ...extraKeys]) current[name] = this.config.get(name) ?? null;
    const writes = mutate(current);
    if (!writes) return false;
    for (const [name, value] of Object.entries(writes)) this.config.set(name, value);
    return true;
  }
  async insertConfigIfAbsent(key: string, value: string): Promise<boolean> {
    if (this.config.has(key)) return false;
    this.config.set(key, value);
    return true;
  }
}

function definedPatch(patch: EntryPatch): EntryPatch {
  const next: EntryPatch = {};
  if (patch.customerName !== undefined) next.customerName = patch.customerName;
  if (patch.amount !== undefined) next.amount = patch.amount;
  if (patch.ownerPersonId !== undefined) next.ownerPersonId = patch.ownerPersonId;
  if (patch.ownerName !== undefined) next.ownerName = patch.ownerName;
  if (patch.note !== undefined) next.note = patch.note;
  if (patch.status !== undefined) next.status = patch.status;
  if (patch.disputed !== undefined) next.disputed = patch.disputed;
  return next;
}

function byCreated(left: { createdAt: string; entryId?: string; appointmentId?: string }, right: { createdAt: string }): number {
  return left.createdAt.localeCompare(right.createdAt);
}
