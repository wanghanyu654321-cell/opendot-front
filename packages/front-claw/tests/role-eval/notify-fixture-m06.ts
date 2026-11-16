import { vi } from 'vitest';
import type { NotificationSendInput, NotificationSendResult, NotificationSender } from '../../src/role-eval/notification-dispatch.js';
import { NOW } from './access-fixture-m03.js';

/**
 * M06 假发送器（只记录，不联网）。契约同生产：先 await beforeSend()，它抛错就不“上线”。
 * plan 返回：结果对象；'hang-before'（领取后、beforeSend 前卡住）；'hang-after'（beforeSend 后卡住=已上线但无回执）；'throw'（发送中抛错）。
 */
export type Plan = NotificationSendResult | 'hang-before' | 'hang-after' | 'throw' | { deferred: Promise<NotificationSendResult> };
export function fakeSender(plan: (input: NotificationSendInput, call: number) => Plan = () => ({ state: 'accepted', detail: 'sdk_ack_accepted', code: 0 })) {
  const calls: NotificationSendInput[] = [];
  /** 通过 beforeSend、真正“上线”的消息。 */
  const wire: NotificationSendInput[] = [];
  const sender: NotificationSender = {
    async send(input, beforeSend) {
      calls.push(input);
      const step = plan(input, calls.length);
      if (step === 'hang-before') return new Promise<NotificationSendResult>(() => {});
      try { await beforeSend(); } catch { return { state: 'blocked', detail: 'authority_refused' }; }
      wire.push(input);
      if (step === 'hang-after') return new Promise<NotificationSendResult>(() => {});
      if (step === 'throw') throw Error('socket_closed');
      if ('deferred' in step) return step.deferred;
      return step;
    },
  };
  return { sender, calls, wire, spy: vi.fn() };
}
/** 可控时钟：读取不自动前进（dispatcher 与 handler 共用）；advance/jump 显式移动。 */
export function manualClock(start = NOW.getTime()) {
  let t = start;
  return { now: () => new Date(t), advance(ms: number) { t += ms; }, jump(ms: number) { t = ms; }, get ms() { return t; } };
}
export const MIN = 60_000;
