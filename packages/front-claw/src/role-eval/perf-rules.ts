/**
 * R5（PERF-RULES-v1）：账本只存原始事实；业绩在查询时按版本化规则计算。
 * MVP：员工私聊报的单 = 开单业绩（amount_type = consultant），只计已确认；
 * 门店业绩 = 本店已确认开单业绩合计；月目标完成率 = 当月已确认开单业绩 ÷ 门店月目标（不封顶）。
 * 分子只计 confirmed + consultant（pending / voided 不计；耗卡 MVP 不加）。
 * 分配约束与 R8 基数落在校验层，不引入分配表。提成、手工费不算业绩。退款走改单。
 */
import { sumCents } from './money.js';
import type { LedgerEntry } from './performance-store.js';

export const PERF_RULE_VERSION = 1;
export const PERF_TYPE_CONSULTANT = 'consultant' as const;
/** 007 历史值；009 会改成 consultant。查询时两者都按开单业绩计。 */
export const LEGACY_CONSULTANT_TYPE = '业绩';

export function isConsultantType(amountType: string): boolean {
  return amountType === PERF_TYPE_CONSULTANT || amountType === LEGACY_CONSULTANT_TYPE;
}

export function isConfirmedStatus(status: string): boolean {
  return status === 'confirmed';
}

export function consultantEntries(entries: readonly LedgerEntry[]): LedgerEntry[] {
  return entries.filter(row => isConfirmedStatus(row.status) && isConsultantType(row.amountType));
}

/** 已确认开单业绩合计（分）。加法只走整数分。 */
export function sumConsultantCents(entries: readonly LedgerEntry[]): number {
  return sumCents(consultantEntries(entries).map(row => row.amount)) ?? 0;
}

/**
 * 门店月目标完成率。没有门店月目标或目标为 0 → null。
 * 个人目标不参与门店完成率。
 */
export function storeCompletionRate(consultantCents: number, storeTargetCents: number | null): number | null {
  if (storeTargetCents === null || storeTargetCents <= 0) return null;
  // 不封顶：超额（例如 120%）原样返回，由展示层显示超过 100%。
  return consultantCents / storeTargetCents;
}

/** R5 分配约束（校验层，MVP 不写入分配表、不做多人分配）。比例用百分数，容差 0.01。 */
export interface AllocationShare { storeId: string; share: number; personId?: string }
export function validateAllocation(input: {
  storeShares: readonly { storeId: string; share: number }[];
  employeeShares?: readonly { personId: string; storeId: string; share: number }[];
}): { ok: true } | { ok: false; reason: string } {
  const stores = input.storeShares;
  if (!stores.length) return { ok: false, reason: 'missing_store_share' };
  const storeSum = stores.reduce((n, s) => n + s.share, 0);
  if (Math.abs(storeSum - 100) > 0.01) return { ok: false, reason: 'store_shares_must_sum_to_100' };
  const byStore = new Map(stores.map(s => [s.storeId, s.share]));
  for (const e of input.employeeShares ?? []) {
    if (!(e.share > 0)) return { ok: false, reason: 'employee_share_must_be_positive' };
    const cap = byStore.get(e.storeId);
    if (cap === undefined) return { ok: false, reason: 'employee_store_missing' };
    if (e.share - cap > 0.01) return { ok: false, reason: 'employee_share_exceeds_store' };
  }
  return { ok: true };
}

/**
 * R8 业绩基数：折后实收。员工按实收报，系统不再扣折扣；赠送不计入；充值实付计入。
 * MVP 不做外带单。giftCents 被忽略（调用方不应把它加进 receivedCents）。
 */
export function performanceBaseCents(input: { receivedCents: number; giftCents?: number }): { ok: true; cents: number } | { ok: false; reason: string } {
  if (!Number.isSafeInteger(input.receivedCents) || input.receivedCents <= 0) return { ok: false, reason: 'invalid_received' };
  return { ok: true, cents: input.receivedCents };
}
