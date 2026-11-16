import { afterEach, expect, it } from 'vitest';
import { createNotificationDispatcher, requeueUnknownNotification } from '../../src/role-eval/notification-dispatch.js';
import { decodeStatus } from '../../src/role-eval/notification-status.js';
import { FENCE_OF_STATUS } from '../../src/role-eval/performance-postgres.js';
import { gate, installPausePoints } from '../../src/role-eval/pause-points.js';
import { NOW } from '../role-eval/access-fixture-m03.js';
import { worldM05, registerUnnamedAppointment} from '../role-eval/appointment-fixture-m05.js';
import { fakeSender } from '../role-eval/notify-fixture-m06.js';
import { freshDatabase, open, rawQuery, useCluster } from '../migration/pg-harness-m08.js';

// R3（f 单调）：PG17 用户态临时集群，合成数据。f 只由领取时数据库内 f = f + 1 增长；重试、终态、unknown、人工补发都保留 f。
useCluster();
let uninstall: (() => void) | null = null;
afterEach(() => { uninstall?.(); uninstall = null; });
const MIN = 60_000;
const at = (ms: number) => new Date(NOW.getTime() + ms);
const row = async (url: string) => (await rawQuery(url, `SELECT status FROM front_claw_perf.performance_notifications WHERE kind='appointment'`))[0]! as { status: string };

async function setup() {
  const url = await freshDatabase(); const db = await open(url); const other = await open(url);
  const w = await worldM05({ store: db.store });
  expect(await registerUnnamedAppointment(w, 'm-zhao', '明天下午3点有个客人要来')).toContain('预约还没登记');
  expect(await w.call('m-zhao', '对')).toContain('预约已登记');
  return { url, db, other, close: async () => { await db.close(); await other.close(); } };
}

it('R3-F1：f 全程单调——领取 → 拒收重试 → 再领 → unknown → 人工补发 → 再领 → 发出；f 依次 1,1,2,2,2,3,3，从不回 0/1', async () => {
  const t = await setup();
  const seen: number[] = [];
  const record = async () => { const r = await row(t.url); seen.push(decodeStatus(r.status).delivery.fence); };
  const plans = ['rejected', 'unknown', 'accepted'] as const; let call = 0;
  const sender = fakeSender(() => ({ state: plans[call++]!, detail: 'r3', code: 1 }));
  let clock = NOW;
  const d = createNotificationDispatcher({ store: t.db.store, sender: sender.sender, now: () => clock, worker: 'w', leaseMs: MIN });
  uninstall = installPausePoints({ 'send-gate:before-begin': async () => { await record(); } });
  await d.tick(); await record();                         // 拒收 → queued，f 保留
  clock = at(2 * MIN); await d.tick(); await record();    // 再领 f+1，unknown 保留
  expect(await requeueUnknownNotification(t.db.store, (await t.db.store.listNotifications())[0]!.notificationId, { actor: 'r3', reason: 'synthetic', now: clock })).toBe('requeued');
  await record();                                         // 补发 queued，f 保留
  clock = at(4 * MIN); await d.tick(); await record();    // 再领 f+1 → sent，f 保留
  console.info(JSON.stringify({ fences: seen, final: (await row(t.url)).status }));
  expect(seen).toEqual([1, 1, 2, 2, 2, 3, 3]);
  for (let i = 1; i < seen.length; i++) expect(seen[i]!).toBeGreaterThanOrEqual(seen[i - 1]!);
  expect((await row(t.url)).status.startsWith('sent|')).toBe(true);
  await t.close();
}, 30_000);

it('R3-F2：去掉整段原文比对、只靠 f 条件也挡得住旧领取者——A(f=1) 暂停；B 重领(f=2) 被拒收重试；C 再领(f=3) 发出；A 的 f 条件 0 行，A 不上线', async () => {
  const t = await setup();
  const g = gate();
  uninstall = installPausePoints({ 'send-gate:before-begin': g.hook });
  const fa = fakeSender(), fb = fakeSender(() => ({ state: 'rejected', detail: 'r3', code: 1 })), fc = fakeSender();
  let clockA = NOW;
  const A = createNotificationDispatcher({ store: t.db.store, sender: fa.sender, now: () => clockA, worker: 'w-a', leaseMs: MIN });
  const ticking = A.tick(); await g.reached;
  const rawA = (await row(t.url)).status; const id = (await t.db.store.listNotifications())[0]!.notificationId;
  expect(decodeStatus(rawA).delivery.fence).toBe(1);
  const later = at(MIN + 1_000), latest = at(10 * MIN);
  expect(await createNotificationDispatcher({ store: t.other.store, sender: fb.sender, now: () => later, worker: 'w-b', leaseMs: MIN }).tick()).toMatchObject({ claimed: 1, retried: 1 });
  expect(decodeStatus((await row(t.url)).status).delivery).toMatchObject({ phase: 'queued', fence: 2 });
  // C 领取但先不发：此刻原文与 A 不同，只看 f——A 的 f=1 不能再匹配（修前 B 的重试把 f 丢回 0，C 又领到 f=1，会匹配）。
  const gc = gate(); uninstall(); uninstall = installPausePoints({ 'send-gate:before-begin': gc.hook });
  const C = createNotificationDispatcher({ store: t.other.store, sender: fc.sender, now: () => latest, worker: 'w-c', leaseMs: MIN });
  const tickC = C.tick(); await gc.reached;
  const rawC = (await row(t.url)).status;
  expect(decodeStatus(rawC).delivery).toMatchObject({ phase: 'claimed', fence: 3, worker: 'w-c' });
  const fOnly = await rawQuery(t.url, `UPDATE front_claw_perf.performance_notifications SET status=status WHERE notification_id=$1 AND ${FENCE_OF_STATUS} = $2 RETURNING notification_id`, [id, decodeStatus(rawA).delivery.fence]);
  expect(fOnly).toEqual([]);
  clockA = latest; g.release();
  expect(await ticking).toMatchObject({ sent: 0, lost: 1 });
  expect(fa.wire).toEqual([]);
  gc.release(); expect(await tickC).toMatchObject({ sent: 1 });
  expect(fc.wire).toHaveLength(1); expect(fb.wire).toHaveLength(1);
  const final = (await row(t.url)).status;
  console.info(JSON.stringify({ rawA, rawC, final }));
  expect(decodeStatus(final).delivery.fence).toBe(3);
  await t.close();
}, 30_000);
