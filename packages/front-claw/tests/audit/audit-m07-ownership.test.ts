import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { startFrontClawOpenDotService, operationIdFor, type AdapterDeps } from '../../src/opendot/adapter.js';
import { CONSUMER_LEASE_KEY } from '../../src/opendot/consumer-lease.js';
import { startFrontClawHook } from '../../integrations/opendot-front-claw/opendot-src/front-claw-hook.js';
import { fakeHost, manualClock, memoryWorld, offlineChannels, opIdOf } from '../opendot/fixture-m07.js';

// Independent port: passing means safe behavior; same takeover schedules.
const sheet = '12号测试B店\n560（小赵）';
async function start(world: Awaited<ReturnType<typeof memoryWorld>>, clock: ReturnType<typeof manualClock>, owner: string) {
  const channels = offlineChannels();
  const service = await startFrontClawOpenDotService(fakeHost().host, {
    open: world.open, now: clock.now, owner, channel: channels.factory, timers: false,
  });
  const say = async (text: string, id: string) => { channels.send('m-zhao', text, id); await service.idle(); };
  return { service, channels, say };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}

for (const bAlsoConfirms of [false, true]) it(`AUDIT regression safe: A resumes an in-flight commit after B takeover (B confirms=${bAlsoConfirms})`, async () => {
  const world = await memoryWorld(); const clock = manualClock();
  const a = await start(world, clock, 'A'); await a.say(sheet, 'report');
  const hit = deferred(), release = deferred();
  const original = world.store.commitConfirmingDraft.bind(world.store);
  const spy = vi.spyOn(world.store, 'commitConfirmingDraft').mockImplementationOnce(async (...args) => {
    hit.resolve(); await release.promise; return original(...args);
  });
  a.channels.send('m-zhao', '对', 'confirm'); await hit.promise;
  clock.advance(30_001);
  const b = await start(world, clock, 'B');
  expect(b.service.state()).toBe('active');
  const leaseB = await world.store.getConfig(CONSUMER_LEASE_KEY);
  let beforeResume: unknown;
  if (bAlsoConfirms) {
    await b.say('对', 'confirm');
    expect(b.channels.replies().at(-1)).toContain('已入账');
    beforeResume = { entries: await world.store.listEntries(), drafts: await world.store.listDrafts() };
  }
  release.resolve(); await a.service.idle();
  expect(a.channels.replies().join('')).not.toContain('已入账'); // stale A must not reply
  expect((await world.store.listEntries()).filter(e => e.amount === 56000)).toHaveLength(bAlsoConfirms ? 1 : 0);
  expect(await world.store.getConfig(CONSUMER_LEASE_KEY)).toBe(leaseB);
  if (bAlsoConfirms) {
    expect(spy).toHaveBeenCalledTimes(2); // both execute, same confirmed draft stays unchanged
    expect({ entries: await world.store.listEntries(), drafts: await world.store.listDrafts() }).toEqual(beforeResume);
  }
  await a.service.close();
  expect(await world.store.getConfig(CONSUMER_LEASE_KEY)).toBe(leaseB); // token protects release only
  await b.service.close(); spy.mockRestore();
});

it('AUDIT regression safe: restart retains durable operation result', async () => {
  const world = await memoryWorld(); const clock = manualClock(); const a = await start(world, clock, 'A');
  await a.say(sheet, 'report'); await a.say('对', 'confirm');
  const id = operationIdFor(opIdOf('m-zhao', 'confirm'));
  expect(await a.service.result(id)).toMatchObject({ ledgerSettled: true });
  await a.service.close(); const b = await start(world, clock, 'B');
  expect(await b.service.result(id)).toMatchObject({ ledgerSettled: true });
  expect((await world.store.listEntries()).filter(e => e.amount === 56000)).toHaveLength(1);
  await b.service.close();
});

it('AUDIT regression safe: pending adapter function returns OFF by timeout', async () => {
  const world = await memoryWorld(); const clock = manualClock(); const channels = offlineChannels();
  const hit = deferred(), release = deferred();
  const globals = globalThis as { __frontClawM07Deps?: AdapterDeps };
  globals.__frontClawM07Deps = { open: async () => { hit.resolve(); await release.promise; return world.open(); },
    channel: channels.factory, now: clock.now, timers: false };
  let done = false;
  const startup = startFrontClawHook(fakeHost().host.logger, { FRONT_CLAW_OPENDOT_ADAPTER: '1',
    FRONT_CLAW_OPENDOT_START_TIMEOUT_MS: '10', FRONT_CLAW_OPENDOT_MODULE: path.resolve('tests/opendot/hook-entry-m07.ts') }).then(s => { done = true; return s; });
  await hit.promise;
  await new Promise(r => setTimeout(r, 25));
  expect(done).toBe(true);
  release.resolve(); await (await startup).close();
  delete globals.__frontClawM07Deps;
});

it('AUDIT regression safe: channel open failure cleans channel lease and DB', async () => {
  const world = await memoryWorld(); const clock = manualClock(); const channels = offlineChannels();
  const close = vi.fn(async () => {});
  await expect(startFrontClawOpenDotService(fakeHost().host, { open: world.open, now: clock.now, owner: 'A', timers: false,
    channel: () => ({ ...channels.factory(), open: () => { throw Error('partial_channel_open'); }, close }),
  })).rejects.toThrow('partial_channel_open');
  expect(world.closes).toHaveBeenCalledTimes(1); expect(close).toHaveBeenCalledTimes(1);
  expect(JSON.parse((await world.store.getConfig(CONSUMER_LEASE_KEY))!).owner).toBeNull();
});
