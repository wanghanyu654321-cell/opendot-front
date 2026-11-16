/**
 * R14 R13-02 PG：过期草稿取消后能关闭；回「对」须含「这笔已过期，请重新报」且零入账。
 * 使用用例自建临时集群，不碰共享库。自编句子（许姨、周老师）。
 */
import { describe, expect, it } from 'vitest';
import { worldM05 } from '../role-eval/appointment-fixture-m05.js';
import { freshDatabase, openLatest, useCluster } from '../migration/pg-harness-m08.js';

useCluster();

describe('R14 过期草稿 PG', () => {
  it('过期后取消关闭，随后新报单进入下一笔，旧单零入账', async () => {
    const url = await freshDatabase();
    const db = await openLatest(url);
    try {
      const w = await worldM05({ store: db.store });
      expect(await w.call('m-zhao', '许姨：720（小赵）')).toMatch(/还没入账/);
      const old = (await w.base.listDrafts({ status: 'pending' }))[0];
      if (!old) throw new Error('expected pending draft');
      await w.base.saveDraft({ ...old, expiresAt: '2000-01-01T00:00:00.000Z' });
      const cancel = await w.call('m-zhao', '取消');
      expect(cancel).toMatch(/已取消|已过期|已关闭|已作废/);
      expect(cancel).not.toMatch(/请先确认或取消当前草稿/);
      expect((await w.base.getDraft(old.draftId))?.status).toBe('void');
      const next = await w.call('m-zhao', '周老师 880');
      expect(next).toMatch(/还没入账/);
      expect(next).toMatch(/客户：周老师/);
      expect(next).not.toMatch(/请先确认或取消当前草稿/);
      const pending = await w.base.listDrafts({ status: 'pending' });
      expect(pending).toHaveLength(1);
      if (pending[0]!.payload.type === 'report') {
        expect(pending[0]!.payload.added[0]!.customer).toBe('周老师');
      }
      expect((await w.base.listEntries()).filter(e => e.customerName === '许姨')).toHaveLength(0);
    } finally {
      await db.close();
    }
  }, 30_000);

  it('过期后回「对」：回复含「这笔已过期，请重新报」，入账为零，草稿关闭', async () => {
    const url = await freshDatabase();
    const db = await openLatest(url);
    try {
      const w = await worldM05({ store: db.store });
      expect(await w.call('m-zhao', '许姨：720（小赵）')).toMatch(/还没入账/);
      const old = (await w.base.listDrafts({ status: 'pending' }))[0];
      if (!old) throw new Error('expected pending draft');
      await w.base.saveDraft({ ...old, expiresAt: '2000-01-01T00:00:00.000Z' });
      const entriesBefore = JSON.stringify(await w.base.listEntries());
      const r = await w.call('m-zhao', '对');
      expect(r).toContain('这笔已过期，请重新报');
      expect(r).toMatch(/未入账/);
      expect((await w.base.getDraft(old.draftId))?.status).toBe('void');
      expect(JSON.stringify(await w.base.listEntries())).toBe(entriesBefore);
      expect((await w.base.listEntries()).filter(e => e.customerName === '许姨' && e.status === 'confirmed')).toHaveLength(0);
      expect((await w.base.listEntries()).filter(e => e.sourceDraftId === old.draftId)).toHaveLength(0);
      const next = await w.call('m-zhao', '周老师 880');
      expect(next).toMatch(/还没入账/);
      expect(next).not.toMatch(/请先确认或取消当前草稿/);
    } finally {
      await db.close();
    }
  }, 30_000);
});
