/**
 * R13 D139 修订第 3 档 + 补充：未知名字只问「是新客户「X」吗？」，不附草稿。
 * 回「是」才出草稿；回「对」确认入账后，名字才从本店已确认账本算已知。
 * 只回「是」、草稿取消/作废/超时，名字都不进名单。自编句子。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { setCustomerNamePolicyModeForTest } from '../../src/role-eval/customer-name-policy.js';
import { collectKnownCustomerNames } from '../../src/role-eval/store-customer-roster.js';
import { worldM05 } from '../role-eval/appointment-fixture-m05.js';
import { NOW } from '../role-eval/access-fixture-m03.js';
import { seedHistoricalCustomers } from './historical-seed.js';

afterEach(() => setCustomerNamePolicyModeForTest(null));

describe('D139 新客户首报只问一句，不附草稿', () => {
  it('未知「赵美丽：680」只回「是新客户「赵美丽」吗？」，没有还没入账、没有操作号、零草稿', async () => {
    const w = await worldM05();
    const before = JSON.stringify(await w.snapshot());
    const r = await w.call('m-zhao', '赵美丽：680');
    expect(r).toBe('Front Claw：是新客户「赵美丽」吗？');
    expect(r).not.toMatch(/还没入账|操作号|回复「对」/);
    const snap = await w.snapshot();
    expect(JSON.stringify(snap)).toBe(before);
    expect(snap.drafts.filter(d => d.status === 'pending')).toHaveLength(0);
  });

  it('回「是」才出带「客户：赵美丽」的草稿；此时名字还不算已知', async () => {
    const w = await worldM05();
    expect(await w.call('m-zhao', '赵美丽：680')).toBe('Front Claw：是新客户「赵美丽」吗？');
    const draft = await w.call('m-zhao', '是');
    expect(draft).toMatch(/还没入账/);
    expect(draft).toMatch(/\n客户：赵美丽\n/);
    expect(draft).toMatch(/小赵 680元/);
    expect(draft).toMatch(/回复「对」/);
    const known = await collectKnownCustomerNames(w.base, 's-b');
    expect(known.has('赵美丽')).toBe(false);
  });

  it('回「是」之后不回「对」（取消草稿），再报同一个名字要再问一次', async () => {
    const w = await worldM05();
    expect(await w.call('m-zhao', '钱多多：500')).toBe('Front Claw：是新客户「钱多多」吗？');
    expect(await w.call('m-zhao', '是')).toMatch(/还没入账/);
    expect(await w.call('m-zhao', '取消')).toMatch(/已取消|没有入账/);
    const known = await collectKnownCustomerNames(w.base, 's-b');
    expect(known.has('钱多多')).toBe(false);
    const again = await w.call('m-zhao', '钱多多：500');
    expect(again).toBe('Front Claw：是新客户「钱多多」吗？');
    expect(again).not.toMatch(/还没入账/);
  });

  // D172（20:08 补充）：回「对」现算肯定且只出草稿；否定撤销，其余按新消息处理。
  // 肯定状态矩阵在 tests/r19/r19-state-and-gate.test.ts 覆盖。
  it('对新客户追问回否定或无关答复：不出草稿、不入账、不进名单', async () => {
    for (const ans of ['不是', '好的', '嗯']) {
      const w = await worldM05();
      const before = JSON.stringify(await w.snapshot());
      expect(await w.call('m-zhao', '周雅琴：300')).toBe('Front Claw：是新客户「周雅琴」吗？');
      const r = await w.call('m-zhao', ans);
      expect(r, ans).toMatch(/没有记|没有写入/); // D172：否定固定回复为「好的，这条没有记。」
      expect(r, ans).not.toMatch(/还没入账/);
      expect(JSON.stringify(await w.snapshot()), ans).toBe(before);
      expect((await collectKnownCustomerNames(w.base, 's-b')).has('周雅琴')).toBe(false);
    }
  });

  it('回「是的」也算出草稿，取消后名字仍未知', async () => {
    const w = await worldM05();
    await w.call('m-zhao', '林晓晓：220');
    const r = await w.call('m-zhao', '是的');
    expect(r).toMatch(/还没入账/);
    expect(r).toMatch(/\n客户：林晓晓\n/);
    await w.call('m-zhao', '取消');
    expect((await collectKnownCustomerNames(w.base, 's-b')).has('林晓晓')).toBe(false);
  });
});

describe('D139 补充：名字只在确认入账后进本店名单', () => {
  it('回「是」、回「对」入账之后，隔日再报同一个名字直接出草稿（不再问是新客户）', async () => {
    let t = NOW.getTime();
    const w = await worldM05({ now: () => new Date(t += 1000) });
    expect(await w.call('m-zhao', '赵美丽：680')).toBe('Front Claw：是新客户「赵美丽」吗？');
    expect(await w.call('m-zhao', '是')).toMatch(/还没入账/);
    expect(await w.call('m-zhao', '对')).toMatch(/已入账/);
    const booked = (await w.snapshot()).entries.filter(e => e.businessDay === '2026-11-12' && e.customerName === '赵美丽' && e.status === 'confirmed');
    expect(booked).toHaveLength(1);
    expect((await collectKnownCustomerNames(w.base, 's-b')).has('赵美丽')).toBe(true);
    // 隔日：上一营业日已确认，D131 只看「今天」已确认，不触发二选一，直接出普通报单草稿。
    t = NOW.getTime() + 24 * 60 * 60 * 1000;
    const again = await w.call('m-zhao', '赵美丽：200');
    expect(again).toMatch(/还没入账/);
    expect(again).toMatch(/\n客户：赵美丽\n/);
    expect(again).toMatch(/小赵 200元/);
    expect(again).not.toMatch(/是新客户/);
    expect(again).not.toMatch(/今天已经有|已有记录/);
    await w.call('m-zhao', '取消');
  });

  it('回「是」、回「对」入账后，同一天再报同名走 D131 二选一，不再问是新客户（D131 口径不变）', async () => {
    const w = await worldM05();
    expect(await w.call('m-zhao', '赵美丽：680')).toBe('Front Claw：是新客户「赵美丽」吗？');
    expect(await w.call('m-zhao', '是')).toMatch(/还没入账/);
    expect(await w.call('m-zhao', '对')).toMatch(/已入账/);
    const again = await w.call('m-zhao', '赵美丽：200');
    expect(again).toMatch(/今天已经有|已有/);
    expect(again).toMatch(/赵美丽/);
    expect(again).not.toMatch(/是新客户/);
    expect(again).not.toMatch(/还没入账，回「对」/);
  });

  it('回「是」、回「对」之后把单作废，名字不再算已知，再报要再问', async () => {
    const w = await worldM05();
    expect(await w.call('m-zhao', '钱多多：500')).toBe('Front Claw：是新客户「钱多多」吗？');
    expect(await w.call('m-zhao', '是')).toMatch(/还没入账/);
    expect(await w.call('m-zhao', '对')).toMatch(/已入账/);
    expect((await collectKnownCustomerNames(w.base, 's-b')).has('钱多多')).toBe(true);
    const withdraw = await w.call('m-zhao', '撤回刚才的报数');
    expect(withdraw).toMatch(/还没撤回|将作废/);
    expect(await w.call('m-zhao', '对')).toMatch(/已撤回|已作废|作废/);
    const after = (await w.snapshot()).entries.filter(e => e.customerName === '钱多多');
    expect(after.every(e => e.status === 'voided')).toBe(true);
    expect((await collectKnownCustomerNames(w.base, 's-b')).has('钱多多')).toBe(false);
    const again = await w.call('m-zhao', '钱多多：500');
    expect(again).toBe('Front Claw：是新客户「钱多多」吗？');
    expect(again).not.toMatch(/还没入账/);
  });

  it('别的店已确认的名字，在本店仍要问', async () => {
    const w = await worldM05();
    const lin = (await w.base.listPeople()).find(p => p.memberId === 'm-lin')!;
    await seedHistoricalCustomers(w.base, { storeId: 's-a', owner: lin, names: ['赵美丽'] });
    expect((await collectKnownCustomerNames(w.base, 's-a')).has('赵美丽')).toBe(true);
    expect((await collectKnownCustomerNames(w.base, 's-b')).has('赵美丽')).toBe(false);
    const r = await w.call('m-zhao', '赵美丽：680');
    expect(r).toBe('Front Claw：是新客户「赵美丽」吗？');
    expect(r).not.toMatch(/还没入账/);
  });
});
