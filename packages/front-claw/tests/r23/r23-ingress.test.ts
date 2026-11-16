import { expect, it, vi } from 'vitest';
import { startFrontClawOpenDotService } from '../../src/opendot/adapter.js';
import { capturePendingArrival } from '../../src/role-eval/pending-order.js';
import { MemoryPerformanceStore } from '../../src/role-eval/performance-store.js';
import { fakeHost, manualClock, memoryWorld, offlineChannels } from '../opendot/fixture-m07.js';

it('R23 同一请求经过离线通道和 saveDraft：写前暂停、接管后放行，旧消费者零写零回复且不挂起', async () => {
  const world = await memoryWorld(), clock = manualClock(), ca = offlineChannels(), cb = offlineChannels();
  const a = await startFrontClawOpenDotService(fakeHost().host, { open: world.open, channel: ca.factory, now: clock.now, owner: 'sequence-A', timers: false });
  let entered!: () => void, release!: () => void;
  const reached = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const original = world.store.saveDraft.bind(world.store);
  const spy = vi.spyOn(world.store, 'saveDraft').mockImplementationOnce(async (...args) => { entered(); await held; return original(...args); });
  let b: Awaited<ReturnType<typeof startFrontClawOpenDotService>> | undefined;
  try {
    ca.send('m-zhao', '郗姨：5743（小赵）', 'sequence-stale');
    await reached;
    clock.advance(30001);
    b = await startFrontClawOpenDotService(fakeHost().host, { open: world.open, channel: cb.factory, now: clock.now, owner: 'sequence-B', timers: false });
    expect(b.state()).toBe('active');
    release(); await a.idle();
    expect(await world.store.listDrafts()).toEqual([]);
    expect(ca.replies()).toEqual([]);
  } finally { release(); spy.mockRestore(); await a.close(); await b?.close(); }
});

it('R23 到达读取器保留返回引用：对外副本只读，迟到修改不能改变捕获序号', async () => {
  const store = new MemoryPerformanceStore(), raw = { sequence: '37', hours: null };
  vi.spyOn(store, 'capturePendingArrival').mockResolvedValue(raw);
  const arrival = await capturePendingArrival(store);
  raw.sequence = '991';
  expect(arrival.sequence).toBe('37');
  expect(Reflect.set(arrival, 'sequence', '1289')).toBe(false);
  expect(raw.sequence).toBe('991');
});
