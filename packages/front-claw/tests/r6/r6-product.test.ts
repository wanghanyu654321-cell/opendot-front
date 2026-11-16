/**
 * R6 产品与数据兜底（自编用例，不取盲测原句）。
 * 数据兜底只作用在报单草稿：本店今天已有该客户时必须二选一，不能只问「对不对」。
 * 查询类（查进度、本店业绩、今天的单）应直接办，不因兜底变得更爱追问。
 */
import { describe, expect, it } from 'vitest';
import { extractReport } from '../../src/role-eval/report-extract.js';
import { parsePureMoney } from '../../src/role-eval/amounts.js';
import { pastDayReportPhrase, isSelfProgressQuery, isStorePerfQuery, NOT_TODAY_REPLY } from '../../src/role-eval/scope-refusal.js';
import { ACCESS_DENIED, REPORT_HINT } from '../../src/role-eval/employee-loop.js';
import { worldM05 } from '../role-eval/appointment-fixture-m05.js';
import { storeCompletionRate, validateAllocation, performanceBaseCents, sumConsultantCents, PERF_TYPE_CONSULTANT } from '../../src/role-eval/perf-rules.js';
import { formatScore } from '../../src/role-eval/reply.js';
import { scorePeriod } from '../../src/role-eval/metrics.js';
import {
  BACKLOG_ALERT_ID_PENDING, BACKLOG_ALERT_RECIPIENT_NAME, DEFAULT_BACKLOG_ALERT_RECIPIENT,
  createNotificationDispatcher,
} from '../../src/role-eval/notification-dispatch.js';
import { MemoryPerformanceStore, type LedgerEntry } from '../../src/role-eval/performance-store.js';
import { clarifyQuestion } from '../../src/role-eval/clarify.js';

const TODAY = '2026-11-12';

async function firstPost(w: Awaited<ReturnType<typeof worldM05>>, member: string, text: string) {
  const reply = await w.call(member, text);
  expect(reply).toMatch(/还没入账/);
  expect(reply).not.toMatch(/新增一笔/);
  const confirm = await w.call(member, '对');
  expect(confirm).toContain('已入账');
  return (await w.base.listEntries()).at(-1)!;
}

describe('R6 金额白名单：只接受纯数字（最多两位小数）加单位；不四舍五入、不丢掉负号', () => {
  it('不到 / 负 / 减 不解析成确定金额；将近/左右等仍不清楚', () => {
    for (const text of ['不到两千', '张姐不到两千', '负一百块', '减八十块', '大约六百', '680左右', '680多']) {
      const got = extractReport(text);
      expect(got.status, text).not.toBe('complete');
    }
  });
  it('负号与「减」绝不被吞掉后当成正数', () => {
    expect(parsePureMoney('负一百块')).toMatchObject({ ok: false, issue: 'negative' });
    expect(parsePureMoney('减八十块')).toMatchObject({ ok: false, issue: 'negative' });
    expect(parsePureMoney('-80')).toMatchObject({ ok: false, issue: 'negative' });
    expect(parsePureMoney('100元')).toMatchObject({ ok: true, amount: 10000 });
  });
  it('口语小数「六百八十块五」「一千二百五十块五毛」解析为 680.5 / 1250.5，不能截成整数', () => {
    expect(parsePureMoney('六百八十块五')).toMatchObject({ ok: true, amount: 68050 });
    expect(parsePureMoney('六百八十块五毛')).toMatchObject({ ok: true, amount: 68050 });
    expect(parsePureMoney('一千二百五十块五毛')).toMatchObject({ ok: true, amount: 125050 });
    expect(extractReport('张姐六百八十块五').status).toBe('complete');
    expect(extractReport('张姐六百八十块五')).toMatchObject({ entries: [expect.objectContaining({ amount: 68050 })] });
  });
  it('纯数字加单位仍可通过；门②：该澄清的说法零写入', async () => {
    expect(extractReport('张姐 680.5 元').status).toBe('complete');
    const w = await worldM05();
    const unclear = await w.call('m-zhao', '张姐不到两千');
    expect(unclear).toMatch(/请写成最多两位小数|说清楚|不到/);
    expect(unclear).not.toMatch(/还没入账/);
    expect((await w.base.listEntries()).filter(e => e.customerName === '张姐')).toEqual([]);
    expect((await w.base.listDrafts()).filter(d => d.status === 'pending')).toEqual([]);
  });
});

describe('R6 补报否定：不是昨天那种补报', () => {
  it('「不是昨天那种补报，张姐680」不当成补报昨天，应作为今天的单', () => {
    expect(pastDayReportPhrase('不是昨天那种补报，张姐680', TODAY)).toBe(false);
    expect(pastDayReportPhrase('不是补报，今天张姐680', TODAY)).toBe(false);
    expect(pastDayReportPhrase('昨天张姐680帮我补上', TODAY)).toBe(true);
    expect(extractReport('不是昨天那种补报，张姐680').status).toBe('complete');
  });
  it('入口：不是昨天那种补报的今天报数能出草稿，不回补报拒绝', async () => {
    const w = await worldM05();
    const reply = await w.call('m-zhao', '不是昨天那种补报，张姐680');
    expect(reply).not.toBe(NOT_TODAY_REPLY);
    expect(reply).toMatch(/还没入账/);
    expect(await w.call('m-zhao', '对')).toContain('已入账');
  });
});

describe('R6 P0 数据兜底：同客户再报必须二选一（不扩改单动词表）', () => {
  // R18 / D155：自然句（「张姐其实是880」类）不是纯标准行，归模型路径，离线先问、不出任何草稿（含二选一）；
  // 纯标准行再报同一客户仍触发二选一（D131）。两类都绝不是普通「还没入账」草稿。
  const novel = ['张姐 900', '张姐 880（小王）'];
  const naturalNovel = ['张姐其实是880', '张姐金额弄成880', '张姐应当记880'];

  it('R18 / D155：同客户的自然句说法离线先问，不出草稿也不出二选一，零写入', async () => {
    for (const phrase of naturalNovel) {
      const w = await worldM05();
      await firstPost(w, 'm-zhao', '张姐 736');
      const reply = await w.call('m-zhao', phrase);
      expect(reply, phrase).not.toMatch(/还没入账|新增一笔/);
      expect(await w.base.listDrafts({ status: 'pending' }), phrase).toEqual([]);
      expect((await w.base.listEntries()).filter(e => e.customerName === '张姐'), phrase).toHaveLength(1);
    }
  });

  it('自编、不在改单动词表里的说法全部触发二选一，绝不是普通「还没入账」草稿', async () => {
    for (const phrase of novel) {
      const w = await worldM05();
      await firstPost(w, 'm-zhao', '张姐 680');
      const reply = await w.call('m-zhao', phrase);
      expect(reply, phrase).toMatch(/新增一笔/);
      expect(reply, phrase).toMatch(/改 1|改第?\s*1/);
      expect(reply, phrase).toMatch(/不要直接回「对」/);
      expect(reply, phrase).not.toMatch(/还没入账，回「对」|还没入账，回对/);
      const listed = (await w.base.listDrafts({ status: 'pending' }))[0];
      expect(listed?.payload.type === 'report' && listed.payload.awaitingDuplicateChoice, phrase).toBeTruthy();
    }
  });

  it('「对」在二选一期间不能提交；取消关闭草稿、零入账', async () => {
    const w = await worldM05();
    const first = await firstPost(w, 'm-zhao', '张姐 680');
    const ask = await w.call('m-zhao', '张姐 880');
    expect(ask).toMatch(/新增一笔/);
    const nope = await w.call('m-zhao', '对');
    expect(nope).toMatch(/不要直接回「对」/);
    expect(nope).toMatch(/新增一笔/);
    expect((await w.base.listEntries()).filter(e => e.customerName === '张姐')).toHaveLength(1);
    expect(await w.call('m-zhao', '取消')).toMatch(/已取消|已关闭|取消/);
    expect((await w.base.listEntries()).filter(e => e.customerName === '张姐' && e.status === 'confirmed').map(e => e.entryId)).toEqual([first.entryId]);
  });

  it('选择「新增一笔」可以再记一笔（同客户当天两笔合法），确认后账上两笔', async () => {
    const w = await worldM05();
    await firstPost(w, 'm-zhao', '张姐 680');
    const ask = await w.call('m-zhao', '张姐 680');
    expect(ask).toMatch(/新增一笔/);
    const next = await w.call('m-zhao', '新增一笔');
    expect(next).toMatch(/还没入账/);
    expect(next).not.toMatch(/不要直接回「对」/);
    expect(await w.call('m-zhao', '对')).toContain('已入账');
    const rows = (await w.base.listEntries()).filter(e => e.customerName === '张姐' && e.status === 'confirmed');
    expect(rows).toHaveLength(2);
    expect(rows.every(r => r.amount === 68000)).toBe(true);
  });

  it('选择「改 1」走进既有并排改单+权限；确认后是一笔被改，不是两笔', async () => {
    const w = await worldM05();
    const first = await firstPost(w, 'm-zhao', '张姐 680');
    await w.call('m-zhao', '张姐 880');
    const preview = await w.call('m-zhao', '改 1');
    expect(preview).toMatch(/还没改账|对照|原记录|680/);
    expect(preview).toMatch(/880/);
    expect(await w.call('m-zhao', '对')).toMatch(/已改|已更正|改账已/);
    const rows = (await w.base.listEntries()).filter(e => e.customerName === '张姐');
    const live = rows.filter(e => e.status === 'confirmed');
    expect(live).toHaveLength(1);
    expect(live[0]!.entryId).toBe(first.entryId);
    expect(live[0]!.amount).toBe(88000);
  });

  it('店长代报同一客户也触发兜底（任意报单人）；选新增可入账', async () => {
    const w = await worldM05();
    await firstPost(w, 'm-zhao', '张姐 680');
    const ask = await w.call('m-wang-yj', '张姐 900（小赵）');
    expect(ask).toMatch(/新增一笔/);
    expect(ask).not.toMatch(/还没入账，/);
    const next = await w.call('m-wang-yj', '新增一笔');
    expect(next).toMatch(/还没入账/);
    expect(await w.call('m-wang-yj', '对')).toContain('已入账');
    const rows = (await w.base.listEntries()).filter(e => e.customerName === '张姐' && e.status === 'confirmed');
    expect(rows).toHaveLength(2);
    expect(rows.map(r => r.reporterPersonId).sort()).toEqual(['p-wang-yj', 'p-zhao'].sort());
  });

  it('员工改别人的单走既有权限（无 correct_store 则拒绝，零写入）', async () => {
    const w = await worldM05();
    await firstPost(w, 'm-wang-yj', '张姐 680（小赵）');
    await w.call('m-zhao', '张姐 880');
        const denied = await w.call('m-zhao', '改 1');
    // R7 D118：普通员工对别人的单不再给出「改 N」，回「找店长改」；仍是零写入。
    expect(denied).toMatch(/找店长改|没有权限|不能改|不允许这项操作/);
    expect(denied).toMatch(/没有写入/);
    const live = (await w.base.listEntries()).filter(e => e.customerName === '张姐' && e.status === 'confirmed');
    expect(live).toHaveLength(1);
    expect(live[0]!.amount).toBe(68000);
  });
});

describe('R6 预约：没写称呼先问；「就按没留名登记」可登记', () => {
  it('「明天下午四点有个客人要做护理」先问客人（有个客人不算已回答），不直接登记', async () => {
    const w = await worldM05();
    const ask = await w.call('m-zhao', '明天下午四点有个客人要做护理');
    expect(ask).toContain('哪位客人');
    expect(ask).toContain('没留名');
    expect(ask).not.toContain('预约还没登记');
    expect(await w.base.listDrafts({ kind: 'appointment', status: 'pending' })).toEqual([]);
  });
  it('「明天三点有个客人要来」也要先问（有个客人不算已回答）；第二次「就按没留名登记」出草稿', async () => {
    const w = await worldM05();
    const ask = await w.call('m-zhao', '明天三点有个客人要来');
    expect(ask).toContain('哪位客人');
    const draft = await w.call('m-zhao', '就按没留名登记');
    expect(draft).toContain('预约还没登记');
    expect(draft).toContain('未留名');
    expect(await w.call('m-zhao', '对')).toContain('预约已登记');
  });
});

describe('R6 查询直接办：查本人进度、查本店业绩、查今天的单，不因数据兜底追问', () => {
  it('规则层识别自然说法', () => {
    expect(isSelfProgressQuery('查一下我今天的进度')).toBe(true);
    expect(isSelfProgressQuery('我的进度')).toBe(true);
    expect(isSelfProgressQuery('看今天的单')).toBe(true);
    expect(isStorePerfQuery('查本店业绩')).toBe(true);
    expect(isStorePerfQuery('本店今天的业绩')).toBe(true);
    expect(isSelfProgressQuery('张姐 680')).toBe(false);
    expect(isStorePerfQuery('张姐 680')).toBe(false);
  });
  it('员工「查一下我今天的进度」「看今天的单」直接出进度，不是通用提示、不是二选一', async () => {
    const w = await worldM05();
    await firstPost(w, 'm-zhao', '李姐 200');
    for (const phrase of ['查一下我今天的进度', '看今天的单', '我今天的进度']) {
      const reply = await w.call('m-zhao', phrase);
      expect(reply, phrase).not.toBe(REPORT_HINT);
      expect(reply, phrase).not.toMatch(/新增一笔/);
      expect(reply, phrase).not.toMatch(/请说清楚再发|哪位客人/);
      expect(reply, phrase).toMatch(/已做|进度|已入账|李姐|200|1100/);
    }
  });
  it('店长「查本店业绩」直接出本店汇总', async () => {
    const w = await worldM05();
    await firstPost(w, 'm-zhao', '李姐 200');
    const reply = await w.call('m-wang-yj', '查本店业绩');
    expect(reply).not.toBe(REPORT_HINT);
    expect(reply).not.toMatch(/新增一笔|请说清楚再发/);
    expect(reply).toMatch(/业绩|汇总|完成|200|李姐/);
  });
});

describe('R6 D109 积压告警：收件人 hanyu，ID 待填不真发', () => {
  it('默认 ID 为空，事件 send=false 且带待填说明；填了 ID 且未关 send 才为 true', async () => {
    expect(DEFAULT_BACKLOG_ALERT_RECIPIENT).toBe('');
    expect(BACKLOG_ALERT_RECIPIENT_NAME).toBe('hanyu');
    const store = new MemoryPerformanceStore();
    const sender = { async send(_input: unknown, beforeSend: () => Promise<void>) { await beforeSend(); return { state: 'accepted' as const, detail: 'ok' }; } };
    const events: { type: string; send?: boolean; recipientPersonId?: string; detail?: string }[] = [];
    const empty = createNotificationDispatcher({
      store, sender, now: () => new Date('2026-11-12T02:00:00.000Z'), worker: 'w1',
      backlogAlert: { count: 0, ageMs: 0 },
      onEvent: e => events.push(e),
    });
    await empty.tick();
    const pending = events.filter(e => e.type === 'backlog_alert');
    expect(pending).toEqual([expect.objectContaining({ send: false, recipientPersonId: '', detail: BACKLOG_ALERT_ID_PENDING })]);
    events.length = 0;
    const filled = createNotificationDispatcher({
      store, sender, now: () => new Date('2026-11-12T02:00:00.000Z'), worker: 'w1',
      backlogAlert: { count: 0, ageMs: 0, recipientPersonId: 'wecom-hanyu-id' },
      onEvent: e => events.push(e),
    });
    await filled.tick();
    expect(events.filter(e => e.type === 'backlog_alert')).toEqual([
      expect.objectContaining({ send: true, recipientPersonId: 'wecom-hanyu-id' }),
    ]);
  });
});

describe('R6 PERF-RULES v1.1：完成率不封顶；分子只计已确认开单；分配约束与 R8 基数在校验层', () => {
  it('120% 原样返回，展示为 120%（不封顶）', () => {
    expect(storeCompletionRate(1_200_000, 1_000_000)).toBe(1.2);
    const score = scorePeriod({ done: 1_200_000, fullPeriodTarget: 1_000_000, fullMonthTarget: 1_000_000, elapsedDays: 30, periodDays: 30 });
    expect(score.completionRate).toBe(1.2);
    const text = formatScore('本月', '月完成率', score);
    expect(text).toContain('120%');
    expect(text).not.toMatch(/月完成率 100%/);
  });
  it('pending / voided 不计分子', () => {
    const rows: LedgerEntry[] = [
      { entryId: 'a', storeId: 's-b', businessDay: '2026-11-01', customerName: '张姐', amount: 10000, amountType: PERF_TYPE_CONSULTANT, ownerPersonId: 'p', ownerName: 'n', reporterPersonId: 'p', note: '', status: 'confirmed', disputed: false, createdAt: '2026-11-01T00:00:00.000Z' },
      { entryId: 'b', storeId: 's-b', businessDay: '2026-11-02', customerName: '李姐', amount: 20000, amountType: PERF_TYPE_CONSULTANT, ownerPersonId: 'p', ownerName: 'n', reporterPersonId: 'p', note: '', status: 'pending', disputed: false, createdAt: '2026-11-02T00:00:00.000Z' },
      { entryId: 'c', storeId: 's-b', businessDay: '2026-11-03', customerName: '王姐', amount: 30000, amountType: PERF_TYPE_CONSULTANT, ownerPersonId: 'p', ownerName: 'n', reporterPersonId: 'p', note: '', status: 'voided', disputed: false, createdAt: '2026-11-03T00:00:00.000Z' },
    ];
    expect(sumConsultantCents(rows)).toBe(10000);
    expect(storeCompletionRate(sumConsultantCents(rows), 10000)).toBe(1);
  });
  it('门店份额合计 100%（容差 0.01）；员工份额 >0 且不超过门店份额；员工不必合计 100%', () => {
    expect(validateAllocation({ storeShares: [{ storeId: 'a', share: 60 }, { storeId: 'b', share: 40 }] }).ok).toBe(true);
    expect(validateAllocation({ storeShares: [{ storeId: 'a', share: 50 }, { storeId: 'b', share: 49 }] }).ok).toBe(false);
    expect(validateAllocation({
      storeShares: [{ storeId: 'a', share: 100 }],
      employeeShares: [{ personId: 'p', storeId: 'a', share: 40 }],
    }).ok).toBe(true);
    expect(validateAllocation({
      storeShares: [{ storeId: 'a', share: 50 }, { storeId: 'b', share: 50 }],
      employeeShares: [{ personId: 'p', storeId: 'a', share: 60 }],
    }).ok).toBe(false);
    expect(validateAllocation({
      storeShares: [{ storeId: 'a', share: 100 }],
      employeeShares: [{ personId: 'p', storeId: 'a', share: 0 }],
    }).ok).toBe(false);
  });
  it('R8 基数是折后实收；赠送不加进基数', () => {
    expect(performanceBaseCents({ receivedCents: 68000, giftCents: 10000 })).toEqual({ ok: true, cents: 68000 });
    expect(performanceBaseCents({ receivedCents: 0 }).ok).toBe(false);
  });
});

describe('R6 门②优先于门①：该澄清却执行 = 0（自编）', () => {
  it('不清楚的金额不会出「还没入账」草稿', async () => {
    const w = await worldM05();
    for (const text of ['张姐不到两千', '张姐大概六百', '张姐 680 左右']) {
      const reply = await w.call('m-zhao', text);
      expect(reply, text).not.toMatch(/还没入账/);
      expect(reply, text).not.toMatch(/已入账/);
    }
    expect((await w.base.listDrafts()).filter(d => d.status === 'pending')).toEqual([]);
    expect((await w.base.listEntries()).filter(e => e.customerName === '张姐' && e.status === 'confirmed')).toEqual([]);
  });
  it('clarifyQuestion 对 negative / unclear 有明确问句', () => {
    expect(clarifyQuestion('negative')).toMatch(/负|减|请写成/);
    expect(clarifyQuestion('vague_amount')).toMatch(/最多两位小数/);
  });
});

describe('R6 M04-01：同一草稿连点两次「对」只记一笔（Memory）', () => {
  it('新增确认后立刻再「对」，账上仍是两笔里的第二笔只出现一次', async () => {
    const w = await worldM05();
    await firstPost(w, 'm-zhao', '张姐 680');
    await w.call('m-zhao', '张姐 200');
    await w.call('m-zhao', '新增一笔');
    const first = await w.call('m-zhao', '对');
    expect(first).toContain('已入账');
    const second = await w.call('m-zhao', '对');
    expect(second).not.toMatch(/已入账 2 笔|已入账 3/);
    const rows = (await w.base.listEntries()).filter(e => e.customerName === '张姐' && e.status === 'confirmed');
    expect(rows).toHaveLength(2);
    expect(rows.map(r => r.amount).sort()).toEqual([20000, 68000]);
    const sources = rows.map(r => [r.sourceDraftId, r.sourceOrdinal]);
    expect(new Set(sources.map(s => JSON.stringify(s))).size).toBe(2);
  });
});
