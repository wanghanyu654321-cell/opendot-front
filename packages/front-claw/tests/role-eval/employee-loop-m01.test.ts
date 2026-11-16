import { describe, expect, it, vi } from 'vitest';
import { createWecomBotHandler } from '../../src/role-eval/wecom-bot-unified-handler.js';
import { createPostgresPerformanceStore, migratePerformance } from '../../src/role-eval/performance-postgres.js';
import type { Person } from '../../src/role-eval/performance-store.js';
import { MemorySql } from './sql-fixture.js';

const people: Person[] = [
  { personId: 'p-lin', accountId: 'a-lin', memberId: 'm-lin', displayName: '小林', storeId: 's-a', storeName: '测试A店', tier: 'employee', roles: ['marketing'], active: true },
  { personId: 'p-chen', accountId: 'a-chen', memberId: 'm-chen', displayName: '小陈', storeId: 's-a', storeName: '测试A店', tier: 'employee', roles: ['marketing'], active: true },
  { personId: 'p-wang', accountId: 'a-wang', memberId: 'm-wang', displayName: '小王', storeId: 's-b', storeName: '测试B店', tier: 'employee', roles: ['marketing'], active: true },
];
const sheet = '11号测试A店\n380（林林）';
async function world() {
  const sql = new MemorySql();
  await migratePerformance(sql);
  const store = createPostgresPerformanceStore(sql);
  for (const person of people) await store.savePerson(person);
  await store.saveAlias({ storeId: 's-a', alias: '林林', personId: 'p-lin' });
  await store.setConfig('employee-loop:m01', JSON.stringify({ enabled: true, storeId: 's-a', memberIds: ['m-lin', 'm-chen'] }));
  const model = vi.fn(async () => ({ type: 'chat' as const, text: '不应进入模型' }));
  const make = (db = store, onOutbound?: (text: string) => void) => createWecomBotHandler({
    legacyEntry: true, mode: 'isolated-synthetic', store: db, now: () => new Date('2026-11-11T02:00:00Z'),
    resolve: id => db.getPersonByMember(id), send: async () => 'sent', model: { complete: model },
    employeeLoop: true, ...(onOutbound ? { onOutbound } : {}),
  });
  let handler = make();
  let seq = 0;
  const call = (text: string, messageId = `msg-${++seq}`, memberId = 'm-lin', sessionId = 'session-a', bindingVersion = 1) =>
    handler.handleMessage({ memberId, text, messageId, sessionId, bindingVersion });
  return { sql, store, model, make, call, restart: () => { handler = make(createPostgresPerformanceStore(sql)); },
    replace: (next: ReturnType<typeof make>) => { handler = next; },
    snapshot: async () => ({ entries: await store.listEntries(), drafts: await store.listDrafts() }),
  };
}
const reply = (result: { replies: string[] }) => result.replies.join('\n');

describe('M01 员工本人闭环（PG SQL 替身）', () => {
  it('别名回显、确认一次、原消息重放、新实例查本人进度', async () => {
    const w = await world();
    const echo = reply(await w.call(sheet, 'report-1'));
    expect(echo).toContain('小林'); expect(echo).toContain('测试A店'); expect(echo).toContain('380');
    expect(await w.store.listEntries()).toEqual([]);
    expect(reply(await w.call('对', 'confirm-1'))).toContain('已入账');
    expect((await w.store.listEntries()).map(row => row.amount)).toEqual([38000]);
    const before = await w.snapshot();
    await w.call('对', 'confirm-2'); await w.call('对', 'confirm-1'); await w.call(sheet, 'report-1');
    expect(await w.snapshot()).toEqual(before);
    w.restart();
    expect(reply(await w.call('我的进度'))).toContain('380');
    expect(reply(await w.call('我的进度', 'chen-progress', 'm-chen'))).not.toContain('380');
    expect(w.model).not.toHaveBeenCalled();
  });

  it('无草稿和取消后确认零写入，不调用模型', async () => {
    const w = await world();
    let before = await w.snapshot();
    expect(reply(await w.call('对'))).toContain('没有待确认');
    expect(await w.snapshot()).toEqual(before);
    await w.call(sheet); await w.call('取消'); before = await w.snapshot();
    expect(reply(await w.call('对'))).toContain('没有待确认');
    expect(await w.snapshot()).toEqual(before); expect(w.model).not.toHaveBeenCalled();
  });

  it('空名、空门店、未绑定和伪造解析身份全部零写入', async () => {
    const w = await world();
    for (const patch of [{ displayName: ' ' }, { storeName: '' }, { memberId: '' }, { accountId: '' }]) {
      await w.store.savePerson({ ...people[0]!, ...patch });
      const before = await w.snapshot();
      await w.call(sheet); await w.call('对');
      expect(await w.snapshot()).toEqual(before);
    }
    await w.store.savePerson(people[0]!);
    const before = await w.snapshot(); await w.call(sheet, 'unbound', 'unknown');
    expect(await w.snapshot()).toEqual(before);
  });

  it('他人、他店、另一会话和旧绑定版本草稿均不可确认或查询', async () => {
    const w = await world(); await w.call(sheet, 'owned');
    const draft = (await w.store.listDrafts())[0]!;
    const before = await w.snapshot();
    for (const [member, session, version] of [['m-chen', 'session-a', 1], ['m-wang', 'session-a', 1], ['m-lin', 'other', 1], ['m-lin', 'session-a', 2]] as const) {
      await w.call('对', `denied-${member}-${session}-${version}`, member, session, version);
      expect(reply(await w.call(`入账结果 ${draft.draftId}`, `lookup-${member}-${session}-${version}`, member, session, version))).not.toContain('380');
      expect(await w.snapshot()).toEqual(before);
    }
    // D174/D175：准入新报单替换本人旧草稿；跨店拒绝保留当前挂起项。
    expect(reply(await w.call('11号测试A店\n500（小陈）', 'proxy'))).toContain('没有确认，已作废，需要的话请重新报。');
    expect((await w.store.getDraft(draft.draftId))?.status).toBe('void');
    const replacement = (await w.store.listDrafts({ status: 'pending' }))[0]!;
    await w.store.savePerson({ ...people[2]!, storeName: '栖鹭西店' });
    expect(reply(await w.call('11号栖鹭西店\n2869（小王）', 'foreign'))).not.toContain('没有确认，已作废，需要的话请重新报。');
    expect((await w.store.getDraft(replacement.draftId))?.status).toBe('pending');
    expect(await w.store.listDrafts({ status: 'pending' })).toHaveLength(1);
    expect(await w.store.listEntries()).toEqual(before.entries);
    const afterNewMessages = await w.snapshot();
    await w.call('小陈的进度');
    expect(await w.snapshot()).toEqual(afterNewMessages); expect(w.model).not.toHaveBeenCalled();
  });

  it('提交后回包前中断，按原消息和操作号查回，不确认后续草稿', async () => {
    const w = await world(); await w.call(sheet, 'source');
    const operation = (await w.store.listDrafts())[0]!.draftId;
    w.replace(w.make(w.store, () => { throw Error('合成回包中断'); }));
    await expect(w.call('对', 'commit-lost')).rejects.toThrow('合成回包中断');
    expect((await w.store.listEntries()).map(row => row.amount)).toEqual([38000]);
    w.restart();
    for (const id of ['source', 'commit-lost', operation]) expect(reply(await w.call(`入账结果 ${id}`))).toContain('已入账');
    await w.call('11号测试A店\n100（小林）', 'next');
    const before = await w.snapshot();
    await w.call('对', 'commit-lost');
    expect(await w.snapshot()).toEqual(before);
  });

  it('关闭或坏配置停止新写，保留账目和草稿及本人只读结果', async () => {
    const w = await world(); await w.call(sheet); await w.call('对');
    await w.call('11号测试A店\n100（小林）');
    const before = await w.snapshot();
    for (const config of [JSON.stringify({ enabled: false, storeId: 's-a', memberIds: ['m-lin'] }), '{bad', JSON.stringify({ enabled: true, storeId: 's-a', memberIds: [] })]) {
      await w.store.setConfig('employee-loop:m01', config);
      await w.call('对'); await w.call('取消'); await w.call(sheet);
      w.restart(); await w.call('对');
      expect(await w.snapshot()).toEqual(before);
      expect(reply(await w.call('我的进度'))).toContain('380');
    }
  });

  it('写库失败原子回滚，同库恢复继续原确认，不使用内存兜底', async () => {
    const w = await world(); await w.call(sheet, 'source');
    const query = w.sql.query.bind(w.sql);
    const spy = vi.spyOn(w.sql, 'query').mockImplementation(async (sql, params) => {
      if (sql.includes('INSERT INTO front_claw_perf.performance_entries')) throw Error('合成数据库故障');
      return query(sql, params);
    });
    expect(reply(await w.call('对', 'failed-confirm'))).toContain('结果未知');
    expect(await w.store.listEntries()).toEqual([]);
    spy.mockRestore(); w.restart();
    expect(reply(await w.call('对', 'failed-confirm'))).toContain('已入账');
    expect((await w.store.listEntries()).map(row => row.amount)).toEqual([38000]);
  });

  it('同一消息 ID 改文本冲突零写入；过期草稿回「对」不入账并关闭', async () => {
    const w = await world(); await w.call(sheet, 'same');
    const before = await w.snapshot();
    expect(reply(await w.call('对', 'same'))).toContain('冲突');
    expect(await w.snapshot()).toEqual(before);
    const draft = (await w.store.listDrafts())[0]!;
    await w.store.saveDraft({ ...draft, expiresAt: '2000-01-01T00:00:00Z' });
    const expired = await w.snapshot();
    expect(reply(await w.call('对'))).toContain('这笔已过期，请重新报');
    const after = await w.snapshot();
    expect(after.entries).toEqual(expired.entries);
    expect(after.drafts).toHaveLength(expired.drafts.length);
    expect(after.drafts[0]!.status).toBe('void');
  });
});

it('伪造本人名下的他人员工/他店草稿不能确认；旧 handler 不能维护受控草稿', async () => {
  const w = await world(); await w.call(sheet, 'source');
  const draft = (await w.store.listDrafts())[0]!;
  if (draft.payload.type !== 'report') throw Error('测试草稿类型错误');
  for (const changed of [
    { ...draft, storeId: 's-b' },
    { ...draft, reporterPersonId: 'p-chen' },
    { ...draft, payload: { ...draft.payload, added: draft.payload.added.map(item => ({ ...item, employeeId: 'p-chen' })) } },
  ]) {
    await w.store.saveDraft(changed); const before = await w.snapshot(); await w.call('对'); expect(await w.snapshot()).toEqual(before);
  }
  await w.store.saveDraft(draft);
  const legacy = createWecomBotHandler({ legacyEntry: true, mode: 'isolated-synthetic', store: w.store, now: () => new Date('2026-11-12T02:00:00Z'), resolve: id => w.store.getPersonByMember(id), send: async () => 'sent', model: { complete: w.model } });
  const before = await w.snapshot();
  await legacy.runMaintenance(); await legacy.handleMessage({ memberId: 'm-lin', text: '对' }); await legacy.handleMessage({ memberId: 'm-lin', text: '取消' });
  expect(await w.snapshot()).toEqual(before);
});

it('PG 草稿版本比较、只插一次和无认领 commit 均拒绝意外覆盖', async () => {
  const w = await world(); await w.call(sheet);
  const draft = (await w.store.listDrafts())[0]!;
  const next = { ...draft, status: 'confirming' as const };
  expect(await w.store.transitionPendingDraft({ ...draft, payload: { type: 'report', added: [], missing: [], skipped: 0 } }, next)).toBe(false);
  await w.store.saveDraft({ ...draft, status: 'void' }, { ifAbsent: true });
  expect(await w.store.getDraft(draft.draftId)).toEqual(draft);
  const entry = { entryId: 'unclaimed-entry', storeId: 's-a', businessDay: '2026-11-11', customerName: null, amount: 38000, amountType: 'consultant' as const, ownerPersonId: 'p-lin', ownerName: '小林', reporterPersonId: 'p-lin', note: '', status: 'confirmed' as const, disputed: false, createdAt: draft.createdAt };
  expect(await w.store.commitConfirmingDraft({ ...draft, status: 'confirmed' }, [entry])).toBe(0);
  expect(await w.store.listEntries()).toEqual([]); expect(await w.store.getDraft(draft.draftId)).toEqual(draft);
});

it('迟到身份读取改变本人对象、缺消息上下文和数据库读故障均无业务写入', async () => {
  const w = await world(); const before = await w.snapshot();
  await w.make().handleMessage({ memberId: 'm-lin', text: sheet });
  const get = vi.spyOn(w.store, 'getPersonByAccount').mockResolvedValue({ ...people[1]!, accountId: 'a-lin' });
  await w.call(sheet); expect(await w.snapshot()).toEqual(before); get.mockRestore();
  const read = vi.spyOn(w.store, 'listDrafts').mockRejectedValue(Error('合成读故障'));
  expect(reply(await w.call(sheet))).toContain('结果未知'); read.mockRestore();
  expect(await w.snapshot()).toEqual(before);
});

it('输出可关联的合成消息/操作/最终回复生成时延和账目明细证据', async () => {
  const w = await world();
  const traces: unknown[] = [];
  w.replace(createWecomBotHandler({ legacyEntry: true, mode: 'isolated-synthetic', employeeLoop: true, store: w.store, now: () => new Date('2026-11-11T02:00:00Z'),
    resolve: id => w.store.getPersonByMember(id), send: async () => 'sent', model: { complete: w.model }, onEmployeeTrace: event => traces.push(event) }));
  const before = await w.snapshot(); const echo = await w.call(sheet, 'evidence-report');
  const staged = await w.snapshot(); const saved = await w.call('对', 'evidence-confirm');
  const after = await w.snapshot();
  expect(traces).toHaveLength(2); expect(after.entries.map(row => row.amount)).toEqual([38000]);
  console.info(JSON.stringify({ 场景: 'M01合成闭环', 证据类型: 'SQL替身，非真实PG或企微', before, echo, staged, saved, after, traces }));
});
