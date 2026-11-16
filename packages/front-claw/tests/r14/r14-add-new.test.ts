/**
 * R14 回归：D131 二选一挂起时「新增一笔」出可确认草稿，金额用刚才再报的那笔；
 * 没有挂起二选一时回「新增一笔」固定回复。不改 D131 判定，只锁现有行为。
 * 自编（钱姐），不取留出集原句。
 */
import { describe, expect, it } from 'vitest';
import { worldM05 } from '../role-eval/appointment-fixture-m05.js';

describe('R14 回归：新增一笔', () => {
  it('二选一已挂起时回「新增一笔」，出可确认草稿，金额是刚才再报的那笔', async () => {
    const w = await worldM05();
    const first = await w.call('m-zhao', '钱姐：680（小赵）');
    expect(first).toMatch(/还没入账/);
    expect(await w.call('m-zhao', '对')).toMatch(/已入账/);
    const ask = await w.call('m-zhao', '钱姐：960（小赵）');
    expect(ask).toMatch(/新增一笔/);
    expect(ask).not.toMatch(/还没入账，/);
    const listed = (await w.base.listDrafts({ status: 'pending' }))[0];
    expect(listed?.payload.type === 'report' && listed.payload.awaitingDuplicateChoice).toBeTruthy();
    if (listed?.payload.type === 'report' && listed.payload.awaitingDuplicateChoice) {
      expect(listed.payload.awaitingDuplicateChoice.newAmount).toBe(96000);
    }
    const next = await w.call('m-zhao', '新增一笔');
    expect(next).toMatch(/还没入账/);
    expect(next).not.toMatch(/不要直接回「对」/);
    expect(next).not.toMatch(/当前没有待选择的新增或改单/);
    expect(next).toMatch(/960/);
    const draft = (await w.base.listDrafts({ status: 'pending' }))[0];
    expect(draft?.payload.type).toBe('report');
    if (draft?.payload.type === 'report') {
      expect(draft.payload.awaitingDuplicateChoice).toBeUndefined();
      expect(draft.payload.explicitNew).toBe(true);
      expect(draft.payload.added[0]!.amount).toBe(96000);
      expect(draft.payload.added[0]!.customer).toBe('钱姐');
    }
    expect(await w.call('m-zhao', '对')).toMatch(/已入账/);
    const rows = (await w.base.listEntries()).filter(e => e.customerName === '钱姐' && e.status === 'confirmed');
    expect(rows).toHaveLength(2);
    expect(rows.map(r => r.amount).sort()).toEqual([68000, 96000]);
  });

  it('没有挂起二选一时回「新增一笔」，固定回复且零写入', async () => {
    const w = await worldM05();
    const before = JSON.stringify(await w.snapshot());
    const r = await w.call('m-zhao', '新增一笔');
    expect(r).toBe('Front Claw：当前没有待选择的新增或改单。没有写入。');
    expect(JSON.stringify(await w.snapshot())).toBe(before);
  });

  it('普通待确认草稿（非二选一）时回「新增一笔」，同样没有待选择、账本不变', async () => {
    const w = await worldM05();
    expect(await w.call('m-zhao', '周老师 880')).toMatch(/还没入账/);
    const before = JSON.stringify(await w.snapshot());
    const r = await w.call('m-zhao', '新增一笔');
    expect(r).toBe('Front Claw：当前没有待选择的新增或改单。没有写入。');
    expect(JSON.stringify(await w.snapshot())).toBe(before);
    await w.call('m-zhao', '取消');
  });
});
