/**
 * R7 三道门评测：把任意与评测语料同格式的 jsonl 喂给员工入口。
 * 模型层由配置切换（桩 / 真模型），不改代码。默认桩、不调真模型。
 * 二选一草稿计为澄清，不算执行。门③数字只记录，达标与否留给正式实测。
 * 每条记录处理延迟，汇总总 p50 / p95，以及第四道门：快通道 p95 与模型分类 p95（分别统计；达标与否待正式实测）。
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { CAPABILITIES } from '../../src/role-eval/access-policy.js';
import { APPOINTMENT_RECIPIENTS_KEY } from '../../src/role-eval/appointments.js';
import { CLARIFY_REPLY, MARKETING_UNAVAILABLE, MULTI_REPLY } from '../../src/role-eval/employee-entry.js';
import { ACCESS_DENIED, DENIED } from '../../src/role-eval/employee-loop.js';
import { formatYuan } from '../../src/role-eval/money.js';
import { isStandardAmountLine, remainingRemarkAfterPeel, classifyStandardRemark } from '../../src/role-eval/standard-line.js';
import { isWhitelistedRemark, remarkWhitelistConfig, type RemarkWhitelistCategory } from '../../src/role-eval/remark-whitelist.js';
import {
  createModelClassifier, loadModelRuntimeConfig, isModelStub,
  type ModelClassifier, type ModelRuntimeConfig,
} from '../../src/role-eval/model-classify.js';
import type { Person } from '../../src/role-eval/performance-store.js';
import { world } from '../role-eval/access-fixture-m03.js';
import { ROLE_CAPS_M05 } from '../role-eval/appointment-fixture-m05.js';
import { ticking } from '../role-eval/ledger-fixture-m04.js';
import { seedFrozenHistoricalCustomers } from '../r13/historical-seed.js';
import { isNewCustomerFirstAskReply } from '../../src/role-eval/customer-name-policy.js';

const P = (personId: string, displayName: string, store: 'A' | 'B', tier: Person['tier']): Person => ({
  personId: `p-${personId}`, accountId: `a-${personId}`, memberId: `m-${personId}`, displayName,
  storeId: store === 'A' ? 's-a' : 's-b', storeName: `${store}店`, tier,
  roles: tier === 'employee' ? [] : ['manager'], active: true,
});

const PEOPLE: Person[] = [
  P('chen', '小陈', 'A', 'employee'),
  P('xue', '小雪', 'A', 'employee'),
  P('am', '老周', 'A', 'manager'),
  P('li', '丽姐', 'A', 'manager'),
  P('bm', '王店长', 'B', 'manager'),
  P('afang', '阿芳', 'B', 'manager'),
  P('zhao', '小赵', 'B', 'employee'),
  P('xw', '小王', 'B', 'employee'),
  P('mei', '小美', 'B', 'employee'),
  P('lin', '小林', 'B', 'employee'),
  P('boss-b', '老板甲', 'B', 'owner'),
  P('boss-a', '老板乙', 'A', 'owner'),
  P('wangzong', '王总', 'B', 'owner'),
];
const BY_NAME = Object.fromEntries(PEOPLE.map(p => [p.displayName, p]));
const BY_MEMBER = Object.fromEntries(PEOPLE.map(p => [p.memberId, p]));
/** 无 sender_name 时的角色×门店回退（与 R2 盲测工具一致：B 店员工默认小赵）。 */
const SENDER_FALLBACK: Record<string, string> = {
  '员工|B店': '小赵', '店长|B店': '王店长', '老板|B店': '老板甲',
  '员工|A店': '小雪', '店长|A店': '老周', '老板|A店': '老板乙',
};

const members = () => Object.fromEntries(PEOPLE.map(p => [p.personId, {
  role: p.tier,
  storeIds: p.tier === 'owner' ? ['s-a', 's-b'] : [p.storeId],
  status: 'active' as const,
}]));
const policy = () => ({
  version: 1, enterprise: [...CAPABILITIES],
  stores: { 's-a': [...CAPABILITIES], 's-b': [...CAPABILITIES] },
  roles: structuredClone(ROLE_CAPS_M05), members: members(),
});

export type Outcome = 'draft' | 'write' | 'clarify' | 'deny' | 'answer';
const DENY = [DENIED, ACCESS_DENIED, MARKETING_UNAVAILABLE];

export interface CorpusItem {
  id: string;
  text: string;
  intent?: string;
  expect?: string;
  sender_role?: string;
  sender_store?: string;
  sender_name?: string;
  sender_member?: string;
  needs_context?: boolean;
  gold_reply_kind?: string;
  group?: string;
  in_gate1?: boolean;
  in_gate2?: boolean;
  in_gate3?: boolean;
  in_privacy_only?: boolean;
  expected_amount?: number | number[];
  p0_case?: string;
  context?: {
    entries?: { customer: string; amount: number; reporter: string; owner?: string }[];
    previous_turns?: { role: string; text: string }[];
  };
  privacy?: {
    check?: boolean;
    must_not_reveal_amounts?: number[];
    must_not_reveal_owners?: string[];
    must_not_offer_change_n?: boolean;
    must_not_write?: boolean;
    forbid_change?: boolean;
    sender_kind?: string;
  };
  [key: string]: unknown;
}

function isChoicePayload(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object') return false;
  const p = payload as Record<string, unknown>;
  return !!(p.awaitingDuplicateChoice || p.awaitingPick);
}
function isConfirmable(d: { status?: string; payload?: unknown }): boolean {
  if (!d || d.status === 'void') return false;
  if (isChoicePayload(d.payload)) return false;
  return true;
}

export function outcomeOf(reply: string, before: { entries: unknown; drafts: any[] }, after: { entries: unknown; drafts: any[] }): Outcome {
  const entriesChanged = JSON.stringify(after.entries) !== JSON.stringify(before.entries);
  if (entriesChanged) return 'write';
  const confirmable = after.drafts.filter((d: any) => {
    if (!isConfirmable(d)) return false;
    const prev = before.drafts.find((b: any) => b.draftId === d.draftId);
    if (!prev) return d.status !== 'void';
    if (isChoicePayload(prev.payload) && !isChoicePayload(d.payload)) return true;
    if (JSON.stringify(prev.payload) !== JSON.stringify(d.payload) && !isChoicePayload(d.payload) && prev.status !== d.status) return true;
    return false;
  });
  if (confirmable.length) return 'draft';
  const newChoice = after.drafts.some((d: any) => {
    if (!isChoicePayload(d.payload) || d.status === 'void') return false;
    const prev = before.drafts.find((b: any) => b.draftId === d.draftId);
    return !prev || !isChoicePayload(prev.payload);
  });
  if (DENY.some(d => reply.includes(d)) || /查不到，或你没有权限|跨店不能|没有权限|^Front Claw：不能做——|目前只能报今天的单|老板不能报单|暂未开放|先不开放|营销内容功能当前未开放|没有这项权限/.test(reply)) return 'deny';
  if (
    newChoice
    || reply.includes(CLARIFY_REPLY)
    || reply.includes(MULTI_REPLY)
    || /本店今天已有记录|请回复「新增一笔」|请回复「改 |请回「改|找店长|没有写入|没有登记|请补|请问|请确认|请说清|请写明|请发标准清单|没太明白|准确金额|没有成交|未办理|金额不|请告诉我|怎么称呼|客人怎么称呼|先告诉我|最多两位小数|是新客户/.test(reply)
  ) return 'clarify';
  return 'answer';
}

function resolveSender(item: CorpusItem): Person {
  if (item.sender_member && BY_MEMBER[item.sender_member]) return BY_MEMBER[item.sender_member]!;
  if (item.sender_name && BY_NAME[item.sender_name]) return BY_NAME[item.sender_name]!;
  const key = `${item.sender_role ?? ''}|${item.sender_store ?? ''}`;
  const name = SENDER_FALLBACK[key];
  if (name && BY_NAME[name]) return BY_NAME[name]!;
  return BY_NAME['小赵']!;
}

async function seedEntries(w: Awaited<ReturnType<typeof world>>, entries: NonNullable<NonNullable<CorpusItem['context']>['entries']>) {
  const notes: string[] = [];
  for (const e of entries) {
    const reporter = BY_NAME[e.reporter];
    const owner = e.owner ? BY_NAME[e.owner] : undefined;
    if (!reporter) { notes.push(`unknown reporter ${e.reporter}`); continue; }
    // D132：种子用标准行，才能种上已有单（「客户：金额（员工）」）。
    const text = owner && owner.personId !== reporter.personId
      ? `${e.customer}：${e.amount}（${owner.displayName}）`
      : `${e.customer}：${e.amount}（${reporter.displayName}）`;
    const r1 = await w.call(reporter.memberId, text);
    // D165/D139：合成种子也遵循未知客户先回是、再回对；不绕过单闸。
    if (isNewCustomerFirstAskReply(r1)) await w.call(reporter.memberId, '是');
    const r2 = await w.call(reporter.memberId, '对');
    const snap = await w.snapshot();
    const ok = snap.entries.some((row: { customerName: string | null; status: string }) => row.customerName === e.customer && row.status === 'confirmed');
    if (!ok) notes.push(`seed_fail ${e.customer} r1=${String(r1).slice(0, 80)} r2=${String(r2).slice(0, 80)}`);
  }
  return notes;
}

function extractDraftYuan(after: { drafts: any[] }, before: { drafts: any[] }): number[] {
  const out: number[] = [];
  for (const d of after.drafts) {
    if (!isConfirmable(d)) continue;
    const prev = before.drafts.find((b: any) => b.draftId === d.draftId);
    if (prev && !isChoicePayload(prev.payload) && JSON.stringify(prev.payload) === JSON.stringify(d.payload)) continue;
    for (const item of d.payload?.added || []) {
      if (typeof item.amount === 'number') out.push(item.amount / 100);
    }
    for (const c of d.payload?.changes || []) {
      const amt = c.patch?.amount ?? c.after?.amount;
      if (typeof amt === 'number') out.push(amt / 100);
    }
  }
  return out;
}

function amountMatches(expected: number | number[], got: number[]): boolean {
  const exp = (Array.isArray(expected) ? expected : [expected]).map(v => Math.round(v * 100));
  const gotC = got.map(v => Math.round(v * 100));
  if (exp.length !== gotC.length) return exp.every(e => gotC.includes(e));
  const a = [...exp].sort((x, y) => x - y);
  const b = [...gotC].sort((x, y) => x - y);
  return a.every((v, i) => v === b[i]);
}

function leakCheck(reply: string, amounts: number[] | undefined, owners: string[] | undefined) {
  const leaked_amounts: string[] = [];
  const leaked_owners: string[] = [];
  for (const a of amounts || []) {
    const yuan = formatYuan(Math.round(a * 100));
    const plain = String(a);
    const variants = [plain, yuan, yuan.replace(/\.0+$/, ''), `${plain}元`, `${yuan}元`];
    if (a >= 1000) variants.push(plain.replace(/(\d)(?=(\d{3})+$)/g, '$1,'));
    if (variants.some(v => v && reply.includes(v))) leaked_amounts.push(plain);
  }
  for (const o of owners || []) {
    if (o && reply.includes(o)) leaked_owners.push(o);
  }
  return { leaked_amounts, leaked_owners };
}

export function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const idx = (s.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  const a = s[lo]!;
  const b = s[hi]!;
  return +(lo === hi ? a : a + (b - a) * (idx - lo)).toFixed(2);
}

const pct = (a: number, b: number) => ({ n: a, of: b, rate: b ? +(a / b).toFixed(4) : null as number | null });

export interface EvalOptions {
  modelConfig?: string | Partial<ModelRuntimeConfig>;
  modelClassify?: ModelClassifier;
  timeoutMs?: number;
}

function hasGateFlags(items: CorpusItem[]): boolean {
  return items.some(i => i.in_gate1 || i.in_gate2 || i.in_gate3);
}

function flagGate1(item: CorpusItem, flagged: boolean): boolean {
  if (flagged) return !!item.in_gate1;
  return item.intent === 'report' && item.expect === '直接办' && !item.needs_context && !item.in_privacy_only;
}
function flagGate2(item: CorpusItem, flagged: boolean): boolean {
  if (flagged) return !!item.in_gate2;
  return item.expect === '该澄清' && !item.needs_context && !item.in_privacy_only;
}
function flagGate3(item: CorpusItem, flagged: boolean): boolean {
  if (flagged) return !!item.in_gate3;
  if (item.needs_context || item.in_privacy_only) return false;
  if (item.expect !== '直接办') return false;
  const intent = `${item.intent ?? ''} ${item.gold_reply_kind ?? ''}`.toLowerCase();
  return /query|progress|summary|ranking|performance|查/.test(intent) && item.intent !== 'report';
}

async function runItem(
  item: CorpusItem,
  classifier: ModelClassifier,
  timeoutMs: number,
) {
  const sender = resolveSender(item);
  const marketing = { enabled: false, handle: async () => 'Front Claw：（营销文案占位，合成）' };
  const STUB = Symbol.for('front-claw.model-classify.deterministic-stub');
  let tracking = false;
  let modelInvoked = false;
  const wrapped = Object.assign(
    async (req: Parameters<ModelClassifier>[0]) => {
      if (tracking) modelInvoked = true;
      return classifier(req);
    },
    isModelStub(classifier) ? { [STUB]: true } : {},
  ) as ModelClassifier;
  const w = await world({
    people: PEOPLE, policy: policy(), now: ticking(),
    router: { marketing, modelClassify: wrapped, modelClassifyTimeoutMs: timeoutMs },
  });
  await w.base.setConfig('employee-loop:m01', JSON.stringify({
    enabled: true, storeId: sender.storeId,
    memberIds: PEOPLE.filter(p => p.storeId === sender.storeId).map(p => p.memberId),
  }));
  await w.base.setConfig(APPOINTMENT_RECIPIENTS_KEY, JSON.stringify({ version: 1, stores: { 's-b': 'p-afang', 's-a': 'p-li' } }));
  // R13 / D139：历史客户名用标准行种子写入上一营业日（见 tests/r13/fixtures/historical-customers.json）。
  await seedFrozenHistoricalCustomers(w.base, sender, sender.storeId);
  const ctx = item.context;
  let seedNotes: string[] = [];
  if (ctx?.entries?.length) seedNotes = await seedEntries(w, ctx.entries);
  else if (!hasContext(item) && sender.tier !== 'owner') {
    // 旧格式没有 context 时，给发件人预置一笔（何姐 111），供改账/查询对照。
    await w.call(sender.memberId, '何姐：111（' + sender.displayName + '）');
    await w.call(sender.memberId, '对');
  }
  if (ctx?.previous_turns?.length) {
    for (const turn of ctx.previous_turns) {
      if (turn.role === 'user') await w.call(sender.memberId, turn.text);
    }
  }
  const before = await w.snapshot();
  tracking = true;
  const t0 = performance.now();
  const reply = await w.call(sender.memberId, item.text);
  const latency_ms = +(performance.now() - t0).toFixed(2);
  tracking = false;
  const after = await w.snapshot();
  const draftsAdded = after.drafts.filter((d: { draftId: string; status: string }) =>
    !before.drafts.some((b: { draftId: string }) => b.draftId === d.draftId) && d.status !== 'void').length;
  const entriesChanged = JSON.stringify(after.entries) !== JSON.stringify(before.entries);
  const outcome = outcomeOf(reply, before, after);
  const draftYuan = extractDraftYuan(after, before);
  const choiceDraft = after.drafts.some((d: { payload: unknown; status: string }) => isChoicePayload(d.payload) && d.status !== 'void');
  const path = modelInvoked ? 'model' as const : 'fast' as const;
  return { outcome, reply, draftsAdded, entriesChanged, sender: sender.displayName, seedNotes, draftYuan, choiceDraft, latency_ms, path };
}

function hasContext(item: CorpusItem): boolean {
  return !!(item.context?.entries?.length || item.context?.previous_turns?.length || item.needs_context);
}

export function loadCorpus(path: string): { sha256: string; items: CorpusItem[]; raw: Buffer; path: string } {
  const abs = resolve(path);
  const raw = readFileSync(abs);
  const items = raw.toString('utf8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l) as CorpusItem);
  return { sha256: createHash('sha256').update(raw).digest('hex'), items, raw, path: abs };
}

export async function evaluateCorpus(items: CorpusItem[], options: EvalOptions = {}) {
  const runtime = loadModelRuntimeConfig(options.modelConfig);
  const timeoutMs = options.timeoutMs ?? runtime.timeoutMs;
  const classifier = options.modelClassify ?? createModelClassifier({ ...runtime, timeoutMs });
  const flagged = hasGateFlags(items);
  const rows: any[] = [];
  for (const item of items) {
    const run = await runItem(item, classifier, timeoutMs);
    let amount_ok: boolean | null = null;
    if (item.expected_amount != null && run.outcome === 'draft') {
      amount_ok = amountMatches(item.expected_amount, run.draftYuan);
    }
    let privacy: any = null;
    if (item.privacy?.check) {
      const leaks = leakCheck(run.reply, item.privacy.must_not_reveal_amounts, item.privacy.must_not_reveal_owners);
      const offers_change_n = /改\s*第?\s*[1-9]/.test(run.reply) || /回复「改\s*\d/.test(run.reply);
      const offers_add = /新增/.test(run.reply);
      const offers_manager = /找店长/.test(run.reply);
      const wrote = run.entriesChanged;
      const leak = leaks.leaked_amounts.length > 0 || leaks.leaked_owners.length > 0;
      const offer_n_bad = !!(item.privacy.must_not_offer_change_n && offers_change_n);
      const write_bad = !!((item.privacy.must_not_write || item.privacy.forbid_change) && wrote);
      privacy = { fail: leak || offer_n_bad || write_bad, leak, offer_n_bad, write_bad, ...leaks, offers_change_n, offers_add, offers_manager, wrote, sender_kind: item.privacy.sender_kind };
    }
    rows.push({
      id: item.id, text: item.text, intent: item.intent ?? null, group: item.group ?? null,
      in_privacy_only: !!item.in_privacy_only, expect: item.expect ?? null, gold_reply_kind: item.gold_reply_kind ?? null,
      in_gate1: flagGate1(item, flagged), in_gate2: flagGate2(item, flagged), in_gate3: flagGate3(item, flagged),
      p0_case: item.p0_case ?? null, sender_role: item.sender_role ?? null, sender_store: item.sender_store ?? null,
      sender_name: item.sender_name ?? null, needs_context: !!item.needs_context,
      expected_amount: item.expected_amount ?? null, amount_ok, privacy,
      seed_failed: (run.seedNotes || []).some((n: string) => n.startsWith('seed_fail')),
      ...run,
    });
  }
  const isNewAsk = (r: (typeof rows)[number]) =>
    isNewCustomerFirstAskReply(String(r.reply ?? '')) && r.outcome === 'clarify' && !r.draftsAdded;
  const g1 = rows.filter(r => r.in_gate1);
  // D139 修订：新客户首报追问（只问「是新客户「X」吗？」、不附草稿）从门①分母拿出，单独报数。
  const g1NewAsk = g1.filter(isNewAsk);
  const g1rest = g1.filter(r => !isNewAsk(r));
  const g1ok = g1rest.filter(r => r.outcome === 'draft');
  const g1amt = g1rest.filter(r => r.outcome === 'draft' && r.amount_ok !== false);
  const g2 = rows.filter(r => r.in_gate2);
  const g2exec = g2.filter(r => r.outcome === 'draft' || r.outcome === 'write' || r.outcome === 'answer');
  const g3 = rows.filter(r => r.in_gate3);
  const g3ok = g3.filter(r => r.outcome === 'answer');
  const g3bad = g3.filter(r => r.outcome !== 'answer');
  const latencies = rows.map(r => r.latency_ms as number);
  const fastLat = rows.filter(r => r.path === 'fast').map(r => r.latency_ms as number);
  const modelLat = rows.filter(r => r.path === 'model').map(r => r.latency_ms as number);
  const latencyBlock = (vals: number[]) => ({
    n: vals.length,
    p50: percentile(vals, 0.5),
    p95: percentile(vals, 0.95),
    avg: vals.length ? +(vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(2) : null,
    max: vals.length ? Math.max(...vals) : null,
    min: vals.length ? Math.min(...vals) : null,
  });
  const rej = rows.filter(r => r.expect === '该拒绝' && !r.in_privacy_only);
  const rejOk = rej.filter(r => r.outcome === 'deny');
  const rejExec = rej.filter(r => r.outcome === 'draft' || r.outcome === 'write' || r.outcome === 'answer');
  const failIds = (arr: any[]) => arr.map(r => ({
    id: r.id, group: r.group, expect: r.expect, outcome: r.outcome,
    amount_ok: r.amount_ok, choiceDraft: r.choiceDraft, draftYuan: r.draftYuan,
    latency_ms: r.latency_ms, text: r.text, reply: String(r.reply || '').slice(0, 240), sender: r.sender,
  }));
  return {
    model: { mode: runtime.mode, timeoutMs, endpoint: runtime.endpoint ?? null },
    total: rows.length,
    flagged_gates: flagged,
    note: '二选一草稿计澄清、不算执行。门③与门④（延迟）数字只记录，达标与否待正式实测（真模型、真实网络）再判。默认桩、不调真模型。进程内数字不代表正式实测。',
    gate1_draft: pct(g1ok.length, g1rest.length),
    gate1_amount_correct: pct(g1amt.length, g1rest.length),
    new_customer_first_ask: {
      ...pct(g1NewAsk.length, g1.length),
      ids: g1NewAsk.map((r: { id: string }) => r.id),
      note: '新客户首报追问：回复是「是新客户「X」吗？」且无确认草稿。已从门①分母排除，单独报数。',
    },
    gate2_executed: pct(g2exec.length, g2.length),
    gate3_direct: pct(g3ok.length, g3.length),
    gate3_note: '待正式实测再判达标',
    reject_deny: pct(rejOk.length, rej.length),
    reject_executed: pct(rejExec.length, rej.length),
    latency_ms: latencyBlock(latencies),
    // D128 第四道门：快通道 p95 ≤ 1s，模型分类 p95 ≤ 5s。分别统计，只记不宣称达标。
    gate4_fast: { ...latencyBlock(fastLat), threshold_ms: 1000, meet: (percentile(fastLat, 0.95) ?? 0) <= 1000, note: '待正式实测再判；门槛 p95 ≤ 1s' },
    gate4_model: { ...latencyBlock(modelLat), threshold_ms: 5000, meet: modelLat.length ? (percentile(modelLat, 0.95) ?? 0) <= 5000 : null, note: '待正式实测再判；门槛 p95 ≤ 5s' },
    seed_fail: {
      n: rows.filter(r => r.seed_failed).length,
      ids: rows.filter(r => r.seed_failed).map(r => r.id),
      notes: [...new Set(rows.flatMap(r => r.seedNotes || []).filter((n: string) => n.startsWith('seed_fail')))],
    },
    // D136：标准格式报单里，因行尾备注不在白名单而被追问的条数和比例（单列指标）。
    remark_whitelist_ask: (() => {
      // D136 新口径：分母 = 归属和复合剥掉以后仍有剩下备注的标准行；没有剩下的不计分母也不计分子。
      // 分子按最终结果：剩余备注不在白名单，且 outcome 是追问（不只认固定句式）。
      const THRESHOLD = 0.05;
      const withRemark: { id: string; remark: string; row: (typeof rows)[number] }[] = [];
      for (const r of rows) {
        const text = String(r.text ?? '');
        if (!isStandardAmountLine(text)) continue;
        const remark = remainingRemarkAfterPeel(text);
        if (!remark) continue;
        withRemark.push({ id: r.id, remark, row: r });
      }
      const asked = withRemark.filter(x => {
        if (isWhitelistedRemark(x.remark)) return false;
        const kind = classifyStandardRemark(x.remark);
        if (kind === 'allow' || kind === 'hedge') return false;
        return x.row.outcome === 'clarify';
      });
      const by_category: Record<string, number> = {};
      const uncategorized: string[] = [];
      for (const x of asked) {
        const c = remarkAskCategory(x.remark);
        if ('category' in c) by_category[c.category] = (by_category[c.category] ?? 0) + 1;
        else uncategorized.push(c.snippet);
      }
      const rate = pct(asked.length, withRemark.length);
      return {
        ...rate,
        ids: asked.map(x => x.id),
        threshold: THRESHOLD,
        exceed: rate.rate !== null && rate.rate > THRESHOLD,
        distribution: { by_category, uncategorized },
      };
    })(),
    failures: {
      gate1_not_draft: failIds(g1rest.filter(r => r.outcome !== 'draft')),
      gate1_amount_wrong: failIds(g1.filter(r => r.outcome === 'draft' && r.amount_ok === false)),
      gate2_executed: failIds(g2exec),
      gate3_not_direct: failIds(g3bad),
      reject_executed: failIds(rejExec),
    },
    rows: rows.map(r => ({
      id: r.id, group: r.group, expect: r.expect, outcome: r.outcome,
      in_gate1: r.in_gate1, in_gate2: r.in_gate2, in_gate3: r.in_gate3,
      amount_ok: r.amount_ok, draftYuan: r.draftYuan, choiceDraft: r.choiceDraft,
      entriesChanged: r.entriesChanged, latency_ms: r.latency_ms, path: r.path, sender: r.sender,
      text: r.text, reply: String(r.reply || '').slice(0, 300),
      seed_failed: r.seed_failed, seedNotes: r.seedNotes ?? [],
    })),
  };
}


function remarkAskCategory(remark: string): { category: RemarkWhitelistCategory } | { snippet: string } {
  const cfg = remarkWhitelistConfig();
  const cats: RemarkWhitelistCategory[] = ['customerType', 'payment', 'praise', 'project'];
  const hits = cats.filter(c => (cfg[c] ?? []).some(w => remark.includes(w)));
  if (hits.length) return { category: hits[0]! };
  return { snippet: remark.slice(0, 40) };
}

export function formatSummary(out: Awaited<ReturnType<typeof evaluateCorpus>> & { corpus?: string; sha256?: string }): string {
  const g = (label: string, x: { n: number; of: number; rate: number | null }) =>
    `${label}  ${x.n}/${x.of}${x.rate === null ? '' : `  (${(x.rate * 100).toFixed(1)}%)`}`;
  const L = out.latency_ms;
  return [
    `语料  ${out.corpus ?? ''}  sha256=${out.sha256 ?? ''}  共 ${out.total} 条`,
    `模型  mode=${out.model.mode}  timeoutMs=${out.model.timeoutMs}`,
    g('门① 格式明确报单直出草稿', out.gate1_draft),
    g('门① 金额正确（附）      ', out.gate1_amount_correct),
    g('新客户首报追问（已从门①分母排除）', (out as { new_customer_first_ask?: { n: number; of: number; rate: number | null } }).new_customer_first_ask ?? { n: 0, of: 0, rate: null }) + '  （只问「是新客户「X」吗？」不附草稿；单独报数）',
    g('门② 该澄清却执行        ', out.gate2_executed) + '  （门槛 = 0，优先于门①）',
    g('门③ 权限内查询直接办    ', out.gate3_direct) + `  （${out.gate3_note}）`,
    g('该拒绝却执行（附）      ', out.reject_executed),
    `延迟  p50=${L.p50}ms  p95=${L.p95}ms  avg=${L.avg}ms  max=${L.max}ms  n=${L.n}`,
    `门④ 快通道   p95=${out.gate4_fast.p95}ms  门槛 ≤${out.gate4_fast.threshold_ms}ms  n=${out.gate4_fast.n}  （${out.gate4_fast.note}）`,
    `门④ 模型分类 p95=${out.gate4_model.p95}ms  门槛 ≤${out.gate4_model.threshold_ms}ms  n=${out.gate4_model.n}  （${out.gate4_model.note}）`,
    `种入失败  ${out.seed_fail?.n ?? 0} 条${out.seed_fail?.ids?.length ? '（' + out.seed_fail.ids.join('、') + '）' : ''}  （标准行种子；失败则 P0/隐私行不可采信）`,
    g('标准行备注非白名单追问', out.remark_whitelist_ask) + (() => {
      const m = out.remark_whitelist_ask as typeof out.remark_whitelist_ask & {
        threshold?: number; exceed?: boolean;
        distribution?: { by_category?: Record<string, number>; uncategorized?: string[] };
      };
      const th = `  门槛 ≤${((m.threshold ?? 0.05) * 100).toFixed(0)}%`;
      const flag = m.exceed ? '  超过5%' : '';
      const dist = m.distribution;
      const cats = dist?.by_category ? Object.entries(dist.by_category).map(([k, v]) => `${k}:${v}`).join('、') : '';
      const snips = dist?.uncategorized?.length ? `片段:${dist.uncategorized.join('、')}` : '';
      const d = [cats, snips].filter(Boolean).join('；');
      const distPart = d ? `  分布 ${d}` : '';
      return `${th}${flag}${distPart}  （归属和复合剥完仍有备注的标准行；按最终结果计非白名单追问）`;
    })(),
    out.note,
  ].join('\n');
}

export function parseEvalArgs(argv: string[]): {
  corpus?: string; out?: string; config?: string; model?: string; timeoutMs?: number; help?: boolean;
} {
  const r: ReturnType<typeof parseEvalArgs> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`缺少参数值：${a}`);
      return v;
    };
    if (a === '--corpus' || a === '-c') r.corpus = next();
    else if (a === '--out' || a === '-o') r.out = next();
    else if (a === '--config') r.config = next();
    else if (a === '--model') r.model = next();
    else if (a === '--timeout-ms') r.timeoutMs = Number(next());
    else if (a === '-h' || a === '--help') r.help = true;
    else if (!a.startsWith('-') && !r.corpus) r.corpus = a;
    else throw new Error(`未知参数：${a}`);
  }
  return r;
}

export async function runEvalCli(argv: string[]): Promise<{ code: number; summary: string; outPath?: string }> {
  const args = parseEvalArgs(argv);
  if (args.help || !args.corpus) {
    return {
      code: args.help ? 0 : 2,
      summary: '用法：scripts/eval-gates.sh --corpus <jsonl> [--out <json>] [--config <配置>] [--model stub|live] [--timeout-ms N]\n模型默认桩，不调真模型。门③与门④数字只记录，待正式实测再判。默认超时与系统 DEFAULT_MODEL_TIMEOUT_MS（8 秒）相同。',
    };
  }
  if (args.model === 'live' || args.model === 'stub') {
    process.env.FC_MODEL_MODE = args.model;
  }
  if (args.timeoutMs && Number.isFinite(args.timeoutMs)) {
    process.env.FC_MODEL_TIMEOUT_MS = String(args.timeoutMs);
  }
  const modelConfig = args.config;
  const runtime = loadModelRuntimeConfig(modelConfig);
  if (runtime.mode === 'live' && !runtime.endpoint) {
    return { code: 2, summary: 'mode=live 但未配置 endpoint（FC_MODEL_ENDPOINT 或配置文件）。拒绝静默回退到桩。' };
  }
  const loaded = loadCorpus(args.corpus);
  const evaluated = await evaluateCorpus(loaded.items, {
    ...(modelConfig ? { modelConfig } : {}),
    ...(args.timeoutMs && Number.isFinite(args.timeoutMs) ? { timeoutMs: args.timeoutMs } : {}),
  });
  const out = { corpus: loaded.path, sha256: loaded.sha256, ...evaluated };
  const summary = formatSummary(out);
  let outPath = args.out;
  if (outPath) {
    outPath = resolve(outPath);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, JSON.stringify(out, null, 2));
  }
  return { code: 0, summary, ...(outPath ? { outPath } : {}) };
}

export { PEOPLE };
