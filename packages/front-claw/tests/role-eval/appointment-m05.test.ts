import { describe, expect, it } from 'vitest';
import { ACCESS_DENIED, POLICY_CHANGED } from '../../src/role-eval/employee-loop.js';
import { updateAccessPolicy } from '../../src/role-eval/access-policy.js';
import { createWecomBotHandler } from '../../src/role-eval/wecom-bot-unified-handler.js';
import { MemoryPerformanceStore, type Draft, type PerformanceStore } from '../../src/role-eval/performance-store.js';
import { APPOINTMENT_RECIPIENTS_KEY, appointmentContentId, parseAppointmentRequest } from '../../src/role-eval/appointments.js';
import { NOW } from './access-fixture-m03.js';
import { faultyStore, membersM05, policyM05, worldM05, registerUnnamedAppointment} from './appointment-fixture-m05.js';

const at = NOW.toISOString();
const NO_DRAFT = 'Front Claw：没有待确认的本人草稿，请先发送报数清单。';
type W = Awaited<ReturnType<typeof worldM05>>;
const appts = (w: W) => w.base.listAppointments();
const notices = async (w: W) => (await w.base.listNotifications()).filter(n => n.kind === 'appointment');
async function bump(store: PerformanceStore, from: number, next: ReturnType<typeof policyM05>) {
  expect(await updateAccessPolicy(store, { expectedVersion: from, next, actor: 'test-admin', reason: 'test', at })).toEqual({ ok: true, version: next.version });
}
/** 可跳的时钟：每次读 +1 秒；jump 跳到指定时刻。 */
function clock(start = NOW.getTime()) { let t = start; return { now: () => new Date(t += 1000), jump(ms: number) { t = ms; } }; }
/** 拒绝/未登记：回复匹配，预约/提醒/草稿都不变，未发送。 */
async function unchanged(w: W, memberId: string, text: string, expected: string | RegExp) {
  const before = { a: await appts(w), n: await w.base.listNotifications(), d: await w.base.listDrafts() };
  const reply = await registerUnnamedAppointment(w, memberId, text);
  if (typeof expected === 'string') expect(reply).toBe(expected); else expect(reply).toMatch(expected);
  expect({ a: await appts(w), n: await w.base.listNotifications(), d: await w.base.listDrafts() }).toEqual(before);
  expect(w.send).not.toHaveBeenCalled();
  return reply;
}

describe('M05 登记即成立：PM 例句、回显后「对」、待发提醒只落库不发送', () => {
  it('「明天三点有个客人要来」→ 回显（日期/星期/时间/顾客/提醒对象）→ 对 → 预约 1 条 registered + 待发提醒 1 条（仅提醒，无需回复）；未调用发送', async () => {
    const w = await worldM05();
    const echo = await registerUnnamedAppointment(w, 'm-zhao', '明天三点有个客人要来');
    expect(echo).toContain('预约还没登记'); expect(echo).toContain('11月13日（周五）15:00'); expect(echo).toContain('未留名'); expect(echo).toContain('苏晓禾');
    expect(await appts(w)).toEqual([]); expect(await notices(w)).toEqual([]);
    const done = await w.call('m-zhao', '对');
    expect(done).toContain('预约已登记（登记即成立）'); expect(done).toContain('已排队提醒指定店长 苏晓禾'); expect(done).toContain('尚未发送');
    expect(done).not.toMatch(/已送达|已通知|已读/);
    const [row] = await appts(w);
    expect(row).toMatchObject({ storeId: 's-b', employeePersonId: 'p-zhao', customerName: '未留名', whenText: '2026-11-13 15:00', status: 'registered' });
    expect(done).toContain(row!.appointmentId.slice(0, 8));
    const [notice] = await notices(w);
    expect(notice).toMatchObject({ recipientPersonId: 'p-wang-yj', status: 'pending', relatedId: row!.appointmentId, sentAt: null });
    expect(notice!.body).toContain('仅提醒，无需回复'); expect(notice!.body).toContain(row!.appointmentId.slice(0, 8)); expect(notice!.body).toContain('测试B店');
    // M07 删除了未接线的 buildReminderPayload（真实派发走 M06 createBotNotificationSender）；这里只断言正文可直接作为企微 markdown 推送。
    expect(Buffer.byteLength(notice!.body)).toBeLessThanOrEqual(16384);
    expect(w.send).not.toHaveBeenCalled();
    expect(w.model).not.toHaveBeenCalled();
  });

  it('有/无空格同一业务：「明天 15:00 李女士 来做美甲」与「明天15:00李女士来做美甲」同一预约号；重复消息不增', async () => {
    const w = await worldM05();
    const a = await w.call('m-zhao', '明天 15:00 李女士 来做美甲');
    expect(a).toContain('顾客 李女士'); expect(a).toContain('项目 美甲');
    expect(await w.call('m-zhao', '对')).toContain('预约已登记');
    const again = await unchanged(w, 'm-zhao', '明天15:00李女士来做美甲', /已经登记过/);
    expect(again).toContain((await appts(w))[0]!.appointmentId.slice(0, 8));
    expect(await appts(w)).toHaveLength(1); expect(await notices(w)).toHaveLength(1);
    const now = new Date('2026-11-12T02:00:00Z');
    const p1 = parseAppointmentRequest('明天 三点 有个客人要来', now, 'Asia/Shanghai'), p2 = parseAppointmentRequest('明天三点有个客人要来', now, 'Asia/Shanghai');
    expect(p1).toEqual(p2);
  });

  it('取消零写；同一「对」重放只回原结果；无草稿时「对」不登记', async () => {
    const w = await worldM05();
    await w.call('m-zhao', '后天下午两点王姐来做护理');
    expect(await w.call('m-zhao', '取消')).toContain('已取消');
    expect(await appts(w)).toEqual([]);
    await w.call('m-zhao', '后天下午两点王姐来做护理');
    const first = await w.call('m-zhao', '对', 'confirm-1');
    expect(first).toContain('预约已登记');
    expect(await w.call('m-zhao', '对', 'confirm-1')).toBe(first);
    await unchanged(w, 'm-zhao', '对', NO_DRAFT);
    expect(await appts(w)).toHaveLength(1); expect(await notices(w)).toHaveLength(1);
  });

  it('缺时间就问、过去时间拒绝、写法无效拒绝，都零写；非策略模式“未开放”', async () => {
    const w = await worldM05();
    await unchanged(w, 'm-zhao', '明天有客人要来', /要说清几点/);
    await unchanged(w, 'm-zhao', '今天早上8点有客人来', /已经过了/);
    await unchanged(w, 'm-zhao', '明天25点客人来', /写法不对/);
    // 回显时未过、确认时已过 → 不登记，零写，草稿仍待确认；「取消」可关闭。
    const c = clock();
    const late = await worldM05({ now: c.now });
    expect(await registerUnnamedAppointment(late, 'm-zhao', '今天10点30分有客人要来')).toContain('预约还没登记');
    c.jump(Date.parse('2026-11-12T02:31:00Z'));
    await unchanged(late, 'm-zhao', '对', /预约时间已经过了，没有登记/);
    expect((await late.base.listDrafts({ kind: 'appointment' }))[0]!.status).toBe('pending');
    expect(await late.call('m-zhao', '取消')).toContain('已取消');
    expect(await appts(late)).toEqual([]);
    const off = await worldM05({ accessPolicy: false });
    await unchanged(off, 'm-zhao', '明天三点有个客人要来', /预约登记当前未开放/);
  });
});

describe('M05 遗留问题：①序号/重试不会确认到下一笔 ②提醒失败不被吞', () => {
  it('①：A 已登记后又起 B 草稿，A 的「对」被企微重试（同一消息号）→ 只回 A 的结果，B 仍待确认；「确认预约 1」只解释新规则、零写', async () => {
    const w = await worldM05();
    await registerUnnamedAppointment(w, 'm-zhao', '明天三点有个客人要来');
    const a = await w.call('m-zhao', '对', 'retry-me');
    await w.call('m-zhao', '后天上午10点陈先生过来');
    expect(await w.call('m-zhao', '对', 'retry-me')).toBe(a);
    expect(await appts(w)).toHaveLength(1);
    const drafts = await w.base.listDrafts({ kind: 'appointment' });
    expect(drafts.filter(d => d.status === 'pending')).toHaveLength(1);
    expect(drafts.find(d => d.status === 'pending')!.payload).toMatchObject({ items: [{ customer: '陈先生' }] });
    await unchanged(w, 'm-wang-yj', '确认预约 1', /登记即成立.*不需要确认或回复/);
    await unchanged(w, 'm-wang-yj', '确认预约 2', /没有写入/);
  });

  it('②：写待发提醒失败 → 预约同事务回滚，回“结果未知”，不谎称已登记；故障消除后用原确认续跑只登记一次、提醒一条', async () => {
    const { sql, store } = await faultyStore();
    const w = await worldM05({ store });
    await registerUnnamedAppointment(w, 'm-zhao', '明天三点有个客人要来');
    sql.failOn = /^INSERT INTO \S*performance_notifications/;
    const broken = await w.call('m-zhao', '对', 'confirm-x');
    expect(broken).toContain('结果未知'); expect(broken).not.toContain('已登记');
    expect(await appts(w)).toEqual([]); expect(await notices(w)).toEqual([]);
    expect((await w.base.listDrafts({ kind: 'appointment' }))[0]!.status).toBe('confirming');
    sql.failOn = null;
    // 同进程内 M02 请求预算按消息号去重，换新进程（新 handler、同库）重发原确认。
    const again = createWecomBotHandler({ legacyEntry: true, mode: 'isolated-synthetic', store, now: () => new Date(NOW.getTime() + 60_000), resolve: id => store.getPersonByMember(id),
      send: async () => { throw Error('不应发送'); }, model: { complete: async () => { throw Error('不应调用模型'); } }, employeeLoop: true, accessPolicy: true });
    const resumed = (await again.handleMessage({ memberId: 'm-zhao', text: '对', messageId: 'confirm-x', sessionId: 'session-m-zhao', bindingVersion: 1 })).replies.join('\n');
    expect(resumed).toContain('预约已登记');
    expect(await appts(w)).toHaveLength(1); expect(await notices(w)).toHaveLength(1);
  });

  it('②：提醒明确失败/回执未知（模拟 M06 回写 not_sent/unknown）→ 预约仍有效；「我的预约」如实显示未送达/未知，不写已送达', async () => {
    const w = await worldM05();
    await registerUnnamedAppointment(w, 'm-zhao', '明天三点有个客人要来'); await w.call('m-zhao', '对');
    await w.call('m-zhao', '后天下午两点王姐来做护理'); await w.call('m-zhao', '对');
    const [n1, n2] = await notices(w);
    await w.base.updateNotificationStatus(n1!.notificationId, 'not_sent', null);
    await w.base.updateNotificationStatus(n2!.notificationId, 'unknown', null);
    const mine = await w.call('m-zhao', '我的预约');
    expect(mine).toContain('发送失败，未送达'); expect(mine).toContain('发送结果未知，未确认送达');
    expect(mine).not.toMatch(/已送达|已读/);
    expect((await appts(w)).every(row => row.status === 'registered')).toBe(true);
  });
});

describe('M05 指定店长：无收件人/撤权/离店/本人都不回滚预约', () => {
  it('未配置指定店长 → 登记成立、提醒待配置、零提醒', async () => {
    const w = await worldM05({ recipients: null });
    expect(await registerUnnamedAppointment(w, 'm-zhao', '明天三点有个客人要来')).toContain('不排店长提醒');
    const done = await w.call('m-zhao', '对');
    expect(done).toContain('预约已登记'); expect(done).toContain('没有配置指定店长');
    expect(await appts(w)).toHaveLength(1); expect(await notices(w)).toEqual([]);
  });
  it('指定店长被收回 appointment_receive / 调离本店 → 登记成立、不排提醒；登记人本人就是指定店长 → 不给自己发', async () => {
    const w = await worldM05();
    await bump(w.base, 1, policyM05(2, membersM05(), { members: { ...membersM05(), 'p-wang-yj': { role: 'manager', storeIds: ['s-b'], status: 'active', capabilities: ['appointment_submit', 'report_self', 'progress_self'] } } }));
    const echo = await registerUnnamedAppointment(w, 'm-zhao', '明天三点有个客人要来');
    expect(echo).toContain('不排店长提醒'); expect(echo).not.toContain('苏晓禾');
    expect(await w.call('m-zhao', '对')).toContain('不能接收提醒');
    expect(await appts(w)).toHaveLength(1); expect(await notices(w)).toEqual([]);
    const v = await worldM05();
    await v.base.savePerson({ ...(await v.base.getPerson('p-wang-yj'))!, storeId: 's-a', storeName: '测试A店' });
    await registerUnnamedAppointment(v, 'm-zhao', '明天三点有个客人要来');
    expect(await v.call('m-zhao', '对')).toContain('不能接收提醒');
    expect(await notices(v)).toEqual([]);
    const u = await worldM05();
    await registerUnnamedAppointment(u, 'm-wang-yj', '明天三点有个客人要来');
    expect(await u.call('m-wang-yj', '对')).toContain('你就是本店指定店长');
    expect(await appts(u)).toHaveLength(1); expect(await notices(u)).toEqual([]);
  });
  it('提交事务内指定店长被撤权（与确认竞态）→ 预约成立、提醒不排队，最终回复如实改写', async () => {
    const w = await worldM05();
    await registerUnnamedAppointment(w, 'm-zhao', '明天三点有个客人要来');
    const original = w.base.commitConfirmingAppointments.bind(w.base);
    w.base.commitConfirmingAppointments = async (draft, rows, options) => {
      await bump(w.base, 1, policyM05(2, { ...membersM05(), 'p-wang-yj': { role: 'manager', storeIds: ['s-b'], status: 'suspended' } }));
      return original(draft, rows, options);
    };
    // R2（D79）：预检之后策略版本变了 → 本次整体不落账（草稿退回待确认），重新确认后按新策略：预约成立、提醒不排队。
    expect(await w.call('m-zhao', '对', 'race-0')).toBe(POLICY_CHANGED);
    expect(await appts(w)).toHaveLength(0);
    w.base.commitConfirmingAppointments = original;
    const done = await w.call('m-zhao', '对', 'race-1');
    expect(await appts(w)).toHaveLength(1); expect(await notices(w)).toEqual([]);
    expect(done).toContain('预约已登记');
    expect(await w.call('m-zhao', '入账结果 race-1')).not.toContain('已排队提醒');
  });
  it('R2：提交事务内指定店长被停用（人员行变化、策略未变）→ 预约成立、提醒不排队，最终回复如实改写', async () => {
    const w = await worldM05();
    await registerUnnamedAppointment(w, 'm-zhao', '明天三点有个客人要来');
    const original = w.base.commitConfirmingAppointments.bind(w.base);
    w.base.commitConfirmingAppointments = async (draft, rows, options) => {
      await w.base.savePerson({ ...(await w.base.getPerson('p-wang-yj'))!, active: false });
      return original(draft, rows, options);
    };
    const done = await w.call('m-zhao', '对', 'race-1');
    expect(await appts(w)).toHaveLength(1); expect(await notices(w)).toEqual([]);
    expect(done).toContain('预约已登记');
    expect(await w.call('m-zhao', '入账结果 race-1')).not.toContain('已排队提醒');
  });
});

describe('M05 鉴权：每一步过 M03（入口、建草稿前、确认前、提交事务内）', () => {
  it('无 appointment_submit → 拒绝且不读预约表与指定店长配置；回显后被撤权 → 确认拒绝、草稿保留待确认、零写', async () => {
    const w = await worldM05({ policy: policyM05(1, membersM05(), { members: { ...membersM05(), 'p-zhao': { role: 'employee', storeIds: ['s-b'], status: 'active', capabilities: ['report_self', 'progress_self'] } } }) });
    w.reset();
    await unchanged(w, 'm-zhao', '明天三点有个客人要来', ACCESS_DENIED);
    expect(w.spy.reads.some(r => r.method === 'listAppointments' || (r.method === 'getConfig' && r.args[0] === APPOINTMENT_RECIPIENTS_KEY))).toBe(false);
    const v = await worldM05();
    await registerUnnamedAppointment(v, 'm-zhao', '明天三点有个客人要来');
    await bump(v.base, 1, policyM05(2, { ...membersM05(), 'p-zhao': { role: 'employee', storeIds: ['s-b'], status: 'active', capabilities: ['report_self'] } }));
    await unchanged(v, 'm-zhao', '对', ACCESS_DENIED);
    expect((await v.base.listDrafts({ kind: 'appointment' }))[0]!.status).toBe('pending');
  });
  it('提交事务内撤权（guard）→ 拒绝、零预约零提醒、草稿退回待确认；恢复授权后再「对」登记一次', async () => {
    const w = await worldM05();
    await registerUnnamedAppointment(w, 'm-zhao', '明天三点有个客人要来');
    const original = w.base.commitConfirmingAppointments.bind(w.base);
    let once = true;
    w.base.commitConfirmingAppointments = async (draft, rows, options) => {
      if (once) { once = false; await bump(w.base, 1, policyM05(2, { ...membersM05(), 'p-zhao': { role: 'employee', storeIds: ['s-b'], status: 'revoked' } })); }
      return original(draft, rows, options);
    };
    expect(await w.call('m-zhao', '对')).toBe(ACCESS_DENIED);
    expect(await appts(w)).toEqual([]); expect(await notices(w)).toEqual([]);
    expect((await w.base.listDrafts({ kind: 'appointment' }))[0]!.status).toBe('pending');
    await bump(w.base, 2, policyM05(3));
    expect(await w.call('m-zhao', '对')).toContain('预约已登记');
    expect(await appts(w)).toHaveLength(1); expect(await notices(w)).toHaveLength(1);
  });
  it('「预约列表」需要 appointment_receive，只看本店；员工「今天的预约」只看本人', async () => {
    const w = await worldM05();
    await registerUnnamedAppointment(w, 'm-zhao', '明天三点有个客人要来'); await w.call('m-zhao', '对');
    const list = await w.call('m-wang-yj', '预约列表');
    expect(list).toContain('小赵登记'); expect(list).toContain('已排队，尚未发送');
    const own = await w.call('m-zhao', '预约列表');
    expect(own).toContain('你登记的预约');
    await unchanged(w, 'm-zhou', '预约列表', /本店今天及以后没有登记的预约/);
  });
});

describe('M05 店长不回复也有效、旧入口不能处理新草稿、两张同内容草稿只登记一次', () => {
  it('店长从不回复，跨过闭店（23:00）到第二天：预约仍有效、提醒仍是待发；没有任何作废或催店长', async () => {
    const c = clock();
    const w = await worldM05({ now: c.now });
    await w.call('m-zhao', '后天下午两点王姐来做护理'); await w.call('m-zhao', '对');
    c.jump(Date.parse('2026-11-13T16:30:00Z')); // 11-14 00:30 北京时间，已过 11-13 闭店
    const mine = await w.call('m-zhao', '我的预约');
    expect(mine).toContain('11月14日（周六）14:00'); expect(mine).toContain('已排队，尚未发送');
    expect((await appts(w))[0]!.status).toBe('registered');
    expect((await w.base.listNotifications()).filter(n => n.kind !== 'appointment')).toEqual([]);
    expect(w.send).not.toHaveBeenCalled();
  });
  it('旧入口（非 employeeLoop）遇到员工入口的预约草稿：对/取消/新预约都让回本人入口，草稿与预约不变', async () => {
    const w = await worldM05();
    await registerUnnamedAppointment(w, 'm-zhao', '明天三点有个客人要来');
    const legacy = createWecomBotHandler({ legacyEntry: true, mode: 'isolated-synthetic', store: w.base, now: () => NOW, resolve: id => w.base.getPersonByMember(id),
      send: async () => 'sent', model: { complete: async () => ({ type: 'chat' as const, text: '不应进入模型' }) } });
    const before = { a: await appts(w), d: await w.base.listDrafts() };
    for (const text of ['对', '取消', '预约 赵姐 16:30 洗吹']) {
      const reply = (await legacy.handleMessage({ memberId: 'm-zhao', text, messageId: `legacy-${text}`, sessionId: 'session-m-zhao', bindingVersion: 1 })).replies.join('\n');
      expect(reply).toContain('请从本人报数入口处理草稿');
    }
    expect({ a: await appts(w), d: await w.base.listDrafts() }).toEqual(before);
  });
  it('两个会话各起一张同内容草稿，先后确认 → 只登记一次，后者作废（duplicate），提醒一条', async () => {
    const w = await worldM05();
    const h = createWecomBotHandler({ legacyEntry: true, mode: 'isolated-synthetic', store: w.base, now: () => NOW, resolve: id => w.base.getPersonByMember(id),
      send: async () => 'sent', model: { complete: async () => { throw Error('不应调用模型'); } }, employeeLoop: true, accessPolicy: true });
    const other = (text: string, messageId: string) => h.handleMessage({ memberId: 'm-zhao', text, messageId, sessionId: 'session-2', bindingVersion: 1 }).then(r => r.replies.join('\n'));
    await registerUnnamedAppointment(w, 'm-zhao', '明天三点有个客人要来');
    const otherAsk = await other('明天三点有个客人要来', 'o-1');
    if (/哪位客人/.test(otherAsk)) expect(await other('没留名', 'o-1b')).toContain('预约还没登记');
    else expect(otherAsk).toContain('预约还没登记');
    expect(await w.call('m-zhao', '对')).toContain('预约已登记');
    expect(await other('对', 'o-2')).toContain('同样的预约已经登记过');
    expect(await appts(w)).toHaveLength(1); expect(await notices(w)).toHaveLength(1);
    expect((await w.base.listDrafts({ kind: 'appointment' })).map(d => d.status).sort()).toEqual(['confirmed', 'void']);
  });
});

describe('M05 内存实现与 PG 实现同语义', () => {
  it('MemoryPerformanceStore：committed / already / denied / duplicate；旧调用（不带 options）行为不变', async () => {
    const m = new MemoryPerformanceStore();
    const draft = (id: string): Draft => ({ draftId: id, reporterPersonId: 'p-zhao', storeId: 's-b', businessDay: '2026-11-12', expiresAt: '2026-11-12T15:00:00Z', kind: 'appointment',
      payload: { type: 'appointment', items: [{ customer: '未留名', whenText: '2026-11-13 15:00', note: '' }] }, status: 'confirming', reminder: 'none', voidNotice: 'none', createdAt: at, closedAt: null });
    const appointmentId = appointmentContentId({ storeId: 's-b', employeePersonId: 'p-zhao', whenText: '2026-11-13 15:00', customer: '未留名', note: '' });
    const row = { appointmentId, storeId: 's-b', employeePersonId: 'p-zhao', customerName: '未留名', whenText: '2026-11-13 15:00', note: '', status: 'registered' as const, createdAt: at };
    const notice = { notificationId: 'n1', kind: 'appointment' as const, recipientPersonId: 'p-wang-yj', body: 'x', status: 'pending' as const, relatedId: appointmentId, createdAt: at, sentAt: null };
    await m.saveDraft(draft('d1')); await m.saveDraft(draft('d2')); await m.saveDraft(draft('d3'));
    await m.setConfig('k', 'deny');
    expect(await m.commitConfirmingAppointments({ ...draft('d1'), status: 'confirmed' }, [row], { notices: [notice], guard: { key: 'k', check: raw => raw !== 'deny' } })).toMatchObject({ outcome: 'denied' });
    expect((await m.getDraft('d1'))!.status).toBe('pending');
    await m.setConfig('k', 'ok');
    await m.saveDraft(draft('d1'));
    expect(await m.commitConfirmingAppointments({ ...draft('d1'), status: 'confirmed' }, [row], { notices: [notice], guard: { key: 'k', check: raw => raw !== 'deny' } })).toEqual({ total: 1, claimed: true, outcome: 'committed', noticesWritten: 1 });
    expect(await m.commitConfirmingAppointments({ ...draft('d1'), status: 'confirmed' }, [row], { notices: [notice] })).toMatchObject({ outcome: 'already' });
    expect(await m.commitConfirmingAppointments({ ...draft('d2'), status: 'confirmed' }, [row], { notices: [notice] })).toMatchObject({ outcome: 'duplicate' });
    expect((await m.getDraft('d2'))!.status).toBe('void');
    expect(await m.listAppointments()).toHaveLength(1); expect(await m.listNotifications()).toHaveLength(1);
    // 收件人在事务内不合格：只丢提醒。
    const other = { ...row, appointmentId: 'other', whenText: '2026-11-14 15:00' };
    expect(await m.commitConfirmingAppointments({ ...draft('d3'), status: 'confirmed' }, [other], { notices: [{ ...notice, notificationId: 'n2' }], guard: { key: 'k', check: () => true }, noticeAllowed: () => false }))
      .toEqual({ total: 1, claimed: true, outcome: 'committed', noticesWritten: 0 });
    // 旧入口语义：pending_manager 照旧插入。
    await m.saveDraft(draft('d4'));
    expect(await m.commitConfirmingAppointments({ ...draft('d4'), status: 'confirmed' }, [{ ...row, appointmentId: 'legacy', status: 'pending_manager' }])).toMatchObject({ total: 1, claimed: true });
  });
});
