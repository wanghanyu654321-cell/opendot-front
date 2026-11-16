/**
 * R13 R12-02 / D139：所有报单草稿单独一行「客户：X」。自编句子。
 */
import { describe, expect, it } from 'vitest';
import { worldM05 } from '../role-eval/appointment-fixture-m05.js';

describe('报单草稿单独一行显示客户', () => {
  it('「张姐 680（小赵）」草稿含独立行「客户：张姐」再写员工和金额', async () => {
    const w = await worldM05();
    const r = await w.call('m-zhao', '张姐 680（小赵）');
    expect(r).toMatch(/还没入账[^\n]*，2026-11-12：\n客户：张姐\n小赵 680元/);
    await w.call('m-zhao', '取消');
  });

  it('没写客户的「680（小赵）」显示「客户：（未写）」', async () => {
    const w = await worldM05();
    const r = await w.call('m-zhao', '680（小赵）');
    expect(r).toMatch(/还没入账/);
    expect(r).toMatch(/\n客户：（未写）\n小赵 680元/);
    await w.call('m-zhao', '取消');
  });

  it('多笔清单每笔都有自己的客户行', async () => {
    const w = await worldM05();
    const r = await w.call('m-zhao', '张姐 680（小赵）\n李姐 1200（小王）');
    expect(r).toMatch(/客户：张姐\n小赵 680元/);
    expect(r).toMatch(/客户：李姐\n小王 1200元/);
    const idxZhang = r.indexOf('客户：张姐');
    const idxLi = r.indexOf('客户：李姐');
    expect(idxZhang).toBeGreaterThan(0);
    expect(idxLi).toBeGreaterThan(idxZhang);
    await w.call('m-zhao', '取消');
  });
});
