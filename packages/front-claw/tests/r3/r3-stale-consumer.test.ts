import { expect, it, vi } from 'vitest';
import { startFrontClawOpenDotService } from '../../src/opendot/adapter.js';
import { CONSUMER_LEASE_KEY } from '../../src/opendot/consumer-lease.js';
import { OPERATION_RECORD_PREFIX } from '../../src/role-eval/operation-records.js';
import { fakeHost, manualClock, memoryWorld, offlineChannels } from '../opendot/fixture-m07.js';

// R3（A-P1-1）：在 audit 两条（新建/作废）之外，再覆盖“确认（pending→confirming）”与“操作记录持久化”两条写路径。
const sheet = '12号测试B店\n560（小赵）';
function gate() { let hit!: () => void, release!: () => void; return { reached: new Promise<void>(r => { hit = r; }), wait: new Promise<void>(r => { release = r; }), hit: () => hit(), release: () => release() }; }
async function start(w: Awaited<ReturnType<typeof memoryWorld>>, c: ReturnType<typeof manualClock>, owner: string) {
  const channel = offlineChannels(); const service = await startFrontClawOpenDotService(fakeHost().host, { open: w.open, now: c.now, owner, channel: channel.factory, timers: false });
  return { service, channel, say: async (text: string, id: string) => { channel.send('m-zhao', text, id); await service.idle(); } };
}

it('R3-S1：A 停在“确认”写入前 → B 接管 → 放行 A：草稿仍 pending、零入账、A 不回复', async () => {
  const w = await memoryWorld(), c = manualClock(), a = await start(w, c, 'A'); await a.say(sheet, 'report');
  const g = gate(), original = w.store.transitionPendingDraft.bind(w.store);
  const spy = vi.spyOn(w.store, 'transitionPendingDraft').mockImplementationOnce(async (...args) => { g.hit(); await g.wait; return original(...args); });
  const repliesBefore = a.channel.replies().length;
  a.channel.send('m-zhao', '对', 'confirm'); await g.reached; c.advance(30_001);
  const b = await start(w, c, 'B'); expect(b.service.state()).toBe('active');
  g.release(); await a.service.idle();
  expect((await w.store.listDrafts()).map(d => d.status)).toEqual(['pending']);
  expect((await w.store.listEntries()).filter(e => e.amount === 56000)).toEqual([]);
  expect(a.channel.replies().length).toBe(repliesBefore);
  // B 接手后同一草稿可正常确认，只入账一次。
  await b.say('对', 'confirm-b');
  expect((await w.store.listEntries()).filter(e => e.amount === 56000)).toHaveLength(1);
  spy.mockRestore(); await a.service.close(); await b.service.close();
});

it('R3-S2：A 处理中被接管 → A 收尾的操作记录写不进（不覆盖新持有者的记录），租约行不变', async () => {
  const w = await memoryWorld(), c = manualClock(), a = await start(w, c, 'A');
  const g = gate(), original = w.store.replacePendingReport.bind(w.store);
  const spy = vi.spyOn(w.store, 'replacePendingReport').mockImplementationOnce(async (...args) => { g.hit(); await g.wait; return original(...args); });
  a.channel.send('m-zhao', sheet, 'report'); await g.reached;
  c.advance(30_001);
  const b = await start(w, c, 'B'); const lease = await w.store.getConfig(CONSUMER_LEASE_KEY);
  const setConfig = vi.spyOn(w.store, 'setConfig');
  g.release(); await a.service.idle();
  // A 的收尾 saveOp 带的是 A 的 epoch：统一入口拒绝（调用发生了，但被拒绝、不写）。
  const opWrites = setConfig.mock.calls.filter(call => String(call[0]).startsWith(OPERATION_RECORD_PREFIX));
  expect(opWrites.length).toBeGreaterThan(0);
  for (const call of opWrites) expect(call[2]).toMatchObject({ owner: 'A' });
  const results = await Promise.allSettled(setConfig.mock.results.map(r => r.value));
  expect(results.every(r => r.status === 'rejected')).toBe(true);
  expect(await w.store.getConfig(CONSUMER_LEASE_KEY)).toBe(lease);
  expect(await w.store.listDrafts()).toEqual([]);
  spy.mockRestore(); setConfig.mockRestore(); await a.service.close(); await b.service.close();
});
