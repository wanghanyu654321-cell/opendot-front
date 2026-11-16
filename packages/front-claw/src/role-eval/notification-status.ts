import { fenceHolds, nextEpoch } from './fencing.js';

/**
 * M06 出站箱状态编码；R1 起为**严格**契约（JS 与 008 触发器同一套规则，见 STATUS_PATTERN）：
 *   pending                                            —— M04/M05 写入的待发行（立即到期，0 次）
 *   pending|<到期>|queued|a=1|r=0[|f=3][|err=..]       —— 明确失败后退避等待
 *   pending|<租约到期>|claimed|a=0|r=0|f=4|tok=..|by=.. —— 已领取，尚未进入发送
 *   pending|<租约到期>|sending|a=1|r=0|f=4|tok=..|by=.. —— 已进入发送（可能已上线）
 *   sent|-|-|a=1|r=0[|f=4]                             —— 企微通道已接受（不代表已读）
 *   not_sent|-|-|a=5|r=0[|f=..]|err=...                —— 明确失败 / 不再发送
 *   unknown|-|-|a=1|r=0[|f=..]|err=...                 —— 结果未知；不自动重发
 * f = fencing 版本号（R1，与 M07 租约共用 fencing.ts）：每次领取 +1；写结果时必须与领取时一致且租约未到期。
 * 字段顺序固定（a、r、f、tok、by、err），计数 0..9999，时间为合法日历的 toISOString()。
 * 不符合的原文一律判“畸形”：不领取、不发送、不当作可重发；写入口（encode/transition/008 触发器）直接拒绝。
 */
export type DeliveryBase = 'pending' | 'sent' | 'not_sent' | 'unknown';
export type DeliveryPhase = 'queued' | 'claimed' | 'sending';
export interface DeliveryMeta {
  raw: string;
  phase: DeliveryPhase | null;
  /** queued：下次可发时间；claimed/sending：租约到期时间；其余 null。 */
  dueAt: string | null;
  attempts: number;
  resends: number;
  /** R1：fencing 版本号（没有 f 字段的旧行为 0）。 */
  fence: number;
  token: string | null;
  worker: string | null;
  error: string | null;
}
const BASES: readonly DeliveryBase[] = ['pending', 'sent', 'not_sent', 'unknown'];
const ISO_SHAPE = String.raw`\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z`;
const N = String.raw`(?:0|[1-9]\d{0,3})`;
const F = String.raw`(?:0|[1-9]\d{0,14})`;
const T = String.raw`[A-Za-z0-9_.:\-]{1,80}`;
const TAIL = String.raw`\|a=(${N})\|r=(${N})(?:\|f=(${F}))?(?:\|tok=(${T}))?(?:\|by=(${T}))?(?:\|err=(${T}))?`;
/** 与 008 触发器中的正则逐字一致（有测试）。 */
export const STATUS_PATTERN = String.raw`^(?:(pending|sent|not_sent|unknown)|pending\|(${ISO_SHAPE})\|(queued|claimed|sending)${TAIL}|(sent|not_sent|unknown)\|-\|-${TAIL})$`;
const STATUS = new RegExp(STATUS_PATTERN);
const ISO = new RegExp(`^${ISO_SHAPE}$`);
const clean = (value: string) => value.replace(/[^A-Za-z0-9_.:\-]/g, '_').slice(0, 80);
/** 合法日历时间（2026-02-30 之类拒绝）。 */
export const validIso = (value: string | null | undefined): value is string => !!value && ISO.test(value) && !value.startsWith('0000') && !Number.isNaN(Date.parse(value)) && new Date(Date.parse(value)).toISOString() === value;

function malformed(raw: string): { status: DeliveryBase; delivery: DeliveryMeta } {
  const head = raw.split('|')[0]!;
  const base = (BASES as readonly string[]).includes(head) ? head as DeliveryBase : 'unknown';
  return { status: base, delivery: { raw, phase: null, dueAt: null, attempts: 0, resends: 0, fence: 0, token: null, worker: null, error: 'malformed_status' } };
}

export function decodeStatus(raw: string): { status: DeliveryBase; delivery: DeliveryMeta } {
  const m = typeof raw === 'string' ? STATUS.exec(raw) : null;
  if (!m) return malformed(String(raw));
  const meta: DeliveryMeta = { raw, phase: null, dueAt: null, attempts: 0, resends: 0, fence: 0, token: null, worker: null, error: null };
  if (m[1]) { if (m[1] === 'pending') meta.phase = 'queued'; return { status: m[1] as DeliveryBase, delivery: meta }; }
  const pending = m[2] !== undefined;
  const g = pending ? m.slice(4, 10) : m.slice(11, 17);
  if (pending && !validIso(m[2])) return malformed(raw);
  meta.dueAt = pending ? m[2]! : null;
  meta.phase = pending ? m[3] as DeliveryPhase : null;
  meta.attempts = Number(g[0]); meta.resends = Number(g[1]);
  meta.fence = g[2] === undefined ? 0 : Number(g[2]);
  meta.token = g[3] ?? null; meta.worker = g[4] ?? null; meta.error = g[5] ?? null;
  if (!Number.isSafeInteger(meta.fence)) return malformed(raw);
  if ((meta.phase === 'claimed' || meta.phase === 'sending') && !meta.token) return malformed(raw);
  return { status: (pending ? 'pending' : m[10]) as DeliveryBase, delivery: meta };
}
export const wellFormedStatus = (raw: string) => decodeStatus(raw).delivery.error !== 'malformed_status';
/** 写入口统一校验：畸形原文直接拒绝。 */
export function assertStatus(raw: string): void { if (!wellFormedStatus(raw)) throw Error('invalid_delivery_status'); }

const count = (value: number) => Number.isSafeInteger(value) && value >= 0 && value <= 9999;
export function encodeStatus(base: DeliveryBase, meta: { phase?: DeliveryPhase | null; dueAt?: string | null; attempts: number; resends: number; fence?: number | null; token?: string | null; worker?: string | null; error?: string | null }): string {
  if (base === 'pending' && (!meta.phase || !validIso(meta.dueAt))) throw Error('invalid_delivery_status');
  if (base !== 'pending' && meta.phase) throw Error('invalid_delivery_status');
  if (!count(meta.attempts) || !count(meta.resends)) throw Error('invalid_delivery_status');
  const fields = [base, base === 'pending' ? meta.dueAt! : '-', base === 'pending' ? meta.phase! : '-', `a=${meta.attempts}`, `r=${meta.resends}`];
  if (meta.fence !== undefined && meta.fence !== null && meta.fence !== 0) {
    if (!Number.isSafeInteger(meta.fence) || meta.fence < 0) throw Error('invalid_delivery_status');
    fields.push(`f=${meta.fence}`);
  }
  if (meta.token) fields.push(`tok=${clean(meta.token)}`);
  if (meta.worker) fields.push(`by=${clean(meta.worker)}`);
  if (meta.error) fields.push(`err=${clean(meta.error)}`);
  const raw = fields.join('|');
  assertStatus(raw);
  return raw;
}

/** 到期判定（与 SQL 条件同义；畸形行永不到期）。 */
export function dueRaw(raw: string, nowIso: string): boolean {
  if (raw === 'pending') return true;
  if (!raw.startsWith('pending|')) return false;
  const { delivery } = decodeStatus(raw);
  return delivery.error !== 'malformed_status' && delivery.dueAt !== null && delivery.dueAt <= nowIso;
}
/** R1：领取时 fencing 版本号 +1（R3 起只用于说明与测试；真正的 +1 由存储在同一条 UPDATE 里做，见 bumpFence）。 */
export const claimFence = (raw: string) => nextEpoch(decodeStatus(raw).delivery.fence);
/** R3：f 的上限（STATUS_PATTERN 最多 15 位）。到顶不再领取（fail-closed）。 */
export const MAX_FENCE = 999_999_999_999_999;
/**
 * R3（f 单调）：把领取模板（不含 f）补上 `|f=<n>`，位置在 `|r=…` 之后（与 encodeStatus 字段顺序一致）。
 * PG 端是同一条 UPDATE 里的 regexp_replace + (旧 f + 1)；内存存储用这个函数做同样的事。
 */
export function bumpFence(template: string, previousRaw: string): string | null {
  const previous = decodeStatus(previousRaw).delivery.fence;
  if (!Number.isSafeInteger(previous) || previous >= MAX_FENCE) return null;
  return template.replace(/(\|r=[0-9]+)(\||$)/, `$1|f=${previous + 1}$2`);
}
/** R1：写结果的 fencing 判定——原文未变、fence 一致、领取租约（claimed/sending）未到期。 */
export function resultFenceHolds(currentRaw: string, expectedRaw: string, fence: { epoch: number; nowIso: string }): boolean {
  if (currentRaw !== expectedRaw) return false;
  const { delivery } = decodeStatus(currentRaw);
  if (delivery.error === 'malformed_status' || (delivery.phase !== 'claimed' && delivery.phase !== 'sending')) return false;
  return fenceHolds({ owner: delivery.worker, epoch: delivery.fence, until: Date.parse(delivery.dueAt!) }, { epoch: fence.epoch }, Date.parse(fence.nowIso));
}
/** 由出站箱管理的行：M04/M05/M06 写的确定性 64 位十六进制 ID（旧入口用 randomUUID，带连字符）。 */
export const outboxManaged = (notificationId: string) => /^[0-9a-f]{64}$/.test(notificationId);
