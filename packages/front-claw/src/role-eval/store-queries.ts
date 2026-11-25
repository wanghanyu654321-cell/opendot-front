import type { PerformanceStore, Person } from './performance-store.js';
import { formatAmount, formatScore } from './reply.js';
import { sumCents } from './money.js';
import { consultantEntries } from './perf-rules.js';
import { monthKey, monthPeriod, scoreDay, scoreMonth } from './metrics.js';

/**
 * M03 管理查询：调用方必须先按策略算出允许的门店，再把门店显式传进来。
 * 每次读取都按门店下推到 listEntries({ storeId })，不读未授权门店的数据。
 */
const F = 'Front Claw';
async function recorded(store: PerformanceStore, storeId: string) {
  return consultantEntries(await store.listEntries({ storeId, status: 'confirmed' }));
}
export async function storeSummary(store: PerformanceStore, scope: { storeId: string; storeName: string }, businessDay: string): Promise<string> {
  const entries = await recorded(store, scope.storeId);
  const month = monthPeriod(businessDay);
  const today = entries.filter(row => row.businessDay === businessDay);
  const monthTotal = entries.filter(row => row.businessDay >= month.start && row.businessDay <= businessDay).reduce((sum, row) => { const next = sumCents([sum, row.amount]); if (next === null) throw Error('money_overflow'); return next; }, 0);
  const byPerson = new Map<string, number>();
  for (const row of today) byPerson.set(row.ownerName, (sumCents([byPerson.get(row.ownerName) ?? 0, row.amount]) ?? 0));
  return [`${F} ${scope.storeName} 汇总（${businessDay}）`, `今天 ${formatAmount(today.reduce((sum, row) => { const next = sumCents([sum, row.amount]); if (next === null) throw Error('money_overflow'); return next; }, 0))}`,
    ...[...byPerson.entries()].sort((a, b) => a[0].localeCompare(b[0], 'zh')).map(([name, amount]) => `${name} ${formatAmount(amount)}`),
    `本月 ${formatAmount(monthTotal)}`].join('\n');
}
export async function storeTargetSummary(store: PerformanceStore, scope: { storeId: string; storeName: string }, businessDay: string): Promise<string> {
  const entries = await recorded(store, scope.storeId);
  const month = monthPeriod(businessDay);
  const storeTarget = await store.getStoreTarget(scope.storeId, monthKey(businessDay));
  const monthTarget = storeTarget?.amount ?? 0;
  const today = entries.filter(row => row.businessDay === businessDay);
  const todayTotal = today.reduce((sum, row) => { const next = sumCents([sum, row.amount]); if (next === null) throw Error('money_overflow'); return next; }, 0);
  const monthTotal = entries.filter(row => row.businessDay >= month.start && row.businessDay <= businessDay).reduce((sum, row) => { const next = sumCents([sum, row.amount]); if (next === null) throw Error('money_overflow'); return next; }, 0);
  const byPerson = new Map<string, number>();
  for (const row of today) byPerson.set(row.ownerName, (sumCents([byPerson.get(row.ownerName) ?? 0, row.amount]) ?? 0));
  return [
    `${F} ${scope.storeName} 汇总（${businessDay}）`,
    formatScore('今天', '日完成率', scoreDay(todayTotal, monthTarget, businessDay)),
    ...[...byPerson.entries()].sort((a, b) => a[0].localeCompare(b[0], 'zh')).map(([name, amount]) => `${name} ${formatAmount(amount)}`),
    formatScore('本月', '月完成率', scoreMonth(monthTotal, monthTarget, businessDay)),
  ].join('\n');
}
export async function unreported(store: PerformanceStore, scope: { storeId: string; storeName: string }, businessDay: string): Promise<string> {
  const people = (await store.listPeople()).filter(row => row.active && row.storeId === scope.storeId && (row.tier === 'employee' || row.tier === 'manager'));
  const reported = new Set((await recorded(store, scope.storeId)).filter(row => row.businessDay === businessDay).map(row => row.ownerPersonId));
  const names = people.filter(row => !reported.has(row.personId)).map(row => row.displayName).sort((a, b) => a.localeCompare(b, 'zh'));
  return names.length ? `${F} ${scope.storeName} 今天还没报：\n${names.join('\n')}` : `${F}：${scope.storeName} 今天都报过了。`;
}
export async function ranking(store: PerformanceStore, scopes: readonly { storeId: string; storeName: string }[], businessDay: string): Promise<string> {
  const month = monthPeriod(businessDay);
  const rows: { name: string; total: number }[] = [];
  for (const scope of scopes) {
    const total = (await recorded(store, scope.storeId)).filter(row => row.businessDay >= month.start && row.businessDay <= businessDay).reduce((sum, row) => { const next = sumCents([sum, row.amount]); if (next === null) throw Error('money_overflow'); return next; }, 0);
    rows.push({ name: scope.storeName, total });
  }
  rows.sort((a, b) => b.total - a.total || a.name.localeCompare(b.name, 'zh'));
  return [`${F} 门店排名（本月，仅含你被授权的门店）`, ...rows.map((row, index) => `${index + 1}. ${row.name} ${formatAmount(row.total)}`)].join('\n');
}
/** 门店名 → 门店（来自人员目录）；同名多店视为无法确定。 */
export function storeByName(people: readonly Person[], name: string): { storeId: string; storeName: string } | null {
  const ids = new Set(people.filter(row => row.storeName === name).map(row => row.storeId));
  if (ids.size !== 1) return null;
  const storeId = [...ids][0]!;
  return { storeId, storeName: name };
}
export function storeById(people: readonly Person[], storeId: string): { storeId: string; storeName: string } | null {
  const row = people.find(person => person.storeId === storeId && person.storeName.trim());
  return row ? { storeId, storeName: row.storeName } : null;
}
