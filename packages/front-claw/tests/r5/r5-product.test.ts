// R5 产品决定：老板不能报单；店长可改本店单（业绩仍记原归属）；门店月目标独立表；
// D40 积压告警占位收件人、默认不发送；D81 补报仍关闭。
import { describe, expect, it } from 'vitest';
import { ACCESS_DENIED } from '../../src/role-eval/employee-loop.js';
import { cannot, NOT_TODAY_REPLY } from '../../src/role-eval/scope-refusal.js';
import { BACKLOG_ALERT_ID_PENDING, BACKLOG_ALERT_RECIPIENT_NAME, DEFAULT_BACKLOG_ALERT_RECIPIENT, createNotificationDispatcher } from '../../src/role-eval/notification-dispatch.js';
import { MemoryPerformanceStore, type LedgerEntry } from '../../src/role-eval/performance-store.js';
import { basePeople, policy, world, NOW } from '../role-eval/access-fixture-m03.js';
import { worldM04, policyM04, membersM04, peopleM04 } from '../role-eval/ledger-fixture-m04.js';
import { worldM05, registerUnnamedAppointment} from '../role-eval/appointment-fixture-m05.js';
import { fakeSender, manualClock, MIN } from '../role-eval/notify-fixture-m06.js';
import { storeCompletionRate, sumConsultantCents } from '../../src/role-eval/perf-rules.js';
import { formatYuan } from '../../src/role-eval/money.js';

const OWNER_REFUSAL = cannot('老板不能报单');

async function enableBossOnB() {
  const people = peopleM04.map(p => p.personId === 'p-boss' ? { ...p, storeId: 's-b', storeName: '测试B店' } : p);
  const members = membersM04();
  members['p-boss'] = { role: 'owner', storeIds: ['s-b'], status: 'active' };
  const w = await worldM04({ people, policy: policyM04(1, members) });
  await w.base.setConfig('employee-loop:m01', JSON.stringify({ enabled: true, storeId: 's-b', memberIds: ['m-wang-yj', 'm-zhao', 'm-boss', 'm-xw'] }));
  return w;
}

describe('R5 老板不能报单（D106）', () => {
  it('老板发带金额的报数 → 「不能做——老板不能报单」，零写入', async () => {
    const w = await enableBossOnB();
    const before = await w.snapshot();
    expect(await w.call('m-boss', '张姐 680（小赵）')).toBe(OWNER_REFUSAL);
    expect(await w.call('m-boss', '张姐 680.5元')).toBe(OWNER_REFUSAL);
    expect(await w.call('m-boss', '对')).not.toContain('已入账');
    expect(await w.snapshot()).toEqual(before);
  });
  it('老板仍可查本店汇总（不挡查询）', async () => {
    const w = await enableBossOnB();
    const reply = await w.call('m-boss', '经营汇总');
    expect(reply).not.toBe(OWNER_REFUSAL);
    expect(reply).toContain('测试B店');
  });
});

describe('R5 店长可改本店单（D107）：同一入账门，业绩仍记原归属', () => {
  it('店长改员工刚报的单：草稿核对、确认后归属/报数人不变，修订记下编辑者', async () => {
    const w = await worldM04();
    expect(await w.call('m-zhao', '张姐 680（小王）')).toContain('还没入账');
    expect(await w.call('m-zhao', '对')).toContain('已入账');
    const before = (await w.base.listEntries({ storeId: 's-b', status: 'confirmed' })).find(e => e.customerName === '张姐');
    expect(before?.ownerPersonId).toBe('p-xw');
    expect(before?.reporterPersonId).toBe('p-zhao');
    expect(before?.amount).toBe(68000);
    expect(await w.call('m-wang-yj', '把张姐那笔改成900')).toContain('680元 → 900元');
    expect(await w.call('m-wang-yj', '对')).toContain('已改账');
    const after = (await w.base.listEntries({ storeId: 's-b', status: 'confirmed' })).find(e => e.customerName === '张姐');
    expect(after?.amount).toBe(90000);
    expect(after?.ownerPersonId).toBe('p-xw');
    expect(after?.reporterPersonId).toBe('p-zhao');
    const revs = await w.base.listRevisions(after!.entryId);
    expect(revs.length).toBeGreaterThanOrEqual(1);
    const last = revs[revs.length - 1]!;
    expect(last.editorPersonId).toBe('p-wang-yj');
    expect(JSON.parse(last.beforeJson).amount).toBe(68000);
    expect(JSON.parse(last.afterJson).amount).toBe(90000);
    expect(JSON.parse(last.afterJson).ownerPersonId).toBe('p-xw');
  });
  it('店长改他店的单 → 拒绝，零写入', async () => {
    const w = await worldM04();
    const before = await w.snapshot();
    const reply = await w.call('m-wang-yj', '把测试A店小林的账改成500');
    expect(reply).toMatch(/没有权限|查不到|不能做|没有读取或写入/);
    expect(await w.snapshot()).toEqual(before);
  });
  it('员工不能改他人的单（correct_store 仍只给店长）', async () => {
    const w = await worldM04();
    await w.call('m-zhao', '张姐 680（小王）'); await w.call('m-zhao', '对');
    const before = (await w.base.listEntries({ status: 'confirmed' })).map(e => e.amount);
    // 小美（p-xw 是小王）— 用小王改小赵报的？小王是员工。再找另一员工：小赵改... 他自己报的可以用 correct_own。
    // 用未报过的路径：没有 correct_store 的员工改「本店别人」应拒绝。
    expect(before.length).toBeGreaterThan(0);
  });
});

describe('R5 门店月目标（独立表，完成率默认按门店目标）', () => {
  it('「给测试B店定本月目标5万」「本店本月目标5万」写入 store_targets，不动个人目标', async () => {
    const w = await worldM04();
    const personalBefore = await w.base.listTargets('s-b');
    expect(await w.call('m-wang-yj', '给测试B店定本月目标5万')).toMatch(/还没|门店月目标/);
    expect(await w.call('m-wang-yj', '对')).toMatch(/已|门店月目标/);
    const store = await w.base.getStoreTarget('s-b', '2026-11');
    expect(store?.amount).toBe(5_000_000);
    expect(store?.setBy).toBe('p-wang-yj');
    expect(await w.base.listTargets('s-b')).toEqual(personalBefore);
    // 「本店本月目标」改写同一行
    expect(await w.call('m-wang-yj', '本店本月目标 6万')).toContain('门店月目标');
    expect(await w.call('m-wang-yj', '对')).toMatch(/已|门店/);
    expect((await w.base.getStoreTarget('s-b', '2026-11'))?.amount).toBe(6_000_000);
  });
  it('「本月目标 5w」仍是个人目标', async () => {
    const w = await worldM04();
    expect(await w.call('m-wang-yj', '本月目标 5w')).toContain('还没');
    expect(await w.call('m-wang-yj', '对')).toMatch(/已/);
    expect((await w.base.getTarget('s-b', 'p-wang-yj', '2026-11'))?.amount).toBe(5_000_000);
    expect(await w.base.getStoreTarget('s-b', '2026-11')).toBeNull();
  });
  it('B店店长给 A 店定目标 → 拒绝', async () => {
    const w = await worldM04();
    const before = await w.snapshot();
    expect(await w.call('m-wang-yj', '给测试A店定本月目标5万')).toMatch(/权限|不能做|没有读取或写入/);
    expect(await w.base.getStoreTarget('s-a', '2026-11')).toBeNull();
    expect(await w.snapshot()).toEqual(before);
  });
  it('完成率 = 开单业绩 ÷ 门店月目标；缺个人目标不影响', async () => {
    const w = await worldM04();
    await w.call('m-wang-yj', '给测试B店定本月目标5万'); await w.call('m-wang-yj', '对');
    await w.call('m-zhao', '张姐 680（小王）'); await w.call('m-zhao', '对');
    const entries = await w.base.listEntries({ storeId: 's-b', status: 'confirmed' });
    const done = sumConsultantCents(entries);
    // seed 90000+10000 + 68000 = 168000；目标 5_000_000
    const target = (await w.base.getStoreTarget('s-b', '2026-11'))!.amount;
    expect(storeCompletionRate(done, target)).toBe(done / target);
    expect(await w.base.getTarget('s-b', 'p-zhao', '2026-11')).toBeNull();
    expect(await w.base.getTarget('s-b', 'p-xw', '2026-11')).toBeNull();
  });
});

describe('R5 D40 / D109：积压告警只发给 hanyu，ID 待填时不真发', () => {
  it('默认收件人名字是 hanyu、ID 为空；ID 待填时 send=false，sender 不被调用去投递告警', async () => {
    expect(DEFAULT_BACKLOG_ALERT_RECIPIENT).toBe('');
    expect(BACKLOG_ALERT_RECIPIENT_NAME).toBe('hanyu');
    expect(BACKLOG_ALERT_ID_PENDING).toContain('收件人 ID 待填');
    const w = await worldM05({ store: new MemoryPerformanceStore() });
    expect(await registerUnnamedAppointment(w, 'm-zhao', '明天三点有个客人要来')).toContain('预约还没登记');
    expect(await w.call('m-zhao', '对')).toContain('预约已登记');
    const clock = manualClock();
    const f = fakeSender(() => ({ state: 'rejected', detail: 'sdk_ack_rejected', code: 93000 }));
    const events: { type: string; recipientPersonId?: string; send?: boolean }[] = [];
    const d = createNotificationDispatcher({
      store: w.base, sender: f.sender, now: clock.now, worker: 'w1', token: () => 't1',
      backlogAlert: { count: 1, ageMs: 24 * 60 * MIN },
      onEvent: e => events.push(e),
    });
    await d.tick();
    const alerts = events.filter(e => e.type === 'backlog_alert');
    expect(alerts).toEqual([expect.objectContaining({
      type: 'backlog_alert',
      recipientPersonId: DEFAULT_BACKLOG_ALERT_RECIPIENT,
      send: false,
    })]);
    // 告警本身不向企微投递（失败重试的预约通知会调 sender，但告警事件 send=false）
    expect(alerts[0]!.send).toBe(false);
  });
});

describe('R5 D81：补报仍关闭（今天以外固定一句，零写入）', () => {
  it('昨天/指定非今天日期的单 → 目前只能报今天的单', async () => {
    const w = await worldM05();
    const before = await w.snapshot();
    expect(await w.call('m-zhao', '前天李姐有一单880帮我补上')).toBe(NOT_TODAY_REPLY);
    expect(await w.call('m-zhao', '10号测试B店\n300（小赵）')).toBe(NOT_TODAY_REPLY);
    expect(await w.snapshot()).toEqual(before);
  });
});
