import { afterEach, expect, it } from 'vitest';
import { createNotificationDispatcher, NOTIFICATION_AUDIT_PREFIX, type DispatchEvent } from '../../src/role-eval/notification-dispatch.js';
import { decodeStatus } from '../../src/role-eval/notification-status.js';
import { gate, installPausePoints, type PauseContext } from '../../src/role-eval/pause-points.js';
import { NOW } from '../role-eval/access-fixture-m03.js';
import { worldM05, registerUnnamedAppointment} from '../role-eval/appointment-fixture-m05.js';
import { fakeSender } from '../role-eval/notify-fixture-m06.js';
import { freshDatabase, open, rawQuery, useCluster } from '../migration/pg-harness-m08.js';

// R2a：发送门 fencing 的确定性竞态（PG17 用户态临时集群，全部合成数据）。
// A 领取（f=1）→ A 停在 send-gate:before-begin → 租约过期 → B 重新领取（f=2）…… → 放行 A。
// 断言：A 被挡（不上线、不写状态），发送记录 / 审计里只有 B 一条，终态是 B 的结果。
useCluster();
let uninstall: (() => void) | null = null;
afterEach(() => { uninstall?.(); uninstall = null; });

const LEASE = 60_000;
const LATER = new Date(NOW.getTime() + LEASE + 1_000);
const statusOf = async (url: string) => (await rawQuery(url, `SELECT status FROM front_claw_perf.performance_notifications WHERE kind='appointment'`))[0]!.status as string;
const auditRows = async (url: string) => (await rawQuery(url, `SELECT key FROM front_claw_perf.performance_config WHERE key LIKE $1`, [`${NOTIFICATION_AUDIT_PREFIX}%`])).length;

/** 按到达顺序依次交给 gates[0], gates[1]…；用完后直接放行。 */
function sequence(...gates: ReturnType<typeof gate>[]) {
  let i = 0;
  return (context: PauseContext) => { const g = gates[i++]; return g ? g.hook(context) : undefined; };
}

async function setup() {
  const url = await freshDatabase(); const dbA = await open(url); const dbB = await open(url);
  const w = await worldM05({ store: dbA.store });
  expect(await registerUnnamedAppointment(w, 'm-zhao', '明天下午3点有个客人要来')).toContain('预约还没登记');
  expect(await w.call('m-zhao', '对')).toContain('预约已登记');
  const events: DispatchEvent[] = [];
  const fa = fakeSender(), fb = fakeSender();
  let clockA = NOW;
  const A = createNotificationDispatcher({ store: dbA.store, sender: fa.sender, now: () => clockA, worker: 'w-a', leaseMs: LEASE, onEvent: e => events.push(e) });
  const B = createNotificationDispatcher({ store: dbB.store, sender: fb.sender, now: () => LATER, worker: 'w-b', leaseMs: LEASE, onEvent: e => events.push(e) });
  return { url, dbA, dbB, events, fa, fb, A, B, advanceA: () => { clockA = LATER; }, close: async () => { await dbA.close(); await dbB.close(); } };
}

function assertOnlyB(t: Awaited<ReturnType<typeof setup>>, finalRaw: string, a: { sent: number; lost: number }) {
  expect(t.fa.wire).toEqual([]);                       // A 没有上线
  expect(t.fb.wire).toHaveLength(1);                    // 发送记录只有 B 一条
  expect(a).toMatchObject({ sent: 0, lost: 1 });        // A 在发送门被挡（lost）
  expect(t.events.filter(e => e.type === 'sent').map(e => e.worker)).toEqual(['w-b']);
  expect(t.events.filter(e => e.worker === 'w-a').map(e => e.type)).not.toContain('sent');
  expect(finalRaw.startsWith('sent|')).toBe(true);       // 终态是 B 的结果
  expect(decodeStatus(finalRaw).delivery.attempts).toBe(1); // 只有一次发送尝试
}

it('R2a-1：A 领取后暂停 → 租约过期 → B 领取并发完 → A 恢复去发送/标记 → A 被挡，只有 B 一条', async () => {
  const t = await setup();
  const gA = gate();
  uninstall = installPausePoints({ 'send-gate:before-begin': sequence(gA) });
  const ticking = t.A.tick();
  await gA.reached;
  const claimedByA = await statusOf(t.url);
  expect(decodeStatus(claimedByA).delivery).toMatchObject({ phase: 'claimed', fence: 1, worker: 'w-a' });
  t.advanceA();                                          // 租约过期（A 的时钟也走到过期之后）
  const b = await t.B.tick();
  expect(b).toMatchObject({ claimed: 1, sent: 1 });
  const afterB = await statusOf(t.url);
  gA.release();
  const a = await ticking;
  const finalRaw = await statusOf(t.url);
  expect(finalRaw).toBe(afterB);                         // A 没有改写 B 的终态
  assertOnlyB(t, finalRaw, a);
  expect(await auditRows(t.url)).toBe(0);
  await t.close();
}, 30_000);

it('R2a-2（变体）：A 在 B 领取（f=2）之后、B 发送之前恢复 → A 被挡；B 随后正常发完，只有 B 一条', async () => {
  const t = await setup();
  const gA = gate(), gB = gate();
  uninstall = installPausePoints({ 'send-gate:before-begin': sequence(gA, gB) });
  const tickA = t.A.tick();
  await gA.reached;
  t.advanceA();
  const tickB = t.B.tick();
  await gB.reached;                                      // B 已领取，停在发送门前
  const claimedByB = await statusOf(t.url);
  expect(decodeStatus(claimedByB).delivery).toMatchObject({ phase: 'claimed', fence: 2, worker: 'w-b' });
  gA.release();
  const a = await tickA;                                 // A 先进发送门
  expect(await statusOf(t.url)).toBe(claimedByB);        // A 被挡，没有动 B 的领取
  expect(t.fa.wire).toEqual([]);
  gB.release();
  const b = await tickB;
  expect(b).toMatchObject({ claimed: 1, sent: 1 });
  assertOnlyB(t, await statusOf(t.url), a);
  expect(await auditRows(t.url)).toBe(0);
  await t.close();
}, 30_000);

it('R2a-3（变体）：租约已过期但还没人重领时 A 恢复 → A 仍被挡（租约到期判定），之后 B 领取发完，只有 B 一条', async () => {
  const t = await setup();
  const gA = gate();
  uninstall = installPausePoints({ 'send-gate:before-begin': sequence(gA) });
  const tickA = t.A.tick();
  await gA.reached;
  const claimedByA = await statusOf(t.url);
  t.advanceA();
  gA.release();
  const a = await tickA;
  expect(await statusOf(t.url)).toBe(claimedByA);        // 原文未变、f 未变——挡住 A 的只能是租约到期判定
  expect(t.fa.wire).toEqual([]);
  const b = await t.B.tick();
  expect(b).toMatchObject({ claimed: 1, sent: 1 });
  assertOnlyB(t, await statusOf(t.url), a);
  await t.close();
}, 30_000);
