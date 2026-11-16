/**
 * M06 真实子进程派发 worker（仅测试用；由 notify-pg-m06 用 rolldown 打包后以 node 子进程运行，连隔离 PG17 临时库）。
 * 发送器是假的（只往结果文件写一行），绝不联网。M06_MODE 选择在哪一步 SIGKILL 自己：
 *   normal | crash-before-claim | crash-after-claim | crash-in-begin-tx | crash-on-wire | crash-after-ack
 */
import { appendFileSync } from 'node:fs';
import { FRONT_CLAW_DATABASE_URL, openPerformanceStore } from '../../src/role-eval/performance-open.js';
import { createNotificationDispatcher, type NotificationSender } from '../../src/role-eval/notification-dispatch.js';
import type { PerformanceStore } from '../../src/role-eval/performance-store.js';

const env = process.env;
const mode = env.M06_MODE ?? 'normal', out = env.M06_OUT!, worker = env.M06_WORKER ?? `pid-${process.pid}`;
const fixed = Number(env.M06_NOW_MS);
const log = (line: string) => appendFileSync(out, `${worker} ${line}\n`);
const die = (point: string) => { log(`KILL ${point}`); process.kill(process.pid, 'SIGKILL'); };

const opened = await openPerformanceStore({ [FRONT_CLAW_DATABASE_URL]: env.M06_DB_URL }, { requirePostgres: true });
const base = opened.store;
const store: PerformanceStore = {
  ...base,
  async claimDueNotifications(options) {
    if (mode === 'crash-before-claim') die('before-claim');
    const result = await base.claimDueNotifications(options);
    if (mode === 'crash-after-claim' && result.claimed.length) die('after-claim');
    return result;
  },
  async beginNotificationSend(id, raw, options) {
    return base.beginNotificationSend(id, raw, { ...options, decide(config, row, current) {
      const decision = options.decide(config, row, current);
      if (mode === 'crash-in-begin-tx') die('in-begin-tx'); // 事务未提交即被杀
      return decision;
    } });
  },
  async transitionNotification(id, expected, next, sentAt, fence) {
    if (mode === 'crash-after-ack' && next.startsWith('sent')) die('after-ack-before-status');
    return base.transitionNotification(id, expected, next, sentAt, fence);
  },
};
const sender: NotificationSender = {
  async send(input, beforeSend) {
    try { await beforeSend(); } catch { log(`REFUSED ${input.notificationId}`); return { state: 'blocked', detail: 'authority_refused' }; }
    log(`WIRE ${input.notificationId} ${input.memberId}`);
    if (mode === 'crash-on-wire') die('on-wire');
    return { state: 'accepted', detail: 'sdk_ack_accepted', code: 0 };
  },
};
const dispatcher = createNotificationDispatcher({ store, sender, now: () => new Date(fixed), worker, leaseMs: 60_000,
  onEvent: event => log(`EVENT ${event.type} ${event.notificationId ?? '-'}`) });
const stats = await dispatcher.tick();
log(`DONE ${JSON.stringify(stats)}`);
await opened.close();
