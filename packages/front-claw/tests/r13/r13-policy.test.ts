/**
 * R13 D139：默认政策 C。自编句子，不取留出集原句。
 * 非名字（时段/泛称/量词/泛指）追问、不执行；已种历史客户直接出草稿。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { setCustomerNamePolicyModeForTest } from '../../src/role-eval/customer-name-policy.js';
import { worldM05 } from '../role-eval/appointment-fixture-m05.js';
import { seedProductNamedCustomers, seedHistoricalCustomers } from './historical-seed.js';

afterEach(() => setCustomerNamePolicyModeForTest(null));

const NON_NAME = ['今早 680', '上午 680', '全天 680', '本旬 680', '每人 680', '大家 680', '各位 680', '一位 680', '两个 680', '我本人 680', '咱们 680'];

describe('D139-C 非名字词追问、不出草稿、零写入', () => {
  it('时段、泛称、量词、泛指人称：追问或不执行，没有「还没入账」，账本不变', async () => {
    const w = await worldM05();
    const before = JSON.stringify(await w.snapshot());
    for (const t of NON_NAME) {
      const r = await w.call('m-zhao', t);
      expect(r, t).not.toMatch(/还没入账/);
      expect(r, t).not.toMatch(/操作号/);
      expect(r, t).toMatch(/需要确认|没有写入|没太明白|是新客户|没法当成客户名|权限|不能做/);
      if (/还没入账|还没登记|还没改/.test(r)) await w.call('m-zhao', '取消').catch(() => {});
    }
    expect(JSON.stringify(await w.snapshot())).toBe(before);
  });
});

describe('D139-C 本店已知客户直接出草稿', () => {
  it('种过的苏晓禾、小雪、阿玲、李小雪、欧阳娜娜不带括号直接出草稿，记给报单人，并单独一行「客户：X」', async () => {
    const w = await worldM05();
    await seedProductNamedCustomers(w.base);
    const cases: [string, string, string][] = [
      ['苏晓禾：680', '苏晓禾', '680'],
      ['小雪：1280', '小雪', '1280'],
      ['阿玲 980', '阿玲', '980'],
      ['李小雪：680', '李小雪', '680'],
      ['欧阳娜娜 1500', '欧阳娜娜', '1500'],
    ];
    for (const [t, name, amt] of cases) {
      const r = await w.call('m-zhao', t);
      expect(r, t).toMatch(/还没入账/);
      expect(r, t).toMatch(new RegExp(`客户：${name}`));
      expect(r, t).toMatch(/小赵/);
      expect(r, t).toMatch(new RegExp(amt));
      // 「客户：X」单独一行，前后都是换行或开头
      expect(r, t).toMatch(new RegExp(`\\n客户：${name}\\n`));
      await w.call('m-zhao', '取消');
    }
  });

  it('姓＋称谓「周老师 680」不需要名单，直接出草稿并显示客户行', async () => {
    const w = await worldM05();
    const r = await w.call('m-zhao', '周老师 680');
    expect(r).toMatch(/还没入账/);
    expect(r).toMatch(/\n客户：周老师\n/);
    expect(r).toMatch(/小赵 680元/);
    await w.call('m-zhao', '取消');
  });

  it('带括号未知全名也只问新客户，回是后才出草稿', async () => {
    const w = await worldM05();
    const r = await w.call('m-zhao', '苏晓禾：680（小赵）');
    // D165：员工位对上不能跳过 D139 第三档。
    expect(r).toBe('Front Claw：是新客户「苏晓禾」吗？');
    expect(await w.base.listDrafts({ status: 'pending' })).toHaveLength(0);
    expect(await w.call('m-zhao', '是')).toMatch(/还没入账/);
    await w.call('m-zhao', '取消');
  });

  it('预约里出现过的名字，不带括号直接出草稿', async () => {
    const w = await worldM05();
    const ask = await w.call('m-zhao', '预约明天下午3点护理');
    expect(ask).toMatch(/哪位客人/);
    const staged = await w.call('m-zhao', '孙丽');
    expect(staged).toMatch(/预约还没登记|还没登记/);
    expect(staged).toMatch(/孙丽/);
    expect(await w.call('m-zhao', '对')).toMatch(/预约已登记/);
    const r = await w.call('m-zhao', '孙丽：680');
    expect(r).toMatch(/还没入账/);
    expect(r).toMatch(/\n客户：孙丽\n/);
    expect(r).not.toMatch(/是新客户/);
    await w.call('m-zhao', '取消');
  });
});

describe('D131 / D137 不回退', () => {
  it('D131：已确认「李小雪」后再发不带括号的「李小雪：880」进二选一', async () => {
    const w = await worldM05();
    const first = await w.call('m-zhao', '李小雪：680（小赵）');
    // D165/D139：括号未知客户也先确认名字，再确认入账。
    expect(first).toContain('是新客户');
    expect(await w.call('m-zhao', '是')).toMatch(/还没入账/);
    expect(await w.call('m-zhao', '对')).toMatch(/已入账/);
    const beforeEntries = JSON.stringify((await w.snapshot()).entries);
    const again = await w.call('m-zhao', '李小雪：880');
    expect(again).toMatch(/今天已经有|已有/);
    expect(again).toMatch(/李小雪/);
    expect(again).not.toMatch(/还没入账，回「对」/);
    expect(JSON.stringify((await w.snapshot()).entries)).toBe(beforeEntries);
  });

  it('D137：「苏晓禾680算我的」记给小赵；「苏晓禾680报小王的」记给小王（已种历史名）', async () => {
    const w = await worldM05();
    await seedProductNamedCustomers(w.base);
    const a = await w.call('m-zhao', '苏晓禾680算我的');
    expect(a).toMatch(/还没入账/);
    expect(a).toMatch(/小赵/);
    expect(a).toMatch(/680/);
    expect(a).toMatch(/\n客户：苏晓禾\n/);
    await w.call('m-zhao', '取消');
    const b = await w.call('m-zhao', '苏晓禾680报小王的');
    expect(b).toMatch(/还没入账/);
    expect(b).toMatch(/小王|代报/);
    expect(b).toMatch(/680/);
    await w.call('m-zhao', '取消');
  });

  it('上一营业日标准行种子不会触发今天的 D131：种过李小雪后今天首报直接出草稿', async () => {
    const w = await worldM05();
    const owner = (await w.base.listPeople()).find(p => p.memberId === 'm-zhao')!;
    await seedHistoricalCustomers(w.base, { storeId: owner.storeId, owner, names: ['李小雪'] });
    const r = await w.call('m-zhao', '李小雪：680');
    expect(r).toMatch(/还没入账/);
    expect(r).not.toMatch(/今天已经有|已有记录/);
    expect(r).toMatch(/\n客户：李小雪\n/);
    await w.call('m-zhao', '取消');
  });
});
