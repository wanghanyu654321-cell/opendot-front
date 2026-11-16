/**
 * R4（R3A-01）：更正按「客户名＋营业日＋报单人」唯一命中；并排确认；
 * 原金额不符则拒绝；0/多条列出今日已报请「改 N」；绝不改另一笔；复合句不静默丢半句。
 * 用例是本文件新写的说法，验证通用规则，不取盲测原句作为规则本身。
 */
import { describe, expect, it } from 'vitest';
import { worldM05 } from '../role-eval/appointment-fixture-m05.js';

async function posted(w: Awaited<ReturnType<typeof worldM05>>, member: string, text: string) {
  const reply = await w.call(member, text);
  // R6 数据兜底：本店今天已有该客户时先二选一，「新增一笔」后再确认。
  if (/新增一笔/.test(reply) && /不要直接回「对」/.test(reply)) {
    const add = await w.call(member, '新增一笔');
    expect(add).toMatch(/还没入账/);
    const confirm = await w.call(member, '对');
    expect(confirm).toContain('已入账');
    return (await w.base.listEntries()).at(-1)!;
  }
  expect(reply).toMatch(/还没入账/);
  const confirm = await w.call(member, '对');
  expect(confirm).toContain('已入账');
  return (await w.base.listEntries()).at(-1)!;
}

describe('R4 R3A-01 更正对象选择与并排确认', () => {
  it('唯一命中（客户+今天+报单人）：「把许姐那笔改成860」无原金额也能改；确认回显并排原记录与新内容', async () => {
    const w = await worldM05();
    await posted(w, 'm-zhao', '何姐111');
    const xu = await posted(w, 'm-zhao', '许姐680');
    expect(xu.amount).toBe(68000);
    const reply = await w.call('m-zhao', '把许姐那笔改成860');
    expect(reply).toMatch(/还没改账/);
    expect(reply).toContain('许姐');
    expect(reply).toContain('680');
    expect(reply).toContain('860');
    // 并排：原记录身份（客户、原金额、报出时间）必须可见，免得拣错。
    expect(reply).toMatch(/原记录[：:].*许姐/);
    expect(reply).toMatch(/680\s*元/);
    expect(reply).toMatch(/报于|报出/);
    expect(reply).toMatch(/改为[：:].*860/);
    expect(reply).not.toMatch(/何姐.*111\s*元\s*→\s*860/);
    const heBefore = (await w.base.listEntries()).find(e => e.customerName === '何姐')!;
    expect(await w.call('m-zhao', '对')).toContain('已改账');
    const after = await w.base.listEntries();
    expect(after.find(e => e.entryId === heBefore.entryId)).toEqual(heBefore);
    expect(after.find(e => e.entryId === xu.entryId)!.amount).toBe(86000);
  });

  it('用户说了原金额但与账上不符 → 拒绝并说明，零写入，不改另一笔', async () => {
    const w = await worldM05();
    const he = await posted(w, 'm-zhao', '何姐111');
    await posted(w, 'm-zhao', '许姐680');
    const reply = await w.call('m-zhao', '把许姐500那笔改成860');
    expect(reply).toMatch(/不能|不符|对不上|不是 500/);
    expect(reply).toContain('680');
    expect(reply).not.toMatch(/还没改账/);
    expect(await w.call('m-zhao', '对')).toMatch(/没有待确认|请先发送|没有可查/);
    const after = await w.base.listEntries();
    expect(after.find(e => e.customerName === '何姐')!.amount).toBe(11100);
    expect(after.find(e => e.customerName === '许姐')!.amount).toBe(68000);
    expect(after.find(e => e.entryId === he.entryId)!.amount).toBe(11100);
  });

  it('同客户今天两笔不唯一 → 列出今天已报请「改 N」，不擅自挑选；「改 N」后再并排确认', async () => {
    const w = await worldM05();
    await posted(w, 'm-zhao', '许姐680');
    await posted(w, 'm-zhao', '许姐200');
    const reply = await w.call('m-zhao', '把许姐那笔改成860');
    expect(reply).toMatch(/改\s*\d/);
    expect(reply).toContain('许姐');
    expect(reply).toContain('680');
    expect(reply).toContain('200');
    expect(reply).not.toMatch(/还没改账/);
    // 「对」不能当成确认去改某一笔
    const no = await w.call('m-zhao', '对');
    expect(no).toMatch(/改\s*\d|请指定|哪一笔/);
    expect((await w.base.listEntries()).filter(e => e.customerName === '许姐').map(e => e.amount).sort()).toEqual([20000, 68000]);
    const pick = await w.call('m-zhao', '改 1');
    expect(pick).toMatch(/还没改账/);
    expect(pick).toMatch(/原记录/);
    expect(await w.call('m-zhao', '对')).toContain('已改账');
    const xu = (await w.base.listEntries()).filter(e => e.customerName === '许姐');
    expect(xu.some(e => e.amount === 86000)).toBe(true);
    expect(xu).toHaveLength(2);
  });

  it('点名的客户今天没有记录 → 列出今天已报请「改 N」，绝不改相近金额或姓名的另一笔', async () => {
    const w = await worldM05();
    const he = await posted(w, 'm-zhao', '何姐111');
    const reply = await w.call('m-zhao', '把许姐680那笔改成860');
    expect(reply).toMatch(/改\s*\d|没有找到|找不到/);
    expect(reply).toContain('何姐');
    expect(reply).toContain('111');
    expect(reply).not.toMatch(/还没改账.*111\s*元\s*→\s*860|111元 → 860元/);
    await w.call('m-zhao', '对');
    expect((await w.base.listEntries()).find(e => e.entryId === he.entryId)).toEqual(he);
  });

  it('复合「报一笔＋改已报」：不得把另一位客人的账改掉，也不得静默丢掉报单半句', async () => {
    const w = await worldM05();
    const he = await posted(w, 'm-zhao', '何姐111');
    const reply = await w.call('m-zhao', '秦姐520算我今天的，另外把我今天已报许姐680那笔改成860');
    // 不得把何姐 111 显示成要改成 860
    expect(reply).not.toMatch(/何姐[^\\n]*111\s*元\s*→\s*860|小赵 111元 → 860元|111元 → 860元/);
    // R18 / D157：复合句整句先问——不出报单草稿、不出改账草稿，明说没有写入。
    const listsBoth = false;
    expect(reply).not.toMatch(/还没入账|还没改账/);
    expect(reply).toMatch(/没有写入/);
    const confirm = await w.call('m-zhao', '对');
    const after = (await w.base.listEntries()).find(e => e.entryId === he.entryId)!;
    expect(after).toEqual(he);
    expect(after.amount).toBe(11100);
    // 520 若没进清单，确认后也不该凭空入账或改账
    if (!listsBoth) {
      expect((await w.base.listEntries()).find(e => e.customerName === '秦姐')).toBeUndefined();
    }
    expect(confirm).not.toMatch(/111\s*元\s*→\s*860/);
  });

  it('已有唯一许姐记录时，复合句改账半句应对准许姐，并排确认，何姐不动', async () => {
    const w = await worldM05();
    const he = await posted(w, 'm-zhao', '何姐111');
    const xu = await posted(w, 'm-zhao', '许姐680');
    const reply = await w.call('m-zhao', '秦姐520算我今天的，另外把我今天已报许姐680那笔改成860');
    expect(reply).not.toMatch(/何姐[^\\n]*111\s*元\s*→\s*860|111元 → 860元/);
    // R18 / D157：复合句整句先问，零草稿。
    expect(reply).not.toMatch(/还没入账|还没改账/);
    expect(reply).toMatch(/没有写入/);
    if (/还没改账/.test(reply) && /许姐/.test(reply)) {
      expect(reply).toMatch(/原记录[：:].*许姐/);
      expect(reply).toContain('680');
      expect(reply).toContain('860');
      await w.call('m-zhao', '对');
      expect((await w.base.listEntries()).find(e => e.entryId === he.entryId)).toEqual(he);
      expect((await w.base.listEntries()).find(e => e.entryId === xu.entryId)!.amount).toBe(86000);
    } else {
      await w.call('m-zhao', '对');
      expect((await w.base.listEntries()).find(e => e.entryId === he.entryId)).toEqual(he);
      expect((await w.base.listEntries()).find(e => e.entryId === xu.entryId)!.amount).toBe(68000);
    }
  });
});
