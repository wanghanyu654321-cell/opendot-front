import { expect, it } from 'vitest';
import { worldM05, registerUnnamedAppointment} from '../role-eval/appointment-fixture-m05.js';
import { fakeSender, manualClock, MIN } from '../role-eval/notify-fixture-m06.js';
import { createNotificationDispatcher, dispatchPaused, requeueUnknownNotification, NOTIFICATION_AUDIT_PREFIX, type NotificationSender } from '../../src/role-eval/notification-dispatch.js';
import { decodeStatus, dueRaw, encodeStatus } from '../../src/role-eval/notification-status.js';
import { MemoryPerformanceStore } from '../../src/role-eval/performance-store.js';

// Independent port: expected safe behavior. No source changes.
async function setup() {
  const clock = manualClock();
  const w = await worldM05({ now: clock.now, store: new MemoryPerformanceStore() });
  return { w, clock };
}
async function register(w: Awaited<ReturnType<typeof setup>>['w']) {
  expect(await registerUnnamedAppointment(w, 'm-zhao', '明天三点有个客人要来')).toContain('预约还没登记');
  expect(await w.call('m-zhao', '对')).toContain('预约已登记');
}
const dispatch = (w: Awaited<ReturnType<typeof setup>>['w'], sender: NotificationSender, now: () => Date) =>
  createNotificationDispatcher({ store: w.base, sender, now, worker: 'audit', leaseMs: MIN });

it('AUDIT regression safe: expired result is lost without sweeper', async () => {
  const { w, clock } = await setup(); await register(w);
  const sender: NotificationSender = { async send(_input, beforeSend) {
    await beforeSend(); clock.advance(2 * MIN);
    return { state: 'accepted', detail: 'late_ack_after_lease' };
  } };
  expect(await dispatch(w, sender, clock.now).tick()).toMatchObject({ sent: 0, lost: 1 });
  expect((await w.base.listNotifications())[0]!.status).toBe('pending');
});

it('AUDIT regression safe: recipient disabled after precheck is refused', async () => {
  const { w, clock } = await setup(); await register(w); const f = fakeSender();
  const sender: NotificationSender = { async send(input, beforeSend) {
    await w.base.savePerson({ ...(await w.base.getPerson('p-wang-yj'))!, active: false });
    return f.sender.send(input, beforeSend);
  } };
  expect(await dispatch(w, sender, clock.now).tick()).toMatchObject({ sent: 0 });
  expect(f.wire.map(i => i.memberId)).toEqual([]);
});

it('AUDIT regression safe: confirmed draft no longer receives reminder', async () => {
  const { w, clock } = await setup();
  expect(await w.call('m-zhao', '张姐 680（小王）')).toContain('还没入账');
  clock.advance(31 * MIN); const f = fakeSender();
  const sender: NotificationSender = { async send(input, beforeSend) {
    expect(await w.call('m-zhao', '对')).toContain('已入账');
    return f.sender.send(input, beforeSend);
  } };
  expect(await dispatch(w, sender, clock.now).tick()).toMatchObject({ sent: 0 });
  expect(f.wire).toEqual([]);
  expect((await w.base.listDrafts({ kind: 'report' }))[0]!.status).toBe('confirmed');
});

it('AUDIT regression safe: malformed phase rejected by write API', async () => {
  const { w, clock } = await setup(); await register(w);
  const row = (await w.base.listNotifications())[0]!;
  const raw = 'pending|2026-11-12T02:00:00.000Z|sending_typo|a=1|r=0|tok=old';
  await expect(w.base.transitionNotification(row.notificationId, 'pending', raw, null)).rejects.toThrow('invalid_delivery_status');
  expect(decodeStatus(raw).delivery.error).toBe('malformed_status');

});

it('AUDIT regression safe: invalid calendar and counters rejected', () => {
  expect(() => encodeStatus('pending', { phase: 'sending', dueAt: '2026-02-30T02:00:00.000Z', attempts: Infinity, resends: -3 })).toThrow('invalid_delivery_status');
  expect(dueRaw('pending|', '2026-11-12T02:00:00.000Z')).toBe(false);
  expect(decodeStatus('pending|').delivery.error).toBe('malformed_status');
  expect(decodeStatus('unknown|-|-|a=99999999999|r=-2').delivery.error).toBe('malformed_status');
});

it('AUDIT regression safe: winning resend actor preserved in audit', async () => {
  const { w, clock } = await setup(); await register(w);
  const f = fakeSender(() => ({ state: 'unknown', detail: 'no_ack' }));
  await dispatch(w, f.sender, clock.now).tick();
  const row = (await w.base.listNotifications())[0]!;
  const results = await Promise.all(['operator-A', 'operator-B'].map(actor =>
    requeueUnknownNotification(w.base, row.notificationId, { actor, reason: 'reviewed', now: clock.now() })));
  expect(results).toEqual(['requeued', 'not_unknown']);
  const audit = JSON.parse((await w.base.getConfig(`${NOTIFICATION_AUDIT_PREFIX}${row.notificationId}:1`))!);
  expect(audit.actor).toBe('operator-A');
});

it('AUDIT regression safe: type-invalid paused config pauses dispatch', () => {
  expect(dispatchPaused('{"paused":"true"}')).toBe(true);
  expect(dispatchPaused('{"paused":1}')).toBe(true);
});
