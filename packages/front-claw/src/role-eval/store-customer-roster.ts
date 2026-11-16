/**
 * D139 补充：本店已知客户只用现有数据推导，不另建「名单系统」，也没有「回是就记住」的单独状态。
 * 来源（严格本店隔离，别的店不算）：
 *   - 本店已确认订单（任一营业日，含今天已确认的报单；status=confirmed，作废/voided 不算）；
 *   - 本店预约的客户名。
 * 未确认的报单草稿不算「今天已报单」。
 * 匹配：归一后整词；去掉称谓后缀后再整词（核心名至少 2 字）。
 *
 * D131 同店同名二选一不走本模块：它仍只看本店今天已确认单（todayConfirmed，见 employee-loop），口径不变。
 */
import type { PerformanceStore } from './performance-store.js';
import { customerCoreName, normalizeCustomerName } from './customer-conflict.js';

export type RosterStore = Pick<PerformanceStore, 'listEntries' | 'listAppointments'>;

function addName(into: Set<string>, raw: string | null | undefined): void {
  const full = normalizeCustomerName(raw ?? '');
  if (!full) return;
  into.add(full);
  const core = customerCoreName(full);
  if (core && core !== full && core.length >= 2) into.add(core);
}

export async function collectKnownCustomerNames(store: RosterStore, storeId: string): Promise<Set<string>> {
  const names = new Set<string>();
  // D139-roster-confirmed：只取本店已确认订单（含今天已确认报单）；作废不算。
  for (const row of await store.listEntries({ storeId, status: 'confirmed' })) { // D139-roster-confirmed
    if (row.storeId !== storeId || row.status !== 'confirmed') continue;
    addName(names, row.customerName);
  }
  for (const appt of await store.listAppointments({ storeId })) {
    if (appt.storeId !== storeId) continue;
    addName(names, appt.customerName);
  }
  // D139-roster-no-pending：未确认草稿不进名单（只回「是」不够；作废/超时/放弃的草稿也不算）。
  return names;
}

/**
 * R16 / D146：具体追问用的「本店已确认客户」只含回「对」入账的名字，不含预约、不含草稿。
 * 不改变 D139 的 collectKnownCustomerNames（政策 C 名单仍含预约）。
 */
export async function collectConfirmedLedgerNames(store: RosterStore, storeId: string): Promise<Set<string>> {
  const names = new Set<string>();
  for (const row of await store.listEntries({ storeId, status: 'confirmed' })) {
    if (row.storeId !== storeId || row.status !== 'confirmed') continue;
    addName(names, row.customerName);
  }
  return names;
}

export function nameInRoster(names: Set<string>, customer: string): boolean {
  const full = normalizeCustomerName(customer);
  if (!full) return false;
  if (names.has(full)) return true;
  const core = customerCoreName(full);
  if (core.length >= 2 && names.has(core)) return true;
  return false;
}
