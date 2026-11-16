/**
 * R17 / D151：并发回「对」只入账一次、金额不翻倍、只回一次「已入账」。
 * 没改到草稿状态的第二次按已处理回复，不带第二次「已入账」。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { ALREADY_CONFIRMED_TEXT, ALREADY_SETTLED_REPLY } from '../../src/role-eval/employee-loop.js';
import { confirmEntryId } from '../../src/role-eval/performance-store.js';
import { gate, installPausePoints } from '../../src/role-eval/pause-points.js';
import { worldM05 } from '../role-eval/appointment-fixture-m05.js';

let uninstall: (() => void) | undefined;
afterEach(() => { uninstall?.(); uninstall = undefined; });

describe('R17 确认幂等（D151）', () => {
  it('存储层：同一草稿第二次 commit 返回 0，入账行数仍为 1、金额不翻倍', async () => {
    const w = await worldM05();
    expect(await w.call('m-zhao', '周老师：680（小赵）')).toContain('还没入账');
    const pending = (await w.base.listDrafts({ status: 'pending' }))[0]!;
    const claimed = await w.base.claimPendingDraft(pending.draftId);
    expect(claimed?.status).toBe('confirming');
    const entry = {
      entryId: confirmEntryId(pending.draftId, 0), storeId: pending.storeId, businessDay: pending.businessDay,
      customerName: '周老师', amount: 68000, amountType: 'consultant' as const,
      ownerPersonId: 'p-zhao', ownerName: '小赵', reporterPersonId: 'p-zhao', note: '',
      status: 'confirmed' as const, disputed: false, createdAt: pending.createdAt,
      sourceDraftId: pending.draftId, sourceOrdinal: 0,
    };
    const done = { ...claimed!, status: 'confirmed' as const, closedAt: '2026-11-12T02:00:01.000Z' };
    expect(await w.base.commitConfirmingDraft(done, [entry])).toBeGreaterThan(0);
    expect(await w.base.commitConfirmingDraft(done, [entry])).toBe(0);
    const rows = (await w.base.listEntries({ status: 'confirmed' })).filter(r => r.sourceDraftId === pending.draftId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.amount).toBe(68000);
  });

  it('入口：确认停在提交前，另一条「对」并发进来，放行后只入一笔、只回一次「已入账」、金额不翻倍', async () => {
    const w = await worldM05();
    expect(await w.call('m-zhao', '周老师：680（小赵）')).toContain('还没入账');
    const g = gate();
    uninstall = installPausePoints({ 'commit-gate:before-commit': g.hook });
    const first = w.call('m-zhao', '对');
    await g.reached;
    const second = w.call('m-zhao', '对');
    // 给第二条走到 leftover confirming 或「版本已变化」的机会，再放行第一次提交。
    await new Promise(r => setTimeout(r, 30));
    g.release();
    const replies = await Promise.all([first, second]);
    const booked = replies.filter(t => t.includes('已入账'));
    expect(booked, replies.join('\n---\n')).toHaveLength(1);
    const other = replies.find(t => !t.includes('已入账'))!;
    // R18 / D160：输家只回这一句（「已经入账」不含「已入账」字串），不多记一笔。
    expect(other).toBe('Front Claw：这笔已经入账了，不用重复确认。');
    expect(other).not.toContain('已入账');
    expect(other).not.toContain('结果未知');
    const rows = (await w.base.listEntries({ status: 'confirmed' })).filter(r => r.customerName === '周老师' && r.amount === 68000);
    expect(rows).toHaveLength(1);
    expect(rows.reduce((s, r) => s + r.amount, 0)).toBe(68000);
  });

  it('R18 / D160：重复确认回复恰为「这笔已经入账了，不用重复确认。」，不含「已入账」', () => {
    const text = ALREADY_SETTLED_REPLY('draft-abc');
    expect(text).toBe('Front Claw：这笔已经入账了，不用重复确认。');
    expect(text).toBe(ALREADY_CONFIRMED_TEXT);
    expect(text).not.toMatch(/已入账/);
  });

  it('R18 / D160：确认入账后紧接着再回一次「对」，只回「已经入账了」，不多记一笔；中间隔了进入店务循环的别的消息就不再这么回', async () => {
    const w = await worldM05();
    expect(await w.call('m-zhao', '周老师：680（小赵）')).toContain('还没入账');
    expect(await w.call('m-zhao', '对')).toContain('已入账');
    const again = await w.call('m-zhao', '对');
    expect(again).toBe(ALREADY_CONFIRMED_TEXT);
    expect(again).not.toContain('已入账');
    const rows = (await w.base.listEntries({ status: 'confirmed' })).filter(r => r.customerName === '周老师');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.amount).toBe(68000);
    // 进入店务循环的任何别的消息（这里用「取消」）都会清掉标记；之后再回「对」按没有待确认草稿处理。
    await w.call('m-zhao', '取消');
    expect(await w.call('m-zhao', '对')).not.toBe(ALREADY_CONFIRMED_TEXT);
  });
});
