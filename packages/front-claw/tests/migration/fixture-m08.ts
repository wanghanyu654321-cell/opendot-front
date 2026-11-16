import { vi } from 'vitest';
import type { PerformanceStore } from '../../src/role-eval/performance-store.js';
import { createWecomBotHandler } from '../../src/role-eval/wecom-bot-unified-handler.js';
import { createNotificationDispatcher, type NotificationSender } from '../../src/role-eval/notification-dispatch.js';
import { encodeStatus } from '../../src/role-eval/notification-status.js';
import type { OpenedPerformanceStore } from '../../src/role-eval/performance-open.js';
import { NOW } from '../role-eval/access-fixture-m03.js';
import { worldM05 } from '../role-eval/appointment-fixture-m05.js';
import { ticking } from '../role-eval/ledger-fixture-m04.js';
import { fakeSender } from '../role-eval/notify-fixture-m06.js';
import { seedBindings } from '../opendot/fixture-m07.js';

/** M08 合成数据（全部合成，非真实业务）：M01–M07 流程造出的库，外加旧入口遗留行与运行态行。 */
export const T0 = NOW.getTime();
export const say = (round: number) => `明天下午3点${String(round).padStart(2, '0')}分王姐要来`;
const LEGACY_APPOINTMENT = '7d0c5a8e-0000-4000-8000-00000000a001';
const LEGACY_NOTICE = '7d0c5a8e-0000-4000-8000-00000000b001';

/** 不重复播种的员工入口（目标库迁移后继续营业用）；消息号带前缀，避免与源库的确定性 ID 撞车。 */
export function handlerFor(store: PerformanceStore, prefix: string, now: () => Date = ticking(T0 + 3_600_000)) {
  const handler = createWecomBotHandler({
    legacyEntry: true, mode: 'isolated-synthetic', store, now, resolve: id => store.getPersonByMember(id),
    send: vi.fn(async () => 'sent' as const), model: { complete: vi.fn(async () => ({ type: 'chat' as const, text: '不应进入模型' })) },
    employeeLoop: true, accessPolicy: true,
  });
  let seq = 0;
  return async (memberId: string, text: string) =>
    (await handler.handleMessage({ memberId, text, messageId: `${prefix}-${++seq}`, sessionId: `${prefix}-session-${memberId}`, bindingVersion: 1 })).replies.join('\n');
}
export function dispatcher(store: PerformanceStore, sender: NotificationSender, worker: string, at = T0) {
  let n = 0;
  return createNotificationDispatcher({ store, sender, now: () => new Date(at), worker, leaseMs: 60_000, token: () => `tok${worker}${++n}` });
}

/**
 * 在 v7 库上跑 M01–M07 流程：报数入账、更正、目标、预约（产生提醒）、派发（sent / 失败排队 / 结果未知），
 * 再写入旧入口遗留行（pending_manager 预约、UUID 通知）、崩溃留下的 sending 租约、畸形 pending、M07 绑定与租约行。
 */
export async function populate(db: OpenedPerformanceStore, raw: (sql: string, params?: unknown[]) => Promise<unknown>) {
  const w = await worldM05({ store: db.store, now: ticking(T0) });
  const expectOk = (reply: string, part: string) => { if (!reply.includes(part)) throw Error(`populate: ${reply}`); };
  await w.call('m-zhao', '12号测试B店\n560（小赵）'); expectOk(await w.call('m-zhao', '对'), '已入账');
  await w.call('m-wang-yj', '12号测试B店\n330（小赵）'); expectOk(await w.call('m-wang-yj', '对'), '已入账');
  await w.call('m-zhao', '880（小赵）'); expectOk(await w.call('m-zhao', '对'), '已入账');
  await w.call('m-zhao', '把刚才那笔改成800'); await w.call('m-zhao', '对');
  await w.call('m-zhou', '给小林定本月目标3万'); await w.call('m-zhou', '对');
  for (let i = 0; i < 6; i++) { await w.call('m-zhao', say(i)); expectOk(await w.call('m-zhao', '对'), '预约已登记'); }
  await w.call('m-zhao', '12号测试B店\n777（小赵）'); // 留一个待确认草稿
  const plan = (_: unknown, call: number) => call === 1 ? { state: 'accepted' as const, detail: 'sdk_ack_accepted', code: 0 }
    : call === 2 ? { state: 'rejected' as const, detail: 'sdk_ack_rejected', code: 93000 } : call === 3 ? 'throw' as const : { state: 'accepted' as const, detail: 'sdk_ack_accepted', code: 0 };
  const f = fakeSender(plan as never);
  await createNotificationDispatcher({ store: db.store, sender: f.sender, now: () => new Date(T0), worker: 'src', leaseMs: 60_000, batch: 3, token: () => 'toksrc' }).tick();
  // 崩溃留下的 sending 租约、畸形 pending、旧入口遗留行、M07 绑定与租约。
  const notes = (await db.store.listNotifications()).filter(n => n.status === 'pending');
  if (notes[0]) await raw(`UPDATE front_claw_perf.performance_notifications SET status=$1 WHERE notification_id=$2`,
    [encodeStatus('pending', { phase: 'sending', dueAt: new Date(T0 + 30_000).toISOString(), attempts: 1, resends: 0, token: 'tokcrash', worker: 'crashed' }), notes[0].notificationId]);
  if (notes[1]) await raw(`UPDATE front_claw_perf.performance_notifications SET status=$1 WHERE notification_id=$2`, ['pending|garbage|queued|a=1|r=0', notes[1].notificationId]);
  await raw(`INSERT INTO front_claw_perf.performance_appointments (appointment_id, store_id, employee_person_id, customer_name, when_text, note, status, created_at) VALUES ($1,'s-b','p-zhao','旧客','2026-11-01 15:00','旧入口','pending_manager','2026-10-31T02:00:00.000Z')`, [LEGACY_APPOINTMENT]);
  await raw(`INSERT INTO front_claw_perf.performance_appointments (appointment_id, store_id, employee_person_id, customer_name, when_text, note, status, created_at) VALUES ($1,'s-b','p-zhao','旧客2','2026-11-02 15:00','旧入口','confirmed','2026-10-31T03:00:00.000Z')`, [LEGACY_APPOINTMENT.replace(/1$/, '2')]);
  await raw(`INSERT INTO front_claw_perf.performance_notifications (notification_id, kind, recipient_person_id, body, status, related_id, created_at, sent_at) VALUES ($1,'appointment_pending','p-wang-yj','旧提醒','pending',$2,'2026-10-31T02:00:00.000Z',NULL)`, [LEGACY_NOTICE, LEGACY_APPOINTMENT]);
  await seedBindings(db.store, db.bindings);
  await db.store.setConfig('front-claw-opendot-consumer', JSON.stringify({ owner: 'old-host', token: 't', until: T0 + 30_000 }));
  return { wire: f.wire.length };
}
