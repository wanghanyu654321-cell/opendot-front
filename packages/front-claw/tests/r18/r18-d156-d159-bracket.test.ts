/** R18 / D156（括号以本店员工为准，BRACKET_NOT_NAME 只做粗筛、进 config 冻结）、D159（括号里的「姓＋店长」）。句子均为自编。 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { worldM05 } from '../role-eval/appointment-fixture-m05.js';
import { basePeople } from '../role-eval/access-fixture-m03.js';
import { BRACKET_NOT_NAME, BRACKET_NOT_NAME_WORDS, isBracketNotName } from '../../src/role-eval/confirmable-draft-gate.js';

describe('R18 / D156 粗筛表在 config、冻结', () => {
  it('词表来自 config/bracket-not-name.json，代码里不再有字面量词表', () => {
    const cfg = JSON.parse(readFileSync(resolve(__dirname, '../../config/bracket-not-name.json'), 'utf8'));
    expect(cfg.frozen).toBe(true);
    expect(BRACKET_NOT_NAME_WORDS).toEqual(cfg.words);
    expect(cfg.words).toHaveLength(19);
    for (const w of cfg.words) expect(BRACKET_NOT_NAME.test(w), w).toBe(true);
    const src = readFileSync(resolve(__dirname, '../../src/role-eval/confirmable-draft-gate.ts'), 'utf8');
    expect(src).not.toMatch(/BRACKET_NOT_NAME\s*=\s*\/店长/);
    expect(isBracketNotName('夜班')).toBe(false); // 不在粗筛表：交给正向员工校验
  });
  it('括号里像人名但不是本店员工 → 仍按跨店/查无此人拒绝（语义不弱化），零写入', async () => {
    const w = await worldM05();
    const before = JSON.stringify(await w.snapshot());
    const r = await w.call('m-zhao', '甄姐：410（老周）');
    expect(r).not.toMatch(/还没入账/);
    expect(r).toMatch(/跨店|不符合|不能/);
    expect(JSON.stringify(await w.snapshot())).toBe(before);
  });
  it('括号里是粗筛表外的非名字词 → 正向校验对不上本店员工，不出草稿', async () => {
    const w = await worldM05();
    const r = await w.call('m-zhao', '甄姐：410（夜班）');
    expect(r).not.toMatch(/还没入账/);
  });
});

describe('R18 / D159 括号里的店长', () => {
  it('「姓＋店长」在本店唯一对上 → 记给该店长', async () => {
    const w = await worldM05();
    const r = await w.call('m-zhao', '甄姐：410（苏店长）');
    expect(r).toMatch(/还没入账/);
    expect(r).toContain('苏晓禾 410元');
  });
  it('「姓＋店长」对不上本店店长 → 先问，零草稿（不按跨店拒）', async () => {
    const w = await worldM05();
    const r = await w.call('m-zhao', '甄姐：410（李店长）');
    expect(r).not.toMatch(/还没入账/);
    expect(r).not.toMatch(/跨店/);
    expect((await w.base.listDrafts({ status: 'pending' })).length).toBe(0);
  });
  it('「姓＋店长」对上不止一个 → 先问', async () => {
    const extra = { ...basePeople.find(p => p.personId === 'p-wang-yj')!, personId: 'p-wang-2', accountId: 'a-wang-2', memberId: 'm-wang-2', displayName: '苏静然' };
    const w = await worldM05({ people: [...basePeople, extra] });
    const r = await w.call('m-zhao', '甄姐：410（苏店长）');
    expect(r).not.toMatch(/还没入账/);
    expect((await w.base.listDrafts({ status: 'pending' })).length).toBe(0);
  });
  it('他店店长不算（只在本店店长里找）→ 先问', async () => {
    const w = await worldM05();
    const r = await w.call('m-zhao', '甄姐：410（周店长）');
    expect(r).not.toMatch(/还没入账/);
  });
  it('「老板」不算员工位 → 先问', async () => {
    const w = await worldM05();
    const r = await w.call('m-zhao', '甄姐：410（老板）');
    expect(r).not.toMatch(/还没入账/);
    expect(r).not.toMatch(/跨店/);
  });
});
