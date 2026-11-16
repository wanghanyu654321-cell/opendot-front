import { expect, it, vi } from 'vitest';
import { worldM05 } from '../role-eval/appointment-fixture-m05.js';
import { parseLooseReport } from '../../src/role-eval/report-parse.js';
import { classifyIntent, classifyWithSemantic, decideRoute } from '../../src/role-eval/intent-router.js';
import { stubIntentClassifier } from '../../src/role-eval/intent-classifier.js';
import { intentClassifierFromOpenDotModel } from '../../src/opendot/model-config.js';

const DAY = '2026-11-12';
it('R1-M02-1a: 解析前 NFKC；k/w/元/块 换算整数；全角数字与括号', () => {
  const one = parseLooseReport('王姨 1.2k（小林）', DAY);
  expect(one).toMatchObject({ status: 'complete', report: { entries: [{ customer: '王姨', amount: 120000, employeeName: '小林', amountText: '1.2k' }] } });
  expect(parseLooseReport('刘姐２６８０元（小王）', DAY)).toMatchObject({ status: 'complete', report: { entries: [{ customer: '刘姐', amount: 268000, employeeName: '小王' }] } });
  expect(parseLooseReport('赵姐 0.3w(小美) 谢啦', DAY)).toMatchObject({ status: 'complete', report: { entries: [{ amount: 300000, employeeName: '小美' }] } });
  expect(parseLooseReport('孙姐 560块（小林）', DAY)).toMatchObject({ status: 'complete', report: { entries: [{ amount: 56000 }] } });
  // 换算后不是整数 → 不猜
  expect(parseLooseReport('王姨 1.2345k（小林）', DAY)).toMatchObject({ status: 'complete', report: { entries: [{ amount: 123450 }] } });
  // 括号里多个员工 → 不直接执行
  expect(parseLooseReport('张姐680（小王/小美）', DAY).status).toBe('none');
});

it('R1-M02-1b: 格式明确的代报路由为直接办（报数），不靠关键词', () => {
  for (const text of ['王姨 1.2k（小林）', '刘姐２６８０元（小王）', '孙姐 560块（小林）']) {
    expect(classifyIntent(text, { businessDay: DAY })).toMatchObject({ label: 'report', reason: 'single' });
  }
  expect(classifyIntent('张姐680（小王/小美）', { businessDay: DAY }).label).not.toBe('report');
});

it('R1-M02-1c: 「刘姐２６８０元（小王）」直接出草稿并回显换算，括号员工同店', async () => {
  const w = await worldM05();
  const reply = await w.call('m-zhao', '刘姐２６８０元（小王）');
  expect(reply).toContain('还没入账');
  expect(reply).toContain('2680元 → 2680');
  expect(reply).toContain('小王 2680元');
  const w2 = await worldM05();
  const r2 = await w2.call('m-zhao', '王姨 1.2k（小王）');
  expect(r2).toContain('1.2k → 1200');
  expect(r2).toContain('小王 1200元');
});

it('R1-M02-1d: 括号员工是他店人员（小林在 A 店）→ 拒绝，零草稿', async () => {
  const w = await worldM05();
  expect(await w.call('m-zhao', '王姨 1.2k（小林）')).toContain('跨店不能代报');
  expect(await w.base.listDrafts()).toEqual([]);
});

it('R1-M02-2a: 默认确定性桩：不调用模型、恒澄清', async () => {
  const out = await stubIntentClassifier({ text: '辛苦啦谢谢你～', signal: new AbortController().signal });
  expect(out).toMatchObject({ route: 'clarify', confidence: 0 });
  // R3：纯客套话由规则直接判闲聊（短答，不写账、不追问），不交兜底桩；桩本身仍恒澄清（上一行）。
  const c = await classifyWithSemantic('辛苦啦谢谢你～', { semantic: stubIntentClassifier });
  expect(c.label).toBe('chitchat');
  const other = await classifyWithSemantic('番茄炒蛋怎么做', { semantic: stubIntentClassifier });
  expect(other.label).toBe('clarify');
});

it('R1-M02-2b: 规则非单一命中（无信号/多意图）交兜底分类器；输出直接办/澄清/营销/闲聊+字段', async () => {
  const semantic = vi.fn(async ({ text }: { text: string }) => text.includes('奶茶') ? { route: 'chitchat', confidence: 0.95 }
    : text.includes('补水') ? { route: 'marketing', confidence: 0.9 }
      : { route: 'act', intent: 'progress', confidence: 0.9, fields: { scope: 'self' } });
  expect((await classifyWithSemantic('刚喝了杯奶茶花了18块，快乐回血', { semantic })).label).toBe('chitchat');
  expect((await classifyWithSemantic('给老客户写条唤醒消息，邀请来做补水护理', { semantic })).label).toBe('marketing');
  const act = await classifyWithSemantic('我本周离目标还差多少块', { semantic });
  expect(act).toMatchObject({ label: 'progress', source: 'semantic', fields: { scope: 'self' } });
  // 规则单一高置信命中：不调分类器
  semantic.mockClear();
  expect((await classifyWithSemantic('我的进度', { semantic })).label).toBe('progress');
  expect(semantic).not.toHaveBeenCalled();
  // 多意图交分类器
  const multi = '门店业绩排名发我，再帮我写一句朋友圈开门营业的文案';
  expect(classifyIntent(multi)).toMatchObject({ label: 'clarify', reason: 'multi-intent' });
  const asked = vi.fn(async () => ({ route: 'clarify', confidence: 0.9 }));
  expect((await classifyWithSemantic(multi, { semantic: asked })).label).toBe('clarify');
  expect(asked).toHaveBeenCalledTimes(1);
  // 多意图时分类器不能引入规则没命中的意图
  expect((await classifyWithSemantic(multi, { semantic: async () => ({ route: 'act', intent: 'report', confidence: 0.99 }) })).label).toBe('clarify');
  expect((await classifyWithSemantic(multi, { semantic: async () => ({ route: 'act', intent: 'summary', confidence: 0.99 }) })).label).toBe('summary');
  // 低置信度、未知 route、畸形字段 → 澄清
  expect((await classifyWithSemantic('随便', { semantic: async () => ({ route: 'act', intent: 'report', confidence: 0.5 }) })).label).toBe('clarify');
  expect((await classifyWithSemantic('随便', { semantic: async () => ({ route: 'delete_all', confidence: 0.99 }) })).label).toBe('clarify');
  expect((await classifyWithSemantic('随便', { semantic: async () => ({ route: 'act', intent: 'report', confidence: 0.99, fields: 'x' }) })).label).toBe('clarify');
  expect(decideRoute(act, { marketingEnabled: false, marketingGranted: false }).target).toBe('store');
});

it('R1-M02-2c: OpenDot 模型配置适配点：未配置 → 桩；配置后经注入的 complete 调用，输出严格校验', async () => {
  const none = intentClassifierFromOpenDotModel(undefined);
  expect(none).toBe(stubIntentClassifier);
  const complete = vi.fn(async () => JSON.stringify({ route: 'act', intent: 'result', confidence: 0.92 }));
  const classifier = intentClassifierFromOpenDotModel({ provider: 'opendot', model: 'unset', complete });
  const c = await classifyWithSemantic('OP-B-099是我刚提交的，帮我看处理结果', { semantic: classifier });
  expect(complete).toHaveBeenCalledTimes(1);
  expect(c.label).toBe('result');
  const bad = intentClassifierFromOpenDotModel({ provider: 'opendot', model: 'unset', complete: async () => 'not json' });
  expect((await classifyWithSemantic('OP-B-099是我刚提交的，帮我看处理结果', { semantic: bad })).label).toBe('clarify');
});
