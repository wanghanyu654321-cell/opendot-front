/**
 * R13 评测/测试用「标准行种子」：把客户名写成上一营业日（默认 2026-11-11）已确认账本行。
 *
 * 定义（写入 REPORT 的同一口径）：
 * 一条历史客户名种子，等价于在该营业日用标准行「客户名：金额（员工）」报入并回「对」之后的已确认记录。
 * 实现上经 PerformanceStore.insertEntries 直接写入，不走今天的员工入口——
 * 这样既不会触发今天的 D131 二选一，也不会在政策 A 下被「是新客户」拦住而种不上。
 *
 * 冻结名单见 fixtures/historical-customers.json：含产品点名的苏晓禾、小雪、阿玲、李小雪、欧阳娜娜，
 * 以及门①锁定集（gate1-lock-ids.json，仅两组早期已公开语料）里 tryStandardReport 能解析出的客户名。
 * 不读盲测留出集，不改语料原句。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LedgerEntry, PerformanceStore, Person } from '../../src/role-eval/performance-store.js';

export interface HistoricalCustomerSeedFile {
  businessDay: string;
  definition: string;
  namedByProduct: string[];
  fromLockSet: string[];
  names: string[];
}

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures/historical-customers.json');

let cached: HistoricalCustomerSeedFile | null = null;

export function loadHistoricalCustomerSeed(): HistoricalCustomerSeedFile {
  if (cached) return cached;
  cached = JSON.parse(readFileSync(FIXTURE, 'utf8')) as HistoricalCustomerSeedFile;
  return cached;
}

export interface SeedHistoricalOptions {
  storeId: string;
  owner: Person;
  names: readonly string[];
  businessDay?: string;
  amountCents?: number;
}

export async function seedHistoricalCustomers(
  store: Pick<PerformanceStore, 'insertEntries'>,
  opts: SeedHistoricalOptions,
): Promise<LedgerEntry[]> {
  const day = opts.businessDay ?? '2026-11-11';
  const base = opts.amountCents ?? 10000;
  const entries: LedgerEntry[] = opts.names.map((name, i) => ({
    entryId: `hist-${opts.storeId}-${day}-${i}-${name}`,
    storeId: opts.storeId,
    businessDay: day,
    customerName: name,
    amount: base + i,
    amountType: 'consultant',
    ownerPersonId: opts.owner.personId,
    ownerName: opts.owner.displayName,
    reporterPersonId: opts.owner.personId,
    note: '标准行种子（上一营业日已确认）',
    status: 'confirmed',
    disputed: false,
    createdAt: `${day}T03:00:00.000Z`,
    sourceDraftId: `hist-draft-${opts.storeId}-${day}`,
    sourceOrdinal: i,
  }));
  if (entries.length) await store.insertEntries(entries);
  return entries;
}

/** 给 worldM05 / 评测世界种上冻结名单（发件人所在店）。 */
export async function seedFrozenHistoricalCustomers(
  store: Pick<PerformanceStore, 'insertEntries'>,
  owner: Person,
  storeId: string = owner.storeId,
): Promise<LedgerEntry[]> {
  const file = loadHistoricalCustomerSeed();
  return seedHistoricalCustomers(store, {
    storeId,
    owner,
    names: file.names,
    businessDay: file.businessDay,
  });
}

export const PRODUCT_NAMED_CUSTOMERS = ['苏晓禾', '小雪', '阿玲', '李小雪', '欧阳娜娜'] as const;

export async function seedProductNamedCustomers(
  store: Pick<PerformanceStore, 'insertEntries' | 'listPeople'>,
  memberId = 'm-zhao',
): Promise<LedgerEntry[]> {
  const people = await store.listPeople();
  const owner = people.find(p => p.memberId === memberId);
  if (!owner) throw new Error(`seedProductNamedCustomers: 找不到 ${memberId}`);
  return seedHistoricalCustomers(store, {
    storeId: owner.storeId,
    owner,
    names: PRODUCT_NAMED_CUSTOMERS,
    businessDay: '2026-11-11',
  });
}
