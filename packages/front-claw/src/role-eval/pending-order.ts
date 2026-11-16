import type { PerformanceStore } from './performance-store.js';
/** 同一存储的序列号以十进制字符串传输，避免 bigint 经 JSON 或 number 丢失精度。 */
export interface PendingArrival { sequence: string; hours: string | null }
export function sequenceBefore(issued: string | undefined, arrival: string): boolean {
  return /^\d+$/.test(issued ?? '') && /^\d+$/.test(arrival) && BigInt(issued!) < BigInt(arrival);
}
/** 保留替换场景的平台迟到/同秒保守拒绝；存储层仍只比较一个序号条件。
 * 优先以原报单的平台时刻为下界，避免比较消费者时钟；旧无平台元数据项沿用原下界。
 * 未提供确认的平台时刻时完全使用共享序列。 */
export function confirmationSequence(issuedAt: string, platformAt: string | undefined, replaced: boolean, sequence: string): string {
  return replaced && platformAt !== undefined && Date.parse(platformAt) <= Date.parse(issuedAt) ? '0' : sequence;
}
export function capturePendingArrival(store: PerformanceStore): Promise<Readonly<PendingArrival>> {
  // 读取器可能保留返回值；消费前复制并冻结，迟到修改不能换掉已捕获的序号。
  const reading = store.capturePendingArrival();
  return reading.then(value => Object.freeze(structuredClone(value)));
}
