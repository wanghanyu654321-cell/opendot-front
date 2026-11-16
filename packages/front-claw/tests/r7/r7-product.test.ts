/**
 * R7 产品路径：跨员工隐私（D118）、找店长改零写入、二选一自然说法（D121）。自编，不取留出集。
 */
import { describe, expect, it } from 'vitest';
import { worldM05 } from '../role-eval/appointment-fixture-m05.js';
import { ASK_MANAGER_HINT } from '../../src/role-eval/employee-loop.js';
import { parseAddNewChoice, parseAskManagerChoice, parseCorrectionPick } from '../../src/role-eval/ledger-commands.js';
import type { CorrectionPickItem, DraftPayload } from '../../src/role-eval/performance-store.js';

async function post(w: Awaited<ReturnType<typeof worldM05>>, member: string, text: string) {
  const reply = await w.call(member, text);
  expect(reply, text).toMatch(/还没入账/);
  const confirm = await w.call(member, '对');
  expect(confirm).toContain('已入账');
  return (await w.base.listEntries()).at(-1)!;
}

function listedOf(drafts: { payload: DraftPayload; status: string }[]): CorrectionPickItem[] {
  const pending = drafts.filter(d => d.status === 'pending' || d.status === 'confirming');
  for (const d of pending) {
    const p = d.payload as DraftPayload & { awaitingDuplicateChoice?: { listed: CorrectionPickItem[] }; awaitingPick?: { listed: CorrectionPickItem[] } };
    if (p && 'awaitingDuplicateChoice' in p && p.awaitingDuplicateChoice) return p.awaitingDuplicateChoice.listed;
    if (p && 'awaitingPick' in p && p.awaitingPick) return p.awaitingPick.listed;
  }
  return [];
}

function assertNoReporter(items: CorrectionPickItem[], reply: string) {
  for (const row of items) {
    expect(row, JSON.stringify(row)).not.toHaveProperty('reporterPersonId');
    expect('reporterPersonId' in row).toBe(false);
    if (row.visibility === 'peer-redacted') {
      expect(row.amount).toBeUndefined();
      expect(row.ownerName).toBeUndefined();
      expect(row.ownerPersonId).toBeUndefined();
      expect(row.entryId).toBeUndefined();
      expect(row.beforeJson).toBeUndefined();
    }
  }
  expect(JSON.stringify(items)).not.toMatch(/reporterPersonId/);
  // 回复正文也不应带别人的报单人 id
  expect(reply).not.toMatch(/p-wang-yj|p-zhao|reporterPersonId/);
}

describe('R7 D118 跨员工隐私与找店长改', () => {
  it('普通员工看别人已报的单：只告知「别人报的单」，不露金额/归属/报单人；选项是新增或找店长改', async () => {
    const w = await worldM05();
    const existing = await post(w, 'm-wang-yj', '林姐 900');
    expect(existing.amount).toBe(90000);
    const ask = await w.call('m-zhao', '林姐 680');
    expect(ask).toMatch(/这位客户今天已有一笔别人报的单/);
    expect(ask).not.toMatch(/900/);
    expect(ask).not.toMatch(/苏晓禾/);
    expect(ask).not.toMatch(/改 1|改第/);
    expect(ask).toMatch(/新增一笔/);
    expect(ask).toMatch(/找店长改/);
    expect(ask).not.toMatch(/还没入账，回「对」|还没入账，回对/);
    const drafts = await w.base.listDrafts({ status: 'pending' });
    const listed = listedOf(drafts);
    expect(listed.length).toBeGreaterThan(0);
    expect(listed.every(r => r.visibility === 'peer-redacted')).toBe(true);
    assertNoReporter(listed, ask);
    // 完整草稿 JSON 里 listed 项不得出现 reporterPersonId（草稿自身 reporter 是当前员工，另论）
    for (const d of drafts) {
      const p = d.payload as { awaitingDuplicateChoice?: { listed: CorrectionPickItem[] } };
      if (p.awaitingDuplicateChoice) {
        expect(JSON.stringify(p.awaitingDuplicateChoice.listed)).not.toMatch(/reporterPersonId/);
      }
    }
  });

  it('「找店长改」只给提示、零写入；对别人的单回「改 1」也不写', async () => {
    const w = await worldM05();
    await post(w, 'm-wang-yj', '林姐 900');
    const ask = await w.call('m-zhao', '林姐 680');
    expect(ask).toMatch(/找店长改/);
    const before = JSON.stringify(await w.snapshot());
    const hint = await w.call('m-zhao', '找店长改');
    expect(hint).toBe(ASK_MANAGER_HINT);
    expect(hint).toMatch(/没有写入|不会改账/);
    const mid = JSON.stringify(await w.snapshot());
    expect(JSON.parse(mid).entries).toEqual(JSON.parse(before).entries);
    // 重新触发二选一再试「改 1」
    const w2 = await worldM05();
    const first2 = await post(w2, 'm-wang-yj', '林姐 900');
    await w2.call('m-zhao', '林姐 680');
    const denied = await w2.call('m-zhao', '改 1');
    expect(denied).toMatch(/那笔是别人报的|找店长|没有权限|不能改|不允许这项操作/);
    expect(denied).toMatch(/没有写入|没有权限|不允许/);
    const live = (await w2.base.listEntries()).filter(e => e.customerName === '林姐' && e.status === 'confirmed');
    expect(live).toHaveLength(1);
    expect(live[0]!.entryId).toBe(first2.entryId);
    expect(live[0]!.amount).toBe(90000);
  });

  // R18 / D155：原用自然句「林姐其实是880」触发二选一；自然句现归模型路径离线先问，改用纯标准行再报同一客户触发 D131。
  it('自己的单仍可「改第 N 笔」；可见数据不含 reporterPersonId；店长能看见并改本店别人的单', async () => {
    const w = await worldM05();
    await post(w, 'm-zhao', '林姐 680');
    const ask = await w.call('m-zhao', '林姐 880');
    expect(ask).toMatch(/改 1|本店今天已有记录/);
    expect(ask).toMatch(/680/);
    const listed = listedOf(await w.base.listDrafts({ status: 'pending' }));
    const own = listed.filter(r => r.visibility === 'own');
    expect(own.length).toBeGreaterThan(0);
    assertNoReporter(own, ask);
    const preview = await w.call('m-zhao', '改 1');
    expect(preview).toMatch(/880|还没改|改账/);
    expect(await w.call('m-zhao', '对')).toMatch(/已改|已更正|改账已/);
    const rows = (await w.base.listEntries()).filter(e => e.customerName === '林姐' && e.status === 'confirmed');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.amount).toBe(88000);

    const w2 = await worldM05();
    await post(w2, 'm-zhao', '林姐 680');
    const mgrAsk = await w2.call('m-wang-yj', '林姐 900（小赵）');
    expect(mgrAsk).toMatch(/改 1|本店今天已有记录/);
    expect(mgrAsk).toMatch(/680/);
    const mgrListed = listedOf(await w2.base.listDrafts({ status: 'pending' }));
    const full = mgrListed.filter(r => r.visibility === 'manager-full' || r.visibility === 'own');
    expect(full.some(r => r.amount === 68000)).toBe(true);
    // 店长可见项可以带 reporterPersonId（本店全量）
    expect(full.some(r => r.reporterPersonId === 'p-zhao' || r.visibility === 'own')).toBe(true);
    const next = await w2.call('m-wang-yj', '改 1');
    expect(next).toMatch(/900|还没改|改账/);
    expect(await w2.call('m-wang-yj', '对')).toMatch(/已改|已更正|改账已/);
    const after = (await w2.base.listEntries()).filter(e => e.customerName === '林姐' && e.status === 'confirmed');
    expect(after).toHaveLength(1);
    expect(after[0]!.amount).toBe(90000);
  });

  it('混合：自己的一笔可见、别人的一笔只计数不露金额', async () => {
    const w = await worldM05();
    await post(w, 'm-zhao', '林姐 680');
    const mgr = await w.call('m-wang-yj', '林姐 900（苏晓禾）');
    expect(mgr).toMatch(/新增一笔/);
    expect(await w.call('m-wang-yj', '新增一笔')).toMatch(/还没入账/);
    expect(await w.call('m-wang-yj', '对')).toContain('已入账');
    const ask = await w.call('m-zhao', '林姐 700');
    expect(ask).toMatch(/另有 1 笔别人报的单|别人报的单/);
    expect(ask).toMatch(/680/);
    expect(ask).not.toMatch(/900/);
    expect(ask).toMatch(/找店长改/);
    const listed = listedOf(await w.base.listDrafts({ status: 'pending' }));
    const peers = listed.filter(r => r.visibility === 'peer-redacted');
    const owns = listed.filter(r => r.visibility === 'own');
    expect(peers.length).toBeGreaterThan(0);
    expect(owns.length).toBeGreaterThan(0);
    assertNoReporter(listed, ask);
    expect(owns[0]!.amount).toBe(68000);
  });
});

describe('R7 D121 二选一自然说法放宽', () => {
  it('解析层认「新加的」「是另一单」「第二个」「改刚才那笔」', () => {
    expect(parseAddNewChoice('新加的')).toBe(true);
    expect(parseAddNewChoice('是另一单')).toBe(true);
    expect(parseAddNewChoice('另外一单')).toBe(true);
    expect(parseAddNewChoice('再来一笔')).toBe(true);
    expect(parseAddNewChoice('随便写写')).toBe(false);
    expect(parseAskManagerChoice('找店长改')).toBe(true);
    expect(parseAskManagerChoice('请店长改')).toBe(true);
    expect(parseAskManagerChoice('改 1')).toBe(false);
    expect(parseCorrectionPick('第二个')).toEqual({ index: 2 });
    expect(parseCorrectionPick('改第二笔')).toEqual({ index: 2 });
    expect(parseCorrectionPick('改刚才那笔', 3)).toEqual({ index: 3 });
    expect(parseCorrectionPick('刚才那笔', 2)).toEqual({ index: 2 });
    expect(parseCorrectionPick('改刚才那笔')).toEqual({ index: 1 });
  });

  it('端到端：自然说法能完成新增或改账选择', async () => {
    const w = await worldM05();
    await post(w, 'm-zhao', '林姐 680');
    const ask = await w.call('m-zhao', '林姐 700');
    expect(ask).toMatch(/新增一笔/);
    const next = await w.call('m-zhao', '新加的');
    expect(next).toMatch(/还没入账/);
    expect(await w.call('m-zhao', '对')).toContain('已入账');
    const rows = (await w.base.listEntries()).filter(e => e.customerName === '林姐' && e.status === 'confirmed');
    expect(rows).toHaveLength(2);

    const w2 = await worldM05();
    await post(w2, 'm-zhao', '林姐 680');
    const ask2 = await w2.call('m-zhao', '林姐 700');
    expect(ask2).toMatch(/新增一笔/);
    const next2 = await w2.call('m-zhao', '是另一单');
    expect(next2).toMatch(/还没入账/);
    expect(await w2.call('m-zhao', '对')).toContain('已入账');

    const w3 = await worldM05();
    await post(w3, 'm-zhao', '林姐 500');
    const add = await w3.call('m-zhao', '林姐 600');
    expect(add).toMatch(/新增一笔/);
    expect(await w3.call('m-zhao', '新增一笔')).toMatch(/还没入账/);
    expect(await w3.call('m-zhao', '对')).toContain('已入账');
    const ask3 = await w3.call('m-zhao', '林姐 880');
    expect(ask3).toMatch(/本店今天已有记录|改 /);
    const listed = listedOf(await w3.base.listDrafts({ status: 'pending' }));
    expect(listed.length).toBeGreaterThanOrEqual(2);
    const pick = await w3.call('m-zhao', '改刚才那笔');
    expect(pick).toMatch(/880|还没改|改账/);
    expect(pick).not.toMatch(/没太明白|没有第/);
    expect(await w3.call('m-zhao', '对')).toMatch(/已改|已更正|改账已/);
    const after = (await w3.base.listEntries()).filter(e => e.customerName === '林姐' && e.status === 'confirmed');
    expect(after.some(e => e.amount === 88000)).toBe(true);

    const w4 = await worldM05();
    await post(w4, 'm-zhao', '林姐 500');
    const a2 = await w4.call('m-zhao', '林姐 600');
    expect(a2).toMatch(/新增一笔/);
    await w4.call('m-zhao', '新增一笔');
    await w4.call('m-zhao', '对');
    const ask4 = await w4.call('m-zhao', '林姐 990');
    expect(ask4).toMatch(/已有记录|改 /);
    const second = await w4.call('m-zhao', '第二个');
    expect(second).toMatch(/990|还没改|改账/);
    expect(await w4.call('m-zhao', '对')).toMatch(/已改|已更正|改账已/);
  });
});
