/**
 * R13 历史客户名标准行种子的定义与行为。不打开留出集。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadHistoricalCustomerSeed, seedHistoricalCustomers, PRODUCT_NAMED_CUSTOMERS } from './historical-seed.js';
import { worldM05 } from '../role-eval/appointment-fixture-m05.js';

describe('历史客户名标准行种子', () => {
  it('冻结文件包含定义、产品点名五人和锁定集解析名；营业日是上一营业日 2026-11-11', () => {
    const file = loadHistoricalCustomerSeed();
    expect(file.businessDay).toBe('2026-11-11');
    expect(file.definition).toMatch(/标准行「客户名：金额（员工）」/);
    expect(file.definition).toMatch(/insertEntries/);
    expect(file.definition).toMatch(/2026-11-11/);
    expect(file.definition).toMatch(/不走今天的员工入口/);
    expect(file.namedByProduct).toEqual([...PRODUCT_NAMED_CUSTOMERS]);
    for (const n of PRODUCT_NAMED_CUSTOMERS) expect(file.names).toContain(n);
    expect(file.fromLockSet.length).toBeGreaterThan(10);
    expect(file.names).toContain('张姐');
    const raw = readFileSync(resolve(__dirname, 'fixtures/historical-customers.json'), 'utf8');
    expect(raw).toMatch(/gate1-lock-ids/);
    expect(raw).toMatch(/仅两组早期已公开语料/);
    expect(raw).toMatch(/不读盲测留出集/);
    expect(raw).not.toMatch(/复审/);
  });

  it('种子写入上一营业日已确认行，今天账本在种入后即可按名单认出，且不占用今天 D131', async () => {
    const w = await worldM05();
    const owner = (await w.base.listPeople()).find(p => p.memberId === 'm-zhao')!;
    await seedHistoricalCustomers(w.base, { storeId: owner.storeId, owner, names: ['苏晓禾'] });
    const hist = (await w.base.listEntries({ storeId: 's-b', businessDay: '2026-11-11', status: 'confirmed' }))
      .filter(e => e.customerName === '苏晓禾');
    expect(hist).toHaveLength(1);
    expect(hist[0]!.status).toBe('confirmed');
    expect(hist[0]!.note).toMatch(/标准行种子/);
    const today = (await w.base.listEntries({ storeId: 's-b', businessDay: '2026-11-12', status: 'confirmed' }))
      .filter(e => e.customerName === '苏晓禾');
    expect(today).toHaveLength(0);
  });
});
