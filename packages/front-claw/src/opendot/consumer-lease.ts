import { randomUUID } from 'node:crypto';
import { nextEpoch, parseLeaseRecord, type Fence } from '../role-eval/fencing.js';
import type { PerformanceStore } from '../role-eval/performance-store.js';

/**
 * M07：企微入站的单消费者租约（同一机器人只一个消费者）。存在 PG performance_config 一行里，不改 schema。
 * 先 insertConfigIfAbsent 保证行存在（并发首写不会互相覆盖），再 updateConfigLocked（行 FOR UPDATE）判断/续约/释放。
 * 参考 client-go leaderelection（租期 > 续约周期）。
 * R1（M07-01）：记录带单调递增 epoch，每次换主 +1；持有者把 fence()（key+owner+epoch）带进每次入账，
 * 入账事务内 FOR SHARE 读这一行核对 owner/epoch 未变且未到期，否则拒绝（与 M06 通知领取同一判定 fenceHolds）。
 */
export const CONSUMER_LEASE_KEY = 'front-claw-opendot-consumer';
const FREE = JSON.stringify({ owner: null, token: null, until: 0, epoch: 0 });
const parse = parseLeaseRecord;

export interface ConsumerLease {
  readonly owner: string;
  /** 抢占或续约；返回本次之后是否持有。 */
  acquire(): Promise<boolean>;
  /** 本地判断：最近一次成功抢占/续约的到期时间还没到。 */
  held(): boolean;
  release(): Promise<void>;
  /** 当前持有令牌（未持有为 null）。 */
  token(): string | null;
  /** R1：当前持有的 fencing 凭据（未持有为 null）。 */
  fence(): Fence | null;
}

export function createConsumerLease(options: { store: PerformanceStore; owner: string; ttlMs: number; now: () => Date; key?: string }): ConsumerLease {
  const { store, owner, ttlMs, now } = options;
  const key = options.key ?? CONSUMER_LEASE_KEY;
  if (!owner.trim() || !Number.isInteger(ttlMs) || ttlMs < 1_000) throw Error('invalid_consumer_lease');
  let mine: string | null = null;
  let heldUntil = 0;
  let epoch = 0;
  return {
    owner,
    async acquire() {
      await store.insertConfigIfAbsent(key, FREE);
      const at = now().getTime();
      const next = mine ?? randomUUID().replace(/-/g, '');
      let won = false, wonEpoch = 0;
      await store.updateConfigLocked(key, [], current => {
        const record = parse(current[key] ?? null);
        // 损坏的租约行不当作“空闲”（否则两个实例都能抢到），保持不消费，等人工处理。
        if (!record) return null;
        const ours = record.owner === owner && record.token !== null && record.token === mine;
        if (!ours && record.owner !== null && record.until > at) return null;
        won = true;
        // 续约（同一持有者同一令牌）epoch 不变；换主（含自己丢失令牌后重抢）+1。
        wonEpoch = ours ? record.epoch : nextEpoch(record.epoch);
        return { [key]: JSON.stringify({ owner, token: next, until: at + ttlMs, epoch: wonEpoch }) };
      });
      if (won) { mine = next; heldUntil = at + ttlMs; epoch = wonEpoch; } else { mine = null; heldUntil = 0; }
      return won;
    },
    held() { return mine !== null && now().getTime() < heldUntil; },
    async release() {
      const token = mine;
      mine = null; heldUntil = 0;
      if (!token) return;
      await store.updateConfigLocked(key, [], current => {
        const record = parse(current[key] ?? null);
        // 释放保留 epoch（下一任再 +1），旧持有者的在途提交随即失效。
        return record && record.owner === owner && record.token === token ? { [key]: JSON.stringify({ owner: null, token: null, until: 0, epoch: record.epoch }) } : null;
      });
    },
    token() { return mine; },
    fence() { return mine ? { key, owner, epoch } : null; },
  };
}
