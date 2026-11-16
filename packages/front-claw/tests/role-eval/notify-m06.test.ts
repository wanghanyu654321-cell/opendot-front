import { describe, expect, it } from 'vitest';
import { updateAccessPolicy } from '../../src/role-eval/access-policy.js';
import { APPOINTMENT_RECIPIENTS_KEY } from '../../src/role-eval/appointments.js';
import { createBotSender } from '../../src/role-eval/wecom-bot-sender.js';
import { createWecomBotHandler } from '../../src/role-eval/wecom-bot-unified-handler.js';
import { bootFrontClaw } from '../../src/role-eval/front-claw-boot.js';
import {
  createBotNotificationSender, createNotificationDispatcher, dispatchPaused, draftReminderId, NOTIFICATION_AUDIT_PREFIX, NOTIFICATION_DISPATCH_KEY,
  requeueUnknownNotification, type DispatchEvent, type NotificationSender,
} from '../../src/role-eval/notification-dispatch.js';
import { decodeStatus, encodeStatus, outboxManaged } from '../../src/role-eval/notification-status.js';
import { MemoryPerformanceStore, type Notification, type PerformanceStore } from '../../src/role-eval/performance-store.js';
import { NOW } from './access-fixture-m03.js';
import { membersM05, policyM05, worldM05, registerUnnamedAppointment} from './appointment-fixture-m05.js';
import { fakeSender, manualClock, MIN } from './notify-fixture-m06.js';

const at = NOW.toISOString();
type W = Awaited<ReturnType<typeof worldM05>>;
async function setup(options: { recipients?: string | null; memory?: boolean } = {}) {
  const clock = manualClock();
  const w = await worldM05({ now: clock.now, ...(options.memory === false ? {} : { store: new MemoryPerformanceStore() }), ...(options.recipients !== undefined ? { recipients: options.recipients } : {}) });
  return { w, clock };
}
function dispatcher(store: PerformanceStore, sender: NotificationSender, now: () => Date, extra: Partial<Parameters<typeof createNotificationDispatcher>[0]> = {}) {
  const events: DispatchEvent[] = [];
  let n = 0;
  const d = createNotificationDispatcher({ store, sender, now, worker: extra.worker ?? 'w1', token: () => `tok${++n}`, onEvent: e => events.push(e), ...extra });
  return { ...d, events };
}
const appt = async (w: W) => (await w.base.listNotifications()).filter(n => n.kind === 'appointment');
async function register(w: W, text = '明天三点有个客人要来') {
  expect(await registerUnnamedAppointment(w, 'm-zhao', text)).toContain('预约还没登记');
  expect(await w.call('m-zhao', '对')).toContain('预约已登记');
}
async function bump(store: PerformanceStore, from: number, next: ReturnType<typeof policyM05>) {
  expect(await updateAccessPolicy(store, { expectedVersion: from, next, actor: 'test-admin', reason: 'test', at })).toEqual({ ok: true, version: next.version });
}

describe('M06 状态编码（不改 schema）', () => {
  it('基本词在前，旧读者照常；到期时间可按字典序比较；出站箱 ID 识别', () => {
    const raw = encodeStatus('pending', { phase: 'claimed', dueAt: '2026-11-12T02:01:00.000Z', attempts: 2, resends: 0, token: 't|x', worker: 'w 1', error: 'rejected:93000' });
    expect(raw).toBe('pending|2026-11-12T02:01:00.000Z|claimed|a=2|r=0|tok=t_x|by=w_1|err=rejected:93000');
    expect(decodeStatus(raw)).toMatchObject({ status: 'pending', delivery: { phase: 'claimed', attempts: 2, token: 't_x', worker: 'w_1', error: 'rejected:93000' } });
    expect(decodeStatus('pending').delivery).toMatchObject({ phase: 'queued', attempts: 0 });
    expect(decodeStatus('sent|-|-|a=1|r=0')).toMatchObject({ status: 'sent', delivery: { attempts: 1, phase: null } });
    expect(() => encodeStatus('pending', { attempts: 0, resends: 0 })).toThrow();
    expect(outboxManaged('a'.repeat(64))).toBe(true); expect(outboxManaged('2b7c0b1e-1111-4111-8111-111111111111')).toBe(false);
    expect(dispatchPaused(null)).toBe(false); expect(dispatchPaused('{"paused":true}')).toBe(true); expect(dispatchPaused('{}')).toBe(false); expect(dispatchPaused('坏')).toBe(true);
  });
});

describe('M06 派发：店长提醒与改账通知', () => {
  it('登记 → 派发一次（只发给指定店长，正文含“仅提醒，无需回复”）→「我的预约」显示通道已接受；再跑不重发', async () => {
    const { w, clock } = await setup();
    await register(w);
    const f = fakeSender(); const d = dispatcher(w.base, f.sender, clock.now);
    expect(await w.call('m-zhao', '我的预约')).toContain('已排队，尚未发送');
    const stats = await d.tick();
    expect(stats).toMatchObject({ claimed: 1, sent: 1, unknown: 0 });
    expect(f.wire).toHaveLength(1); expect(f.wire[0]).toMatchObject({ memberId: 'm-wang-yj', kind: 'appointment' }); expect(f.wire[0]!.content).toContain('仅提醒，无需回复');
    const [row] = await appt(w);
    expect(row).toMatchObject({ status: 'sent', sentAt: clock.now().toISOString() }); expect(row!.delivery).toMatchObject({ attempts: 1 });
    expect(await w.call('m-zhao', '我的预约')).toContain('企微通道已接受（不代表店长已读）');
    clock.advance(10 * MIN); await d.tick(); await d.tick();
    expect(f.calls).toHaveLength(1);
    expect(w.send).not.toHaveBeenCalled();
  });
  it('改账通知只发给归属人和报数人（不含操作人、不抄送老板）', async () => {
    const { w, clock } = await setup();
    expect(await w.call('m-zhao', '张姐 680（小王）')).toContain('还没入账');
    expect(await w.call('m-zhao', '对')).toContain('已入账');
    expect(await w.call('m-wang-yj', '把小王刚才那笔改成600')).toContain('680元 → 600元');
    expect(await w.call('m-wang-yj', '对')).toContain('已改账');
    const f = fakeSender(); const d = dispatcher(w.base, f.sender, clock.now);
    await d.tick();
    expect(f.wire.map(i => i.memberId).sort()).toEqual(['m-xw', 'm-zhao']);
    expect(f.wire.every(i => i.kind === 'correction')).toBe(true);
    expect((await w.base.listNotifications()).filter(n => n.kind === 'correction').map(n => n.status)).toEqual(['sent', 'sent']);
  });
  it('多个派发者同时跑：每条只上线一次', async () => {
    const { w, clock } = await setup();
    for (const text of ['明天三点有个客人要来', '明天四点李女士来做美甲', '后天下午两点王姐来做护理']) await register(w, text);
    const f = fakeSender();
    const ds = ['w1', 'w2', 'w3'].map(worker => dispatcher(w.base, f.sender, clock.now, { worker }));
    await Promise.all(ds.map(d => d.tick()));
    expect(f.wire).toHaveLength(3); expect(new Set(f.wire.map(i => i.notificationId)).size).toBe(3);
    expect((await appt(w)).map(n => n.status)).toEqual(['sent', 'sent', 'sent']);
  });
});

describe('M06 失败策略：明确失败有限退避；unknown 不当 sent、不自动重发；人工补发可审计且有上限', () => {
  it('明确失败 → 1 分钟后重试；未到时间不领取；连续失败到上限 → not_sent，「我的预约」如实显示', async () => {
    const { w, clock } = await setup();
    await register(w);
    const f = fakeSender(() => ({ state: 'rejected', detail: 'sdk_ack_rejected', code: 93000 }));
    const d = dispatcher(w.base, f.sender, clock.now, { maxAttempts: 3, backoffMs: [MIN, 5 * MIN], backlogAlert: { count: 1, ageMs: 24 * 60 * MIN } });
    expect(await d.tick()).toMatchObject({ retried: 1, backlog: 1 });
    expect(d.events.filter(e => e.type === 'backlog_alert')).toEqual([expect.objectContaining({ count: 1 })]);
    let [row] = await appt(w);
    expect(row).toMatchObject({ status: 'pending', delivery: { phase: 'queued', attempts: 1, error: 'rejected:93000', dueAt: new Date(clock.ms + MIN).toISOString() } });
    expect(await w.call('m-zhao', '我的预约')).toContain('上次发送未成功，稍后自动重试（已试 1 次）');
    clock.advance(30_000); expect(await d.tick()).toMatchObject({ claimed: 0 });
    clock.advance(31_000); expect(await d.tick()).toMatchObject({ retried: 1 });
    clock.advance(5 * MIN); expect(await d.tick()).toMatchObject({ failed: 1 });
    [row] = await appt(w);
    expect(row).toMatchObject({ status: 'not_sent', delivery: { attempts: 3 } });
    clock.advance(60 * MIN); await d.tick();
    expect(f.calls).toHaveLength(3);
    expect(await w.call('m-zhao', '我的预约')).toContain('发送失败，未送达');
  });
  it('通道未连接（blocked，未上线）→ 退避重试，恢复后送达一次', async () => {
    const { w, clock } = await setup();
    await register(w);
    let ready = false;
    const f = fakeSender(() => ready ? { state: 'accepted', detail: 'ok', code: 0 } : { state: 'blocked', detail: 'not_connected' });
    const d = dispatcher(w.base, f.sender, clock.now);
    expect(await d.tick()).toMatchObject({ retried: 1 });
    ready = true; clock.advance(MIN); expect(await d.tick()).toMatchObject({ sent: 1 });
    expect((await appt(w))[0]).toMatchObject({ status: 'sent', delivery: { attempts: 2 } });
  });
  it('发送器超时（复用现有 wecom-bot-sender，回执不来）→ unknown + 告警；之后不重发；人工补发一次留审计，第二次被拒', async () => {
    const { w, clock } = await setup();
    await register(w);
    const sdkCalls: string[] = [];
    let respond = false;
    const bot = createBotSender({ timeoutMs: 50, sdk: { mode: 'isolated-synthetic', ready: () => true, reply: async () => ({}),
      sendMessage: async (chatid: string) => { sdkCalls.push(chatid); return respond ? { headers: { req_id: 'r-1' }, errcode: 0 } : new Promise(() => {}); } } });
    const d = dispatcher(w.base, createBotNotificationSender(bot), clock.now);
    expect(await d.tick()).toMatchObject({ unknown: 1, sent: 0 });
    expect(d.events.some(e => e.type === 'unknown_alert' && e.error === 'send_result_unknown')).toBe(true);
    expect((await appt(w))[0]).toMatchObject({ status: 'unknown', delivery: { attempts: 1 } });
    expect(await w.call('m-zhao', '我的预约')).toContain('发送结果未知，未确认送达');
    clock.advance(120 * MIN); await d.tick();
    expect(sdkCalls).toEqual(['m-wang-yj']);
    const id = (await appt(w))[0]!.notificationId;
    expect(await requeueUnknownNotification(w.base, id, { actor: 'ops-1', reason: '店长说没收到', now: clock.now() })).toBe('requeued');
    expect(JSON.parse((await w.base.getConfig(`${NOTIFICATION_AUDIT_PREFIX}${id}:1`))!)).toMatchObject({ actor: 'ops-1', reason: '店长说没收到', attempts: 1 });
    respond = true; await d.tick();
    expect(sdkCalls).toEqual(['m-wang-yj', 'm-wang-yj']);
    expect((await appt(w))[0]).toMatchObject({ status: 'sent', delivery: { attempts: 2, resends: 1 } });
    expect(await requeueUnknownNotification(w.base, id, { actor: 'ops-1', reason: 'x', now: clock.now() })).toBe('not_unknown');
    bot.close();
  });
  it('补发上限：unknown 已补发过一次后再次 unknown → 拒绝第二次补发；空操作人/原因拒绝', async () => {
    const { w, clock } = await setup();
    await register(w);
    const f = fakeSender(() => ({ state: 'unknown', detail: 'send_result_unknown' }));
    const d = dispatcher(w.base, f.sender, clock.now);
    await d.tick();
    const id = (await appt(w))[0]!.notificationId;
    expect(await requeueUnknownNotification(w.base, id, { actor: ' ', reason: 'x', now: clock.now() })).toBe('invalid');
    expect(await requeueUnknownNotification(w.base, id, { actor: 'ops', reason: 'x', now: clock.now() })).toBe('requeued');
    await d.tick();
    expect(await requeueUnknownNotification(w.base, id, { actor: 'ops', reason: 'y', now: clock.now() })).toBe('limit');
    expect(await w.call('m-zhao', '我的预约')).toContain('已人工补发 1 次');
    expect(f.wire).toHaveLength(2);
  });
});

describe('M06 崩溃与租约（受控时钟；真实进程 kill -9 见 PG 用例）', () => {
  it('领取后、发送前卡死（=崩溃）→ 租约到期后另一个派发者重领并只发一次；卡死者之后无法上线', async () => {
    const { w, clock } = await setup();
    await register(w);
    let release: (() => void) | undefined;
    const stuck: NotificationSender = { async send(_input, beforeSend) { await new Promise<void>(r => { release = r; }); try { await beforeSend(); } catch { return { state: 'blocked', detail: 'authority_refused' }; } return { state: 'accepted', detail: 'late' }; } };
    const a = dispatcher(w.base, stuck, clock.now, { worker: 'A', leaseMs: MIN });
    void a.tick();
    await new Promise(r => setTimeout(r, 20));
    expect((await appt(w))[0]).toMatchObject({ status: 'pending', delivery: { phase: 'claimed', worker: 'A' } });
    const f = fakeSender(); const b = dispatcher(w.base, f.sender, clock.now, { worker: 'B', leaseMs: MIN });
    expect(await b.tick()).toMatchObject({ claimed: 0 });
    clock.advance(MIN + 1000);
    expect(await b.tick()).toMatchObject({ claimed: 1, sent: 1 });
    release!(); await new Promise(r => setTimeout(r, 20));
    expect(a.events.some(e => e.type === 'lost')).toBe(true);
    expect(f.wire).toHaveLength(1);
    expect((await appt(w))[0]).toMatchObject({ status: 'sent', delivery: { attempts: 1, worker: null } });
  });
  it('领取者自己停住超过租约（无人接手）→ 醒来后不得上线；下一轮重新领取只发一次', async () => {
    const { w, clock } = await setup();
    await register(w);
    let release: (() => void) | undefined;
    const wire: string[] = [];
    const stuck: NotificationSender = { async send(input, beforeSend) { await new Promise<void>(r => { release = r; }); try { await beforeSend(); } catch { return { state: 'blocked', detail: 'authority_refused' }; } wire.push(input.notificationId); return { state: 'accepted', detail: 'late' }; } };
    const a = dispatcher(w.base, stuck, clock.now, { worker: 'A', leaseMs: MIN });
    const ticking = a.tick();
    await new Promise(r => setTimeout(r, 20));
    clock.advance(MIN + 1000);
    release!(); await ticking;
    expect(wire).toEqual([]);
    expect(a.events.some(e => e.type === 'lost')).toBe(true);
    const f = fakeSender();
    expect(await dispatcher(w.base, f.sender, clock.now, { worker: 'B' }).tick()).toMatchObject({ sent: 1 });
    expect(f.wire).toHaveLength(1);
  });
  it('已进入发送阶段后卡死 → 租约到期判 unknown（可能已送达，不重发）；卡死者迟到的“已接受”写不进去', async () => {
    const { w, clock } = await setup();
    await register(w);
    let resolve!: (r: { state: 'accepted'; detail: string }) => void;
    const deferred = new Promise<{ state: 'accepted'; detail: string }>(r => { resolve = r; });
    const fa = fakeSender(() => ({ deferred }));
    const a = dispatcher(w.base, fa.sender, clock.now, { worker: 'A', leaseMs: MIN });
    const ticking = a.tick();
    await new Promise(r => setTimeout(r, 20));
    expect((await appt(w))[0]).toMatchObject({ status: 'pending', delivery: { phase: 'sending', attempts: 1 } });
    expect(await w.call('m-zhao', '我的预约')).toContain('正在发送，结果待确认');
    clock.advance(MIN + 1000);
    const fb = fakeSender(); const b = dispatcher(w.base, fb.sender, clock.now, { worker: 'B' });
    expect(await b.tick()).toMatchObject({ recovered: 1, claimed: 0 });
    expect(b.events.some(e => e.type === 'recovered_unknown')).toBe(true);
    resolve({ state: 'accepted', detail: 'late' }); await ticking;
    expect(a.events.some(e => e.type === 'stale_claim')).toBe(true);
    expect((await appt(w))[0]).toMatchObject({ status: 'unknown', delivery: { error: 'lease_expired_during_send' } });
    clock.advance(120 * MIN); await b.tick();
    expect(fa.wire).toHaveLength(1); expect(fb.calls).toHaveLength(0);
  });
  it('发送中抛错（已上线）→ unknown；发送前抛错 → 退避重试', async () => {
    const { w, clock } = await setup();
    await register(w);
    const f = fakeSender(() => 'throw');
    const d = dispatcher(w.base, f.sender, clock.now);
    expect(await d.tick()).toMatchObject({ unknown: 1 });
    const { w: v, clock: c2 } = await setup();
    await register(v);
    const early: NotificationSender = { async send() { throw Error('boom'); } };
    expect(await dispatcher(v.base, early, c2.now).tick()).toMatchObject({ retried: 1 });
  });
});

describe('M06 发送前重判授权与收件人（同一事务，锁住的策略）', () => {
  it('撤销店长 appointment_receive / 停用 / 更换指定店长 / 调店 → 不上线，not_sent 带原因；预约照样成立；「我的预约」如实显示', async () => {
    const cases: [string, (w: W) => Promise<void>, string][] = [
      ['收回能力', w => bump(w.base, 1, policyM05(2, membersM05(), { members: { ...membersM05(), 'p-wang-yj': { role: 'manager', storeIds: ['s-b'], status: 'active', capabilities: ['report_self'] } } })), 'recipient_ineligible'],
      ['停用', w => bump(w.base, 1, policyM05(2, { ...membersM05(), 'p-wang-yj': { role: 'manager', storeIds: ['s-b'], status: 'suspended' } })), 'recipient_ineligible'],
      ['更换指定店长', w => w.base.setConfig(APPOINTMENT_RECIPIENTS_KEY, JSON.stringify({ version: 2, stores: { 's-b': 'p-xw' } })), 'recipient_changed'],
      ['调店', async w => w.base.savePerson({ ...(await w.base.getPerson('p-wang-yj'))!, storeId: 's-a', storeName: '测试A店' }), 'recipient_ineligible'],
    ];
    for (const [name, change, reason] of cases) {
      const { w, clock } = await setup();
      await register(w);
      await change(w);
      const f = fakeSender(); const d = dispatcher(w.base, f.sender, clock.now);
      expect(await d.tick(), name).toMatchObject({ refused: 1, sent: 0 });
      expect(f.wire, name).toEqual([]);
      expect((await appt(w))[0], name).toMatchObject({ status: 'not_sent', delivery: { error: reason } });
      expect((await w.base.listAppointments())[0]!.status).toBe('registered');
      expect(await w.call('m-zhao', '我的预约'), name).toContain('未发送：指定店长当前不能接收或已更换');
    }
  });
  it('发送时策略在 beforeSend 内重读：领取之后才撤权也拦得住', async () => {
    const { w, clock } = await setup();
    await register(w);
    let revoked = false;
    const f = fakeSender();
    const wrapped: NotificationSender = { async send(input, beforeSend) {
      if (!revoked) { revoked = true; await bump(w.base, 1, policyM05(2, { ...membersM05(), 'p-wang-yj': { role: 'manager', storeIds: ['s-b'], status: 'revoked' } })); }
      return f.sender.send(input, beforeSend);
    } };
    expect(await dispatcher(w.base, wrapped, clock.now).tick()).toMatchObject({ refused: 1 });
    expect(f.wire).toEqual([]);
  });
  it('预约时间已过才派发 → 不发（stale）；未配置店长 → 无提醒行，默认不补发；开补发开关后只补一次', async () => {
    const { w, clock } = await setup();
    await register(w, '今天10点30分有客人要来');
    clock.advance(40 * MIN);
    const f = fakeSender(); const d = dispatcher(w.base, f.sender, clock.now);
    expect(await d.tick()).toMatchObject({ refused: 1 });
    expect((await appt(w))[0]).toMatchObject({ status: 'not_sent', delivery: { error: 'stale_appointment_passed' } });
    const { w: v, clock: c } = await setup({ recipients: null });
    await register(v);
    expect(await appt(v)).toEqual([]);
    await v.base.setConfig(APPOINTMENT_RECIPIENTS_KEY, JSON.stringify({ version: 1, stores: { 's-b': 'p-wang-yj' } }));
    const g = fakeSender();
    await dispatcher(v.base, g.sender, c.now).tick();
    expect(g.calls).toEqual([]); expect(await appt(v)).toEqual([]);
    const back = dispatcher(v.base, g.sender, c.now, { backfillAppointmentReminders: true });
    await back.tick(); await back.tick();
    expect(g.wire).toHaveLength(1); expect(g.wire[0]!.content).toContain('仅提醒，无需回复');
    expect(back.events.filter(e => e.type === 'backfill_queued')).toHaveLength(1);
  });
});

describe('M06 员工入口草稿维护：提醒一次、已确认不提醒、闭店作废并通知一次；预约不受影响', () => {
  it('报数草稿 30 分钟提醒一次；已确认的不提醒；闭店作废 + 作废通知一次；用户取消的不通知；已登记预约不作废', async () => {
    const { w, clock } = await setup();
    await register(w);
    expect(await w.call('m-zhao', '张姐 680（小王）')).toContain('还没入账');
    const f = fakeSender(); const d = dispatcher(w.base, f.sender, clock.now);
    clock.advance(29 * MIN); await d.tick();
    expect(f.wire.filter(i => i.kind === 'reminder')).toHaveLength(0);
    clock.advance(2 * MIN); await d.tick(); await d.tick();
    clock.advance(10 * MIN); await d.tick();
    expect(f.wire.filter(i => i.kind === 'reminder').map(i => i.memberId)).toEqual(['m-zhao']);
    // 闭店（23:00 北京时间）后：草稿作废、作废通知一次；登记的预约仍是 registered
    clock.jump(Date.parse('2026-11-12T15:01:00Z'));
    await d.tick(); await d.tick();
    const drafts = await w.base.listDrafts({ kind: 'report' });
    expect(drafts.map(x => x.status)).toEqual(['void']);
    expect(f.wire.filter(i => i.kind === 'void').map(i => i.memberId)).toEqual(['m-zhao']);
    expect((await w.base.listAppointments()).map(a => a.status)).toEqual(['registered']);
    expect(await w.call('m-zhao', '对')).not.toContain('已入账');

    const { w: v, clock: c } = await setup();
    expect(await v.call('m-zhao', '张姐 680（小王）')).toContain('还没入账');
    const g = fakeSender(); const e = dispatcher(v.base, g.sender, c.now);
    c.advance(31 * MIN); await e.tick();                     // 入队 + 发送
    expect(g.wire.filter(i => i.kind === 'reminder')).toHaveLength(1);
    const { w: u, clock: c3 } = await setup();
    expect(await u.call('m-zhao', '张姐 680（小王）')).toContain('还没入账');
    const h = fakeSender(); const k = dispatcher(u.base, h.sender, c3.now, { draftMaintenance: true });
    c3.advance(31 * MIN); await k.maintainDrafts();            // 只入队
    expect(await u.call('m-zhao', '对')).toContain('已入账');
    await k.tick();
    expect(h.wire).toEqual([]);
    const reportId = (await u.base.listDrafts({ kind: 'report' }))[0]!.draftId;
    expect((await u.base.listNotifications()).find(n => n.notificationId === draftReminderId(reportId))).toMatchObject({ status: 'not_sent', delivery: { error: 'stale_draft_closed' } });
    expect(await u.call('m-zhao', '李姐 300（小王）')).toContain('还没入账');
    expect(await u.call('m-zhao', '取消')).toContain('已取消');
    c3.advance(MIN); await k.tick();                              // 用户取消的草稿：不发作废通知
    c3.jump(Date.parse('2026-11-12T15:30:00Z')); await k.tick();
    expect(h.wire.filter(i => i.kind === 'void')).toEqual([]);
    expect((await u.base.listNotifications()).filter(n => n.kind === 'void')).toEqual([]);
  });
});

describe('M06 开关：生产默认关闭；PG 配置可暂停并保留数据；旧入口不再把出站箱行改成 unknown', () => {
  it('暂停配置：不领取、不维护草稿、行保留；恢复后发送', async () => {
    const { w, clock } = await setup();
    await register(w);
    await w.base.setConfig(NOTIFICATION_DISPATCH_KEY, JSON.stringify({ paused: true }));
    const f = fakeSender(); const d = dispatcher(w.base, f.sender, clock.now);
    expect(await d.tick()).toMatchObject({ paused: true, claimed: 0 });
    expect((await appt(w))[0]!.status).toBe('pending');
    await w.base.setConfig(NOTIFICATION_DISPATCH_KEY, '{oops');
    expect(await d.tick()).toMatchObject({ paused: true });
    await w.base.setConfig(NOTIFICATION_DISPATCH_KEY, JSON.stringify({ paused: false }));
    expect(await d.tick()).toMatchObject({ sent: 1 });
  });
  it('boot：不设 FRONT_CLAW_NOTIFY_DISPATCH=1 或非员工入口 → disabled，发送器零调用', async () => {
    const f = fakeSender();
    const plain = await bootFrontClaw({ legacyEntry: true, env: {}, send: async () => 'sent', model: { complete: async () => ({ type: 'chat', text: 'x' }) } });
    expect(plain.startNotificationDispatch(f.sender)).toBe('disabled');
    await plain.close();
    const flagged = await bootFrontClaw({ legacyEntry: true, env: { FRONT_CLAW_NOTIFY_DISPATCH: '1' }, send: async () => 'sent', model: { complete: async () => ({ type: 'chat', text: 'x' }) } });
    expect(flagged.startNotificationDispatch(f.sender)).toBe('disabled');
    await flagged.close();
    expect(f.calls).toEqual([]);
  });
  it('旧入口维护只结算自己的 UUID 行，不碰出站箱（确定性 ID）行；派发器也不领旧入口的 UUID 行', async () => {
    const store = new MemoryPerformanceStore();
    const base: Notification = { notificationId: 'f'.repeat(64), kind: 'appointment', recipientPersonId: 'p-wang-yj', body: 'x', status: 'pending', relatedId: 'a', createdAt: at, sentAt: null };
    await store.insertNotification(base);
    await store.insertNotification({ ...base, notificationId: '2b7c0b1e-1111-4111-8111-111111111111', kind: 'reminder' });
    const old = createWecomBotHandler({ legacyEntry: true, mode: 'isolated-synthetic', store, now: () => NOW, resolve: id => store.getPersonByMember(id), send: async () => 'sent', model: { complete: async () => ({ type: 'chat', text: 'x' }) } });
    const legacy = new MemoryPerformanceStore();
    await legacy.insertNotification({ ...base, notificationId: '2b7c0b1e-1111-4111-8111-111111111111', kind: 'reminder' });
    const f = fakeSender();
    expect(await dispatcher(legacy, f.sender, () => NOW).tick()).toMatchObject({ claimed: 0 });   // 派发器也不碰旧入口的 UUID 行
    expect((await legacy.listNotifications())[0]!.status).toBe('pending');
    await old.runMaintenance();
    expect((await store.listNotifications()).map(n => [n.notificationId.slice(0, 4), n.status])).toEqual([['ffff', 'pending'], ['2b7c', 'unknown']]);
  });
});

describe('M06 内存实现：条件写语义（PG 实现见 notify-pg-m06）', () => {
  it('enqueue 幂等；transition 以原文为条件；begin 原文不符 = lost', async () => {
    for (const store of [new MemoryPerformanceStore()]) {
      const n: Notification = { notificationId: 'e'.repeat(64), kind: 'appointment', recipientPersonId: 'p', body: 'b', status: 'pending', relatedId: 'r', createdAt: at, sentAt: null };
      expect(await store.enqueueNotification(n)).toBe(true); expect(await store.enqueueNotification({ ...n, body: 'changed' })).toBe(false);
      expect((await store.listNotifications())[0]!.body).toBe('b');
      expect(await store.transitionNotification(n.notificationId, 'wrong', 'sent|-|-|a=1|r=0', at)).toBe(false);
      expect(await store.beginNotificationSend(n.notificationId, 'wrong', { lockKeys: [], decide: () => ({ ok: true, nextRaw: 'x' }) })).toBe('lost');
      const claimed = await store.claimDueNotifications({ nowIso: at, leaseUntil: '2026-11-12T02:01:00.000Z', limit: 5, kinds: ['appointment'], worker: 'w', tokenFor: () => 't' });
      expect(claimed.claimed).toHaveLength(1);
      expect((await store.claimDueNotifications({ nowIso: at, leaseUntil: '2026-11-12T02:01:00.000Z', limit: 5, kinds: ['appointment'], worker: 'w2', tokenFor: () => 't2' })).claimed).toHaveLength(0);
    }
  });
});
