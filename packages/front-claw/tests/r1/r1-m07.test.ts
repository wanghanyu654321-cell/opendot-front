import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { startFrontClawOpenDotService, operationIdFor, type AdapterDeps } from '../../src/opendot/adapter.js';
import { CONSUMER_LEASE_KEY } from '../../src/opendot/consumer-lease.js';
import { startFrontClawHook } from '../../integrations/opendot-front-claw/opendot-src/front-claw-hook.js';
import { fakeHost, manualClock, memoryWorld, offlineChannels, opIdOf } from '../opendot/fixture-m07.js';

/** R1 复现测试（由 助手B audit-m07-ownership 反例取反）。 */
const sheet = '12号测试B店\n560（小赵）';
async function start(world: Awaited<ReturnType<typeof memoryWorld>>, clock: ReturnType<typeof manualClock>, owner: string) {
  const channels = offlineChannels();
  const service = await startFrontClawOpenDotService(fakeHost().host, { open: world.open, now: clock.now, owner, channel: channels.factory, timers: false });
  const say = async (text: string, id: string) => { channels.send('m-zhao', text, id); await service.idle(); };
  return { service, channels, say };
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }

for (const bAlsoConfirms of [false, true]) it(`R1-M07-P1-1: B 接管后 A 恢复在途提交 → A 的提交被 fencing 拒绝且不回复（B confirms=${bAlsoConfirms}）`, async () => {
  const world = await memoryWorld(); const clock = manualClock();
  const a = await start(world, clock, 'A'); await a.say(sheet, 'report');
  const hit = deferred(), release = deferred();
  const original = world.store.commitConfirmingDraft.bind(world.store);
  const spy = vi.spyOn(world.store, 'commitConfirmingDraft').mockImplementationOnce(async (...args) => { hit.resolve(); await release.promise; return original(...args); });
  const repliesBefore = a.channels.replies().length;
  a.channels.send('m-zhao', '对', 'confirm'); await hit.promise;
  clock.advance(30_001);
  const b = await start(world, clock, 'B');
  expect(b.service.state()).toBe('active');
  if (bAlsoConfirms) { await b.say('对', 'confirm'); expect(b.channels.replies().at(-1)).toContain('已入账'); }
  release.resolve(); await a.service.idle();
  // A 是旧持有者：不回复；B 未确认时 A 也不能入账。
  expect(a.channels.replies().slice(repliesBefore).join('')).not.toContain('已入账');
  expect((await world.store.listEntries()).filter(e => e.amount === 56000)).toHaveLength(bAlsoConfirms ? 1 : 0);
  await a.service.close(); await b.service.close(); spy.mockRestore();
});

it('R1-M07-P1-1b: 租约 epoch 单调递增（每次换主 +1）', async () => {
  const world = await memoryWorld(); const clock = manualClock();
  const a = await start(world, clock, 'A');
  const e1 = JSON.parse((await world.store.getConfig(CONSUMER_LEASE_KEY))!).epoch;
  clock.advance(30_001);
  const b = await start(world, clock, 'B');
  const e2 = JSON.parse((await world.store.getConfig(CONSUMER_LEASE_KEY))!).epoch;
  expect(e2).toBe(e1 + 1);
  await a.service.close(); await b.service.close();
});

it('R1-M07-P1-3: 重启后按操作号仍能查回结果', async () => {
  const world = await memoryWorld(); const clock = manualClock(); const a = await start(world, clock, 'A');
  await a.say(sheet, 'report'); await a.say('对', 'confirm');
  const id = operationIdFor(opIdOf('m-zhao', 'confirm'));
  expect(await a.service.result(id)).toMatchObject({ ledgerSettled: true });
  await a.service.close(); const b = await start(world, clock, 'B');
  expect(await b.service.result(id)).toMatchObject({ operationId: id, state: 'completed', ledgerSettled: true, draftStatus: 'confirmed' });
  expect(await b.service.cancel(id)).toMatchObject({ state: 'completed', ledgerSettled: true });
  await b.service.close();
});

it('R1-M07-P1-2: 启动挂起不拖住 OpenDot：超时返回关闭态，迟到成功后自动回收', async () => {
  const world = await memoryWorld(); const clock = manualClock(); const channels = offlineChannels();
  const hit = deferred(), release = deferred();
  const globals = globalThis as { __frontClawM07Deps?: AdapterDeps };
  globals.__frontClawM07Deps = { open: async () => { hit.resolve(); await release.promise; return world.open(); }, channel: channels.factory, now: clock.now, timers: false };
  const host = fakeHost();
  const service = await startFrontClawHook(host.host.logger, { FRONT_CLAW_OPENDOT_ADAPTER: '1', FRONT_CLAW_OPENDOT_START_TIMEOUT_MS: '50',
    FRONT_CLAW_OPENDOT_MODULE: path.resolve('tests/opendot/hook-entry-m07.ts') });
  await hit.promise;
  expect(await service.ready()).toBeNull(); // R3：超时 → unavailable
  expect(service.state()).toBe('unavailable');
  await service.close(); // 关闭态 close 立即返回
  expect(host.logs.some(l => l.level === 'warn' && /timed out/.test(l.message ?? ''))).toBe(true);
  release.resolve();
  await vi.waitFor(async () => { expect(world.closes).toHaveBeenCalled(); });
  const lease = JSON.parse((await world.store.getConfig(CONSUMER_LEASE_KEY))!);
  expect(lease.owner).toBeNull();
  delete globals.__frontClawM07Deps;
});

it('R1-M07-P2-1: 通道 open 失败 → 关通道、释放租约、关 DB', async () => {
  const world = await memoryWorld(); const clock = manualClock(); const channels = offlineChannels();
  const close = vi.fn(async () => {});
  await expect(startFrontClawOpenDotService(fakeHost().host, { open: world.open, now: clock.now, owner: 'A', timers: false,
    channel: () => ({ ...channels.factory(), open: () => { throw Error('partial_channel_open'); }, close }) })).rejects.toThrow('partial_channel_open');
  expect(world.closes).toHaveBeenCalledTimes(1); expect(close).toHaveBeenCalledTimes(1);
  expect(JSON.parse((await world.store.getConfig(CONSUMER_LEASE_KEY))!).owner).toBeNull();
});
