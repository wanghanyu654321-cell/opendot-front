import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { membersM05, policyM05, worldM05 } from '../role-eval/appointment-fixture-m05.js';
import { newCustomerAskKey, NOT_A_CUSTOMER_NAME_ASK } from '../../src/role-eval/customer-name-policy.js';
import { ALREADY_CONFIRMED_TEXT, DRAFT_EXPIRED_REREPORT } from '../../src/role-eval/employee-loop.js';
import { collectKnownCustomerNames } from '../../src/role-eval/store-customer-roster.js';
import { GENERIC_MODEL_ASK } from '../../src/role-eval/model-path-ask.js';
import { textLevelImpurity } from '../../src/role-eval/confirmable-draft-gate.js';
import { NOT_CUSTOMER_NAME } from '../../src/role-eval/standard-line.js';
import { createWecomBotHandler } from '../../src/role-eval/wecom-bot-unified-handler.js';

type World = Awaited<ReturnType<typeof worldM05>>;
const key = newCustomerAskKey('p-zhao', 'session-m-zhao');
const name = '郗蘅';
const ask = `Front Claw：是新客户「${name}」吗？`;
const reminder = `上一条「${name}」没有记，需要的话请重新报。`;
const counts = async (w: World) => ({ drafts: (await w.base.listDrafts()).length, entries: (await w.base.listEntries()).length });
async function delta(w: World, before: Awaited<ReturnType<typeof counts>>, drafts: number, entries: number) {
  const after = await counts(w);
  expect(after.drafts - before.drafts).toBe(drafts);
  expect(after.entries - before.entries).toBe(entries);
}
async function start(w: World) {
  const before = await counts(w);
  expect(await w.call('m-zhao', `${name}：1437（小赵）`)).toBe(ask);
  await delta(w, before, 0, 0);
  expect((await w.base.getConfig(key))?.trim()).toBeTruthy();
  return before;
}

describe('R19 D172 待答新客户追问状态矩阵', () => {
  for (const answer of ['是', '是的', '对', '对的']) it(`答 ${answer} 只建草稿，清追问，名字未进名单`, async () => {
    const w = await worldM05(); const before = await start(w);
    const reply = await w.call('m-zhao', answer);
    expect(reply).toContain('还没入账');
    expect(reply).toContain(`客户：${name}`);
    expect(reply).toContain('回复「对」');
    await delta(w, before, 1, 0);
    expect(await w.base.getConfig(key)).toBe('');
    expect((await collectKnownCustomerNames(w.base, 's-b')).has(name)).toBe(false);
  });
  for (const answer of ['不是', '取消']) it(`答 ${answer} 撤销追问，零草稿零入账`, async () => {
    const w = await worldM05(); const before = await start(w);
    expect(await w.call('m-zhao', answer)).toBe('Front Claw：好的，这条没有记。');
    await delta(w, before, 0, 0);
    expect(await w.base.getConfig(key)).toBe('');
  });
  it('新报单作废原追问并处理新单，提醒重新报旧单', async () => {
    const w = await worldM05(); const before = await start(w);
    const reply = await w.call('m-zhao', '逯姨：1873（小赵）');
    expect(reply).toContain(reminder);
    expect(reply).toContain('客户：逯姨');
    expect(reply).toContain('还没入账');
    expect(reply).toContain('回复「对」');
    await delta(w, before, 1, 0);
    expect(await w.base.getConfig(key)).toBe('');
  });
  it('新报单仍需新客追问时，只保留新名字的待答对象', async () => {
    const w = await worldM05(); const before = await start(w);
    const reply = await w.call('m-zhao', '逯霁：1873（小赵）');
    expect(reply).toContain(reminder);
    expect(reply).toContain('是新客户「逯霁」吗？');
    await delta(w, before, 0, 0);
    expect(JSON.parse((await w.base.getConfig(key))!).names).toEqual(['逯霁']);
    expect(await w.call('m-zhao', '是')).toContain('客户：逯霁');
    await delta(w, before, 1, 0);
    expect(await w.base.getConfig(key)).toBe('');
  });
  it('D175：D171 未过关口，保留原追问并提示下一步', async () => {
    const w = await worldM05(); const before = await start(w);
    const reply = await w.call('m-zhao', '累计：1873（小赵）');
    // D175 白名单：通用先问不产生新挂起项，不能清旧追问。
    expect(reply).not.toContain(reminder);
    expect(reply).toContain(NOT_A_CUSTOMER_NAME_ASK);
    await delta(w, before, 0, 0);
    expect(JSON.parse((await w.base.getConfig(key))!).names).toEqual([name]);
    expect(await w.call('m-zhao', '是')).toContain('还没入账');
    await w.call('m-zhao', '对');
    await delta(w, before, 1, 1);
  });
  for (const text of ['【11月11日】逯姨：1873（小赵）', '【栖鹭店】逯姨：1873（小赵）']) it(`D175：入口拒绝保留旧追问 ${text}`, async () => {
    const w = await worldM05(); const before = await start(w);
    const reply = await w.call('m-zhao', text);
    // D175：入口拒绝不属于已准入新报单。
    expect(reply).not.toContain(reminder);
    expect(reply).toMatch(/不能|只能/);
    await delta(w, before, 0, 0);
    expect(JSON.parse((await w.base.getConfig(key))!).names).toEqual([name]);
    expect(await w.call('m-zhao', '是')).toContain('还没入账');
    await w.call('m-zhao', '对');
    await delta(w, before, 1, 1);
  });
  for (const answer of ['是', '对']) it(`到期边界后 ${answer} 无效，自动清追问`, async () => {
    let at = Date.parse('2026-11-16T02:00:00Z');
    const w = await worldM05({ now: () => new Date(at) }); const before = await start(w);
    const saved = JSON.parse((await w.base.getConfig(key))!);
    expect(Number.isFinite(Date.parse(saved.expiresAt))).toBe(true);
    at = Date.parse(saved.expiresAt);
    const reply = await w.call('m-zhao', answer);
    expect(reply).not.toContain('还没入账');
    expect(reply).not.toBe('Front Claw：没有写入。');
    expect(reply).toMatch(/请|重新/);
    await delta(w, before, 0, 0);
    expect(await w.base.getConfig(key)).toBe('');
  });
  it('到期前仍有效；追问和草稿使用同一确认窗口', async () => {
    let at = Date.parse('2026-11-16T02:00:00Z');
    const w = await worldM05({ now: () => new Date(at) }); const before = await start(w);
    const saved = JSON.parse((await w.base.getConfig(key))!);
    expect(Number.isFinite(Date.parse(saved.expiresAt))).toBe(true);
    at = Date.parse(saved.expiresAt) - 1;
    expect(await w.call('m-zhao', '是')).toContain('还没入账');
    const draft = (await w.base.listDrafts({ status: 'pending' }))[0]!;
    expect(draft.expiresAt).toBe(saved.expiresAt);
    await delta(w, before, 1, 0);
    expect(await w.base.getConfig(key)).toBe('');
  });
  it('答是后的异步读取跨过期限，不能在下一窗口建立旧报单草稿', async () => {
    let at = Date.parse('2026-11-16T02:00:00Z');
    const w = await worldM05({ now: () => new Date(at) }); const before = await start(w);
    const saved = JSON.parse((await w.base.getConfig(key))!);
    const listPeople = w.store.listPeople.bind(w.store);
    const getConfig = w.store.getConfig.bind(w.store);
    let askRead = false;
    const configRead = vi.spyOn(w.store, 'getConfig').mockImplementation(async keyRead => {
      const raw = await getConfig(keyRead);
      if (keyRead === key) askRead = true;
      return raw;
    });
    const read = vi.spyOn(w.store, 'listPeople').mockImplementation(async () => {
      const people = await listPeople();
      if (askRead) at = Date.parse(saved.expiresAt);
      return people;
    });
    // D185：异步读取期间过期的追问也只回 D176，消费后不再提醒。
    expect(await w.call('m-zhao', '是')).toBe(`上一笔「${name}」已过期，没有记，需要的话请重新报。`);
    read.mockRestore();
    configRead.mockRestore();
    await delta(w, before, 0, 0);
    expect(await w.base.getConfig(key)).toBe('');
  });
  it('答是后重复对：确认一次、第二次已入账提示，总共一笔', async () => {
    const w = await worldM05(); const before = await start(w);
    expect(await w.call('m-zhao', '是')).toContain('回复「对」');
    await delta(w, before, 1, 0);
    expect(await w.base.getConfig(key)).toBe('');
    expect(await w.call('m-zhao', '对')).toContain('已入账');
    await delta(w, before, 1, 1);
    expect(await w.call('m-zhao', '对')).toBe(ALREADY_CONFIRMED_TEXT);
    await delta(w, before, 1, 1);
    expect(await w.base.getConfig(key)).toBe('');
  });
  it('无关答复也不能只回没有写入，应按新消息提供下一步', async () => {
    const w = await worldM05(); const before = await start(w);
    const saved = await w.base.getConfig(key);
    const reply = await w.call('m-zhao', '嗯');
    expect(reply).not.toBe('Front Claw：没有写入。');
    expect(reply).toMatch(/请|重新/);
    await delta(w, before, 0, 0);
    // D175：无关答复不消费原追问。
    expect(await w.base.getConfig(key)).toBe(saved);
  });
  it('正常草稿确认不增加追问的存储读写', async () => {
    const w = await worldM05();
    await w.call('m-zhao', '郗姨：1437（小赵）');
    w.reset();
    expect(await w.call('m-zhao', '对')).toContain('已入账');
    // D172：沿用原有一次读取，不能在并发确认路径上再加操作。
    expect(w.spy.reads.filter(r => r.method === 'getConfig' && r.args[0] === key)).toHaveLength(1);
    expect(w.spy.reads.filter(r => r.method === 'setConfig' && r.args[0] === key)).toHaveLength(0);
  });
  for (const text of ['累计：1873（小赵）', '逯姨：1873（小赵）']) it(`读取追问时取消，迟到消费不撤销追问 ${text}`, async () => {
    const w = await worldM05(); const before = await start(w);
    const saved = await w.base.getConfig(key);
    const abort = new AbortController();
    const getConfig = w.store.getConfig.bind(w.store);
    const read = vi.spyOn(w.store, 'getConfig').mockImplementation(async keyRead => {
      const raw = await getConfig(keyRead);
      if (keyRead === key) abort.abort();
      return raw;
    });
    const handler = createWecomBotHandler({
      mode: 'isolated-synthetic', employeeLoop: true, accessPolicy: true, store: w.store,
      now: () => new Date('2026-11-12T02:00:00Z'), resolve: id => w.base.getPersonByMember(id),
      send: async () => 'sent', model: { complete: async () => ({ type: 'chat', text: '离线桩' }) },
    });
    const result = await handler.handleMessage({ memberId: 'm-zhao', text, messageId: 'r19-cancel-read', sessionId: 'session-m-zhao', bindingVersion: 1, signal: abort.signal });
    expect(result.state).toBe('cancelled');
    await new Promise<void>(resolve => setImmediate(resolve));
    read.mockRestore();
    expect(await w.base.getConfig(key)).toBe(saved);
    await delta(w, before, 0, 0);
  });
});

describe('R19 D171 冻结汇总词粗筛', () => {
  it('汇总词来自冻结 config，保留原汇总词行为', () => {
    const config = JSON.parse(readFileSync(new URL('../../config/customer-not-name.json', import.meta.url), 'utf8'));
    expect(config.frozen).toBe(true);
    for (const word of ['小计', '合计', '总计', '共计', '一共', '总共', '累计', '总额', '加起来']) {
      expect(config.words).toContain(word);
      expect(NOT_CUSTOMER_NAME.test(word)).toBe(true);
    }
  });
  for (const word of ['小计', '合计', '总计', '共计', '一共', '总共', '累计']) {
    for (const employee of ['', '（小赵）']) it(`${word}${employee} 通用先问，回是也不建`, async () => {
      const w = await worldM05(); const before = await counts(w);
      expect(await w.call('m-zhao', `${word}：1437${employee}`)).toBe(NOT_A_CUSTOMER_NAME_ASK);
      expect((await w.base.getConfig(key))?.trim() ?? '').toBe('');
      const yes = await w.call('m-zhao', '是');
      expect(yes).not.toMatch(/还没入账|是新客户/);
      await delta(w, before, 0, 0);
      expect((await collectKnownCustomerNames(w.base, 's-b')).has(word)).toBe(false);
    });
  }
});

describe('R19 D173 结构优先级', () => {
  for (const phrase of ['不用上周那种补报', '无需前天的补录', '别当漏登', '不用再按早先说的补报']) {
    for (const text of [`${phrase}，郗姨：1437（小赵）`, `郗姨：1437（小赵），${phrase}`]) it(`未见否定补报先问 ${text}`, async () => {
      const w = await worldM05(); const before = await counts(w);
      expect(textLevelImpurity(text, '2026-11-12')).toBe('unseen-makeup');
      const reply = await w.call('m-zhao', text);
      expect(reply).toBe(GENERIC_MODEL_ASK);
      expect(reply).not.toContain('只能报今天');
      await delta(w, before, 0, 0);
    });
  }
  for (const customer of ['郗蘅', '查蘅', '单蘅', '欧阳蘅', '阿蘅']) {
    for (const text of [`${customer}：1437`, `${customer}：1437（小赵）`, `【11月12日】${customer}：1437（小赵）`, `报数：${customer}：1437（小赵）`]) it(`D170 形态问新客户 ${text}`, async () => {
      const w = await worldM05(); const before = await counts(w);
      expect(await w.call('m-zhao', text)).toBe(`Front Claw：是新客户「${customer}」吗？`);
      await delta(w, before, 0, 0);
      expect(JSON.parse((await w.base.getConfig(key))!).names).toEqual([customer]);
    });
  }
});


describe('R19 D174 / D172 统一挂起位状态矩阵', () => {
  const replacements = [
    { label: '标准行', text: '逯姨：1873（小赵）', draft: 1, askNames: [], reply: '客户：逯姨' },
    { label: '新客户', text: '逯霁：1873（小赵）', draft: 0, askNames: ['逯霁'], reply: '是新客户「逯霁」吗？' },
    { label: '关口先问', text: '累计：1873（小赵）', draft: 0, askNames: [], reply: NOT_A_CUSTOMER_NAME_ASK },
    { label: '跨店拒绝', text: '【栖鹭店】逯姨：1873（小赵）', draft: 0, askNames: [], reply: '跨店不能代报' },
  ];
  for (const kind of ['草稿', '追问'] as const) {
    for (const next of replacements) it(`${kind} × ${next.label}：D175 只替换准入的新挂起项`, async () => {
      const w = await worldM05();
      await w.call('m-zhao', kind === '草稿' ? '郗姨：1437（小赵）' : `${name}：1437（小赵）`);
      const before = await counts(w);
      const old = (await w.base.listDrafts()).find(d => d.status === 'pending');
      const replacing = next.label === '标准行' || next.label === '新客户';
      const savedAsk = await w.base.getConfig(key);
      const expectedReminder = kind === '草稿' ? '上一笔「郗姨 1437元」没有确认，已作废，需要的话请重新报。' : reminder;
      const reply = await w.call('m-zhao', next.text);
      // D175 白名单：跨店拒绝和 D171 先问均保留原挂起项。
      expect(reply.startsWith(expectedReminder + '\n')).toBe(replacing);
      expect(reply).toContain(next.reply);
      if (old) expect((await w.base.getDraft(old.draftId))?.status).toBe(replacing ? 'void' : 'pending');
      const raw = await w.base.getConfig(key);
      if (replacing) expect(raw ? JSON.parse(raw).names : []).toEqual(next.askNames);
      else expect(raw).toBe(savedAsk);
      expect((await w.base.listDrafts()).filter(d => d.status === 'pending')).toHaveLength(replacing ? next.draft : Number(kind === '草稿'));
      await delta(w, before, next.draft, 0);
      expect((await w.base.listEntries()).filter(e => e.customerName)).toHaveLength(0);
    });
  }
  it('草稿 × 对：只确认当前那件，重复对不加账', async () => {
    const w = await worldM05();
    await w.call('m-zhao', '郗姨：1437（小赵）');
    await w.call('m-zhao', '逯姨：1873（小赵）');
    const before = await counts(w);
    expect(await w.call('m-zhao', '对')).toContain('已入账');
    await delta(w, before, 0, 1);
    expect((await w.base.listEntries()).filter(e => e.customerName).map(e => [e.customerName, e.amount])).toEqual([['逯姨', 187300]]);
    expect((await w.base.listDrafts()).map(d => d.status).sort()).toEqual(['confirmed', 'void']);
    expect(await w.call('m-zhao', '对')).toBe(ALREADY_CONFIRMED_TEXT);
    await delta(w, before, 0, 1);
  });
  it('草稿 × 过期后对：作废，不入账，不恢复客户名', async () => {
    let at = Date.parse('2026-11-16T02:00:00Z');
    const w = await worldM05({ now: () => new Date(at) });
    await start(w); await w.call('m-zhao', '是');
    const draft = (await w.base.listDrafts())[0]!;
    const before = await counts(w); at = Date.parse(draft.expiresAt);
    // D181-4：过期后回「对」只回 D143，不重复点名提醒。
    expect(await w.call('m-zhao', '对')).toBe(DRAFT_EXPIRED_REREPORT);
    expect((await w.base.getDraft(draft.draftId))?.status).toBe('void');
    await delta(w, before, 0, 0);
    expect((await collectKnownCustomerNames(w.base, 's-b')).has(name)).toBe(false);
  });
  it('草稿确认的异步查重跨过期限：仍由挂起位作废，零入账', async () => {
    let at = Date.parse('2026-11-16T02:00:00Z');
    const w = await worldM05({ now: () => new Date(at) });
    await w.call('m-zhao', '郗姨：1437（小赵）');
    const draft = (await w.base.listDrafts({ status: 'pending' }))[0]!;
    const before = await counts(w);
    const listEntries = w.store.listEntries.bind(w.store);
    vi.spyOn(w.store, 'listEntries').mockImplementation(async query => {
      const rows = await listEntries(query);
      at = Date.parse(draft.expiresAt);
      return rows;
    });
    // D181-4：过期后回「对」只回 D143，不重复点名提醒。
    expect(await w.call('m-zhao', '对')).toBe(DRAFT_EXPIRED_REREPORT);
    expect((await w.base.getDraft(draft.draftId))?.status).toBe('void');
    await delta(w, before, 0, 0);
  });
  for (const kind of ['草稿', '追问'] as const) {
    for (const text of ['我的进度', '我的预约', '本店汇总', '今天谁没报', '辛苦了']) it(`${kind} × 非报单新消息 ${text}：D175 保留原项，之后仍可确认`, async () => {
      const w = await worldM05();
      await w.call('m-zhao', kind === '草稿' ? '郗姨：1437（小赵）' : `${name}：1437（小赵）`);
      const before = await counts(w);
      const savedAsk = await w.base.getConfig(key);
      const reply = await w.call('m-zhao', text);
      // D175 覆盖原 R19 非报单作废断言。
      expect(reply).not.toMatch(/上一[笔条]/);
      expect((await w.base.listDrafts()).filter(d => d.status === 'pending')).toHaveLength(Number(kind === '草稿'));
      expect(await w.base.getConfig(key)).toBe(savedAsk);
      if (kind === '追问') await w.call('m-zhao', '是');
      await w.call('m-zhao', '对');
      await delta(w, before, Number(kind === '追问'), 1);
    });
  }
  it('多笔标准清单占一位，作废提醒逐笔点名原客户与金额', async () => {
    const w = await worldM05();
    await w.call('m-zhao', '郗姨：1437（小赵）；訾姨：2693（小赵）');
    const reply = await w.call('m-zhao', '逯霁：1873（小赵）');
    // R21：D174 多项按每笔一行完整措辞，与 D176/D178 一致（待产品定）。
    expect(reply.startsWith('上一笔「郗姨 1437元」没有确认，已作废，需要的话请重新报。\n上一笔「訾姨 2693元」没有确认，已作废，需要的话请重新报。\n')).toBe(true);
    expect((await w.base.listDrafts()).map(d => d.status)).toEqual(['void']);
    expect((await w.base.listEntries()).filter(e => e.customerName)).toHaveLength(0);
  });
  it('多客户追问占一位，作废提醒用真实换行逐个点名', async () => {
    const w = await worldM05();
    await w.call('m-zhao', '郗蘅：1437（小赵）；訾霁：2693（小赵）');
    expect(JSON.parse((await w.base.getConfig(key))!).names).toEqual(['郗蘅', '訾霁']);
    const reply = await w.call('m-zhao', '逯姨：1873（小赵）');
    expect(reply.startsWith('上一条「郗蘅」没有记，需要的话请重新报。\n上一条「訾霁」没有记，需要的话请重新报。\n')).toBe(true);
    expect((await w.base.listDrafts({ status: 'pending' }))).toHaveLength(1);
    expect(await w.base.getConfig(key)).toBe('');
  });
  it('D175：追问的肯定词不借给草稿，回是保留草稿，随后对才入账', async () => {
    const w = await worldM05();
    await w.call('m-zhao', '郗姨：1437（小赵）');
    const before = await counts(w);
    // D175：不是新报单，也不是草稿确认词；只回答，不作废。
    // D182：回「是」未占挂起位且回复为澄清，也要带原草稿尾句。
    expect(await w.call('m-zhao', '是')).toContain('上一笔「郗姨 1437元」还在等你回「对」确认。');
    expect((await w.base.listDrafts()).map(d => d.status)).toEqual(['pending']);
    await w.call('m-zhao', '对');
    await delta(w, before, 0, 1);
  });
  for (const kind of ['草稿', '追问'] as const) it(`${kind} × 已授权营销新消息：D175 生成期间仍保留旧项`, async () => {
    let base: World['base'];
    let called = false;
    const marketingKey = newCustomerAskKey('p-wang-yj', 'session-m-wang-yj');
    const members = membersM05();
    members['p-wang-yj']!.capabilities = ['marketing'];
    const w = await worldM05({ policy: policyM05(1, members), router: { marketing: { enabled: true, handle: async () => {
      called = true;
      // D175：营销回调也不能消费挂起项。
      expect(await base.listDrafts({ status: 'pending' })).toHaveLength(Number(kind === '草稿'));
      expect(!!(await base.getConfig(marketingKey))).toBe(kind === '追问');
      return '自编离线文案';
    } } } });
    base = w.base;
    await w.call('m-wang-yj', kind === '草稿' ? '郗姨：1437（苏晓禾）' : '郗蘅：1437（苏晓禾）');
    const before = await counts(w);
    const reply = await w.call('m-wang-yj', '写一条补水护理营销文案');
    expect(called).toBe(true);
    expect(reply).toContain('自编离线文案');
    expect(reply).not.toMatch(/上一[笔条]/);
    if (kind === '追问') await w.call('m-wang-yj', '是');
    await w.call('m-wang-yj', '对');
    await delta(w, before, Number(kind === '追问'), 1);
  });
});
