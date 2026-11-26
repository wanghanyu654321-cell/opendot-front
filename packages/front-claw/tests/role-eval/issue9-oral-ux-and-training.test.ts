import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createConsumerLease } from '../../src/opendot/consumer-lease.js';
import { parseStandaloneAppointmentTime } from '../../src/role-eval/appointments.js';
import type { EmployeeRouterOptions } from '../../src/role-eval/employee-entry.js';
import { ACCESS_DENIED, D175_INTERLEAVED_GUIDANCE, STALE_CONSUMER, d175InterleavedKey } from '../../src/role-eval/employee-loop.js';
import { classifyIntent } from '../../src/role-eval/intent-router.js';
import { otherStoresNamed } from '../../src/role-eval/scope-refusal.js';
import { parseTrainingSummary, searchTrainingSummary } from '../../src/role-eval/training-knowledge.js';
import { createWecomBotHandler } from '../../src/role-eval/wecom-bot-unified-handler.js';
import { membersM05, policyM05, worldM05 } from './appointment-fixture-m05.js';
import { NOW } from './access-fixture-m03.js';
import { peopleM04 } from './ledger-fixture-m04.js';

const memberId = 'm-zhao';
const personId = 'p-zhao';
const sessionId = 'session-m-zhao';
const interleavedKey = d175InterleavedKey(personId, sessionId);
const timeAskKey = 'employee-loop:appointment-time-ask:p-zhao:session-m-zhao';
const appointment = '王姐明天下午补水预约';
const softQuestion = '家访五步法怎么带教';
const replyOf = (result: { replies: string[] }) => result.replies.join('\n');

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function setup({
  grantMarketing = false, passthroughMarketing = true, accessPolicy = true, now = () => NOW, semantic, modelClassify,
}: { grantMarketing?: boolean; passthroughMarketing?: boolean; accessPolicy?: boolean;
  now?: () => Date; semantic?: EmployeeRouterOptions['semantic']; modelClassify?: EmployeeRouterOptions['modelClassify'] } = {}) {
  const members = membersM05();
  if (grantMarketing) members[personId]!.capabilities = ['marketing'];
  const w = await worldM05({ policy: policyM05(1, members) });
  const handler = createWecomBotHandler({
    legacyEntry: true,
    mode: 'isolated-synthetic',
    store: w.store,
    now,
    resolve: id => w.base.getPersonByMember(id),
    send: async () => 'sent',
    model: { complete: async () => ({ type: 'chat', text: '离线测试' }) },
    employeeLoop: true,
    accessPolicy,
    router: {
      passthroughMarketing, ...(semantic ? { semantic } : {}), ...(modelClassify ? { modelClassify } : {}),
      marketing: { enabled: true, handle: async () => '营销稿' },
    },
  });
  let seq = 0;
  const send = (text: string, input: Partial<Parameters<typeof handler.handleMessage>[0]> = {}) =>
    handler.handleMessage({ memberId, sessionId, bindingVersion: 1, messageId: `issue9-${++seq}`, text, ...input });
  const say = async (text: string) => replyOf(await send(text));
  return { ...w, send, say };
}

describe('Issue #9 / Issue #20 口语确认', () => {
  it.each(['确认入账', '确认认账', '全部确认'])('插话后单字「对」与裸「确认」均拦截，「%s」入账一次', async command => {
    const { base, say, send } = await setup({ grantMarketing: true });
    // 这个用例用已有档案标记隔离 D175 与本 Issue 的营销角色变更。
    const person = (await base.getPerson(personId))!;
    await base.savePerson({ ...person, roles: ['marketing'] });
    const before = await base.listEntries();
    await say('郗姨：680（小赵）');
    const [draft] = await base.listDrafts({ status: 'pending' });
    expect(await send('写护肤活动文案')).toMatchObject({ pass: true });
    expect(await base.getConfig(interleavedKey)).toBe(draft!.draftId);

    expect(await say('对')).toContain(D175_INTERLEAVED_GUIDANCE);
    expect(await base.listEntries()).toEqual(before);
    expect(await say('确认')).toContain(D175_INTERLEAVED_GUIDANCE);
    expect(await base.listEntries()).toEqual(before);
    expect((await base.listDrafts({ status: 'pending' }))[0]?.draftId).toBe(draft!.draftId);
    expect(await say(command)).toContain('已入账 1 笔');
    const confirmed = await base.listEntries();
    expect(confirmed).toHaveLength(before.length + 1);
    expect(await base.getConfig(interleavedKey)).toBe('');
    await say('对');
    expect(await base.listEntries()).toEqual(confirmed);
  });

  it('追问末尾按当前草稿的插话标记提示确认口令', async () => {
    const { base, say } = await setup();
    await say('郗姨：680（小赵）');
    const [draft] = await base.listDrafts({ status: 'pending' });
    expect(await say('李姐：2867（小赵）先记着')).toContain('还在等你回「对」确认。');
    await base.setConfig(interleavedKey, draft!.draftId);
    expect(await say('李姐：2867（小赵）先记着')).toMatch(/还在等你回「确认入账」或「全部确认」确认。$/);
  });
});

describe('Issue #9 报数备注', () => {
  it.each(['张姐刚做了补水项目680', '李姐皮肤管理套餐 1280'])('白名单项目可生成待确认草稿：%s', async text => {
    const { base, say } = await setup();
    const before = await base.listEntries();
    expect(await say(text)).toContain('还没入账');
    expect(await base.listDrafts({ status: 'pending' })).toHaveLength(1);
    expect(await base.listEntries()).toEqual(before);
  });

  it('其他备注提示重发，单回确认无账目写入', async () => {
    const { base, say } = await setup();
    const before = await base.listEntries();
    expect(await say('郗姨：2867（小赵）先记着')).toBe(
      'Front Claw：行尾备注「先记着」需要确认后再记（请去掉该备注直接重发「客户 金额」，单回「确认」不会入账）。没有写入任何账目。',
    );
    await say('确认');
    expect(await base.listDrafts({ status: 'pending' })).toEqual([]);
    expect(await base.listEntries()).toEqual(before);
  });
});

describe('Issue #9 跨店简称', () => {
  const stores = peopleM04.map(person => ({
    ...person,
    storeName: person.storeId === 's-a' ? '测试二店' : '试点测试门店',
  }));
  it.each([
    ['查一下二店业绩', '测试二店'],
    ['看下B店汇总', 'B店'],
    ['到B店里查业绩', 'B店'],
    ['查二店里谁没报', '测试二店'],
    ['三店的进度', '三店'],
    ['查一下外店业绩', '外店'],
  ])('拒绝 %s，且不读取账目', async (text, expectedStore) => {
    const w = await worldM05({ people: stores });
    const reply = await w.call('m-wang-yj', text);
    expect(reply).toContain('不能做——只能办本店（试点测试门店）的事');
    expect(reply).toContain(expectedStore);
    expect(w.entryStores()).toEqual([]);
  });

  it('保留本店简称、普通门店用词和本店查询', async () => {
    const actor = peopleM04.find(person => person.personId === 'p-wang-yj')!;
    expect(otherStoresNamed('我们店的B店店长今天到店，看看门店业绩和全店汇总', peopleM04, actor)).toEqual([]);
    expect(otherStoresNamed('查一下Ａ店业绩', peopleM04, actor)).toEqual(['测试A店']);
    expect(otherStoresNamed('10号测试B店\n300（小赵）', peopleM04, { ...actor, storeName: 'B店' })).toEqual([]);
    const w = await worldM05();
    expect(await w.call('m-wang-yj', '查本店业绩')).toContain(actor.storeName);
    expect(w.entryStores()).toEqual(['s-b']);
  });
});

describe('Issue #9 预约补时间', () => {
  it('仅接受完整有效的钟点，归一全角数字和时钟冒号', () => {
    expect(parseStandaloneAppointmentTime(' 下午 ４点 ')).toBe('下午4点');
    expect(parseStandaloneAppointmentTime('１６：００')).toBe('16:00');
    for (const text of ['1', '2', '下午', '24:00', '16:80', '4点680块', '4点报数']) {
      expect(parseStandaloneAppointmentTime(text), text).toBeNull();
    }
  });

  it.each([
    ['4点', '16:00'],
    ['下午4点', '16:00'],
    ['下午3点半', '15:30'],
    ['16:00', '16:00'],
  ])('补答 %s 后生成原客户的预约草稿', async (time, expectedTime) => {
    const { base, say } = await setup();
    expect(await say(appointment)).toContain('预约要说清几点');
    expect(await base.getConfig(timeAskKey)).toContain(appointment);
    expect(await say(time)).toContain(`11月13日（周五）${expectedTime}`);
    expect(await base.getConfig(timeAskKey)).toBe('');
    expect(await base.listAppointments()).toEqual([]);
    expect(await base.listDrafts({ status: 'pending' })).toEqual([
      expect.objectContaining({ kind: 'appointment', payload: expect.objectContaining({
        items: [expect.objectContaining({ customer: '王姐', whenText: `2026-11-13 ${expectedTime}`, note: '补水' })],
      }) }),
    ]);
    expect(await say('对')).toContain('预约已登记');
    expect(await base.listAppointments()).toHaveLength(1);
  });

  it.each(['1', '2', '4点 680元', '谢谢'])('非时间答复 %s 清掉追问并按本轮消息处理', async text => {
    const { base, say } = await setup();
    await say(appointment);
    expect(await base.getConfig(timeAskKey)).toContain(appointment);
    const reply = await say(text);
    if (text === '谢谢') expect(reply).toContain('不客气');
    expect(await base.getConfig(timeAskKey)).toBe('');
    await say('4点');
    expect(await base.listDrafts({ status: 'pending' })).toEqual([]);
    expect(await base.listAppointments()).toEqual([]);
  });

  it('查询本人进度保留预约追问，下一轮仍可补时间', async () => {
    const { base, say } = await setup();
    await say(appointment);
    const pending = await base.getConfig(timeAskKey);
    expect(pending).toContain(appointment);
    expect(await say('我的进度')).toContain('今天 已做 900');
    expect(await base.getConfig(timeAskKey)).toBe(pending);
    expect(await say('下午4点')).toContain('16:00');
  });

  it('预约追问隔离会话，撤掉预约权限后不能补建草稿', async () => {
    const { base, say, send } = await setup();
    await say(appointment);
    expect(replyOf(await send('4点', { sessionId: 'other-session' }))).not.toContain('预约还没登记');
    expect(await base.getConfig(timeAskKey)).toContain(appointment);
    const { updateAccessPolicy } = await import('../../src/role-eval/access-policy.js');
    const members = membersM05();
    members[personId]!.capabilities = ['report_self'];
    expect(await updateAccessPolicy(base, {
      expectedVersion: 1, next: policyM05(2, members), actor: 'test-admin', reason: 'test', at: NOW.toISOString(),
    })).toEqual({ ok: true, version: 2 });
    expect(await say('4点')).toBe(ACCESS_DENIED);
    expect(await say(appointment)).toBe(ACCESS_DENIED);
    expect(await base.getConfig(timeAskKey)).toBe('');
    expect(await base.listDrafts({ status: 'pending' })).toEqual([]);
  });

  it('更早到达的时间消息不能消费后来建立的预约追问', async () => {
    const entered = deferred();
    const release = deferred();
    const { base, say } = await setup({ semantic: async ({ text }) => {
      if (text === '4点') {
        entered.resolve();
        await release.promise;
      }
      return null;
    } });
    const earlier = say('4点');
    try {
      await entered.promise;
      expect(await say(appointment)).toContain('预约要说清几点');
    } finally {
      release.resolve();
    }
    expect(await earlier).not.toContain('预约还没登记');
    expect(await base.getConfig(timeAskKey)).toContain(appointment);
    expect(await say('4点')).toContain('16:00');
  });

  it('跨午夜补答沿用发问日期，项目不串入回答中的时段', async () => {
    let at = new Date('2026-11-12T15:59:30Z');
    const { base, say } = await setup({ now: () => at });
    await say('王姐明天下午来做补水');
    at = new Date('2026-11-12T16:00:30Z');
    await say('上午9点');
    expect(await base.listDrafts({ status: 'pending' })).toEqual([
      expect.objectContaining({ payload: expect.objectContaining({
        items: [expect.objectContaining({ customer: '王姐', whenText: '2026-11-13 09:00', note: '补水' })],
      }) }),
    ]);
  });

  it('绑定版本切换后不沿用上个绑定的预约上下文', async () => {
    const { base, say, send } = await setup();
    await say(appointment);
    expect(replyOf(await send('4点', { bindingVersion: 2 }))).not.toContain('预约还没登记');
    expect(await base.listDrafts({ status: 'pending' })).toEqual([]);
  });

  it('已有预约追问时纯时间答复优先于语义分类', async () => {
    const { say } = await setup({
      grantMarketing: true,
      semantic: async () => ({ route: 'marketing', confidence: 1 }),
    });
    await say(appointment);
    expect(await say('4点')).toContain('预约还没登记');
  });

  it('已有待确认报数时不暂存新的预约追问', async () => {
    const { base, say } = await setup();
    expect(await say('郗姨：680（小赵）')).toContain('还没入账');
    expect(await say(appointment)).toContain('请先确认或取消当前草稿');
    expect(await base.getConfig(timeAskKey)).toBeNull();
  });

  it('同一会话的并发追问保留较新的预约', async () => {
    const { base, say } = await setup();
    const earlierWrite = deferred();
    const laterRead = deferred();
    const release = deferred();
    let writing = false;
    const getConfig = base.getConfig.bind(base);
    const setConfig = base.setConfig.bind(base);
    vi.spyOn(base, 'getConfig').mockImplementation(async key => {
      const value = await getConfig(key);
      if (key === timeAskKey && writing) laterRead.resolve();
      return value;
    });
    vi.spyOn(base, 'setConfig').mockImplementation(async (key, value, fence) => {
      if (key === timeAskKey && value.includes('王姐')) {
        writing = true;
        earlierWrite.resolve();
        await release.promise;
      }
      await setConfig(key, value, fence);
    });
    const earlier = say(appointment);
    await earlierWrite.promise;
    const later = say('李姐后天下午补水预约');
    try {
      await laterRead.promise;
      await new Promise<void>(resolve => setImmediate(resolve));
    } finally {
      release.resolve();
    }
    await Promise.all([earlier, later]);
    expect(await say('4点')).toContain('顾客 李姐');
    expect(await base.listDrafts({ status: 'pending' })).toHaveLength(1);
  });

  it('过期租约不能暂存预约追问', async () => {
    const { base, send } = await setup();
    const lease = createConsumerLease({ store: base, owner: 'old', ttlMs: 30_000, now: () => new Date(NOW.getTime() - 60_000) });
    expect(await lease.acquire()).toBe(true);
    const current = createConsumerLease({ store: base, owner: 'current', ttlMs: 30_000, now: () => NOW });
    expect(await current.acquire()).toBe(true);
    expect(replyOf(await send(appointment, { fence: lease.fence()! }))).toBe(STALE_CONSUMER);
    expect(await base.getConfig(timeAskKey)).toBeNull();
  });
});

describe('Issue #9 培训知识与软岗位', () => {
  it('企微培训工作区可查询同作用域教材，账号或工作区不同则拒绝', () => {
    const scope = { accountId: 'trainer', workspaceJid: 'web:wecom-front-claw:training:abc_123' };
    const body = '# 培训教材\n\n## 家访五步法\n先了解现状。';
    const summary = parseTrainingSummary(body, createHash('sha256').update(body).digest('hex'), scope, 'training.md');
    expect(searchTrainingSummary(summary, '家访五步法', scope).matches[0]?.text).toContain('先了解现状');
    expect(() => searchTrainingSummary(summary, '家访五步法', { ...scope, accountId: 'other' })).toThrow('training_scope_denied');
    for (const workspaceJid of ['web:wecom-front-claw:training:abc_124', 'web:marketing', 'web:other', 'other']) {
      expect(() => searchTrainingSummary(summary, '家访五步法', { ...scope, workspaceJid })).toThrow('training_scope_denied');
    }
  });

  it.each(['话术', '客诉', '带教', '家访', '五步法', '演练', '课件', '复盘建议', '经营诊断', '投流复盘', '团购诊断'])(
    '%s 独立命中软岗位路由',
    word => expect(classifyIntent(word).label).toBe('marketing'),
  );

  it.each([
    ['张姐 680（小赵）带教', 'report'],
    ['我的业绩复盘建议', 'progress'],
    ['帮我看今天业绩，顺便给些复盘建议', 'progress'],
    ['查一下本店业绩，顺便给点复盘建议', 'summary'],
    ['入账结果和复盘建议', 'result'],
    ['明天下午3点预约王姐做客诉演练', 'appointment'],
    ['帮我预约王姐明天下午4点，再给一份预约客户接待话术', 'appointment'],
    ['王姐明天下午补水预约，再给一份预约接待话术', 'appointment'],
    ['门店业绩汇总和经营诊断', 'summary'],
    ['把刚才那笔改成600，给点复盘建议', 'correction'],
    ['本月目标 5w', 'target'],
  ])('硬意图优先：%s', (text, expected) => {
    expect(classifyIntent(text, { businessDay: '2026-11-12' }).label).toBe(expected);
  });

  it('只有策略模式且具备 M03 授权才允许无营销角色的员工走透传', async () => {
    const granted = await setup({ grantMarketing: true });
    for (const text of [softQuestion, '预约客户接待话术', '帮我培训预约接待话术', '天气营销文案']) {
      expect(await granted.send(text)).toMatchObject({ pass: true, target: 'marketing' });
    }
    expect(await granted.base.getConfig(timeAskKey)).toBeNull();
    for (const mode of [{ grantMarketing: false }, { grantMarketing: true, passthroughMarketing: false }, { grantMarketing: true, accessPolicy: false }]) {
      const result = await (await setup(mode)).send(softQuestion);
      expect(result).toMatchObject({ target: 'marketing-unavailable' });
      expect(result).not.toHaveProperty('pass');
    }
  });

  it('同一句的预约话术不抢走真正的预约分句', async () => {
    const { base, say } = await setup({ grantMarketing: true });
    const reply = await say('帮我预约王姐明天下午4点，再给一份预约客户接待话术');
    expect(reply).toContain('顾客 王姐');
    expect(reply).toContain('这次没有办');
    expect(await base.listAppointments()).toEqual([]);
  });

  it('带复盘建议的业绩查询不会透传到软岗位', async () => {
    const { send } = await setup({
      grantMarketing: true,
      modelClassify: async () => ({ intent: 'marketing', object: null, action: null, slots: {}, confidence: 1, uncertain: false }),
    });
    const result = await send('帮我看今天业绩，顺便给些复盘建议');
    expect(result).not.toHaveProperty('pass');
    expect(replyOf(result)).toContain('这条里有好几件事');
  });
});
