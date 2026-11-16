import { confirmationSequence, sequenceBefore } from './pending-order.js';
import type { Draft, EmployeeDraftContext, ReportDraftItem } from './performance-store.js';
import type { ConsumerWrites } from './consumer-writes.js';
import type { GateEntry, GateVerdict } from './confirmable-draft-gate.js';
import { isYesNewCustomerReply } from './customer-name-policy.js';
import { formatYuan } from './money.js';

export type SavedNewCustomerAsk = {
  names: string[]; listed: ReportDraftItem[]; businessDay: string; expiresAt?: string; issuedAt?: string; issuedSequence?: string; platformIssuedAt?: string; version?: string; replacedPending?: boolean;
  text?: string; gateEntries?: GateEntry[]; source?: 'standard' | 'natural';
};
function parseAsk(raw: string): SavedNewCustomerAsk | null {
  try {
    const value = JSON.parse(raw) as SavedNewCustomerAsk;
    return Array.isArray(value?.names) && value.names.length > 0 && value.names.every(n => typeof n === 'string')
      && Array.isArray(value.listed) && value.listed.length > 0 ? value : null;
  } catch { return null; }
}
const context = (draft: Draft): EmployeeDraftContext | undefined =>
  'employeeContext' in draft.payload ? draft.payload.employeeContext : undefined;
export const pendingExpired = (expiresAt: string | undefined, at: Date) => !(Date.parse(expiresAt ?? '') > at.getTime());
export const reportLabels = (draft: Draft) => draft.payload.type === 'report'
  ? draft.payload.added.map(i => `${i.customer ?? '未留名'} ${formatYuan(i.amount)}元`) : [];
const draftReminder = (draft: Draft) => reportLabels(draft)
  .map(n => `上一笔「${n}」没有确认，已作废，需要的话请重新报。`).join('\n');
const askReminder = (ask: SavedNewCustomerAsk) => ask.names.map(n => `上一条「${n}」没有记，需要的话请重新报。`).join('\n');
const expiredNames = (names: string[]) => names.map(n => `上一笔「${n}」已过期，没有记，需要的话请重新报。`).join('\n');
const OTHER_EXPIRED = '上一条操作已过期，没有生效，需要的话请重新发。';
/** D180：只用 payload 的原内容；缺必需字段时不猜客户、时间或原金额。 */
function expiredDraftReminder(draft: Draft): string {
  const p = draft.payload;
  if (p.type === 'report') return expiredNames(reportLabels(draft));
  if (p.type === 'appointment' && p.items?.length && p.items.every(i => i.customer?.trim() && i.whenText?.trim())) {
    return p.items.map(i => `上一条预约「${i.customer} ${i.whenText}」已过期，没有保存，需要的话请重新发。`).join('\n');
  }
  if (p.type === 'correction' && p.changes?.length && p.changes.every(c => c.customerName?.trim() && Number.isFinite(c.before?.amount))) {
    return p.changes.map(c => `上一条改单已过期，没有改，原记录「${c.customerName} ${formatYuan(c.before.amount)}元」不变，需要的话请重新发。`).join('\n');
  }
  return OTHER_EXPIRED;
}
export function pendingConfirmationReminder(drafts: readonly Draft[], ask: SavedNewCustomerAsk | null, at: Date): string {
  const labels = drafts.filter(d => d.status === 'pending' && !pendingExpired(d.expiresAt, at)).flatMap(reportLabels);
  if (ask && !pendingExpired(ask.expiresAt, at)) labels.push(...ask.names.map(name => { const item = ask.listed.find(i => i.customer === name); return item && Number.isFinite(item.amount) ? `${name} ${formatYuan(item.amount)}元` : name; }));
  return labels.map(n => `上一笔「${n}」还在等你回「对」确认。`).join('\n');
}
export type PendingReportAdmission = { gate: GateVerdict; next: 'draft' | 'new-customer-ask' };
function readonlyCopy<T>(value: T): T {
  const freeze = (item: unknown): void => {
    if (!item || typeof item !== 'object') return;
    for (const child of Object.values(item)) freeze(child);
    Object.freeze(item);
  };
  const copy = structuredClone(value);
  freeze(copy);
  return copy;
}

/** D143 / D172 / D174–D180：一个逻辑挂起位，沿用草稿表和追问 config，避免确认路径增加数据库操作。
 * 只有单闸准入且即将保存新挂起项时才替换有效旧项；任何消息都消费已过期项。
 * 明确确认/取消仍消费其对应项；过期项收到肯定答复不能恢复。调用方只传本人本会话的草稿。
 * pending -> void 使用原条件迁移；竞争失败阻止继续建立新项，不能覆盖 confirming 或重试提交。
 */
export async function advancePendingSlot(args: {
  drafts: Draft[]; askKey: string; text: string; admission?: PendingReportAdmission; expireOnly?: boolean; arrivedAt?: string | undefined; arrivedSequence?: string;
  readAsk(): Promise<string | null | undefined>; writes: ConsumerWrites; now(): Date; active(): boolean; expiredReply: string;
}) {
  const { askKey, text, writes, now, active, expireOnly = false, expiredReply, arrivedAt, arrivedSequence } = args;
  // 读取器和写入器都可能保留引用；私有快照不能跨 await 暴露给外部回调。
  const drafts = structuredClone(args.drafts);
  const admission = args.admission ? structuredClone(args.admission) : undefined;
  const raw = await args.readAsk();
  if (!active()) return { drafts, expired: [] as Draft[], reminder: '', expiredReminder: '', pendingAsk: null, ask: null, blocked: true };
  const ask = raw ? parseAsk(raw) : null;
  const validAsk = ask && !pendingExpired(ask.expiresAt, now()) ? ask : null;
  // D175 唯一替换判定点：不按消息意图列例外，只认 D152 结论与待保存的新项。
  const replacing = !expireOnly && !!admission && (admission.next === 'draft' ? admission.gate.ok
    : !admission.gate.ok && !!admission.gate.newCustomerNames?.length);
  // D172 的肯定词只回答新客户追问；草稿只接受其自己的确认/取消及二选一命令。
  const answeringAsk = !expireOnly && !replacing && (isYesNewCustomerReply(text) || /^(?:不是|取消)[。.!！]?$/.test(text.normalize('NFKC')));
  let reminder = '';
  let expiredReminder = '';
  const appendExpired = (notice: string) => { expiredReminder += (expiredReminder ? '\n' : '') + notice; };
  const expired: Draft[] = [];
  for (let i = 0; i < drafts.length; i++) {
    const draft = drafts[i]!;
    if (draft.status !== 'pending') continue;
    const isExpired = pendingExpired(draft.expiresAt, now());
    if (!isExpired && !(replacing && draft.kind === 'report')) continue;
    if (!active()) return { drafts, expired, reminder, expiredReminder, pendingAsk: null, ask: null, blocked: true };
    const reply = isExpired ? expiredReply : draftReminder(draft);
    const ctx = context(draft);
    const next = { ...draft, status: 'void' as const, closedAt: now().toISOString(), payload: {
      ...draft.payload, ...(ctx ? { employeeContext: { ...ctx, finalReply: reply } } : {}),
    } } as Draft;
    if (!await writes.transitionPending(readonlyCopy(draft), readonlyCopy(next), isExpired ? { expiredAt: next.closedAt! } : undefined)) return { drafts, expired, reminder, expiredReminder, pendingAsk: null, ask: null, blocked: true };
    drafts[i] = next;
    if (isExpired) { expired.push(next); appendExpired(expiredDraftReminder(draft)); }
    else if (replacing) reminder += (reminder ? '\n' : '') + reply;
  }
  // D179 / D183：配置按读到的完整版本条件消费；过期和到达序号也在存储层核对。
  const consumeAsk = !!raw && ((!!ask && !validAsk) || answeringAsk || replacing);
  if (consumeAsk) {
    if (!active()) return { drafts, expired, reminder, expiredReminder, pendingAsk: null, ask: null, blocked: true };
    // 秒级平台时间是到达时刻的下界：只有确实发生 D174 替换时才保守拦截同秒答复。
    const guardArrival = answeringAsk && !!validAsk && isYesNewCustomerReply(text) && !!arrivedSequence;
    const arrival = validAsk && arrivedSequence ? confirmationSequence(validAsk.platformIssuedAt ?? validAsk.issuedAt ?? '', arrivedAt, !!validAsk.replacedPending, arrivedSequence) : arrivedSequence;
    const staleAnswer = guardArrival && !(sequenceBefore(validAsk!.issuedSequence, arrival!));
    if (staleAnswer) return { drafts, expired, reminder, expiredReminder, pendingAsk: validAsk, ask: null, blocked: false, staleAsk: validAsk };
    // 肯定答复与新草稿在员工级存储事务内 CAS 消费，避免消费后留下并发窗口。
    if (guardArrival) return { drafts, expired, reminder, expiredReminder, pendingAsk: validAsk, ask: validAsk, blocked: false };
    const conditions = ask && !validAsk ? { expiredAt: now().toISOString() }
      : answeringAsk && isYesNewCustomerReply(text) ? { ...(guardArrival ? { arrivedSequence: arrival } : {}), unexpiredAt: now().toISOString() } : {};
    if (!await writes.compareAndSetPendingAsk(askKey, raw!, '', conditions)) return { drafts, expired, reminder, expiredReminder, pendingAsk: null, ask: null, blocked: true };
    if (ask && !validAsk) appendExpired(expiredNames(ask.names));
    else if (replacing && validAsk) reminder += (reminder ? '\n' : '') + askReminder(validAsk);
  }

  return { drafts, expired, reminder, expiredReminder, pendingAsk: consumeAsk ? null : validAsk, ask: answeringAsk ? validAsk : null, blocked: false, expiredAsk: !!ask && !validAsk && consumeAsk };
}
