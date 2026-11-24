import { describe, expect, it } from 'vitest';
import { membersM05, policyM05, worldM05 } from '../role-eval/appointment-fixture-m05.js';
import { newCustomerAskKey } from '../../src/role-eval/customer-name-policy.js';
import { ALREADY_CONFIRMED_TEXT } from '../../src/role-eval/employee-loop.js';

type Kind = '草稿' | '追问';
type World = Awaited<ReturnType<typeof worldM05>>;
const first = (kind: Kind, employee: string) => `${kind === '草稿' ? '訾姨' : '郗澄'}：3917（${employee}）`;
const next = (kind: Kind, employee: string) => `${kind === '草稿' ? '逯姨' : '逯澄'}：2869（${employee}）`;
const expiredReminder = (kind: Kind) => `上一笔「${kind === '草稿' ? '訾姨 3917元' : '郗澄'}」已过期，没有记，需要的话请重新报。`;
const cases = [
  { label: '查进度', text: '我的进度', reply: /今天 已做/ },
  { label: '闲聊', text: '辛苦了', reply: /客气|随时|你好/ },
  { label: '营销未开放', text: '写一条清洁护理营销文案', reply: /营销内容功能当前未开放/ },
  { label: '营销已授权', text: '写一条清洁护理营销文案', reply: /离线护理文案/, marketing: true },
  { label: '过去日期拒绝', text: '【11月11日】逯姨：2869（小赵）', reply: /只能报今天/ },
  { label: '跨店拒绝', text: '【栖鹭店】逯姨：2869（小赵）', reply: /不能|未开放/ },
  { label: '代报拒绝', text: '逯姨：2869（小林）', reply: /不能|未开放/ },
  { label: '金额追问', text: '逯姨：28.69（小赵）', reply: /万|确认/ },
  { label: '入账结果', text: '入账结果', reply: /还没入账|没有可查/ },
  { label: '我的预约', text: '我的预约', reply: /预约/ },
  { label: 'D153 通用先问', text: '整单：2869（小赵）', reply: /请|确认/ },
  { label: 'D171 汇总词先问', text: '合计：2869（小赵）', reply: /请|确认/ },
];
async function setup(marketing = false, now?: () => Date) {
  const members = membersM05();
  members['p-wang-yj']!.capabilities = ['marketing'];
  const w = await worldM05({ ...(now ? { now } : {}), policy: policyM05(1, members),
    router: marketing ? { marketing: { enabled: true, handle: async () => '离线护理文案' } } : {} });
  // 跨店样例使用自编店名，仍沿用原人员和授权。
  for (const person of await w.base.listPeople()) if (person.storeId === 's-a') await w.base.savePerson({ ...person, storeName: '栖鹭店' });
  const member = marketing ? 'm-wang-yj' : 'm-zhao';
  const employee = marketing ? '苏晓禾' : '小赵';
  const key = newCustomerAskKey(marketing ? 'p-wang-yj' : 'p-zhao', `session-${member}`);
  return { w, member, employee, key };
}
async function ledger(w: World, customer: string, amount: number) {
  const entries = (await w.base.listEntries()).filter(e => e.customerName);
  expect(entries.map(e => [e.customerName, e.amount, e.status])).toEqual([[customer, amount, 'confirmed']]);
}

describe('R20 D175 非报单保留矩阵（同一入口请求实际经过循环/SQL 替身）', () => {
  for (const kind of ['草稿', '追问'] as const) for (const item of cases) {
    it(`${kind} × ${item.label}：保留原项，回头确认只入一笔`, async () => {
      const { w, member, employee, key } = await setup(item.marketing);
      await w.call(member, first(kind, employee));
      const drafts = await w.base.listDrafts();
      const ask = await w.base.getConfig(key);
      const reply = await w.call(member, item.text);
      expect(reply).toMatch(item.reply);
      expect(reply).not.toMatch(/上一[笔条].*(?:作废|没有记|已过期)/);
      expect(await w.base.listDrafts()).toEqual(drafts);
      expect(await w.base.getConfig(key)).toBe(ask);
      if (kind === '追问') expect(await w.call(member, '是')).toContain('客户：郗澄');
      expect(await w.call(member, '对')).toContain('已入账');
      expect(await w.call(member, '对')).toBe(ALREADY_CONFIRMED_TEXT);
      await ledger(w, kind === '草稿' ? '訾姨' : '郗澄', 391700);
    });
  }
});

describe('R20 D172/D174 白名单对照', () => {
  for (const kind of ['草稿', '追问'] as const) for (const replacement of ['草稿', '追问'] as const) {
    it(`${kind} × 新${replacement}：作废原项，只确认新项`, async () => {
      const { w, member, employee, key } = await setup();
      await w.call(member, first(kind, employee));
      const old = (await w.base.listDrafts({ status: 'pending' }))[0];
      const reply = await w.call(member, next(replacement, employee));
      expect(reply.startsWith(kind === '草稿'
        ? '上一笔「訾姨 3917元」没有确认，已作废，需要的话请重新报。\n'
        : '上一条「郗澄」没有记，需要的话请重新报。\n')).toBe(true);
      if (old) expect((await w.base.getDraft(old.draftId))?.status).toBe('void');
      if (replacement === '追问') {
        expect(JSON.parse((await w.base.getConfig(key))!).names).toEqual(['逯澄']);
        await w.call(member, '是');
      } else expect((await w.base.getConfig(key)) || '').toBe('');
      await w.call(member, '对');
      await ledger(w, replacement === '草稿' ? '逯姨' : '逯澄', 286900);
    });
  }
});

describe('R20 D176（由 R21 D179 更新）：下一条消息消费过期提醒', () => {
  for (const kind of ['草稿', '追问'] as const) for (const replacement of ['草稿', '追问'] as const) {
    it(`过期${kind} × 新${replacement}：使用过期措辞并只提醒一次`, async () => {
      let at = Date.parse('2026-11-12T02:00:00Z');
      const { w, member, employee, key } = await setup(false, () => new Date(at));
      await w.call(member, first(kind, employee));
      const old = (await w.base.listDrafts({ status: 'pending' }))[0];
      const ask = await w.base.getConfig(key);
      at = Date.parse(old?.expiresAt ?? JSON.parse(ask!).expiresAt);
      const reply = await w.call(member, next(replacement, employee));
      // D179：过期提醒改为正常回复后的末尾。
      expect(reply.endsWith('\n' + expiredReminder(kind))).toBe(true);
      expect(reply.split(expiredReminder(kind))).toHaveLength(2);
      expect(reply).not.toContain('上一条「郗澄」没有记');
      expect(reply).not.toContain('没有确认，已作废');
      expect(reply).toContain(replacement === '草稿' ? '客户：逯姨' : '是新客户「逯澄」吗？');
      if (old) expect((await w.base.getDraft(old.draftId))?.status).toBe('void');
      expect(await w.base.getConfig(key)).not.toBe(ask || undefined);
      if (replacement === '追问') await w.call(member, '是');
      await w.call(member, '对');
      await ledger(w, replacement === '草稿' ? '逯姨' : '逯澄', 286900);
      const again = await w.call(member, '郜姨：4723（小赵）');
      expect(again).not.toContain(expiredReminder(kind));
      expect(again).not.toContain('已过期');
    });
  }
  for (const kind of ['草稿', '追问'] as const) for (const item of cases) {
    it(`过期${kind} × ${item.label}：D179 提醒并清除，迟到肯定不入账`, async () => {
      let at = Date.parse('2026-11-12T02:00:00Z');
      const { w, member, employee, key } = await setup(!!item.marketing, () => new Date(at));
      await w.call(member, first(kind, employee));
      const drafts = await w.base.listDrafts();
      const ask = await w.base.getConfig(key);
      at = Date.parse(drafts[0]?.expiresAt ?? JSON.parse(ask!).expiresAt);
      const reply = await w.call(member, item.text);
      expect(reply.endsWith('\n' + expiredReminder(kind))).toBe(true);
      expect(reply.split(expiredReminder(kind))).toHaveLength(2);
      const readonly = ['查进度', '入账结果', '我的预约'].includes(item.label);
      if (readonly) {
        expect(await w.base.listDrafts()).toEqual(drafts);
        expect(await w.base.getConfig(key)).toBe(ask);
      } else {
        expect((await w.base.listDrafts()).every(d => d.status !== 'pending')).toBe(true);
        expect((await w.base.getConfig(key)) || '').toBe('');
      }
      if (item.label === '入账结果') expect(reply).not.toMatch(/回复「对」|回复.*取消/);
      const replacement = await w.call(member, next('草稿', employee));
      expect(replacement.includes(expiredReminder(kind))).toBe(readonly);
      if (drafts[0]) expect((await w.base.getDraft(drafts[0].draftId))?.status).toBe('void');
      expect((await w.base.getConfig(key)) || '').toBe('');
      // 取消新项后迟到答复不能恢复旧项。
      await w.call(member, '取消');
      await w.call(member, kind === '草稿' ? '对' : '是');
      await w.call(member, '对');
      expect((await w.base.listEntries()).filter(e => e.customerName)).toHaveLength(0);
    });
  }
  for (const kind of ['草稿', '追问'] as const) it(`过期${kind}直接回对/是不入账`, async () => {
    let at = Date.parse('2026-11-12T02:00:00Z');
    const { w, member, employee, key } = await setup(false, () => new Date(at));
    await w.call(member, first(kind, employee));
    const draft = (await w.base.listDrafts())[0];
    at = Date.parse(draft?.expiresAt ?? JSON.parse((await w.base.getConfig(key))!).expiresAt);
    await w.call(member, kind === '草稿' ? '对' : '是');
    await w.call(member, '对');
    expect((await w.base.listEntries()).filter(e => e.customerName)).toHaveLength(0);
  });
  for (const kind of ['草稿', '追问'] as const) it(`多项过期${kind}逐项列出，只消费一次`, async () => {
    let at = Date.parse('2026-11-12T02:00:00Z');
    const { w, member, key } = await setup(false, () => new Date(at));
    const names = kind === '草稿' ? ['訾姨', '郗姨'] : ['郗澄', '訾澄'];
    await w.call(member, `${names[0]}：3917（小赵）；${names[1]}：4723（小赵）`);
    const draft = (await w.base.listDrafts())[0];
    at = Date.parse(draft?.expiresAt ?? JSON.parse((await w.base.getConfig(key))!).expiresAt);
    const reply = await w.call(member, next('草稿', '小赵'));
    for (const [index, name] of names.entries()) expect(reply).toContain(`上一笔「${name}${kind === '草稿' ? ` ${index ? 4723 : 3917}元` : ''}」已过期，没有记，需要的话请重新报。`);
    expect((await w.call(member, '郜姨：5239（小赵）'))).not.toContain('已过期');
  });
});
