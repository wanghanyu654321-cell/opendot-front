// R2-4：D5-roles-draft 已定规则 → 测试（待定项只列在 REPORT，不在此实现）。
import { describe, expect, it } from 'vitest';
import { CAPABILITIES, decideAccess, TIER_FORBIDDEN, type Capability } from '../../src/role-eval/access-policy.js';
import { APPOINTMENT_RECIPIENTS_KEY } from '../../src/role-eval/appointments.js';
import { createNotificationDispatcher } from '../../src/role-eval/notification-dispatch.js';
import { MemoryPerformanceStore, type Person, type Tier } from '../../src/role-eval/performance-store.js';
import { basePeople, policy } from '../role-eval/access-fixture-m03.js';
import { membersM05, policyM05, worldM05, registerUnnamedAppointment} from '../role-eval/appointment-fixture-m05.js';
import { peopleM04 } from '../role-eval/ledger-fixture-m04.js';
import { fakeSender, manualClock, MIN } from '../role-eval/notify-fixture-m06.js';

const ALL = { employee: [...CAPABILITIES], manager: [...CAPABILITIES], owner: [...CAPABILITIES] } as Record<Tier, Capability[]>;
const person = (id: string) => basePeople.find(p => p.personId === id)!;

describe('R2 D5 档位上限：策略配得再宽也越不过已定规则', () => {
  it('员工：查他人/全店/排名、设目标、改他人账一律拒绝；本人报数/代报/本人进度/改本人账照常', () => {
    const raw = JSON.stringify(policy(1, undefined, { roles: ALL }));
    const zhao = person('p-zhao');
    for (const cap of ['progress_other', 'store_summary', 'unreported', 'stores_ranking', 'target_set', 'correct_store'] as Capability[]) {
      expect(decideAccess(raw, zhao, cap, 's-b'), cap).toMatchObject({ allowed: false, reason: 'capability_denied' });
    }
    for (const cap of ['report_self', 'report_proxy', 'progress_self', 'correct_own', 'appointment_submit'] as Capability[]) expect(decideAccess(raw, zhao, cap, 's-b').allowed, cap).toBe(true);
  });
  it('店长：本店全员查询、设本店月目标照常；老板：名下门店查询照常，但不能报单（含代报）', () => {
    const raw = JSON.stringify(policy(1, undefined, { roles: ALL }));
    for (const cap of ['progress_other', 'store_summary', 'unreported', 'target_set'] as Capability[]) expect(decideAccess(raw, person('p-wang-yj'), cap, 's-b').allowed, cap).toBe(true);
    for (const cap of ['progress_other', 'store_summary', 'stores_ranking'] as Capability[]) expect(decideAccess(raw, person('p-boss'), cap, 's-a').allowed, cap).toBe(true);
    expect(TIER_FORBIDDEN.manager).toEqual([]); expect(TIER_FORBIDDEN.owner).toEqual(["report_self", "report_proxy"]);
    expect(Object.isFrozen(TIER_FORBIDDEN.employee)).toBe(true);
  });
  it('跨店代报对所有档位都拒绝（已定）：括号里写他店员工 → DENIED，零写入', async () => {
    for (const member of ['m-zhao', 'm-wang-yj']) {
      const w = await worldM05();
      const before = await w.snapshot();
      expect(await w.call(member, '张姐 680（小林）')).toContain('跨店不能代报');
      expect(await w.call(member, '给测试A店小林记赵姐1.5k')).toContain('跨店不能代报');
      expect(await w.snapshot()).toEqual(before);
    }
  });
  it('员工端到端：即便策略给了全店查询，「本店汇总」「设小王本月目标」也拒绝且零写', async () => {
    const w = await worldM05({ policy: policyM05(1, membersM05(), { roles: ALL }) });
    const before = await w.snapshot();
    expect(await w.call('m-zhao', '给小王定本月目标3万')).not.toContain('还没');
    expect(await w.snapshot()).toEqual(before);
  });
});

describe('R2 D5 提醒对象', () => {
  it('预约提醒只给店长档：指定收件人是老板 → 不排提醒（预约照样成立）', async () => {
    const people: Person[] = peopleM04.map(p => p.personId === 'p-boss' ? { ...p, storeId: 's-b', storeName: '测试B店' } : p);
    const members = membersM05(); members['p-boss'] = { role: 'owner', storeIds: ['s-b'], status: 'active' };
    const w = await worldM05({ people, policy: policyM05(1, members), recipients: JSON.stringify({ version: 1, stores: { 's-b': 'p-boss' } }) });
    const echo = await registerUnnamedAppointment(w, 'm-zhao', '明天三点有个客人要来');
    expect(echo).toContain('登记后不排店长提醒');
    expect(await w.call('m-zhao', '对')).toContain('预约已登记');
    expect((await w.base.listNotifications()).filter(n => n.kind === 'appointment')).toHaveLength(0);
  });
  it('指定收件人是员工 → 不排提醒', async () => {
    const w = await worldM05({ policy: policyM05(1, membersM05(), { roles: ALL }), recipients: JSON.stringify({ version: 1, stores: { 's-b': 'p-xw' } }) });
    expect(await registerUnnamedAppointment(w, 'm-zhao', '明天三点有个客人要来')).toContain('登记后不排店长提醒');
  });
  it('R3（D85）30 分钟未确认提醒：发给报单人本人，不分档位（员工、店长都提醒一次）', async () => {
    const clock = manualClock();
    const w = await worldM05({ now: clock.now, store: new MemoryPerformanceStore() });
    expect(await w.call('m-zhao', '张姐 680（小王）')).toContain('还没入账');
    expect(await w.call('m-wang-yj', '李姐 880（小王）')).toContain('还没入账');
    const f = fakeSender(); let n = 0;
    const d = createNotificationDispatcher({ store: w.base, sender: f.sender, now: clock.now, worker: 'w1', token: () => `t${++n}` });
    clock.advance(31 * MIN); await d.tick(); await d.tick();
    expect(f.wire.filter(i => i.kind === 'reminder').map(i => i.memberId).sort()).toEqual(['m-wang-yj', 'm-zhao']);
    expect((await w.base.listNotifications()).filter(x => x.kind === 'reminder')).toHaveLength(2);
  });
  // R3（D85）：提醒不再按档位筛；这里保留的是「排队后身份行变了（档位变化）→ 入口门 actor_changed，不发旧提醒」。
  it('已排队的提醒，发送前报单人身份行变化（升为店长）→ 不发（发送前按当前身份重判）', async () => {
    const clock = manualClock();
    const w = await worldM05({ now: clock.now, store: new MemoryPerformanceStore() });
    expect(await w.call('m-zhao', '张姐 680（小王）')).toContain('还没入账');
    const f = fakeSender(); let n = 0;
    const d = createNotificationDispatcher({ store: w.base, sender: f.sender, now: clock.now, worker: 'w1', token: () => `t${++n}`, kinds: ['appointment', 'correction', 'void'] });
    clock.advance(31 * MIN); await d.tick();
    expect((await w.base.listNotifications()).filter(x => x.kind === 'reminder')).toHaveLength(1);
    const zhao = (await w.base.getPerson('p-zhao'))!;
    await w.base.savePerson({ ...zhao, tier: 'manager' });
    const g = createNotificationDispatcher({ store: w.base, sender: f.sender, now: clock.now, worker: 'w1', token: () => `u${++n}` });
    await g.tick(); await g.tick();
    expect(f.wire.filter(i => i.kind === 'reminder')).toHaveLength(0);
  });
});
void APPOINTMENT_RECIPIENTS_KEY;
