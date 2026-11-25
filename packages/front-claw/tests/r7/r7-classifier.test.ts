/**
 * R7 模型分类接口与校验链。自编说法，不取留出集原句。
 * 测试用桩只验证接口和链路，不自报门③达标率。
 */
import { describe, expect, it } from 'vitest';
import {
  parseModelClassification, validateModelChain, isUncertain, isReadOnlyQuery, isModelStub,
  runModelClassifier, stubModelClassifier, uncertainClassification, createModelClassifier,
  loadModelRuntimeConfig, DEFAULT_MODEL_TIMEOUT_MS, MODEL_OBJECTS, MODEL_ENTRY_MODES,
  type ModelClassification, type ModelClassifier, type ModelObject,
} from '../../src/role-eval/model-classify.js';
import { standaloneModelClassifier } from '../../src/standalone/compatible-model.js';
import { worldM05 } from '../role-eval/appointment-fixture-m05.js';
import { CLARIFY_REPLY } from '../../src/role-eval/employee-entry.js';
import { REPORT_HINT } from '../../src/role-eval/employee-loop.js';

const ok = (p: Partial<ModelClassification> & Pick<ModelClassification, 'intent'>): ModelClassification => ({
  object: null, action: null, slots: {}, confidence: 0.95, uncertain: false, ...p,
});

function scripted(table: Record<string, unknown>, fallback: unknown = uncertainClassification()): ModelClassifier {
  return async ({ text }) => table[text] ?? fallback;
}

/** 自编：40 条本人进度/今日单查询（员工，不含「汇总/全店」等会触发全店权限拒绝的词）。 */
const SELF_QUERIES: string[] = [
  '帮我瞅一眼今天做了哪些', '今天我这边入了几单啊', '我这边今天成绩咋样', '能不能告诉我我今天报了啥',
  '把我今日的完成情况说一下', '我想核对下自己今天的单子', '我自己今天进账没有', '给我报一下我个人今日数据',
  '我今天干得怎么样了呀', '瞧一瞧我今日业绩数字', '方便说下我这头今天的结果吗', '我个人这边今天到哪了',
  '今天我名下入账情况', '想看看自己今日做完没有', '请把我今天的入账列给我', '我今日的完成度给我瞅瞅',
  '自己今天报数的结果呢', '我这边今日已确认的单', '跟我说下我今天业绩数字吧', '今天属于我的那些单列出来',
  '我今日做到哪儿了请告诉我', '把我个人今天的数字发我', '想确认我今天有没有漏单', '我这头今天做成怎样了',
  '帮我核对自己今日入账', '今日我的单子还在不在账上', '请列我名下今天已报的', '我今天工作成果能看吗',
  '给我看一眼个人今日流水', '今日我完成的部分是哪些', '我这边今天的进度方便说不', '请告知我今日个人完成情况',
  '想核对下我自己今天报过的', '今天我入账的名单有哪些', '把我今天已确认的说一遍', '我个人今日做到什么程度',
  '能不能列一下我今天的单', '我今天的业绩数字在哪看', '请让我核对今日自己的入账', '今日我名下确认过哪些单子',
];

/** 自编：20 条店长本店查询。 */
const STORE_QUERIES: string[] = [
  '店里今天整体如何', '本店今日总共进来多少', '我们今天全店完成得怎样', '门店这边今天数字出来了没',
  '今天全店的入账汇总给我', '店里本月走到哪一步了', '我们店今天完成率高不高', '把本店今日经营情况说一下',
  '全店今天确认了多少单', '想了解店里今天总体成绩', '本店今日目标完成到哪', '店里这个月还差多少',
  '今天全店有没有达成本月节奏', '把我们店今日数字摊开看看', '店里现在业绩看板是怎样', '本店今日合计能告诉我吗',
  '全店这边今天入了多少钱', '我们店今日做成什么样了', '请把本店今天的完成情况发我', '门店今日经营数字怎么看',
];

/** 自编：20 条改账说法（不取留出集）。 */
const AMEND_PHRASES: string[] = [
  '记错了应该是880', '那笔写成 880 吧', '金额不对，改成八百八', '刚才填错了，是 880',
  '帮我把数字调到 880', '不是 680，正确是 880', '我报高了，应当 880', '请更一下金额到 880',
  '那单金额用 880', '数字写错了请改 880', '重新记成 880 行吗', '把刚报的调成 880',
  '金额改成八百八十', '订正一下，880', '我录错数了，改 880', '正确金额该是 880',
  '请把那笔数字换成 880', '账上那笔改写成 880', '报数有误，改为 880', '刚刚那单金额应当是 880',
];

describe('R7 分类 schema 与校验链（单元）', () => {
  it('合法输出能解析；缺字段、未知枚举、金额用分直接给都被拒', () => {
    expect(parseModelClassification(ok({ intent: 'query', object: 'progress', action: 'query' }))).toMatchObject({ intent: 'query' });
    expect(parseModelClassification({ intent: 'query', confidence: 1 })).toBeNull(); // 缺 uncertain
    expect(parseModelClassification({ intent: 'nope', confidence: 1, uncertain: false, object: null, action: null, slots: {} })).toBeNull();
    expect(parseModelClassification({ intent: 'query', confidence: 1, uncertain: false, object: 'foo', action: null, slots: {} })).toBeNull();
    expect(parseModelClassification({ intent: 'amend', confidence: 0.9, uncertain: false, object: 'entry', action: 'amend', slots: { amount: 88000 } })).toBeNull();
    expect(parseModelClassification({ intent: 'amend', confidence: 0.9, uncertain: false, slots: { amountCents: 88000 } })).toBeNull();
    expect(parseModelClassification({ intent: 'amend', confidence: 0.9, uncertain: false, amount: 880, slots: { amountText: '880' } })).toBeNull();
    expect(parseModelClassification({ intent: 'query', confidence: 1.2, uncertain: false, slots: {} })).toBeNull();
    expect(parseModelClassification(null)).toBeNull();
  });
  it('拿不准、低置信、intent=unknown 都视为 uncertain', () => {
    expect(isUncertain(ok({ intent: 'query', uncertain: true }))).toBe(true);
    expect(isUncertain(ok({ intent: 'query', confidence: 0.5 }))).toBe(true);
    expect(isUncertain(ok({ intent: 'unknown', confidence: 1 }))).toBe(true);
    expect(isUncertain(ok({ intent: 'query', object: 'progress', action: 'query' }))).toBe(false);
  });
  it('只读查询判定', () => {
    expect(isReadOnlyQuery(ok({ intent: 'query', object: 'progress', action: 'query' }))).toBe(true);
    expect(isReadOnlyQuery(ok({ intent: 'query', object: 'summary', action: null }))).toBe(true);
    expect(isReadOnlyQuery(ok({ intent: 'amend', object: 'entry', action: 'amend' }))).toBe(false);
    expect(isReadOnlyQuery(ok({ intent: 'query', object: 'progress', action: 'amend' }))).toBe(false);
  });
  it('校验链：schema 失败 / 拿不准 → 追问；脏金额门②优先不执行', () => {
    const schema = validateModelChain({ text: '帮我瞅一眼今天做了哪些', output: { intent: 'query' } });
    expect(schema).toMatchObject({ ok: false, reason: 'schema' });
    const unsure = validateModelChain({ text: '帮我瞅一眼今天做了哪些', output: ok({ intent: 'query', uncertain: true, object: 'progress' }) });
    expect(unsure).toMatchObject({ ok: false, reason: 'uncertain' });
    const dirty = validateModelChain({
      text: '记错了应该是2000出头',
      output: ok({ intent: 'amend', action: 'amend', slots: { amountText: '2000出头', customer: '张姐' } }),
    });
    expect(dirty).toMatchObject({ ok: false, reason: 'amount' });
    const clean = validateModelChain({
      text: '记错了应该是880',
      output: ok({ intent: 'amend', action: 'amend', slots: { amountText: '880', customer: '张姐' } }),
    });
    expect(clean.ok).toBe(true);
    if (clean.ok) expect(clean.amountCents).toBe(88000);
    const unit = validateModelChain({
      text: '改成 0.33w',
      output: ok({ intent: 'amend', action: 'amend', slots: { amountText: '0.33w', customer: '张姐' } }),
    });
    expect(unit.ok).toBe(true);
    if (unit.ok) expect(unit.amountCents).toBe(330000);
  });
  it('默认桩恒为拿不准，createModelClassifier 默认也是桩', () => {
    expect(isModelStub(stubModelClassifier)).toBe(true);
    expect(isModelStub(createModelClassifier({ mode: 'stub' }))).toBe(true);
    expect(loadModelRuntimeConfig().timeoutMs).toBe(DEFAULT_MODEL_TIMEOUT_MS);
  });

  it('Issue #18: 新只读枚举 unreported/identity/self_and_summary 与 slots(ref/countOnly/entryMode) 严格校验', async () => {
    expect(MODEL_OBJECTS).toEqual(expect.arrayContaining(['unreported', 'identity', 'self_and_summary']));
    expect(MODEL_ENTRY_MODES).toEqual(['latest_operation', 'latest_confirmed', 'by_ref']);

    for (const object of ['unreported', 'identity', 'self_and_summary'] as const) {
      const parsed = parseModelClassification(ok({ intent: 'query', object, action: 'query' }));
      expect(parsed).toMatchObject({ intent: 'query', object, action: 'query' });
      expect(isReadOnlyQuery(parsed!)).toBe(true);
    }

    const withSlots = parseModelClassification(ok({
      intent: 'query',
      object: 'entry',
      action: 'query',
      slots: { ref: 'op-123', countOnly: true, entryMode: 'by_ref' },
    }));
    expect(withSlots?.slots).toEqual({ ref: 'op-123', countOnly: true, entryMode: 'by_ref' });

    // 非法类型/越界枚举必须被严格拒绝
    expect(parseModelClassification(ok({
      intent: 'query', object: 'appointment', action: 'query',
      slots: { countOnly: 'true' as unknown as boolean },
    }))).toBeNull();
    expect(parseModelClassification(ok({
      intent: 'query', object: 'entry', action: 'query',
      slots: { entryMode: 'all_history' as unknown as 'by_ref' },
    }))).toBeNull();
    expect(parseModelClassification(ok({
      intent: 'query', object: 'entry', action: 'query',
      slots: { ref: 12345 as unknown as string },
    }))).toBeNull();

    // standaloneModelClassifier schema 同步包含新增对象与槽位
    let capturedBody = '';
    const fakeFetch = (async (_url: unknown, init?: RequestInit) => {
      capturedBody = String(init?.body ?? '');
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: JSON.stringify(ok({ intent: 'query', object: 'unreported', action: 'query' })) } }],
        }),
      } as unknown as Response;
    }) as typeof fetch;
    const classifier = standaloneModelClassifier({
      FC_MODEL_MODE: 'live',
      FC_MODEL_BASE_URL: 'https://api.example.test/v1',
      FC_MODEL_API_KEY: 'sk-test',
      FC_MODEL_NAME: 'test-model',
    }, fakeFetch);
    const out = await classifier({ text: '谁今天没报', signal: new AbortController().signal });
    expect(parseModelClassification(out)).toMatchObject({ intent: 'query', object: 'unreported' });
    expect(capturedBody).toContain('unreported');
    expect(capturedBody).toContain('self_and_summary');
    expect(capturedBody).toContain('countOnly');
    expect(capturedBody).toContain('entryMode');
  });
});

describe('R7 模型超时与 schema 失败：追问、不卡住、不执行', () => {
  it('分类器超时：在超时时间内返回追问，零写入', async () => {
    const slow: ModelClassifier = async ({ signal }) => await new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(ok({ intent: 'query', object: 'progress', action: 'query' })), 8_000);
      const onAbort = () => { clearTimeout(timer); reject(new Error('aborted')); };
      if (signal.aborted) { onAbort(); return; }
      signal.addEventListener('abort', onAbort, { once: true });
    });
    const t0 = performance.now();
    const out = await runModelClassifier('帮我瞅一眼今天做了哪些', slow, undefined, undefined, 80);
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeLessThan(1500);
    expect(out).toMatchObject({ intent: 'unknown', uncertain: true });

    const w = await worldM05({ router: { modelClassify: slow, modelClassifyTimeoutMs: 80, budgetMs: 5_000 } });
    const t1 = performance.now();
    const reply = await w.call('m-zhao', '帮我瞅一眼今天做了哪些');
    const took = performance.now() - t1;
    expect(took, reply).toBeLessThan(2500);
    expect(reply).toMatch(/没太明白|请说|请发标准清单/);
    expect(reply).not.toMatch(/还没入账|已入账/);
    expect((await w.base.listDrafts()).filter(d => d.status === 'pending')).toEqual([]);
  }, 20_000);

  it('schema 失败：追问且零写入，不执行查询或改账', async () => {
    const bad: ModelClassifier = async () => ({ intent: 'query', confidence: 1 }); // 缺 uncertain
    const parsed = validateModelChain({ text: '帮我瞅一眼今天做了哪些', output: await bad({ text: 'x', signal: new AbortController().signal }) });
    expect(parsed).toMatchObject({ ok: false, reason: 'schema' });
    const w = await worldM05({ router: { modelClassify: bad } });
    const reply = await w.call('m-zhao', '帮我瞅一眼今天做了哪些');
    expect(reply).toBe(CLARIFY_REPLY);
    expect(reply).not.toMatch(/还没入账|已入账|已做/);
    expect((await w.base.listEntries()).filter(e => e.customerName === '周姐')).toEqual([]);
  });

  it('分类器抛错：同样追问、不执行', async () => {
    const boom: ModelClassifier = async () => { throw new Error('model_down'); };
    const out = await runModelClassifier('帮我瞅一眼', boom, undefined, undefined, 500);
    expect(out).toMatchObject({ uncertain: true, intent: 'unknown' });
    const w = await worldM05({ router: { modelClassify: boom, modelClassifyTimeoutMs: 500 } });
    const reply = await w.call('m-zhao', '帮我瞅一眼今天做了哪些');
    expect(reply).toMatch(/没太明白|请发标准清单/);
    expect((await w.base.listDrafts()).filter(d => d.status === 'pending')).toEqual([]);
  });
});

describe('R7 桩驱动：≥60 条查询、≥20 条改账，只验证接口与校验链', () => {
  it(`自编 ${SELF_QUERIES.length + STORE_QUERIES.length} 条查询：权限内由桩分类后直接办、不确认`, async () => {
    expect(SELF_QUERIES).toHaveLength(40);
    expect(STORE_QUERIES).toHaveLength(20);
    expect(new Set([...SELF_QUERIES, ...STORE_QUERIES]).size).toBe(60);
    const table: Record<string, ModelClassification> = {};
    for (const t of SELF_QUERIES) table[t] = ok({ intent: 'query', object: 'progress' as ModelObject, action: 'query' });
    for (const t of STORE_QUERIES) table[t] = ok({ intent: 'query', object: 'summary' as ModelObject, action: 'query' });
    const classify = scripted(table);
    expect(isModelStub(classify)).toBe(false);

    const emp = await worldM05({ router: { modelClassify: classify } });
    await emp.call('m-zhao', '李姐 200');
    expect(await emp.call('m-zhao', '对')).toContain('已入账');
    const selfFail: string[] = [];
    for (const phrase of SELF_QUERIES) {
      const reply = await emp.call('m-zhao', phrase);
      const okReply = reply !== REPORT_HINT
        && reply !== CLARIFY_REPLY
        && !/还没入账|请回复「新增一笔」|没太明白要办哪件事|请说清楚/.test(reply)
        && !/回「对」确认/.test(reply)
        && /已做|进度|已入账|李姐|200|业绩|完成|今日|今天/.test(reply);
      if (!okReply) selfFail.push(`${phrase} => ${reply.slice(0, 160)}`);
    }
    expect(selfFail, selfFail.join('\n')).toEqual([]);

    const mgr = await worldM05({ router: { modelClassify: classify } });
    await mgr.call('m-zhao', '李姐 200');
    await mgr.call('m-zhao', '对');
    const storeFail: string[] = [];
    for (const phrase of STORE_QUERIES) {
      const reply = await mgr.call('m-wang-yj', phrase);
      const okReply = reply !== CLARIFY_REPLY
        && reply !== REPORT_HINT
        && !/回「对」确认|还没入账/.test(reply)
        && /业绩|汇总|完成|200|李姐|进度|目标|本店|店/.test(reply);
      if (!okReply) storeFail.push(`${phrase} => ${reply.slice(0, 160)}`);
    }
    expect(storeFail, storeFail.join('\n')).toEqual([]);
  }, 180_000);

  it('默认桩拿不准时查询不执行（不把桩达标率当成门③）', async () => {
    const w = await worldM05();
    const reply = await w.call('m-zhao', '帮我瞅一眼今天做了哪些');
    expect(reply).toMatch(/没太明白|请发标准清单/);
    expect(reply).not.toMatch(/还没入账/);
  });

  it(`自编 ${AMEND_PHRASES.length} 条改账说法：桩给出槽位后走改账/二选一，脏金额被门②拦住`, async () => {
    expect(AMEND_PHRASES).toHaveLength(20);
    const table: Record<string, ModelClassification> = {};
    for (const t of AMEND_PHRASES) {
      table[t] = ok({ intent: 'amend', object: 'entry', action: 'amend', slots: { customer: '张姐', amountText: '880' } });
    }
    const classify = scripted(table);
    const fail: string[] = [];
    for (const phrase of AMEND_PHRASES) {
      const w = await worldM05({ router: { modelClassify: classify } });
      const first = await w.call('m-zhao', '张姐 680');
      expect(first, phrase).toMatch(/还没入账/);
      expect(await w.call('m-zhao', '对')).toContain('已入账');
      const before = (await w.base.listEntries()).filter(e => e.customerName === '张姐' && e.status === 'confirmed');
      expect(before).toHaveLength(1);
      const reply = await w.call('m-zhao', phrase);
      const executedDirect = /已入账|已改|已更正/.test(reply) && !(await w.base.listDrafts({ status: 'pending' })).length;
      const askedOrChoice = /新增一笔|改 1|改账|还没改|请确认|找店长|本店今天已有记录|其实是/.test(reply)
        || /还没改账|更正为|改成 880|880/.test(reply);
      if (executedDirect || !askedOrChoice || /没太明白要办哪件事/.test(reply)) {
        fail.push(`${phrase} => ${reply.slice(0, 200)}`);
      }
      const after = (await w.base.listEntries()).filter(e => e.customerName === '张姐' && e.status === 'confirmed');
      // 未确认前不应改写已入账金额
      expect(after[0]!.amount, phrase).toBe(before[0]!.amount);
    }
    expect(fail, fail.join('\n')).toEqual([]);

    // 脏金额：桩给 2000出头，门②追问、零写入
    const dirty: ModelClassifier = async () => ok({ intent: 'amend', action: 'amend', slots: { customer: '张姐', amountText: '2000出头' } });
    const w = await worldM05({ router: { modelClassify: dirty } });
    await w.call('m-zhao', '张姐 680');
    await w.call('m-zhao', '对');
    const reply = await w.call('m-zhao', '记错了请改成两千出头');
    expect(reply).not.toMatch(/还没入账|已改|已更正|已入账，/);
    expect(reply).toMatch(/出头|准确|请|金额|左右|不清|两位小数|负/);
    const live = (await w.base.listEntries()).filter(e => e.customerName === '张姐' && e.status === 'confirmed');
    expect(live).toHaveLength(1);
    expect(live[0]!.amount).toBe(68000);
  }, 240_000);
});
