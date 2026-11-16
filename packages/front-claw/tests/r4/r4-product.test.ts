/**
 * R4 产品四项（产品负责人已定，待 hanyu 确认）：
 * D101 标题与明细同一物理行；D102 有客户无括号记给报单人；
 * D103 年份写法；D104 预约无称呼先问一次，不知道则「未留名」并在店长提醒标明。
 */
import { describe, expect, it } from 'vitest';
import { CAPABILITIES } from '../../src/role-eval/access-policy.js';
import type { Person } from '../../src/role-eval/performance-store.js';
import { world } from '../role-eval/access-fixture-m03.js';
import { ROLE_CAPS_M05, RECIPIENTS } from '../role-eval/appointment-fixture-m05.js';
import { ticking } from '../role-eval/ledger-fixture-m04.js';
import { APPOINTMENT_RECIPIENTS_KEY } from '../../src/role-eval/appointments.js';
import { parseHeader, parseReportText } from '../../src/role-eval/report-parse.js';

const P = (id: string, name: string, store: 'A' | 'B', tier: Person['tier']): Person => ({
  personId: `p-${id}`, accountId: `a-${id}`, memberId: `m-${id}`, displayName: name,
  storeId: store === 'A' ? 's-a' : 's-b', storeName: `${store}店`, tier,
  roles: tier === 'employee' ? [] : ['manager'], active: true,
});
const PEOPLE: Person[] = [
  P('chen', '小陈', 'A', 'employee'), P('am', '老周', 'A', 'manager'),
  P('bm', '王店长', 'B', 'manager'), P('zhao', '小赵', 'B', 'employee'),
  P('xw', '小王', 'B', 'employee'), P('mei', '小美', 'B', 'employee'),
  P('lin', '小林', 'B', 'employee'),
];
const members = () => Object.fromEntries(PEOPLE.map(p => [p.personId, { role: p.tier, storeIds: [p.storeId], status: 'active' as const }]));
const policy = () => ({ version: 1, enterprise: [...CAPABILITIES], stores: { 's-a': [...CAPABILITIES], 's-b': [...CAPABILITIES] }, roles: structuredClone(ROLE_CAPS_M05), members: members() });
async function make() {
  const w = await world({ people: PEOPLE, policy: policy(), now: ticking() });
  await w.base.setConfig('employee-loop:m01', JSON.stringify({ enabled: true, storeId: 's-b', memberIds: ['m-zhao', 'm-bm', 'm-xw'] }));
  await w.base.setConfig(APPOINTMENT_RECIPIENTS_KEY, JSON.stringify({ version: 1, stores: { 's-b': 'p-bm', 's-a': 'p-am' } }));
  return w;
}

describe('D101 标题与明细同一物理行', () => {
  for (const text of ['12号B店 张姐680（小王）', '11月12日B店 680（小林）', '11月12日 B店 680（小王）', '12号B店张姐680（小赵）']) {
    it(`「${text}」出今天清单，对后入账`, async () => {
      const w = await make();
      const reply = await w.call('m-zhao', text);
      expect(reply).toMatch(/还没入账[^\n]*2026-11-12/);
      expect(reply).toMatch(/680元/);
      expect(await w.call('m-zhao', '对')).toContain('已入账');
      expect((await w.base.listEntries()).some(e => e.businessDay === '2026-11-12' && e.amount === 68000)).toBe(true);
    });
  }
});

describe('D102 有客户名无括号员工 → 记给报单人', () => {
  it('标题下行「张姐680」记给发送人，对后入账', async () => {
    const w = await make();
    const reply = await w.call('m-zhao', '12号B店\n张姐680');
    expect(reply).toMatch(/还没入账/);
    expect(reply).toContain('小赵 680元');
    expect(await w.call('m-zhao', '对')).toContain('已入账');
    const row = (await w.base.listEntries()).find(e => e.customerName === '张姐')!;
    expect(row.ownerName).toBe('小赵');
    expect(row.amount).toBe(68000);
  });
});

describe('D103 年份写法', () => {
  it('parseHeader 认 2026-11-12 与 2026年11月12日（及斜杠）', () => {
    expect(parseHeader('2026-11-12 B店', '2026-11-12')).toEqual({ businessDay: '2026-11-12', storeName: 'B店' });
    expect(parseHeader('2026年11月12日 B店', '2026-11-12')).toEqual({ businessDay: '2026-11-12', storeName: 'B店' });
    expect(parseHeader('2026/11/12 B店', '2026-11-12')).toEqual({ businessDay: '2026-11-12', storeName: 'B店' });
    expect(parseReportText('2026-11-12 B店\n680（小王）', '2026-11-12').status).toBe('complete');
    expect(parseReportText('2026年11月12日 B店\n680（小王）', '2026-11-12').status).toBe('complete');
  });
  for (const header of ['2026-11-12 B店', '2026年11月12日 B店']) {
    it(`「${header}」加明细出清单并入账`, async () => {
      const w = await make();
      const reply = await w.call('m-zhao', `${header}\n880（小美）`);
      expect(reply).toMatch(/还没入账[^\n]*2026-11-12/);
      expect(await w.call('m-zhao', '对')).toContain('已入账');
    });
  }
});

describe('D104 预约无称呼：先问一次，不知道则未留名并标明', () => {
  it('没写客人称呼先问，不直接登记', async () => {
    const w = await make();
    const reply = await w.call('m-zhao', '明天16点做染发，给我登记一下');
    expect(reply).toMatch(/哪位客人|客人称呼|是哪位/);
    expect(reply).not.toMatch(/还没登记|未留名/);
    expect((await w.base.listDrafts()).filter(d => d.kind === 'appointment' && d.status === 'pending')).toHaveLength(0);
  });
  it('回答「不知道/没留名」→ 待确认草稿顾客为未留名；确认后店长提醒标明', async () => {
    const w = await make();
    await w.call('m-zhao', '明天16点做染发，给我登记一下');
    const reply = await w.call('m-zhao', '不知道，没留名');
    expect(reply).toMatch(/还没登记/);
    expect(reply).toContain('未留名');
    expect(await w.call('m-zhao', '对')).toMatch(/已登记|预约/);
    const ap = (await w.base.listAppointments())[0]!;
    expect(ap.customerName).toBe('未留名');
    const notice = (await w.base.listNotifications()).find(n => n.kind === 'appointment');
    expect(notice?.body).toMatch(/未留名/);
  });
  it('回答具体称呼则用该称呼登记', async () => {
    const w = await make();
    await w.call('m-zhao', '明天17点做护理，给我登记');
    const reply = await w.call('m-zhao', '张姐');
    expect(reply).toMatch(/还没登记/);
    expect(reply).toContain('张姐');
    expect(reply).not.toContain('未留名');
  });
});
