/**
 * R4（R3A-02）：补偿写必须走同一围栏入口，比对当前持有者。
 * 过期的 A 不得把 B 正在重放的 confirming 改回 pending，也不得挡住 B 提交。
 */
import { expect, it, vi } from 'vitest';
import { startFrontClawOpenDotService } from '../../src/opendot/adapter.js';
import { memoryWorld, manualClock, offlineChannels, fakeHost } from '../opendot/fixture-m07.js';

function gate() {
  let hit!: () => void, release!: () => void;
  return { reached: new Promise<void>(r => { hit = r; }), wait: new Promise<void>(r => { release = r; }), hit: () => hit(), release: () => release() };
}

it('R4：陈旧 A 的补偿不得把 B 重放中的 confirming 复位，B 应能入账', async () => {
  const w = await memoryWorld(), clock = manualClock(), ca = offlineChannels(), cb = offlineChannels();
  const a = await startFrontClawOpenDotService(fakeHost().host, { open: w.open, now: clock.now, owner: 'A', channel: ca.factory, timers: false });
  ca.send('m-zhao', '12号测试B店\n560（小赵）', 'report'); await a.idle();
  const original = w.store.commitConfirmingDraft.bind(w.store);
  const ga = gate(), gb = gate();
  const spy = vi.spyOn(w.store, 'commitConfirmingDraft').mockImplementation(async (...args) => {
    const g = args[2]?.fence?.owner === 'A' ? ga : gb; g.hit(); await g.wait; return original(...args);
  });
  ca.send('m-zhao', '对', 'confirm'); await ga.reached; clock.advance(30001);
  const b = await startFrontClawOpenDotService(fakeHost().host, { open: w.open, now: clock.now, owner: 'B', channel: cb.factory, timers: false });
  try {
    cb.send('m-zhao', '对', 'confirm'); await gb.reached;
    expect((await w.store.listDrafts())[0]!.status).toBe('confirming');
    ga.release(); await a.idle();
    // A 恢复后不得把草稿打回 pending
    expect((await w.store.listDrafts())[0]!.status).toBe('confirming');
    gb.release(); await b.idle();
    const entries = (await w.store.listEntries()).filter(e => e.amount === 56000);
    expect(entries).toHaveLength(1);
    expect((await w.store.listDrafts())[0]!.status).toBe('confirmed');
  } finally { ga.release(); gb.release(); spy.mockRestore(); await a.close(); await b.close(); }
}, 10000);
