/**
 * R14 R13-02：过期草稿能显式取消或自动关闭，新消息能进入下一笔。
 * 过期名字仍不进名单（只在回「对」入账后进）。自编，不取留出集原句。
 */
import { describe, expect, it } from 'vitest';
import { worldM05 } from '../role-eval/appointment-fixture-m05.js';
import { collectKnownCustomerNames, nameInRoster } from '../../src/role-eval/store-customer-roster.js';

async function expirePending(w: Awaited<ReturnType<typeof worldM05>>, at = '2000-01-01T00:00:00.000Z') {
  const draft = (await w.base.listDrafts({ status: 'pending' }))[0];
  if (!draft) throw new Error('expected pending draft');
  await w.base.saveDraft({ ...draft, expiresAt: at });
  return draft.draftId;
}

describe('R14 过期草稿关闭与会话继续', () => {
  it('过期后回「对」：提示已过期、未入账，草稿关闭，名字不进名单', async () => {
    const w = await worldM05();
    const first = await w.call('m-zhao', '许姨：720（小赵）');
    expect(first).toMatch(/还没入账/);
    const id = await expirePending(w);
    const r = await w.call('m-zhao', '对');
    expect(r).toContain('这笔已过期，请重新报');
    expect(r).toMatch(/未入账/);
    const draft = await w.base.getDraft(id);
    expect(draft?.status).toBe('void');
    expect((await w.base.listEntries()).filter(e => e.customerName === '许姨' && e.status === 'confirmed')).toHaveLength(0);
    expect((await w.base.listEntries()).filter(e => e.status === 'confirmed' && e.sourceDraftId === id)).toHaveLength(0);
    const names = await collectKnownCustomerNames(w.base, 's-b');
    expect(nameInRoster(names, '许姨')).toBe(false);
  });

  it('过期后回「取消」能关闭，随后新报单能开下一笔', async () => {
    const w = await worldM05();
    expect(await w.call('m-zhao', '许姨：720（小赵）')).toMatch(/还没入账/);
    const oldId = await expirePending(w);
    const cancel = await w.call('m-zhao', '取消');
    expect(cancel).toMatch(/已取消|已过期|已关闭|已作废/);
    expect(cancel).not.toMatch(/请先确认或取消当前草稿/);
    expect((await w.base.getDraft(oldId))?.status).toBe('void');
    const next = await w.call('m-zhao', '周老师 880');
    expect(next).toMatch(/还没入账/);
    expect(next).toMatch(/\n客户：周老师\n/);
    expect(next).not.toMatch(/请先确认或取消当前草稿/);
    const pending = await w.base.listDrafts({ status: 'pending' });
    expect(pending).toHaveLength(1);
    if (pending[0]!.payload.type === 'report') {
      expect(pending[0]!.payload.added[0]!.customer).toBe('周老师');
    }
    await w.call('m-zhao', '取消');
  });

  it('过期后直接发新报单：旧草稿自动关闭，新消息进入下一笔，零入账旧单', async () => {
    const w = await worldM05();
    expect(await w.call('m-zhao', '许姨：720（小赵）')).toMatch(/还没入账/);
    const oldId = await expirePending(w);
    const next = await w.call('m-zhao', '周老师 880');
    expect(next).toMatch(/还没入账/);
    expect(next).toMatch(/\n客户：周老师\n/);
    expect(next).not.toMatch(/请先确认或取消当前草稿/);
    expect((await w.base.getDraft(oldId))?.status).toBe('void');
    expect((await w.base.listEntries()).filter(e => e.customerName === '许姨' || e.customerName === '周老师')).toHaveLength(0);
    await w.call('m-zhao', '取消');
  });
});
