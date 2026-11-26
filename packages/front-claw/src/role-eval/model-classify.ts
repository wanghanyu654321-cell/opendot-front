/**
 * R7（D119）：模型分类接口 + 严格 schema。
 *
 * 规则不在本文件做「对象×动作＋同义词表」，连兜底也不做。
 * 默认关闭：确定性桩恒回 uncertain，不调用任何真实模型。
 * 所有被接受的分类结果必须再过同一道校验链（金额校验、权限、数据兜底）；
 * 拿不准或低置信 → 追问、不执行；门②优先（金额不安全则不出可确认草稿）。
 * 只读查询且在权限范围内 → 直接办、不确认。
 * 测试用桩只验证接口和校验链路，不自报门③。
 */
import { readFileSync } from 'node:fs';
import { centsFromModelSlot, guardUtteranceAmounts, guardIssueToReason, type AmountContext } from './amount-guard.js';
import { clarifyQuestion } from './clarify.js';
import type { UnclearReason } from './report-extract.js';

export const MODEL_INTENTS = ['report', 'query', 'amend', 'withdraw', 'appointment', 'target', 'chitchat', 'marketing', 'hold_pending', 'multi_intent', 'unknown'] as const;
export const MODEL_OBJECTS = ['performance', 'target', 'completion', 'entry', 'appointment', 'progress', 'ranking', 'summary', 'unreported', 'identity', 'self_and_summary'] as const;
export const MODEL_ACTIONS = ['query', 'report', 'amend', 'cancel', 'delete'] as const;
export const MODEL_ENTRY_MODES = ['latest_operation', 'latest_confirmed', 'by_ref'] as const;
export const MODEL_SOFT_ROLES = ['marketing', 'reception_ads', 'training', 'manager_ops'] as const;
export const MODEL_SCOPES = ['self', 'store', 'other'] as const;
export const MODEL_SLOT_KEYS = ['amountText', 'customer', 'employee', 'index', 'period', 'store', 'ref', 'countOnly', 'entryMode', 'scope', 'holdPending'] as const;

export type ModelIntent = (typeof MODEL_INTENTS)[number];
export type ModelObject = (typeof MODEL_OBJECTS)[number];
export type ModelAction = (typeof MODEL_ACTIONS)[number];
export type ModelEntryMode = (typeof MODEL_ENTRY_MODES)[number];
export type ModelSoftRole = (typeof MODEL_SOFT_ROLES)[number];
export type ModelScope = (typeof MODEL_SCOPES)[number];

/** 槽位只收原始文本或纯只读标志。金额必须是字符串，由金额校验函数换成分数；模型不得直接给分。 */
export interface ModelSlots {
  amountText?: string;
  customer?: string;
  employee?: string;
  index?: number;
  period?: string;
  store?: string;
  ref?: string;
  countOnly?: boolean;
  entryMode?: ModelEntryMode;
  scope?: ModelScope;
  holdPending?: boolean;
}

export interface ModelClassification {
  intent: ModelIntent;
  object: ModelObject | null;
  action: ModelAction | null;
  softRole?: ModelSoftRole | null;
  slots: ModelSlots;
  /** 0..1；低于阈值或 uncertain=true 都视为拿不准。 */
  confidence: number;
  uncertain: boolean;
}

/** 传给分诊模型的最小脱敏会话提示（严禁含客户名、金额、账本或权限明细）。 */
export interface ModelClassifierContext {
  readonly hasActivePendingDraft?: boolean;
  readonly pendingDraftKind?: 'report' | 'appointment' | 'target' | 'correction' | null;
  readonly hasPendingAppointmentTimeAsk?: boolean;
}

export type ModelClassifier = (input: {
  text: string;
  signal: AbortSignal;
  context?: ModelClassifierContext;
}) => Promise<unknown>;

export function formatClassifierUserInput(text: string, context?: ModelClassifierContext): string {
  if (!context || (!context.hasActivePendingDraft && !context.hasPendingAppointmentTimeAsk)) {
    return text;
  }
  const flags = [
    `hasActivePendingDraft=${context.hasActivePendingDraft === true}`,
    `pendingDraftKind=${context.pendingDraftKind ?? 'none'}`,
    `hasPendingAppointmentTimeAsk=${context.hasPendingAppointmentTimeAsk === true}`,
  ];
  return `[会话状态提示（仅用于语义理解，不含账本与授权）: ${flags.join(', ')}]\n[员工原文]\n${text}`;
}

export const MODEL_MIN_CONFIDENCE = 0.8;

const STUB = Symbol.for('front-claw.model-classify.deterministic-stub');

/** 默认确定性桩：不调用模型，恒为拿不准（confidence 0）。 */
export const stubModelClassifier: ModelClassifier = Object.assign(
  async (_input: { text: string; signal: AbortSignal }): Promise<ModelClassification> => ({
    intent: 'unknown', object: null, action: null, slots: {}, confidence: 0, uncertain: true,
  }),
  { [STUB]: true },
);

export function isModelStub(classifier: unknown): boolean {
  return typeof classifier === 'function' && (classifier as unknown as Record<symbol, unknown>)[STUB] === true;
}

const INTENT_SET = new Set<string>(MODEL_INTENTS);
const OBJECT_SET = new Set<string>(MODEL_OBJECTS);
const ACTION_SET = new Set<string>(MODEL_ACTIONS);
const ENTRY_MODE_SET = new Set<string>(MODEL_ENTRY_MODES);
const SOFT_ROLE_SET = new Set<string>(MODEL_SOFT_ROLES);
const SCOPE_SET = new Set<string>(MODEL_SCOPES);
const SLOT_KEYS = new Set<string>(MODEL_SLOT_KEYS);

/**
 * 严格解析模型输出。多字段、错误类型、未知枚举、金额以数字（分）给出、缺必填 → 全部拒绝（视为拿不准）。
 */
export function parseModelClassification(output: unknown): ModelClassification | null {
  if (!output || typeof output !== 'object' || Array.isArray(output)) return null;
  const o = output as Record<string, unknown>;
  if (Object.keys(o).some(key => !['intent', 'object', 'action', 'softRole', 'slots', 'confidence', 'uncertain'].includes(key))) return null;
  if (typeof o.intent !== 'string' || !INTENT_SET.has(o.intent)) return null;
  if (typeof o.confidence !== 'number' || !Number.isFinite(o.confidence) || o.confidence < 0 || o.confidence > 1) return null;
  if (typeof o.uncertain !== 'boolean') return null;
  if (o.object !== null && o.object !== undefined && (typeof o.object !== 'string' || !OBJECT_SET.has(o.object))) return null;
  if (o.action !== null && o.action !== undefined && (typeof o.action !== 'string' || !ACTION_SET.has(o.action))) return null;
  if (o.softRole !== null && o.softRole !== undefined && (typeof o.softRole !== 'string' || !SOFT_ROLE_SET.has(o.softRole))) return null;
  const slotsIn = o.slots;
  if (slotsIn === undefined) {
    // slots 可缺省，视为空。
  } else if (!slotsIn || typeof slotsIn !== 'object' || Array.isArray(slotsIn)) {
    return null;
  }
  const rawSlots = (slotsIn && typeof slotsIn === 'object' && !Array.isArray(slotsIn)) ? slotsIn as Record<string, unknown> : {};
  // 拒绝未知槽位；拒绝 amount / amountCents / cents 这类想直接写分的字段。
  for (const key of Object.keys(rawSlots)) {
    if (!SLOT_KEYS.has(key)) return null;
  }
  if ('amount' in rawSlots || 'amountCents' in rawSlots || 'cents' in o || 'amount' in o) return null;
  const slots: ModelSlots = {};
  if (rawSlots.amountText !== undefined) {
    if (typeof rawSlots.amountText !== 'string' || rawSlots.amountText.length > 64) return null;
    slots.amountText = rawSlots.amountText;
  }
  if (rawSlots.customer !== undefined) {
    if (typeof rawSlots.customer !== 'string' || rawSlots.customer.length > 32 || !rawSlots.customer.trim()) return null;
    slots.customer = rawSlots.customer.trim();
  }
  if (rawSlots.employee !== undefined) {
    if (typeof rawSlots.employee !== 'string' || rawSlots.employee.length > 32 || !rawSlots.employee.trim()) return null;
    slots.employee = rawSlots.employee.trim();
  }
  if (rawSlots.index !== undefined) {
    if (typeof rawSlots.index !== 'number' || !Number.isInteger(rawSlots.index) || rawSlots.index < 1 || rawSlots.index > 99) return null;
    slots.index = rawSlots.index;
  }
  if (rawSlots.period !== undefined) {
    if (typeof rawSlots.period !== 'string' || rawSlots.period.length > 32) return null;
    slots.period = rawSlots.period;
  }
  if (rawSlots.store !== undefined) {
    if (typeof rawSlots.store !== 'string' || !rawSlots.store.trim() || rawSlots.store.length > 120) return null;
    slots.store = rawSlots.store.trim();
  }
  if (rawSlots.ref !== undefined) {
    if (typeof rawSlots.ref !== 'string' || !rawSlots.ref.trim() || rawSlots.ref.trim().length > 64) return null;
    slots.ref = rawSlots.ref.trim();
  }
  if (rawSlots.countOnly !== undefined) {
    if (typeof rawSlots.countOnly !== 'boolean') return null;
    slots.countOnly = rawSlots.countOnly;
  }
  if (rawSlots.entryMode !== undefined) {
    if (typeof rawSlots.entryMode !== 'string' || !ENTRY_MODE_SET.has(rawSlots.entryMode)) return null;
    slots.entryMode = rawSlots.entryMode as ModelEntryMode;
  }
  if (rawSlots.scope !== undefined) {
    if (typeof rawSlots.scope !== 'string' || !SCOPE_SET.has(rawSlots.scope)) return null;
    slots.scope = rawSlots.scope as ModelScope;
  }
  if (rawSlots.holdPending !== undefined) {
    if (typeof rawSlots.holdPending !== 'boolean') return null;
    slots.holdPending = rawSlots.holdPending;
  }
  return {
    intent: o.intent as ModelIntent,
    object: (o.object ?? null) as ModelObject | null,
    action: (o.action ?? null) as ModelAction | null,
    ...(o.softRole !== undefined ? { softRole: (o.softRole ?? null) as ModelSoftRole | null } : {}),
    slots,
    confidence: o.confidence,
    uncertain: o.uncertain,
  };
}

export function isUncertain(c: ModelClassification): boolean {
  return c.uncertain === true || c.confidence < MODEL_MIN_CONFIDENCE || c.intent === 'unknown';
}

export type ModelChainRefusal = {
  ok: false;
  reason: 'uncertain' | 'schema' | 'amount' | 'permission' | 'fallback';
  ask: string;
  issue?: UnclearReason | 'missing_customer';
};

export type ModelChainAccept = {
  ok: true;
  classification: ModelClassification;
  /** 金额槽位已通过校验的分数；没有槽位则为 undefined。 */
  amountCents?: number;
};

export type ModelChainResult = ModelChainRefusal | ModelChainAccept;

const F = 'Front Claw';
const UNSURE = `${F}：没太明白要办哪件事，请再说一次。没有写入任何账目。`;

/**
 * 校验链：schema 已通过的分类 → 拿不准则追问；金额槽位与源句过金额校验；
 * 门②优先：源句或槽位金额不安全 → 追问、不把金额交给执行层。
 * 权限与数据兜底由调用方（员工循环）在执行前再判；本函数保证金额不会以未校验的分值离开。
 */
export function validateModelChain(input: {
  text: string;
  output: unknown;
  context?: AmountContext;
}): ModelChainResult {
  const parsed = parseModelClassification(input.output);
  if (!parsed) return { ok: false, reason: 'schema', ask: UNSURE };
  if (isUncertain(parsed)) return { ok: false, reason: 'uncertain', ask: UNSURE };
  const utterance = guardUtteranceAmounts(input.text, input.context);
  const slot = parsed.slots.amountText !== undefined ? centsFromModelSlot(parsed.slots.amountText, input.context ?? 'free') : null;
  // 门②：句中或槽位金额不安全 → 追问。写类意图（报/改）尤其不能带脏金额执行。
  const writeIntent = parsed.intent === 'report' || parsed.intent === 'amend' || parsed.action === 'amend' || parsed.action === 'report';
  if (slot) {
    if (!slot.ok) {
      return { ok: false, reason: 'amount', ask: clarifyQuestion(guardIssueToReason(slot.issue), slot.text), issue: guardIssueToReason(slot.issue) };
    }
  }
  if (!utterance.ok && writeIntent) {
    return { ok: false, reason: 'amount', ask: clarifyQuestion(guardIssueToReason(utterance.issue), utterance.text), issue: guardIssueToReason(utterance.issue) };
  }
  if (writeIntent && parsed.slots.amountText === undefined && utterance.ok === false) {
    return { ok: false, reason: 'amount', ask: clarifyQuestion('vague_amount'), issue: 'vague_amount' };
  }
  return { ok: true, classification: parsed, ...(slot && slot.ok ? { amountCents: slot.cents } : {}) };
}

/** 只读查询：intent=query 且 action 为 query 或空，对象是可查的店务对象。 */
export function isReadOnlyQuery(c: ModelClassification): boolean {
  if (c.intent !== 'query') return false;
  if (c.action !== null && c.action !== 'query') return false;
  return c.object === 'progress' || c.object === 'performance' || c.object === 'completion'
    || c.object === 'entry' || c.object === 'appointment' || c.object === 'ranking'
    || c.object === 'summary' || c.object === 'target'
    || c.object === 'unreported' || c.object === 'identity' || c.object === 'self_and_summary';
}

export const DEFAULT_MODEL_TIMEOUT_MS = 8000;

/** 超时、报错、未配置时的拿不准输出：调用方走追问，不执行。 */
export function uncertainClassification(): ModelClassification {
  return { intent: 'unknown', object: null, action: null, slots: {}, confidence: 0, uncertain: true };
}

/**
 * 调用分类器。timeoutMs 可配置（默认 8 秒），并与请求剩余截止取较小值。
 * 超时、抛错或被取消 → 返回 uncertain，不往外抛、不执行。
 */
export async function runModelClassifier(
  text: string,
  classifier: ModelClassifier | undefined,
  signal?: AbortSignal,
  deadline?: number,
  timeoutMs?: number,
  observe?: (diagnostic: { modelMs: number; errorCategory: string }) => void,
  context?: ModelClassifierContext,
): Promise<unknown> {
  if (!classifier) return stubModelClassifier({ text, signal: signal ?? new AbortController().signal, ...(context ? { context } : {}) });
  const cap = (typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0)
    ? timeoutMs : DEFAULT_MODEL_TIMEOUT_MS;
  const untilDeadline = deadline !== undefined ? Math.floor(deadline - performance.now()) : cap;
  const remaining = Math.max(0, Math.min(cap, untilDeadline));
  if (remaining < 50 || signal?.aborted) return uncertainClassification();
  const child = new AbortController();
  let cancel!: () => void;
  const aborted = new Promise<never>((_, reject) => { cancel = () => { child.abort(); reject(Error('model_cancelled')); }; });
  const stop = () => cancel();
  signal?.addEventListener('abort', stop, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const started = performance.now();
  let errorCategory = 'none';
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { reject(new Error('model_classify_timeout')); child.abort(); }, remaining);
    });
    return await Promise.race([
      classifier({ text, signal: child.signal, ...(context ? { context } : {}) }),
      timeout,
      aborted,
    ]);
  } catch (error) {
    const failure = error as { message?: string; status?: number };
    errorCategory = failure.message === 'model_classify_timeout' ? 'timeout' : failure.message === 'model_cancelled' ? 'cancelled'
      : failure.status === 429 || failure.message === 'model_http_429' ? 'rate_limit' : 'model_error';
    return uncertainClassification();
  } finally {
    if (timer) clearTimeout(timer);
    signal?.removeEventListener('abort', stop);
    child.abort();
    try { observe?.({ modelMs: Math.round((performance.now() - started) * 1000) / 1000, errorCategory }); } catch { /* Observation is best effort. */ }
  }
}

/** 模型运行配置：用文件或环境变量切换桩/真模型，不改代码。默认桩、不调真模型。 */
export interface ModelRuntimeConfig {
  mode: 'stub' | 'live';
  timeoutMs: number;
  endpoint?: string;
  /** 仅存环境变量名，不把密钥写进配置文件。只在 mode=live 时读取该变量。 */
  apiKeyEnv?: string;
  model?: string;
}

function asMode(v: unknown): 'stub' | 'live' | undefined {
  return v === 'live' || v === 'stub' ? v : undefined;
}

/**
 * 读配置。优先级：入参对象/文件 → 环境变量 FC_MODEL_MODE / FC_MODEL_TIMEOUT_MS / FC_MODEL_ENDPOINT。
 * 文件路径也可由 FC_MODEL_CONFIG 给出。缺省为桩、8 秒超时。
 */
export function loadModelRuntimeConfig(source?: string | Partial<ModelRuntimeConfig> | null, env: Readonly<Record<string, string | undefined>> = process.env): ModelRuntimeConfig {
  let file: Partial<ModelRuntimeConfig> = {};
  if (typeof source === 'object' && source) {
    file = source;
  } else {
    const path = (typeof source === 'string' && source.trim()) ? source.trim() : (env.FC_MODEL_CONFIG ?? '').trim();
    if (path) {
      const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
      const body = (raw.model && typeof raw.model === 'object') ? raw.model as Record<string, unknown> : raw;
      const fileMode = asMode(body.mode);
      file = {
        ...(fileMode ? { mode: fileMode } : {}),
        ...(typeof body.timeoutMs === 'number' ? { timeoutMs: body.timeoutMs } : {}),
        ...(typeof body.endpoint === 'string' && body.endpoint ? { endpoint: body.endpoint } : {}),
        ...(typeof body.apiKeyEnv === 'string' && body.apiKeyEnv ? { apiKeyEnv: body.apiKeyEnv } : {}),
        ...(typeof body.model === 'string' && body.model ? { model: body.model } : {}),
      };
    }
  }
  const mode = asMode(env.FC_MODEL_MODE) ?? file.mode ?? 'stub';
  const timeoutRaw = env.FC_MODEL_TIMEOUT_MS !== undefined && env.FC_MODEL_TIMEOUT_MS !== ''
    ? Number(env.FC_MODEL_TIMEOUT_MS)
    : (typeof file.timeoutMs === 'number' ? file.timeoutMs : DEFAULT_MODEL_TIMEOUT_MS);
  const timeoutMs = Math.max(50, Math.min(Number.isFinite(timeoutRaw) ? timeoutRaw : DEFAULT_MODEL_TIMEOUT_MS, 60_000));
  const endpoint = (env.FC_MODEL_ENDPOINT?.trim() || file.endpoint || '').trim() || undefined;
  const result: ModelRuntimeConfig = { mode, timeoutMs };
  if (endpoint) result.endpoint = endpoint;
  if (file.apiKeyEnv) result.apiKeyEnv = file.apiKeyEnv;
  if (file.model) result.model = file.model;
  return result;
}

function liveClassifier(cfg: ModelRuntimeConfig, env: Readonly<Record<string, string | undefined>>): ModelClassifier {
  const endpoint = cfg.endpoint!;
  const apiKeyEnv = cfg.apiKeyEnv;
  const model = cfg.model;
  return async ({ text, signal }) => {
    const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json' };
    if (apiKeyEnv) {
      const key = env[apiKeyEnv];
      if (key) headers.authorization = `Bearer ${key}`;
    }
    const body = {
      text,
      ...(model ? { model } : {}),
      schema: {
        intent: MODEL_INTENTS,
        object: MODEL_OBJECTS,
        action: MODEL_ACTIONS,
        slots: MODEL_SLOT_KEYS,
        confidence: '0..1',
        uncertain: 'boolean',
      },
    };
    const res = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(body), signal });
    if (!res.ok) throw new Error(`model_http_${res.status}`);
    return await res.json();
  };
}

/**
 * 按配置构造分类器。mode=stub（默认）返回确定性桩；mode=live 且有 endpoint 才走 HTTP。
 * 真模型的超时/抛错由 runModelClassifier 收成 uncertain。本函数不在默认路径发起网络请求。
 */
export function createModelClassifier(source?: string | Partial<ModelRuntimeConfig> | null, env: Readonly<Record<string, string | undefined>> = process.env): ModelClassifier {
  const cfg = loadModelRuntimeConfig(source, env);
  if (cfg.mode !== 'live') return stubModelClassifier;
  if (!cfg.endpoint) {
    // 误配成 live 但没有地址：不执行、不假装是桩静默成功；每次都拿不准。
    return async () => uncertainClassification();
  }
  return liveClassifier(cfg, cfg.apiKeyEnv ? Object.freeze({ [cfg.apiKeyEnv]: env[cfg.apiKeyEnv] }) : {});
}
