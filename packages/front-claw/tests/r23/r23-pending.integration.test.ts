/** 仅供获准的一次性 PG 集群；不能运行时与 SQL 替身结果分开报告。 */
import { expect, it } from 'vitest';
import { freshDatabase, openLatest, rawQuery, useCluster } from '../migration/pg-harness-m08.js';
import { openSql } from '../../src/migration/pg.js';
import { migrateDown, migrateUp } from '../../src/role-eval/schema-migrations.js';
import { pendingContract } from './pending-contract.js';
useCluster();
pendingContract('R23 PG', async () => openLatest(await freshDatabase()));

it('R23 011 旧无序号挂起项 up/down/up 业务行不变，down 只撤销索引和序列', async () => {
  const url = await freshDatabase(), db = await openLatest(url), sql = await openSql(url);
  try {
    await migrateDown(sql.client, { apply: true });
    expect((await rawQuery(url, "SELECT to_regclass('front_claw_perf.pending_order_seq') AS sequence, to_regclass('front_claw_perf.performance_drafts_pending_reporter_unique') AS idx"))[0]).toEqual({ sequence: null, idx: null });
    const at = '2026-11-20T02:00:00Z';
    await db.store.saveDraft({ draftId: 'seq-upgrade', reporterPersonId: 'p-upgrade', storeId: 's-upgrade', businessDay: '2026-11-20', expiresAt: '2026-11-20T03:00:00Z', kind: 'report', status: 'pending', reminder: 'none', voidNotice: 'none', createdAt: at, closedAt: null, payload: { type: 'report', added: [], missing: [], skipped: 0, employeeContext: { sessionId: 'seq-upgrade', bindingVersion: 1, messageId: 'seq-upgrade', accountId: 'a-upgrade', memberId: 'm-upgrade', version: 'v-upgrade', fingerprint: 'f-upgrade' } } });
    await db.store.setConfig('employee-loop:new-customer-ask:p-upgrade:seq-upgrade', JSON.stringify({ names: ['鄢霁'], listed: [], issuedAt: at, expiresAt: '2026-11-20T03:00:00Z' }));
    const businessRows = () => rawQuery(url, "SELECT 'draft' AS kind, row_to_json(d)::text AS value FROM front_claw_perf.performance_drafts d UNION ALL SELECT 'config', row_to_json(c)::text FROM front_claw_perf.performance_config c ORDER BY kind, value");
    const before = await businessRows();
    for (let round = 0; round < 2; round++) {
      await migrateUp(sql.client, { apply: true });
      expect(await businessRows()).toEqual(before);
      const draft = (await db.store.getDraft('seq-upgrade'))!;
      const issued = draft.payload.type === 'report' ? draft.payload.employeeContext!.pendingSequence : undefined;
      const ask = JSON.parse((await db.store.getConfig('employee-loop:new-customer-ask:p-upgrade:seq-upgrade'))!);
      const arrival = await db.store.capturePendingArrival();
      expect(issued).toBeUndefined(); expect(ask.issuedSequence).toBeUndefined();
      expect(await db.store.transitionPendingDraft(draft, { ...draft, status: 'confirming' }, undefined, { arrivedSequence: arrival.sequence })).toBe(false);
      if (round === 0) {
        await migrateDown(sql.client, { apply: true });
        expect(await businessRows()).toEqual(before);
        expect((await rawQuery(url, "SELECT to_regclass('front_claw_perf.pending_order_seq') AS sequence, to_regclass('front_claw_perf.performance_drafts_pending_reporter_unique') AS idx"))[0]).toEqual({ sequence: null, idx: null });
      }
    }
  } finally { await db.close(); await sql.close(); }
});
