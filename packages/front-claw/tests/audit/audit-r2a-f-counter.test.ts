import { expect, it } from 'vitest';
import { worldM05, registerUnnamedAppointment} from '../role-eval/appointment-fixture-m05.js';
import { fakeSender, manualClock, MIN } from '../role-eval/notify-fixture-m06.js';
import { createNotificationDispatcher, requeueUnknownNotification } from '../../src/role-eval/notification-dispatch.js';
import { MemoryPerformanceStore } from '../../src/role-eval/performance-store.js';

// R3：由缺陷特征断言（f 回 0、下次又从 1 开始）改为安全断言：失败重试 / unknown→人工补发后 f 保留，下次领取严格 +1。修前失败、修后通过。
for (const state of ['rejected', 'unknown'] as const) it(`AUDIT regression safe (R3): f is kept after ${state} and the next claim increments it`, async () => {
  const clock = manualClock(); const w = await worldM05({ now: clock.now, store: new MemoryPerformanceStore() });
  await registerUnnamedAppointment(w, 'm-zhao', '明天三点有个客人要来'); await w.call('m-zhao', '对');
  const fences: number[] = []; const tokens: (string|null|undefined)[] = [];
  const f = fakeSender(() => ({ state, detail: 'audit', code: 1 }));
  const sender = { async send(input: Parameters<typeof f.sender.send>[0], before: () => Promise<void>) {
    const row = (await w.base.listNotifications())[0]!;
    fences.push(row.delivery!.fence); tokens.push(row.delivery!.token);
    return f.sender.send(input, before);
  } };
  const d = createNotificationDispatcher({ store: w.base, sender, now: clock.now, worker: 'audit', leaseMs: MIN });
  await d.tick();
  const after = (await w.base.listNotifications())[0]!;
  expect(after.delivery!.fence).toBe(1);
  if (state === 'unknown') expect(await requeueUnknownNotification(w.base, after.notificationId, {actor:'audit',reason:'synthetic',now:clock.now()})).toBe('requeued');
  clock.advance(2*MIN); await d.tick();
  console.info(JSON.stringify({ state, fences, tokens, intermediate: after.delivery!.raw }));
  expect(fences).toEqual([1,2]); expect(tokens[0]).not.toBe(tokens[1]);
});
