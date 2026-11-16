import { expect, it } from 'vitest';
import { startFrontClawOpenDotService } from '../../src/opendot/adapter.js';
import { fakeHost, manualClock, memoryWorld, offlineChannels } from '../opendot/fixture-m07.js';

it('R22 平台秒级 createTime：未替换草稿在同一秒内确认可以入账', async () => {
  const world = await memoryWorld(); const clock = manualClock(); const channels = offlineChannels();
  const service = await startFrontClawOpenDotService(fakeHost().host, { open: world.open, channel: channels.factory, now: clock.now, timers: false });
  const send = async (text: string, id: string) => {
    const frame = channels.frame('m-zhao', text, id); frame.body.create_time = Math.floor(clock.ms / 1000);
    channels.current().frame(frame); await service.idle(); return channels.replies().at(-1)!;
  };
  try {
    clock.advance(700); await send('郗姨：3923（小赵）', 'r22-second-draft');
    clock.advance(250); expect(await send('对', 'r22-second-confirm')).toContain('已入账');
    expect((await world.store.listEntries()).filter(e => e.customerName).map(e => [e.customerName, e.amount])).toEqual([['郗姨', 392300]]);
  } finally { await service.close(); }
});

it('R22 同一请求贯穿离线 SDK 通道 → 适配器 → 入口 → 循环 → SQL 替身，保留平台到达时间', async () => {
  const world = await memoryWorld(); const clock = manualClock(); const channels = offlineChannels();
  const service = await startFrontClawOpenDotService(fakeHost().host, { open: world.open, channel: channels.factory, now: clock.now, timers: false });
  const send = async (text: string, id: string, arrived = clock.ms) => {
    const frame = channels.frame('m-zhao', text, id); frame.body.create_time = arrived / 1000;
    channels.current().frame(frame); await service.idle(); return channels.replies().at(-1)!;
  };
  try {
    await send('郗姨：3923（小赵）', 'r22-channel-a');
    const early = clock.ms + 1000; clock.advance(2000);
    await send('逯姨：2879（小赵）', 'r22-channel-b');
    clock.advance(1000);
    expect(await send('对', 'r22-channel-early', early)).toBe('上一笔已作废，新的一笔「逯姨 2879元」请看清后再回「对」。');
    expect((await world.store.listEntries()).filter(e => e.customerName)).toEqual([]);
    clock.advance(1000); expect(await send('对', 'r22-channel-later')).toContain('已入账');
    expect((await world.store.listEntries()).filter(e => e.customerName).map(e => [e.customerName, e.amount])).toEqual([['逯姨', 287900]]);
  } finally { await service.close(); }
});
