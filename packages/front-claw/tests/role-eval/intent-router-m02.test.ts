import { describe, expect, it, vi } from 'vitest';
import { classifyIntent, classifyWithSemantic, decideRoute } from '../../src/role-eval/intent-router.js';
import { createRequestBudget } from '../../src/role-eval/request-budget.js';
import { createRouteLog, type RouteLogRecord } from '../../src/role-eval/route-log.js';

const day = { businessDay: '2026-11-11' };
const open = { marketingEnabled: true, marketingGranted: true };

describe('M02 规则分类与决策', () => {
  it('指定场景：报数清单求助、无空格预约、无序号确认、客户名+员工名、复合意图', () => {
    expect(classifyIntent('帮我写今天报数清单', day).label).toBe('report');
    expect(decideRoute(classifyIntent('帮我写今天报数清单', day), open).target).toBe('store');
    expect(classifyIntent('预约明天下午3点张三', day).label).toBe('appointment');
    for (const text of ['对', '对的', '确认', '好的', '取消']) expect(classifyIntent(text, day).label).toBe('followup');
    expect(classifyIntent('11号测试A店\n张姐 680（小林）', day).label).toBe('report');
    expect(classifyIntent('李女士 980（小陈）', day).label).toBe('report');
    const multi = classifyIntent('报一下今天380然后帮我写个朋友圈文案', day);
    expect(multi).toMatchObject({ label: 'clarify', reason: 'multi-intent' });
    expect(multi.intents).toEqual(['report', 'marketing']);
    expect(decideRoute(multi, open).target).toBe('clarify');
  });
  it('营销只在明确意图 ∧ 已启用 ∧ 获权时进入', () => {
    const c = classifyIntent('帮我写一条周末活动的朋友圈文案', day);
    expect(decideRoute(c, open).target).toBe('marketing');
    expect(decideRoute(c, { marketingEnabled: false, marketingGranted: true }).target).toBe('marketing-unavailable');
    expect(decideRoute(c, { marketingEnabled: true, marketingGranted: false }).target).toBe('marketing-unavailable');
    for (const text of ['你好', '我的进度', '入账结果', '11号测试A店\n380（小林）', '对', '活动', '帮我弄一下', '今天做了1200，记一下'])
      expect(decideRoute(classifyIntent(text, day), open).target).not.toBe('marketing');
  });
  it('完整清单里的备注不改变报数意图', () => {
    expect(classifyIntent('11号测试A店\n陈姐 1500（小林） 朋友圈活动来的', day).label).toBe('report');
  });
});

describe('M02 受限语义分类端口', () => {
  it('规则命中时不调用；无信号时至多调用一次并校验输出', async () => {
    const port = vi.fn(async () => ({ label: 'progress', confidence: 0.93 }));
    expect((await classifyWithSemantic('我的进度', { ...day, semantic: port })).source).toBe('rule');
    expect(port).not.toHaveBeenCalled();
    const c = await classifyWithSemantic('那边弄好了没', { ...day, semantic: port, deadline: performance.now() + 500 });
    expect(c).toMatchObject({ label: 'progress', source: 'semantic' });
    expect(port).toHaveBeenCalledTimes(1);
  });
  it('畸形、越界、低置信度、抛错、超时、取消一律保持澄清', async () => {
    for (const output of [null, 'progress', [], { label: 'delete_all', confidence: 1 }, { label: 'report', confidence: 0.5 }, { label: 'report', confidence: 2 }, { label: 'clarify', confidence: 1 }]) {
      const c = await classifyWithSemantic('嗯那个', { ...day, semantic: async () => output, deadline: performance.now() + 500 });
      expect(c.label).toBe('clarify');
    }
    expect((await classifyWithSemantic('嗯那个', { ...day, semantic: async () => { throw Error('down'); }, deadline: performance.now() + 500 })).label).toBe('clarify');
    let seen: AbortSignal | undefined;
    const started = performance.now();
    const hung = await classifyWithSemantic('嗯那个', { ...day, semantic: ({ signal }) => { seen = signal; return new Promise(() => {}); }, deadline: performance.now() + 120 });
    expect(hung).toMatchObject({ label: 'clarify', reason: 'semantic-timeout' });
    expect(performance.now() - started).toBeLessThan(1000);
    expect(seen?.aborted).toBe(true);
    const parent = new AbortController(); parent.abort();
    expect((await classifyWithSemantic('嗯那个', { ...day, semantic: async () => ({ label: 'report', confidence: 1 }), signal: parent.signal })).reason).toBe('semantic-timeout');
  });
});

describe('M02 请求预算与分段日志', () => {
  const unknown = (state: string) => ({ reply: `未知:${state}` });
  it('超时得到唯一终态，迟到结果只记录不覆盖；不阻塞下一请求', async () => {
    const late: unknown[] = [];
    const budget = createRequestBudget({ budgetMs: 60, onLate: (id, outcome) => late.push({ id, outcome }) });
    let release!: () => void;
    const slow = new Promise<void>(resolve => { release = resolve; });
    let childSignal: AbortSignal | undefined;
    const first = await budget.run('r1', 'f', {}, async child => { childSignal = child.signal; await slow; return { reply: '迟到的答复' }; }, unknown);
    expect(first.terminal).toMatchObject({ state: 'timeout', reply: '未知:timeout' });
    expect(childSignal?.aborted).toBe(true);
    const next = await budget.run('r2', 'f', {}, async () => ({ reply: '下一条' }), unknown);
    expect(next.terminal.state).toBe('completed');
    release(); await new Promise(resolve => setTimeout(resolve, 10));
    expect(late).toEqual([{ id: 'r1', outcome: { ok: true, result: { reply: '迟到的答复' } } }]);
    expect(budget.claimDelivery(first.terminal)).toBe(true);
    expect(budget.claimDelivery(first.terminal)).toBe(false);
  });
  it('完成后同号同内容复用终态；同号不同内容不复用；失败/取消不缓存', async () => {
    const budget = createRequestBudget({ budgetMs: 1000 });
    let calls = 0;
    const work = async () => ({ reply: `第${++calls}次` });
    const a = await budget.run('m', 'x', {}, work, unknown);
    const b = await budget.run('m', 'x', {}, work, unknown);
    expect(b).toEqual({ terminal: a.terminal, duplicate: true });
    expect((await budget.run('m', 'y', {}, work, unknown)).duplicate).toBe(false);
    expect(calls).toBe(2);
    const failed = await budget.run('f', 'x', {}, async () => { throw Error('boom'); }, unknown);
    expect(failed.terminal.state).toBe('failed');
    expect((await budget.run('f', 'x', {}, work, unknown)).terminal.state).toBe('completed');
    const parent = new AbortController(); parent.abort();
    expect((await budget.run('c', 'x', { signal: parent.signal }, work, unknown)).terminal.state).toBe('cancelled');
    const both = await Promise.all([budget.run('p', 'x', {}, work, unknown), budget.run('p', 'x', {}, work, unknown)]);
    expect(both.map(row => row.duplicate).sort()).toEqual([false, true]);
    expect(both[0].terminal).toBe(both[1].terminal);
  });
  it('日志按 inbound→classify→commit→deliver 记录请求号与耗时，观测故障不外抛', () => {
    const records: RouteLogRecord[] = [];
    const log = createRouteLog(record => records.push(record));
    log.inbound('q'); log.classify('q', { label: 'report', target: 'store', source: 'rule' }); log.commit('q', { state: 'completed' }); log.deliver('q', { delivered: true });
    expect(records.map(row => [row.requestId, row.stage])).toEqual([['q', 'inbound'], ['q', 'classify'], ['q', 'commit'], ['q', 'deliver']]);
    expect(records.every(row => row.sinceInboundMs >= 0)).toBe(true);
    expect(() => createRouteLog(() => { throw Error('sink'); }).inbound('z')).not.toThrow();
  });
});
