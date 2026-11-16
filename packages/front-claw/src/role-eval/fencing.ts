/**
 * R1：M07 消费租约与 M06 通知领取共用的 fencing 版本号。
 * - epoch：单调递增的整数；每次“换主”（新领取者/新消费者）+1，同一持有者续约不变。
 * - until：租约到期时刻（毫秒）。到期后旧持有者即使没人接管也失权。
 * 提交业务或写通知结果时带上领取时拿到的 Fence；当前记录的 epoch/owner 对不上或已到期 → 拒绝。
 */
export interface FenceState { owner: string | null; epoch: number; until: number }
export interface Fence { key: string; owner: string; epoch: number }

export const validEpoch = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** 唯一判定函数：M06 写结果与 M07 业务提交/回复都用它。 */
export function fenceHolds(state: FenceState | null, fence: { owner?: string | null; epoch: number }, nowMs: number): boolean {
  if (!state || !validEpoch(fence.epoch) || !validEpoch(state.epoch)) return false;
  if (state.epoch !== fence.epoch) return false;
  if (fence.owner !== undefined && fence.owner !== null && state.owner !== fence.owner) return false;
  return Number.isFinite(state.until) && state.until > nowMs;
}
/** 下一任持有者的 epoch（旧记录没有 epoch 视为 0）。 */
export const nextEpoch = (current: number | null | undefined) => (validEpoch(current) ? current : 0) + 1;

/** M07 消费租约记录（PG config 一行 JSON）。旧格式没有 epoch → 0。损坏 → null。 */
export interface LeaseRecord { owner: string | null; token: string | null; until: number; epoch: number }
export function parseLeaseRecord(raw: string | null): LeaseRecord | null {
  if (raw === null) return null;
  try {
    const value = JSON.parse(raw) as Partial<LeaseRecord>;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const owner = value.owner === null || typeof value.owner === 'string' ? value.owner : undefined;
    const token = value.token === null || typeof value.token === 'string' ? value.token : undefined;
    const epoch = value.epoch === undefined ? 0 : value.epoch;
    if (owner === undefined || token === undefined || typeof value.until !== 'number' || !Number.isFinite(value.until) || !validEpoch(epoch)) return null;
    return { owner, token, until: value.until, epoch };
  } catch { return null; }
}
