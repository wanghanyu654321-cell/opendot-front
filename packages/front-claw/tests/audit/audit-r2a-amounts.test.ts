import { expect, it } from 'vitest';
import { worldM04 } from '../role-eval/ledger-fixture-m04.js';

// R5：金额是整数分。12.5 元、1.2345k、200 万、1000001 在撤掉 D80/D84 后合法（技术上界之内）。
const cases: [string, number[]][] = [
  ['张姐1.25k（小王）', [125000]], ['张姐0.5w（小王）', [500000]],
  ['张姐1.2k（小王）', [120000]], ['张姐２６８０元（小王）', [268000]],
  ['张姐12.5 元（小王）', [1250]], ['张姐1.234k（小王）', [123400]],
  ['张姐1.2345k（小王）', [123450]], ['张姐0（小王）', []], ['张姐-680（小王）', []],
  ['张姐200万（小王）', [200_000_000]], // 200万 = 2,000,000 元 = 200,000,000 分
  ['张姐100万（小王）', [100_000_000]],
  ['张姐1000001（小王）', [100000100]], ['张姐999999（小王）', [99999900]],
  ['张姐300（小王）；李姐500（小赵）', [30000, 50000]],
];
for (const [text, amounts] of cases) it(`AUDIT 金额入口 ${text}`, async () => {
  const w = await worldM04(); const before = await w.snapshot();
  const reply = await w.call('m-zhao', text); const after = await w.snapshot();
  const fresh = after.drafts.filter(d => !before.drafts.some(x => x.draftId === d.draftId));
  console.info(JSON.stringify({ text, reply, payload: fresh.map(d => d.payload) }));
  expect(after.entries).toEqual(before.entries);
  if (!amounts.length) { expect(fresh).toHaveLength(0); expect(reply).toContain('没有写入'); }
  else {
    expect(fresh).toHaveLength(1); expect(reply).toContain('还没入账');
    expect(await w.call('m-zhao', '对')).toContain('已入账');
    const final = await w.snapshot();
    expect(final.entries.filter(e => !before.entries.some(x => x.entryId === e.entryId)).map(e => e.amount).sort((a,b)=>a-b)).toEqual([...amounts].sort((a,b)=>a-b));
  }
});
