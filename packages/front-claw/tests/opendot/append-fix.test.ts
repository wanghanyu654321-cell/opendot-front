import {expect, it} from 'vitest';
import {createPostgresPerformanceStore, migratePerformance} from '../../src/role-eval/performance-postgres.js';
import type {CommitGuard, Draft, LedgerEntry} from '../../src/role-eval/performance-store.js';
import {MemorySql} from '../role-eval/sql-fixture.js';

// Synthetic SQL representation checks; actual locking is checked by the PG scenes.
class NumericSql extends MemorySql {
  override async query<T = Record<string, unknown>>(sql: string, params: readonly unknown[] = []): Promise<{rows: T[]}> {
    const result = await super.query<Record<string, unknown>>(sql, params);
    if (/^SELECT \* FROM .*performance_entries/.test(sql)) {
      for (const row of result.rows) {
        const [whole, fraction = ''] = String(row.amount).split('.');
        row.amount = `${whole}.${fraction.padEnd(2, '0')}`;
      }
    }
    return result as {rows: T[]};
  }
}
const line = (entryId: string, amount = 56000): LedgerEntry => ({
  entryId, storeId: 'synthetic-store', businessDay: '2026-11-16', customerName: null, amount,
  amountType: 'consultant', ownerPersonId: 'synthetic-person', ownerName: '合成员',
  reporterPersonId: 'synthetic-person', note: '', status: 'confirmed', disputed: false,
  createdAt: '2026-11-16T01:00:00.000Z', sourceDraftId: entryId, sourceOrdinal: 0,
});
const draft = (): Draft => ({
  draftId: 'synthetic-draft', reporterPersonId: 'synthetic-person', storeId: 'synthetic-store',
  businessDay: '2026-11-16', expiresAt: '2026-11-16T12:00:00.000Z', kind: 'report',
  payload: {type: 'report', added: [], missing: [], skipped: 0}, status: 'confirming',
  reminder: 'none', voidNotice: 'none', createdAt: '2026-11-16T01:00:00.000Z', closedAt: null,
});

it.each([56000, 56050, 56005])('numeric content equality preserves a two-line multiset for %i cents', async amount => {
  const sql = new NumericSql(); await migratePerformance(sql);
  const store = createPostgresPerformanceStore(sql);
  await store.insertEntries([line('synthetic-old', amount)]);
  const d = draft(); await store.saveDraft(d);
  const candidates = [0, 1].map(i => ({...line(`synthetic-new-${i}`, amount), sourceDraftId: d.draftId, sourceOrdinal: i}));
  await store.commitConfirmingDraft({...d, status: 'confirmed'}, candidates);
  const rows = await store.listEntries();
  expect(rows).toHaveLength(2);
  expect(rows.reduce((sum, r) => sum + r.amount, 0)).toBe(amount * 2);
  expect(rows.filter(r => r.sourceDraftId === d.draftId)).toHaveLength(1);
  await store.commitConfirmingDraft({...d, status: 'confirmed'}, candidates);
  expect(await store.listEntries()).toHaveLength(2);
});

it.each([
  {storeId: 'synthetic-other-store'}, {businessDay: '2026-11-15'},
  {ownerPersonId: 'synthetic-other-person'}, {customerName: '合成客户'}, {amount: 56001},
])('content equality keeps isolation %j', async patch => {
  const sql = new NumericSql(); await migratePerformance(sql);
  const store = createPostgresPerformanceStore(sql);
  await store.insertEntries([{...line('synthetic-old'), ...patch}]);
  const d = draft(); await store.saveDraft(d);
  await store.commitConfirmingDraft({...d, status: 'confirmed'}, [line('synthetic-new')]);
  expect(await store.listEntries()).toHaveLength(2);
});

it.each(['performance_config', 'performance_people', 'wecom_bot_bindings'])('guard contention on %s rolls back and is classified', async table => {
  class ContendedSql extends MemorySql {
    override async query<T = Record<string, unknown>>(sql: string, params: readonly unknown[] = []): Promise<{rows: T[]}> {
      if (sql.includes(table) && /FOR SHARE NOWAIT/.test(sql)) throw Object.assign(Error('synthetic_contention'), {code: '55P03'});
      return super.query<T>(sql, params);
    }
  }
  const sql = new ContendedSql(); await migratePerformance(sql);
  const store = createPostgresPerformanceStore(sql);
  const d = draft(); await store.saveDraft(d);
  const guard: CommitGuard = {key: 'synthetic-policy', personIds: ['synthetic-person'], check: () => true,
    binding: {botId: 'synthetic-bot', memberId: 'synthetic-member', corpId: 'synthetic-corp', accountId: 'synthetic-account', version: 1, active: true}};
  await expect(store.commitConfirmingDraft({...d, status: 'confirmed'}, [line('synthetic-new')], guard))
    .rejects.toMatchObject({name: 'CommitContentionRejected', code: '55P03'});
  expect((await store.getDraft(d.draftId))?.status).toBe('confirming');
  expect(await store.listEntries()).toHaveLength(0);
});
