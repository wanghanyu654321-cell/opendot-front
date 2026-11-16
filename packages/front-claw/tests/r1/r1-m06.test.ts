import { expect, it } from 'vitest';
import { worldM05, registerUnnamedAppointment} from '../role-eval/appointment-fixture-m05.js';
import { fakeSender, manualClock, MIN } from '../role-eval/notify-fixture-m06.js';
import { createNotificationDispatcher, dispatchPaused, requeueUnknownNotification, NOTIFICATION_AUDIT_PREFIX, type NotificationSender } from '../../src/role-eval/notification-dispatch.js';
import { decodeStatus, dueRaw, encodeStatus } from '../../src/role-eval/notification-status.js';
import { MemoryPerformanceStore } from '../../src/role-eval/performance-store.js';
import { STORE_HOURS_KEY } from '../../src/role-eval/store-hours.js';

/** R1 复现测试（由 助手B audit-m06-boundaries 反例取反）。 */
async function setup() {
  const clock = manualClock();
  const w = await worldM05({ now: clock.now, store: new MemoryPerformanceStore() });
  return { w, clock };
}
type W = Awaited<ReturnType<typeof setup>>['w'];
async function register(w: W) {
  expect(await registerUnnamedAppointment(w, 'm-zhao', '明天三点有个客人要来')).toContain('预约还没登记');
  expect(await w.call('m-zhao', '对')).toContain('预约已登记');
}
const dispatch = (w: W, sender: NotificationSender, now: () => Date) =>
  createNotificationDispatcher({ store: w.base, sender, now, worker: 'r1', leaseMs: MIN });

it('R1-M06-P1-1: 租约过期且无人接管，旧领取者不能把通知标成 sent；下一轮转 unknown', async () => {
  const { w, clock } = await setup(); await register(w);
  const sender: NotificationSender = { async send(_input, beforeSend) {
    await beforeSend(); clock.advance(2 * MIN);
    return { state: 'accepted', detail: 'late_ack_after_lease' };
  } };
  const stats = await dispatch(w, sender, clock.now).tick();
  expect(stats.sent).toBe(0);
  expect((await w.base.listNotifications())[0]!.status).not.toBe('sent');
  await dispatch(w, fakeSender().sender, clock.now).tick();
  expect((await w.base.listNotifications())[0]!.status).toBe('unknown');
});

it('R1-M06-P0-1: 预检后、发送前收件人被停用 → 发送门按当前档案拒绝，不上线', async () => {
  const { w, clock } = await setup(); await register(w); const f = fakeSender();
  const sender: NotificationSender = { async send(input, beforeSend) {
    await w.base.savePerson({ ...(await w.base.getPerson('p-wang-yj'))!, active: false });
    return f.sender.send(input, beforeSend);
  } };
  expect((await dispatch(w, sender, clock.now).tick()).sent).toBe(0);
  expect(f.wire).toEqual([]);
  expect((await w.base.listNotifications())[0]!.status).toBe('not_sent');
});

it('R1-M06-P0-1b: 预检后收件人换绑 memberId → 不发给旧 memberId', async () => {
  const { w, clock } = await setup(); await register(w); const f = fakeSender();
  const sender: NotificationSender = { async send(input, beforeSend) {
    await w.base.savePerson({ ...(await w.base.getPerson('p-wang-yj'))!, memberId: 'm-wang-yj-new' });
    return f.sender.send(input, beforeSend);
  } };
  await dispatch(w, sender, clock.now).tick();
  expect(f.wire.map(i => i.memberId)).not.toContain('m-wang-yj');
});

it('R1-M06-P0-1c: 预检后收件人调到他店（策略仍给 B 店接收权）→ 发送门按当前档案判不同店，不上线', async () => {
  const { w, clock } = await setup(); await register(w); const f = fakeSender();
  const sender: NotificationSender = { async send(input, beforeSend) {
    await w.base.savePerson({ ...(await w.base.getPerson('p-wang-yj'))!, storeId: 's-a', storeName: '测试A店' });
    return f.sender.send(input, beforeSend);
  } };
  expect((await dispatch(w, sender, clock.now).tick()).sent).toBe(0);
  expect(f.wire).toEqual([]);
  expect((await w.base.listNotifications())[0]!.status).toBe('not_sent');
});

it('R1-M06-P1-2: 预检后草稿被确认 → 「还没确认」提醒作废不发', async () => {
  const { w, clock } = await setup();
  expect(await w.call('m-zhao', '张姐 680（小王）')).toContain('还没入账');
  clock.advance(31 * MIN); const f = fakeSender();
  const sender: NotificationSender = { async send(input, beforeSend) {
    expect(await w.call('m-zhao', '对')).toContain('已入账');
    return f.sender.send(input, beforeSend);
  } };
  expect((await dispatch(w, sender, clock.now).tick()).sent).toBe(0);
  expect(f.wire.map(i => i.content).join('')).not.toContain('还没确认');
  expect((await w.base.listNotifications()).find(n => n.kind === 'reminder')!.status).toBe('not_sent');
});

it('R1-M06-P1-2b: 预检后草稿被（不经入口的）直接作废 → 发送事务内重读草稿行，提醒不发', async () => {
  const { w, clock } = await setup();
  expect(await w.call('m-zhao', '张姐 680（小王）')).toContain('还没入账');
  clock.advance(31 * MIN); const f = fakeSender();
  const sender: NotificationSender = { async send(input, beforeSend) {
    const draft = (await w.base.listDrafts({ status: 'pending' }))[0]!;
    expect(await w.base.transitionPendingDraft(draft, { ...draft, status: 'void', closedAt: clock.now().toISOString() })).toBe(true);
    return f.sender.send(input, beforeSend);
  } };
  expect((await dispatch(w, sender, clock.now).tick()).sent).toBe(0);
  expect(f.wire).toEqual([]);
  expect((await w.base.listNotifications()).find(n => n.kind === 'reminder')!.status).toBe('not_sent');
});

it('R1-M06-P1-3a: 畸形 phase 的行不被领取、不发送', async () => {
  const { w, clock } = await setup(); await register(w);
  const row = (await w.base.listNotifications())[0]!;
  const raw = 'pending|2026-11-12T02:00:00.000Z|sending_typo|a=1|r=0|tok=old';
  // 写入口本身拒绝畸形状态
  await expect(w.base.transitionNotification(row.notificationId, 'pending', raw, null)).rejects.toThrow('invalid_delivery_status');
  const f = fakeSender(); expect((await dispatch(w, f.sender, clock.now).tick()).sent).toBe(1);
  expect(decodeStatus(raw).delivery.error).toBe('malformed_status');
});

it('R1-M06-P1-3b: codec 拒绝非法日期/计数；`pending|` 不到期；超界计数判畸形', () => {
  expect(() => encodeStatus('pending', { phase: 'sending', dueAt: '2026-02-30T02:00:00.000Z', attempts: 1, resends: 0, token: 't', fence: 1 })).toThrow('invalid_delivery_status');
  expect(() => encodeStatus('pending', { phase: 'queued', dueAt: '2026-11-12T02:00:00.000Z', attempts: Infinity, resends: 0 })).toThrow('invalid_delivery_status');
  expect(() => encodeStatus('pending', { phase: 'queued', dueAt: '2026-11-12T02:00:00.000Z', attempts: 1, resends: -3 })).toThrow('invalid_delivery_status');
  expect(dueRaw('pending|', '2026-11-12T02:00:00.000Z')).toBe(false);
  expect(decodeStatus('pending|').delivery.error).toBe('malformed_status');
  expect(decodeStatus('unknown|-|-|a=99999999999|r=-2').delivery.error).toBe('malformed_status');
  expect(decodeStatus('unknown|-|-|a=1|r=0|a=2').delivery.error).toBe('malformed_status');
});

it('R1-M06-P1-4: 并发人工补发只有一人成功，审计记录的是胜者且不被覆盖', async () => {
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

it('R1-M06-P2-1: paused 字段类型错误按暂停处理', () => {
  expect(dispatchPaused('{"paused":"true"}')).toBe(true);
  expect(dispatchPaused('{"paused":1}')).toBe(true);
  expect(dispatchPaused('{"paused":false}')).toBe(false);
  expect(dispatchPaused('{}')).toBe(false);
});

it('R1-M06-P1-5a: 草稿过期时间按门店营业配置（时区/打烊）计算，默认 Asia/Shanghai 23:00', async () => {
  const { w } = await setup();
  await w.base.setConfig(STORE_HOURS_KEY, JSON.stringify({ version: 1, stores: { 's-b': { timeZone: 'Asia/Tokyo', cutoff: '22:00' } } }));
  expect(await w.call('m-zhao', '张姐 680（小王）')).toContain('还没入账');
  const draft = (await w.base.listDrafts({ kind: 'report' }))[0]!;
  expect(draft.expiresAt).toBe('2026-11-12T13:00:00.000Z'); // 东京 22:00
});

it('R1-M06-P1-5b: 派发器按门店时区判断预约是否已过', async () => {
  const { w, clock } = await setup(); await register(w);
  const appt = (await w.base.listAppointments())[0]!;
  expect(appt.whenText).toBe('2026-11-13 15:00');
  clock.jump(new Date('2026-11-13T06:30:00Z').getTime()); // 上海 14:30（未过）；东京 15:30（已过）
  await w.base.setConfig(STORE_HOURS_KEY, JSON.stringify({ version: 1, stores: { 's-b': { timeZone: 'Asia/Tokyo', cutoff: '23:00' } } }));
  const f = fakeSender();
  await dispatch(w, f.sender, clock.now).tick();
  expect(f.wire).toEqual([]);
  expect((await w.base.listNotifications())[0]!.delivery?.error).toBe('stale_appointment_passed');
});

it('R1-M06-P1-5c: 门店营业配置损坏 → 不写草稿', async () => {
  const { w } = await setup();
  await w.base.setConfig(STORE_HOURS_KEY, JSON.stringify({ version: 1, stores: { 's-b': { timeZone: 'Mars/Base', cutoff: '23:00' } } }));
  expect(await w.call('m-zhao', '张姐 680（小王）')).not.toContain('还没入账');
  expect(await w.base.listDrafts({ kind: 'report' })).toEqual([]);
});
