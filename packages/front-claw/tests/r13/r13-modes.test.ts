/**
 * R13 D140：A/B/C 可切换。默认 C。自编句子。
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  decideOpenedCustomerName,
  getCustomerNamePolicyMode,
  matchesPositiveNameFormat,
  setCustomerNamePolicyModeForTest,
  customerNamePolicyConfig,
} from '../../src/role-eval/customer-name-policy.js';
import { worldM05 } from '../role-eval/appointment-fixture-m05.js';
import { seedProductNamedCustomers } from './historical-seed.js';

afterEach(() => setCustomerNamePolicyModeForTest(null));

describe('D140 配置与正向格式（B）', () => {
  it('默认模式是 C；切换只改 mode', () => {
    expect(getCustomerNamePolicyMode()).toBe('C');
    const cfg = customerNamePolicyConfig();
    expect(cfg.source).toMatch(/百家姓/);
    expect(cfg.singles.has('王')).toBe(true);
    expect(cfg.singles.has('李')).toBe(true);
    expect(cfg.compounds).toContain('欧阳');
    expect(cfg.conflictWords.has('周末')).toBe(true);
    expect(cfg.conflictWords.has('全天')).toBe(true);
    setCustomerNamePolicyModeForTest('A');
    expect(getCustomerNamePolicyMode()).toBe('A');
  });

  it('B 正向格式：百家姓＋1–2 字，或小/阿/老＋1；冲突表排除', () => {
    expect(matchesPositiveNameFormat('苏晓禾')).toBe(true);
    expect(matchesPositiveNameFormat('李小雪')).toBe(true);
    expect(matchesPositiveNameFormat('欧阳娜娜')).toBe(true);
    expect(matchesPositiveNameFormat('小雪')).toBe(true);
    expect(matchesPositiveNameFormat('阿玲')).toBe(true);
    expect(matchesPositiveNameFormat('老张')).toBe(true);
    expect(matchesPositiveNameFormat('周末')).toBe(false);
    expect(matchesPositiveNameFormat('周六')).toBe(false);
    expect(matchesPositiveNameFormat('全天')).toBe(false);
    expect(matchesPositiveNameFormat('上午')).toBe(false);
    expect(matchesPositiveNameFormat('大家')).toBe(false);
    expect(matchesPositiveNameFormat('雪儿')).toBe(false);
  });

  it('decide：A 对已知名也问；B 格式通过则 allow；C 看名单', () => {
    expect(decideOpenedCustomerName('苏晓禾', { known: true, mode: 'A' })).toBe('ask-new');
    expect(decideOpenedCustomerName('苏晓禾', { known: false, mode: 'B' })).toBe('allow');
    expect(decideOpenedCustomerName('周末', { known: false, mode: 'B' })).toBe('ask-new');
    expect(decideOpenedCustomerName('苏晓禾', { known: true, mode: 'C' })).toBe('allow');
    expect(decideOpenedCustomerName('赵美丽', { known: false, mode: 'C' })).toBe('ask-new');
    expect(decideOpenedCustomerName('今早', { known: false, mode: 'C' })).toBe('deny');
  });
});

describe('D140 三种模式端到端', () => {
  it('A：即便已种「苏晓禾」，不带括号也只问是新客户，不附草稿', async () => {
    setCustomerNamePolicyModeForTest('A');
    const w = await worldM05();
    await seedProductNamedCustomers(w.base);
    const r = await w.call('m-zhao', '苏晓禾：680');
    expect(r).toBe('Front Claw：是新客户「苏晓禾」吗？');
    expect(r).not.toMatch(/还没入账/);
    const yes = await w.call('m-zhao', '是');
    expect(yes).toMatch(/还没入账/);
    expect(yes).toMatch(/\n客户：苏晓禾\n/);
    await w.call('m-zhao', '取消');
  });

  it('B：未种的「苏晓禾：680」因正向格式直接出草稿；「周末 680」追问不出草稿', async () => {
    setCustomerNamePolicyModeForTest('B');
    const w = await worldM05();
    const a = await w.call('m-zhao', '苏晓禾：680');
    expect(a).toMatch(/还没入账/);
    expect(a).toMatch(/\n客户：苏晓禾\n/);
    expect(a).not.toMatch(/是新客户/);
    await w.call('m-zhao', '取消');
    const before = JSON.stringify(await w.snapshot());
    const b = await w.call('m-zhao', '周末 680');
    expect(b).not.toMatch(/还没入账/);
    expect(b).toMatch(/是新客户「周末」吗？|没法当成客户名|没太明白|没有写入/);
    expect(JSON.stringify(await w.snapshot())).toBe(before);
  });

  it('C：未种的「苏晓禾」要先问；种过的直接出草稿', async () => {
    setCustomerNamePolicyModeForTest('C');
    const w = await worldM05();
    const ask = await w.call('m-zhao', '苏晓禾：680');
    expect(ask).toBe('Front Claw：是新客户「苏晓禾」吗？');
    await w.call('m-zhao', '不是');
    const w2 = await worldM05();
    await seedProductNamedCustomers(w2.base);
    const draft = await w2.call('m-zhao', '苏晓禾：680');
    expect(draft).toMatch(/还没入账/);
    expect(draft).not.toMatch(/是新客户/);
    await w2.call('m-zhao', '取消');
  });
});
