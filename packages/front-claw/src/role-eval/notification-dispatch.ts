import { pausePoint } from './pause-points.js';
import { createHash, randomUUID } from 'node:crypto';
import { decideAccess, POLICY_LOCK_KEYS, policyFrom, type Capability } from './access-policy.js';
import { APPOINTMENT_RECIPIENTS_KEY, appointmentReminderId, designatedRecipient, reminderBody } from './appointments.js';
import { DEFAULT_BUSINESS_CUTOFF, DEFAULT_TIME_ZONE, REMINDER_DELAY_MS, zonedDateTime } from './metrics.js';
import { decodeStatus, encodeStatus } from './notification-status.js';
import type { Appointment, Draft, Notification, PerformanceStore, Person, ResultFence } from './performance-store.js';
import { resolveStoreHours, STORE_HOURS_KEY } from './store-hours.js';
import type { BotReadScope } from './wecom-bot-context.js';
import type { BotSendOutcome } from './wecom-bot-sender.js';

/**
 * M06 持久通知派发器（出站箱）。
 * - 领取：store.claimDueNotifications（PG：FOR UPDATE SKIP LOCKED + 租约 + 令牌）。
 * - 发送前：store.beginNotificationSend 在同一事务内 FOR SHARE 锁策略/指定店长配置、FOR UPDATE 锁行，重判资格后才写“发送中”；
 *   通过注入的 NotificationSender 的 beforeSend 钩子执行，钩子失败则发送器不得上线。
 * - 结果：accepted → sent；明确失败/未上线 → 有限退避，到上限 not_sent；unknown → unknown（告警，不自动重发）。
 * - 进入“发送中”后崩溃：租约到期由下一次领取改为 unknown（可能已送达，不重发）；领取后、发送前崩溃：租约到期后重领（不计次数）。
 * - 所有结果写回都以领取时的 status 原文为条件，过期领取者写不进去。
 * 不承诺企微端到端恰好一次；不发送任何真实消息（发送器由调用方注入，生产默认关闭）。
 */
export interface NotificationSendInput { notificationId: string; kind: Notification['kind']; memberId: string; content: string }
export interface NotificationSendResult {
  state: 'accepted' | 'rejected' | 'blocked' | 'unknown';
  detail: string;
  code?: number | null;
  /** 明确不会因重试而成功（例如正文不合规）。 */
  permanent?: boolean;
}
/** 发送器契约：必须先 await beforeSend()，它抛错就不得上线；返回值如实反映通道结果。 */
export interface NotificationSender { send(input: NotificationSendInput, beforeSend: () => Promise<void>): Promise<NotificationSendResult> }

/** 复用现有长连接发送代码（wecom-bot-sender.notify，有界超时、beforeSend 预检、accepted/rejected/blocked/unknown）。 */
export function createBotNotificationSender(bot: { notify(member: string, content: string, scope: BotReadScope, beforeSend: (scope: BotReadScope) => Promise<void>): Promise<BotSendOutcome> },
  options: { timeoutMs?: number; active?: () => boolean } = {}): NotificationSender {
  const timeout = options.timeoutMs ?? 4000;
  return {
    async send(input, beforeSend) {
      let outcome: BotSendOutcome;
      try {
        outcome = await bot.notify(input.memberId, input.content, { signal: AbortSignal.timeout(timeout), deadline: performance.now() + timeout }, async () => {
          if (options.active && !options.active()) throw Error('dispatch_not_active');
          await beforeSend();
        });
      } catch (error) {
        // notify 在入参不合规时同步抛错（未上线）。
        return { state: 'rejected', detail: error instanceof Error && error.message === 'invalid_bot_reply' ? 'invalid_content' : 'sender_threw_before_send', permanent: true };
      }
      return { state: outcome.state, detail: outcome.detail, code: outcome.apiErrorCode };
    },
  };
}

export const NOTIFICATION_DISPATCH_KEY = 'front-claw-notification-dispatch';
export const NOTIFICATION_AUDIT_PREFIX = 'front-claw-notification:audit:';
export const DISPATCH_FLAG = 'FRONT_CLAW_NOTIFY_DISPATCH';
export const DEFAULT_KINDS: readonly Notification['kind'][] = ['appointment', 'correction', 'reminder', 'void'];
export const DRAFT_EXPIRED_REPLY = 'Front Claw：这张草稿过了打烊还没确认，已作废，没有写入。';
const REMINDER_TEXT = 'Front Claw：你的报数还没确认。回复「对」就入账，回复「取消」作废。';
const VOID_TEXT = 'Front Claw：你的报数过了打烊还没确认，已作废，没有入账。请重新报一次。';
const CORRECTION_MAX_AGE_MS = 72 * 3_600_000;
const VOID_NOTICE_MAX_AGE_MS = 12 * 3_600_000;
const hash = (...parts: string[]) => createHash('sha256').update(JSON.stringify(['front-claw-notice:m06', ...parts])).digest('hex');
export const draftReminderId = (draftId: string) => hash('reminder', draftId);
export const draftVoidNoticeId = (draftId: string) => hash('void', draftId);

export type DispatchEventType = 'claimed' | 'sent' | 'retry' | 'failed' | 'unknown_alert' | 'refused' | 'lost' | 'stale_claim' | 'recovered_unknown'
  | 'backlog_alert' | 'paused' | 'draft_voided' | 'reminder_queued' | 'void_notice_queued' | 'backfill_queued' | 'manual_resend';
export interface DispatchEvent { type: DispatchEventType; worker: string; at: string; notificationId?: string; kind?: string; attempts?: number; error?: string; detail?: string; count?: number; ageMs?: number; recipientPersonId?: string; send?: boolean }
/**
 * D40 / D109（hanyu 12:12 已定）：积压告警只发给 hanyu 一个人。
 * 名字固定为 hanyu；企微/人员 ID 是配置项，默认空（待填）。
 * ID 为空时：启动打告警日志，不写通知行、不调用 sender，告警不会真发。
 * 默认开启条件：待发通知条数 ≥ count（默认 50）或最早一条已等待 ≥ ageMs（默认 30 分钟）；
 * 真实投递仅在 ID 已填写且非空时开启。
 */
export const BACKLOG_ALERT_RECIPIENT_NAME = 'hanyu';
export const DEFAULT_BACKLOG_ALERT_RECIPIENT = '';
export const BACKLOG_ALERT_ID_PENDING = '收件人 ID 待填，填之前告警不会真发';

export interface DispatchStats { paused: boolean; claimed: number; sent: number; retried: number; failed: number; unknown: number; refused: number; lost: number; recovered: number; backlog: number; oldestPendingMs: number }

export interface DispatcherOptions {
  store: PerformanceStore;
  sender: NotificationSender;
  now: () => Date;
  worker: string;
  timeZone?: string;
  leaseMs?: number;
  batch?: number;
  maxAttempts?: number;
  backoffMs?: readonly number[];
  kinds?: readonly Notification['kind'][];
  platform?: readonly Capability[];
  /** 员工入口草稿维护（报数提醒一次、闭店作废并通知一次）。默认开。 */
  draftMaintenance?: boolean;
  /** 给“配置指定店长之前登记、尚无提醒行”的未来预约补排提醒。默认关。 */
  backfillAppointmentReminders?: boolean;
  /**
   * D40 / D109：积压告警。recipientName 固定 hanyu；recipientPersonId 默认空（待填）。
   * send 在 ID 为空时强制 false；ID 填好后默认 true（可用 send:false 关闭）。
   */
  backlogAlert?: { count: number; ageMs: number; recipientPersonId?: string; recipientName?: string; send?: boolean };

  onEvent?: (event: DispatchEvent) => void;
  token?: () => string;
}

/** 暂停开关（PG 配置）：{"paused":true} 暂停领取与草稿维护，保留所有行；配置损坏按暂停处理。 */
export function dispatchPaused(raw: string | null): boolean {
  if (raw === null) return false;
  try {
    const value = JSON.parse(raw) as { paused?: unknown } | null;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return true;
    // R1（M06-P2-1）：paused 存在但不是布尔值 → 视为损坏 → 暂停。
    if ('paused' in value && typeof value.paused !== 'boolean') return true;
    return value.paused === true;
  } catch { return true; }
}

const valid = (value: unknown) => typeof value === 'string' && !!value.trim();
const complete = (person: Person | null): person is Person => !!person?.active && [person.personId, person.accountId, person.memberId, person.displayName, person.storeId, person.storeName].every(valid);
const loopDraft = (draft: Draft) => !!(draft.payload as { employeeContext?: unknown }).employeeContext;
function apptTime(row: Appointment, timeZone: string): Date | null {
  const match = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})$/.exec(row.whenText);
  return match ? zonedDateTime(match[1]!, match[2]!, timeZone) : null;
}
type Related = { draft: Draft | null; appointment: Appointment | null };
type Eligible = { storeId: string; capability: Capability } | { reason: string };

export function createNotificationDispatcher(options: DispatcherOptions) {
  const { store, sender, now, worker } = options;
  const timeZone = options.timeZone ?? DEFAULT_TIME_ZONE;
  const leaseMs = options.leaseMs ?? 60_000;
  const batch = options.batch ?? 20;
  const maxAttempts = options.maxAttempts ?? 5;
  const backoff = options.backoffMs ?? [60_000, 300_000, 900_000, 3_600_000];
  const kinds = options.kinds ?? DEFAULT_KINDS;
  const alert = options.backlogAlert ?? { count: 50, ageMs: 30 * 60_000 };
  const token = options.token ?? (() => randomUUID().replace(/-/g, ''));
  const alertRecipientId = (alert.recipientPersonId ?? DEFAULT_BACKLOG_ALERT_RECIPIENT).trim();
  const alertRecipientName = alert.recipientName ?? BACKLOG_ALERT_RECIPIENT_NAME;
  if (!alertRecipientId) {
    const detail = `${BACKLOG_ALERT_ID_PENDING}（收件人 ${alertRecipientName}）`;
    try { console.warn(`Front Claw：积压告警 ${detail}`); } catch { /* 日志失败不影响派发 */ }
  }
  if (!valid(worker) || !Number.isInteger(leaseMs) || leaseMs < 5_000 || !Number.isInteger(batch) || batch < 1 || batch > 200 ||
    !Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 20 || !backoff.length) throw Error('invalid_notification_dispatcher');
  const emit = (event: Omit<DispatchEvent, 'worker' | 'at'>) => { try { options.onEvent?.({ ...event, worker, at: now().toISOString() }); } catch { /* 日志失败不影响派发 */ } };
  const iso = (offsetMs = 0) => new Date(now().getTime() + offsetMs).toISOString();

  /**
   * 发送资格（纯函数）：关联对象仍有效、未过时、收件人档案完整且同店。
   * R1（出口 b）：锁外预检与发送事务内（锁读的当前人员/草稿/预约行）用同一个判定。
   */
  function eligible(notice: Notification, person: Person | null, related: Related, hoursRaw: string | null): Eligible {
    const at = now().getTime();
    if (!complete(person) || person.personId !== notice.recipientPersonId) return { reason: 'recipient_ineligible' };
    if (notice.kind === 'appointment') {
      const row = related.appointment;
      if (!row || row.status !== 'registered') return { reason: 'related_gone' };
      // R1（M06-06）：预约时间按该店营业配置的时区解释；配置损坏 → 不发。
      const hours = resolveStoreHours(hoursRaw, row.storeId, { timeZone, cutoff: DEFAULT_BUSINESS_CUTOFF });
      if (!hours) return { reason: 'store_hours_invalid' };
      const when = apptTime(row, hours.timeZone);
      if (!when || when.getTime() <= at) return { reason: 'stale_appointment_passed' };
      // R2（D5 已定：预约提醒给店长，老板不提醒）：收件人当前档位必须是店长。
      if (person.storeId !== row.storeId || person.tier !== 'manager') return { reason: 'recipient_ineligible' };
      return { storeId: row.storeId, capability: 'appointment_receive' };
    }
    const draft = related.draft;
    if (!draft || !loopDraft(draft)) return { reason: 'related_gone' };
    if (notice.kind === 'correction') {
      if (draft.kind !== 'correction' || draft.status !== 'confirmed') return { reason: 'related_gone' };
      if (at - Date.parse(notice.createdAt) > CORRECTION_MAX_AGE_MS) return { reason: 'stale_too_old' };
      return { storeId: draft.storeId, capability: 'progress_self' };
    }
    if (notice.kind === 'reminder') {
      if (draft.status !== 'pending' || Date.parse(draft.expiresAt) <= at) return { reason: 'stale_draft_closed' };
      // R3（D85 已定）：30 分钟未确认提醒发给报单人本人，不分档位（员工、店长、老板都发）。
      if (draft.reporterPersonId !== person.personId || person.storeId !== draft.storeId) return { reason: 'recipient_ineligible' };
      return { storeId: draft.storeId, capability: 'report_self' };
    }
    if (notice.kind === 'void') {
      if (draft.status !== 'void' || at - Date.parse(draft.closedAt ?? draft.expiresAt) > VOID_NOTICE_MAX_AGE_MS) return { reason: 'stale_too_old' };
      if (draft.reporterPersonId !== person.personId) return { reason: 'recipient_ineligible' };
      return { storeId: draft.storeId, capability: 'report_self' };
    }
    return { reason: 'kind_not_dispatched' };
  }
  /** 预检（锁外）。 */
  async function precheck(notice: Notification, person: Person | null): Promise<Eligible> {
    const related: Related = notice.kind === 'appointment'
      ? { draft: null, appointment: (await store.listAppointments()).find(item => item.appointmentId === notice.relatedId) ?? null }
      : { draft: await store.getDraft(notice.relatedId), appointment: null };
    return eligible(notice, person, related, await store.getConfig(STORE_HOURS_KEY));
  }

  // R3（f 单调）：重试/终态/unknown 都保留领取时的 f（只有新领取才由存储 +1），f 全程不回退。
  const finalRaw = (base: 'sent' | 'not_sent' | 'unknown', meta: { attempts: number; resends: number; fence: number }, error?: string) =>
    encodeStatus(base, { attempts: meta.attempts, resends: meta.resends, fence: meta.fence, error: error ?? null });

  async function deliver(notice: Notification, stats: DispatchStats): Promise<void> {
    const claimedRaw = notice.delivery!.raw;
    const meta = decodeStatus(claimedRaw).delivery;
    // R1（M06-02）：所有结果写回都带领取时的 fencing 版本号与当前时间；租约过期或被他人重领 → 写不进。
    const fence = (): ResultFence => ({ epoch: meta.fence, nowIso: iso() });
    const person = await store.getPerson(notice.recipientPersonId);
    const pre = await precheck(notice, person);
    if ('reason' in pre) {
      const ok = await store.transitionNotification(notice.notificationId, claimedRaw, finalRaw('not_sent', meta, pre.reason), null, fence());
      stats[ok ? 'refused' : 'lost'] += 1;
      emit({ type: ok ? 'refused' : 'stale_claim', notificationId: notice.notificationId, kind: notice.kind, attempts: meta.attempts, error: pre.reason });
      return;
    }
    const attempts = meta.attempts + 1;
    const sendingRaw = encodeStatus('pending', { phase: 'sending', dueAt: iso(leaseMs), attempts, resends: meta.resends, fence: meta.fence, token: meta.token, worker });
    let began: 'sending' | 'refused' | 'lost' | null = null;
    const beforeSend = async () => {
      if (began) throw Error('before_send_twice');
      // R2：测试专用暂停点（锁外预检读完之后、发送门事务之前）；生产无操作。
      const paused = pausePoint('send-gate:before-begin', notice.notificationId); if (paused) await paused;
      began = await store.beginNotificationSend(notice.notificationId, claimedRaw, {
        lockKeys: [...POLICY_LOCK_KEYS, APPOINTMENT_RECIPIENTS_KEY, STORE_HOURS_KEY],
        personIds: [notice.recipientPersonId],
        ...(notice.kind === 'appointment' ? { appointmentIds: [notice.relatedId] } : { draftIds: [notice.relatedId] }),
        decide(config, row, current) {
          // 租约已过或 fencing 版本变了：本 worker 不再是领取者，不写不发。
          if (!row.delivery?.dueAt || row.delivery.dueAt <= now().toISOString() || row.delivery.fence !== meta.fence) return { ok: false, nextRaw: null };
          // R1（出口 b）：发送前在同一事务里重读收件人档案与关联草稿/预约（FOR SHARE），与锁外预检同一判定。
          const latest = current.people[notice.recipientPersonId] ?? null;
          if (!latest || latest.memberId !== person!.memberId) return { ok: false, nextRaw: finalRaw('not_sent', meta, 'recipient_changed') };
          const now2 = eligible(notice, latest, { draft: current.drafts[notice.relatedId] ?? null, appointment: current.appointments[notice.relatedId] ?? null }, config[STORE_HOURS_KEY] ?? null);
          if ('reason' in now2) return { ok: false, nextRaw: finalRaw('not_sent', meta, now2.reason) };
          if (notice.kind === 'appointment' && designatedRecipient(config[APPOINTMENT_RECIPIENTS_KEY] ?? null, now2.storeId) !== notice.recipientPersonId) {
            return { ok: false, nextRaw: finalRaw('not_sent', meta, 'recipient_changed') };
          }
          if (!decideAccess(policyFrom(config), latest, now2.capability, now2.storeId, options.platform).allowed) {
            return { ok: false, nextRaw: finalRaw('not_sent', meta, 'recipient_ineligible') };
          }
          return { ok: true, nextRaw: sendingRaw };
        },
      });
      if (began !== 'sending') throw Error(`dispatch_${began}`);
    };
    let result: NotificationSendResult | null = null, threw = false;
    try { result = await sender.send({ notificationId: notice.notificationId, kind: notice.kind, memberId: person!.memberId, content: notice.body }, beforeSend); }
    catch { threw = true; }
    const outcome = began as 'sending' | 'refused' | 'lost' | null;
    if (outcome === 'refused') { stats.refused += 1; emit({ type: 'refused', notificationId: notice.notificationId, kind: notice.kind, attempts: meta.attempts, error: 'recipient_ineligible' }); return; }
    if (outcome === 'lost') { stats.lost += 1; emit({ type: 'lost', notificationId: notice.notificationId, kind: notice.kind }); return; }
    // 未进入发送阶段（beforeSend 没被调用或发送器先拒绝）：消息没有上线，从 claimed 原文转。
    const fromRaw = outcome === 'sending' ? sendingRaw : claimedRaw;
    let next: string, sentAt: string | null = null, type: DispatchEventType, error: string | undefined;
    if (outcome !== 'sending' && result?.state === 'accepted') { next = finalRaw('unknown', { attempts, resends: meta.resends, fence: meta.fence }, 'sender_contract_violation'); type = 'unknown_alert'; error = 'sender_contract_violation'; }
    else if (threw) {
      if (outcome === 'sending') { next = finalRaw('unknown', { attempts, resends: meta.resends, fence: meta.fence }, 'sender_threw'); type = 'unknown_alert'; error = 'sender_threw'; }
      else ({ next, type, error } = retryOrFail(attempts, meta.resends, meta.fence, 'sender_threw_before_send', false));
    } else if (result!.state === 'accepted') { next = finalRaw('sent', { attempts, resends: meta.resends, fence: meta.fence }); sentAt = now().toISOString(); type = 'sent'; }
    else if (result!.state === 'unknown') { next = finalRaw('unknown', { attempts, resends: meta.resends, fence: meta.fence }, result!.detail || 'send_result_unknown'); type = 'unknown_alert'; error = result!.detail; }
    else ({ next, type, error } = retryOrFail(attempts, meta.resends, meta.fence, `${result!.state}:${result!.code ?? result!.detail}`, !!result!.permanent));
    // R2：测试专用暂停点（通道已返回、带 fence 的结果写回之前）；生产无操作。
    const paused = pausePoint('notify:before-mark', notice.notificationId); if (paused) await paused;
    const ok = await store.transitionNotification(notice.notificationId, fromRaw, next, sentAt, fence());
    if (!ok) { stats.lost += 1; emit({ type: 'stale_claim', notificationId: notice.notificationId, kind: notice.kind, attempts, ...(result ? { detail: result.state } : {}) }); return; }
    if (type === 'sent') stats.sent += 1; else if (type === 'unknown_alert') stats.unknown += 1; else if (type === 'retry') stats.retried += 1; else stats.failed += 1;
    emit({ type, notificationId: notice.notificationId, kind: notice.kind, attempts, ...(error ? { error } : {}) });
  }

  function retryOrFail(attempts: number, resends: number, fence: number, error: string, permanent: boolean): { next: string; type: DispatchEventType; error: string } {
    if (permanent || attempts >= maxAttempts) return { next: finalRaw('not_sent', { attempts, resends, fence }, error), type: 'failed', error };
    const delay = backoff[Math.min(attempts - 1, backoff.length - 1)]!;
    return { next: encodeStatus('pending', { phase: 'queued', dueAt: iso(delay), attempts, resends, fence, error }), type: 'retry', error };
  }

  /** 员工入口草稿：报数待确认满 30 分钟提醒一次；过期（闭店）作废，报数草稿再通知一次。只动 pending，不碰确认中/已确认，也不碰已登记预约。 */
  async function maintainDrafts(): Promise<void> {
    const at = now();
    for (const draft of await store.listDrafts({ status: 'pending' })) {
      if (!loopDraft(draft)) continue;
      if (Date.parse(draft.expiresAt) <= at.getTime()) {
        const context = (draft.payload as unknown as { employeeContext: Record<string, unknown> }).employeeContext;
        const next = { ...draft, status: 'void', closedAt: at.toISOString(), payload: { ...draft.payload, employeeContext: { ...context, finalReply: DRAFT_EXPIRED_REPLY } } } as Draft;
        if (await store.transitionPendingDraft(draft, next)) emit({ type: 'draft_voided', detail: draft.kind });
        continue;
      }
      if (draft.kind === 'report' && at.getTime() - Date.parse(draft.createdAt) >= REMINDER_DELAY_MS && (await store.getPerson(draft.reporterPersonId)) != null) {
        if (await store.enqueueNotification({ notificationId: draftReminderId(draft.draftId), kind: 'reminder', recipientPersonId: draft.reporterPersonId, body: REMINDER_TEXT, status: 'pending', relatedId: draft.draftId, createdAt: at.toISOString(), sentAt: null })) {
          emit({ type: 'reminder_queued', notificationId: draftReminderId(draft.draftId), kind: 'reminder' });
        }
      }
    }
    // 作废通知单独扫描（崩溃在“作废”与“入队”之间也能补上）；只认维护作废的报数草稿（finalReply 标记），用户「取消」的不通知。
    for (const draft of await store.listDrafts({ status: 'void', kind: 'report' })) {
      if (!loopDraft(draft)) continue;
      if ((draft.payload as { employeeContext?: { finalReply?: string } }).employeeContext?.finalReply !== DRAFT_EXPIRED_REPLY) continue;
      if (at.getTime() - Date.parse(draft.closedAt ?? draft.expiresAt) > VOID_NOTICE_MAX_AGE_MS) continue;
      if (await store.enqueueNotification({ notificationId: draftVoidNoticeId(draft.draftId), kind: 'void', recipientPersonId: draft.reporterPersonId, body: VOID_TEXT, status: 'pending', relatedId: draft.draftId, createdAt: at.toISOString(), sentAt: null })) {
        emit({ type: 'void_notice_queued', notificationId: draftVoidNoticeId(draft.draftId), kind: 'void' });
      }
    }
  }

  /** 补排（默认关）：未来的已登记预约没有任何提醒行，且现在本店有合格的指定店长 → 按确定性 ID 入队一次。 */
  async function backfill(): Promise<void> {
    const at = now().getTime();
    const notices = await store.listNotifications();
    const recipients = await store.getConfig(APPOINTMENT_RECIPIENTS_KEY);
    for (const row of await store.listAppointments({ status: 'registered' })) {
      const hours = resolveStoreHours(await store.getConfig(STORE_HOURS_KEY), row.storeId, { timeZone, cutoff: DEFAULT_BUSINESS_CUTOFF });
      const when = hours ? apptTime(row, hours.timeZone) : null;
      if (!when || when.getTime() <= at || notices.some(notice => notice.kind === 'appointment' && notice.relatedId === row.appointmentId)) continue;
      const personId = designatedRecipient(recipients, row.storeId);
      if (!personId || personId === row.employeePersonId) continue;
      const [manager, employee] = [await store.getPerson(personId), await store.getPerson(row.employeePersonId)];
      if (!complete(manager) || manager.storeId !== row.storeId || !employee) continue;
      const [date, time] = row.whenText.split(' ');
      const notificationId = appointmentReminderId(row.appointmentId, personId);
      if (await store.enqueueNotification({ notificationId, kind: 'appointment', recipientPersonId: personId, relatedId: row.appointmentId, status: 'pending', createdAt: now().toISOString(), sentAt: null,
        body: reminderBody({ storeName: employee.storeName, employeeName: employee.displayName, item: { date: date!, time: time!, customer: row.customerName, note: row.note }, appointmentId: row.appointmentId }) })) {
        emit({ type: 'backfill_queued', notificationId, kind: 'appointment' });
      }
    }
  }

  async function tick(): Promise<DispatchStats> {
    const stats: DispatchStats = { paused: false, claimed: 0, sent: 0, retried: 0, failed: 0, unknown: 0, refused: 0, lost: 0, recovered: 0, backlog: 0, oldestPendingMs: 0 };
    if (dispatchPaused(await store.getConfig(NOTIFICATION_DISPATCH_KEY))) { stats.paused = true; emit({ type: 'paused' }); return stats; }
    if (options.draftMaintenance !== false) await maintainDrafts();
    if (options.backfillAppointmentReminders === true) await backfill();
    const { claimed, expired } = await store.claimDueNotifications({ nowIso: iso(), leaseUntil: iso(leaseMs), limit: batch, kinds, worker, tokenFor: () => token() });
    for (const row of expired) { stats.recovered += 1; emit({ type: 'recovered_unknown', notificationId: row.notificationId, kind: row.kind, attempts: row.delivery?.attempts ?? 0, error: 'lease_expired_during_send' }); }
    stats.claimed = claimed.length;
    for (const row of claimed) {
      emit({ type: 'claimed', notificationId: row.notificationId, kind: row.kind, attempts: row.delivery?.attempts ?? 0 });
      await deliver(row, stats);
    }
    const pending = (await store.listNotifications()).filter(row => row.status === 'pending' && kinds.includes(row.kind));
    stats.backlog = pending.length;
    stats.oldestPendingMs = pending.reduce((max, row) => Math.max(max, now().getTime() - Date.parse(row.createdAt)), 0);
    if (stats.backlog >= alert.count || stats.oldestPendingMs >= alert.ageMs) {
      const recipientPersonId = alertRecipientId;
      // ID 为空强制不发；ID 已填则默认发（除非显式 send:false）。
      const send = !!recipientPersonId && alert.send !== false;
      emit({ type: 'backlog_alert', count: stats.backlog, ageMs: stats.oldestPendingMs, recipientPersonId, send, ...(recipientPersonId ? {} : { detail: BACKLOG_ALERT_ID_PENDING }) });
      // ID 待填或 send=false：不写通知行、不调 sender。
    }
    return stats;
  }
  return { tick, maintainDrafts };
}

/**
 * unknown 人工补发（合审-05）：先写审计记录，再把 unknown 改回排队；每条最多补发 maxResends 次（默认 1）。
 * 可能造成重复提醒（第一次其实已送达），由操作人确认后执行；不自动触发。
 */
export async function requeueUnknownNotification(store: PerformanceStore, notificationId: string, input: { actor: string; reason: string; now: Date; maxResends?: number }):
  Promise<'requeued' | 'not_unknown' | 'limit' | 'missing' | 'invalid'> {
  if (!valid(input.actor) || !valid(input.reason)) return 'invalid';
  const row = (await store.listNotifications()).find(item => item.notificationId === notificationId);
  if (!row) return 'missing';
  if (row.status !== 'unknown') return 'not_unknown';
  const meta = row.delivery ?? decodeStatus('unknown').delivery;
  if (meta.resends >= (input.maxResends ?? 1)) return 'limit';
  const raw = row.delivery?.raw ?? 'unknown';
  const next = encodeStatus('pending', { phase: 'queued', dueAt: input.now.toISOString(), attempts: meta.attempts, resends: meta.resends + 1, fence: meta.fence, error: 'manual_resend' });
  // R1（M06-05）：审计与改回排队在同一事务；审计键已存在（并发补发）→ 整体不写，返回 not_unknown，审计只留真正执行者。
  const audit = { key: `${NOTIFICATION_AUDIT_PREFIX}${notificationId}:${meta.resends + 1}`,
    value: JSON.stringify({ notificationId, actor: input.actor, reason: input.reason, at: input.now.toISOString(), from: raw, attempts: meta.attempts }) };
  return await store.requeueNotificationWithAudit(notificationId, raw, next, audit) ? 'requeued' : 'not_unknown';
}
