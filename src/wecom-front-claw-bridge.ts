import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { hostname } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { logger } from './logger.js';
import {
  getClaudeProviderConfig,
  getDefaultProviderId,
  getEnabledProviders,
  resolveProviderById,
  type ClaudeProviderConfig,
} from './runtime-config.js';
import type { AgentProfile, ExecutionMode } from './types.js';

/**
 * Issue #2 / #3 共享企微文本入站事件契约（与 docs/OPENDOT-FRONT-MASTER-PLAN.md 对齐）。
 */
export interface WeComInboundTextEvent {
  readonly reqId: string;
  readonly botId: string;
  readonly corpId?: string;
  readonly memberId: string;
  readonly messageId: string;
  readonly text: string;
  readonly createTime?: number;
}

/**
 * Issue #2 / #3 共享企微前置拦截三态输出（与 docs/OPENDOT-FRONT-MASTER-PLAN.md 对齐）。
 * 放行态仅携带最小脱敏员工/门店/工作区身份字段，绝不暴露 Front Claw PG store 或数据库连接串。
 */
export type WeComPrecheckOutcome =
  | {
      readonly kind: 'handled' | 'failed';
      readonly replies: readonly string[];
    }
  | {
      readonly kind: 'pass';
      readonly corpId: string;
      readonly accountId: string;
      readonly storeId: string;
      readonly displayName: string;
      readonly workspaceJid?: string;
      readonly expiredReminder?: string;
    };

export type WeComPrecheckPort = (
  event: WeComInboundTextEvent,
) => Promise<WeComPrecheckOutcome>;

export type ModelIntent =
  | 'report'
  | 'query'
  | 'amend'
  | 'withdraw'
  | 'appointment'
  | 'target'
  | 'chitchat'
  | 'marketing'
  | 'unknown';

export type ModelClassifier = (input: {
  text: string;
  signal: AbortSignal;
}) => Promise<unknown>;

export interface BridgePerson {
  personId: string;
  accountId: string;
  memberId: string;
  displayName: string;
  storeId: string;
  storeName: string;
  tier: 'employee' | 'manager' | 'owner';
  roles: string[];
  active: boolean;
  corpId?: string;
}

export interface BridgeWecomBotBinding {
  botId: string;
  corpId: string;
  memberId: string;
  accountId: string;
  version: number;
  active: boolean;
}

export interface BridgeStoreLike {
  getPersonByMember(memberId: string): Promise<BridgePerson | null>;
  listPeople(): Promise<BridgePerson[]>;
  getPerson?(personId: string): Promise<BridgePerson | null>;
  getConfig?(key: string): Promise<string | null>;
  insertConfigIfAbsent?(key: string, value: string): Promise<boolean | void>;
  updateConfigLocked?(
    key: string,
    extraKeys: readonly string[],
    fn: (current: Record<string, string | null>) => Record<string, string> | null,
  ): Promise<unknown>;
}

export interface BridgeBindingStoreLike {
  listBindings(): Promise<BridgeWecomBotBinding[]>;
  saveBinding?(binding: BridgeWecomBotBinding): Promise<void>;
}

export interface BridgeOpenedStore {
  driver: 'memory' | 'postgres' | string;
  store: BridgeStoreLike;
  bindings: BridgeBindingStoreLike;
  close(): Promise<void>;
}

export interface OpenDotClassifierRuntimeConfig {
  mode: 'stub' | 'live';
  providerId: string | null;
  baseUrl: string;
  model: string;
  apiKey?: string;
  authToken?: string;
  timeoutMs: number;
}

/**
 * 放行进 OpenDot 同进程 Agent 前的岗位 Profile 安全快照。
 */
export interface TargetAgentProfileSnapshot {
  readonly profileId?: string;
  readonly workspaceJid?: string;
  readonly status?: 'active' | 'archived' | string;
  readonly executionMode?: ExecutionMode | string;
  readonly contextSource?: 'managed' | 'host_claude' | string;
  readonly hostSkillsMode?: 'inherit' | 'custom' | 'disabled' | string;
  readonly runtimePolicy?: Pick<AgentProfile['runtime_policy'], 'context' | 'skills'>;
  readonly allowedTools?: readonly string[];
  readonly disallowedTools?: readonly string[];
  readonly excludedTools?: readonly string[];
  readonly dangerousToolsDisabled?: boolean;
  readonly injectedEnvKeys?: readonly string[];
}

export interface AgentProfileGuardrailResult {
  readonly ok: boolean;
  readonly reason?: string;
}

export interface TargetProfileLookupContext {
  readonly corpId: string;
  readonly accountId: string;
  readonly memberId: string;
  readonly storeId: string;
  readonly displayName: string;
  readonly tier: 'employee' | 'manager' | 'owner';
  readonly workspaceJid?: string;
}

export interface FrontClawBridgeNotificationSender {
  notify(
    memberId: string,
    content: string,
    scope: { signal: AbortSignal; deadline: number },
    beforeSend: () => Promise<void>,
  ): Promise<{ state: 'accepted' | 'blocked' | 'unknown' }>;
}

export interface WeComFrontClawBridgeOptions {
  readonly env?: Record<string, string | undefined>;
  readonly now?: () => Date;
  readonly root?: string;
  readonly budgetMs?: number;
  readonly modelClassifyTimeoutMs?: number;
  readonly modelClassify?: ModelClassifier;
  readonly modelConfig?:
    | string
    | Partial<{
        mode: 'stub' | 'live';
        timeoutMs: number;
        endpoint?: string;
        apiKeyEnv?: string;
        model?: string;
      }>;
  /** OpenDot runtime-config Provider ID 覆盖（默认取 defaultProviderId）。 */
  readonly openDotProviderId?: string;
  /** 是否读取 src/runtime-config.ts 构造真模型分类器（仍仅在 live 模式下发请求，默认 true）。 */
  readonly useOpenDotModelConfig?: boolean;
  /** 可选注入模型文本补全端口（便于离线单测 OpenDot runtime-config 解析链路）。 */
  readonly openDotModelComplete?: (request: {
    system: string;
    user: string;
    signal: AbortSignal;
    config: OpenDotClassifierRuntimeConfig;
  }) => Promise<string>;
  readonly semantic?: unknown;
  readonly maintenanceIntervalMs?: number;
  readonly onEmployeeTrace?: (event: {
    messageId: string;
    operationId?: string;
    elapsedMs: number;
    outcome: 'reply' | 'unavailable';
    ledgerSettled: boolean;
  }) => void;
  readonly onObservation?: (record: {
    requestId: string;
    route: '快通道' | '模型' | '追问';
    gateReason: string;
    pendingSequence: string | null;
    modelMs: number;
    errorCategory: string;
  }) => void;
  readonly onRoute?: (record: unknown) => void;
  readonly platformCapabilitiesRaw?: string;
  readonly open?: () => Promise<BridgeOpenedStore>;
  /** 放行前解析目标工作区 JID。 */
  readonly resolveWorkspaceJid?: (
    ctx: Omit<TargetProfileLookupContext, 'workspaceJid' | 'tier'>,
  ) => Promise<string | undefined> | string | undefined;
  /**
   * 放行前校验的目标岗位 Profile（与 resolveTargetProfile 二选一）。
   * 未显式提供且未命中 OpenDot 本地 DB 工作区 Profile 时保持安全默认，一旦提供则按 fail-closed 校检。
   */
  readonly targetProfile?: TargetAgentProfileSnapshot;
  readonly resolveTargetProfile?: (
    ctx: TargetProfileLookupContext,
  ) =>
    | Promise<TargetAgentProfileSnapshot | null | undefined>
    | TargetAgentProfileSnapshot
    | null
    | undefined;
  /** 可选：读取 OpenDot SQLite 中注册的工作区与 AgentProfile 做额外宿主隔离校检，默认 false。 */
  readonly checkOpenDotWorkspaceDb?: boolean;
  /** 单消费者 PG 租约配置（driver === 'postgres' 时默认开启）。 */
  readonly lease?: {
    readonly enabled?: boolean;
    readonly owner?: string;
    readonly ttlMs?: number;
    readonly renewMs?: number;
    readonly key?: string;
  };
  /** 可选 M06 主动通知发送端。 */
  readonly sendNotification?: (input: {
    toPersonId: string;
    memberId: string;
    text: string;
  }) => Promise<'sent' | 'not_sent' | 'unknown'>;
}

export interface WeComFrontClawBridge {
  readonly precheck: WeComPrecheckPort;
  readonly driver: string;
  isActive(): boolean;
  leaseHeld(): boolean;
  startMaintenance(): void;
  startNotificationDispatch(
    sender: FrontClawBridgeNotificationSender,
    options?: { intervalMs?: number; onEvent?: (event: unknown) => void },
  ): 'started' | 'disabled' | 'already';
  stopNotificationDispatch(): void;
  close(): Promise<void>;
}

const DEFAULT_BUDGET_MS = 15_000;
const DEFAULT_MODEL_TIMEOUT_MS = 8_000;
const DEFAULT_LEASE_MS = 30_000;
const DEFAULT_RENEW_MS = 10_000;

export const BRIDGE_UNBOUND_REPLY =
  'Front Claw：还没绑定你的身份，我先不办。请让管理员绑定后再发。';
export const BRIDGE_INCOMPLETE_PROFILE_REPLY =
  'Front Claw：你的员工姓名或所属门店档案不完整，我先不办。请让管理员补全后再发。';
export const BRIDGE_STALE_CONSUMER_REPLY =
  'Front Claw：本实例已不再负责这条消息，没有写入。';
export const BRIDGE_EXECUTION_FAILED_REPLY =
  'Front Claw：店务处理遇到异常，没有写入任何账目，请稍后再发。';
export const BRIDGE_AGENT_GUARDRAIL_DENIED_REPLY =
  'Front Claw：目标岗位 Agent 未通过安全权限校验（已拦截高危工具或宿主机权限），已拒绝放行。';

export const SAFE_MARKETING_DISALLOWED_TOOLS = [
  'Bash',
  'Write',
  'Edit',
  'NotebookEdit',
] as const;

const DANGEROUS_TOOL_NAMES = new Set([
  '*',
  'all',
  'bash',
  'shell',
  'sh',
  'exec',
  'execute',
  'terminal',
  'run_command',
  'command',
  'powershell',
  'cmd',
  'write',
  'edit',
  'multiedit',
  'notebookedit',
  'write_file',
  'edit_file',
  'delete_file',
  'remove_file',
  'fs_write',
  'patch',
]);

const REQUIRED_DISALLOWED_CORE_TOOLS = ['bash', 'write', 'edit'] as const;

const FORBIDDEN_SECRET_ENV_KEYS = new Set([
  'FRONT_CLAW_DATABASE_URL',
  'DATABASE_URL',
  'PGPASSWORD',
  'PGUSER',
  'PGHOST',
  'FRONT_CLAW_SQLITE_PATH',
]);

const MODEL_CLASSIFIER_SYSTEM_PROMPT = [
  '你是美容门店助手 Front Claw 的前置意图分类器。',
  '只输出一个合法 JSON 对象，不要包含 Markdown 代码块、解释或多余文本。',
  '允许字段：intent, object, action, slots, confidence, uncertain。',
  'intent 仅可为 report | query | amend | withdraw | appointment | target | chitchat | marketing | unknown。',
  '若拿不准或含糊请设为 {"intent":"unknown","object":null,"action":null,"slots":{},"confidence":0,"uncertain":true}。',
  '绝不猜测金额数字，amountText 若出现必须保留原始文本。',
].join('\n');

interface FrontClawBootModule {
  bootFrontClaw: (options: Record<string, unknown>) => Promise<FrontClawBootInstance>;
}

interface FrontClawEntryModule {
  CLARIFY_REPLY: string;
  MARKETING_UNAVAILABLE: string;
}

interface FrontClawLoopModule {
  ACCESS_DENIED: string;
  DENIED: string;
  STALE_CONSUMER: string;
}

interface FrontClawUnifiedModule {
  UNBOUND: string;
}

interface FrontClawPendingOrderModule {
  capturePendingArrival: (store: BridgeStoreLike) => Promise<{ sequence: string }>;
}

interface FrontClawBindingsModule {
  snapshotBinding: (raw: unknown) => BridgeWecomBotBinding;
  sameBinding: (
    a: Readonly<BridgeWecomBotBinding> | null | undefined,
    b: Readonly<BridgeWecomBotBinding> | null | undefined,
  ) => boolean;
}

interface FrontClawMem0Module {
  assertMem0Off: (env?: Record<string, string | undefined>) => void;
}

interface FrontClawAccessPolicyModule {
  CAPABILITIES: readonly string[];
}

interface FrontClawLeaseModule {
  createConsumerLease: (options: {
    store: BridgeStoreLike;
    owner: string;
    ttlMs: number;
    now: () => Date;
    key?: string;
  }) => {
    acquire(): Promise<boolean>;
    held(): boolean;
    release(): Promise<void>;
    fence(): { key: string; owner: string; epoch: number } | null;
  };
  CONSUMER_LEASE_KEY: string;
}

interface FrontClawFencingModule {
  parseLeaseRecord: (raw: string | null) => unknown;
  fenceHolds: (
    record: unknown,
    fence: { key: string; owner: string; epoch: number },
    nowMs: number,
  ) => boolean;
}

interface FrontClawNotificationModule {
  createBotNotificationSender: (
    channel: {
      notify: (
        member: string,
        content: string,
        scope: { signal: AbortSignal; deadline: number },
        beforeSend: () => Promise<void>,
      ) => Promise<{ state: 'accepted' | 'blocked' | 'unknown' }>;
    },
    options: { active: () => boolean },
  ) => unknown;
}

interface FrontClawModules {
  boot: FrontClawBootModule;
  entry: FrontClawEntryModule;
  loop: FrontClawLoopModule;
  unified: FrontClawUnifiedModule;
  pendingOrder: FrontClawPendingOrderModule;
  bindings: FrontClawBindingsModule;
  mem0: FrontClawMem0Module;
  accessPolicy: FrontClawAccessPolicyModule;
  lease: FrontClawLeaseModule;
  fencing: FrontClawFencingModule;
  notification: FrontClawNotificationModule;
}

interface RoutedResult {
  entry: 'unified';
  replies: string[];
  modelCalled: boolean;
  ledgerSettled?: boolean;
  requestId?: string;
  state?: 'completed' | 'failed' | 'timeout' | 'cancelled';
  target?:
    | 'store'
    | 'chitchat'
    | 'marketing'
    | 'marketing-unavailable'
    | 'clarify';
  duplicate?: boolean;
  pass?: true;
  expiredReminder?: string;
  actor?: BridgePerson;
}

interface FrontClawBootInstance {
  driver: string;
  store: BridgeStoreLike;
  bindings: BridgeBindingStoreLike;
  handler: {
    handleMessage(input: Record<string, unknown>): Promise<RoutedResult>;
  };
  startMaintenance(): void;
  startNotificationDispatch(
    sender: unknown,
    options?: { intervalMs?: number; onEvent?: (event: unknown) => void },
  ): 'started' | 'disabled' | 'already';
  stopNotificationDispatch(): void;
  close(): Promise<void>;
}

const HERE_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE_DIR, '..');
const RUNNING_FROM_DIST = path.basename(HERE_DIR) === 'dist';

let cachedModulesPromise: Promise<FrontClawModules> | undefined;

async function importFrontClawSubpath<T>(subpath: string): Promise<T> {
  const srcRel = `../packages/front-claw/src/${subpath}`;
  const distAbs = path.join(REPO_ROOT, 'packages', 'front-claw', 'dist', subpath);
  const srcAbs = path.join(REPO_ROOT, 'packages', 'front-claw', 'src', subpath);

  const candidates = RUNNING_FROM_DIST
    ? [
        ...(existsSync(distAbs) ? [pathToFileURL(distAbs).href] : []),
        srcRel,
      ]
    : [
        srcRel,
        ...(existsSync(distAbs) ? [pathToFileURL(distAbs).href] : []),
        pathToFileURL(srcAbs).href,
      ];

  let lastError: unknown;
  for (const specifier of candidates) {
    try {
      return (await import(specifier)) as T;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`Failed to load front-claw module: ${subpath}`);
}

async function loadFrontClawModules(): Promise<FrontClawModules> {
  if (!cachedModulesPromise) {
    cachedModulesPromise = (async () => {
      const [
        boot,
        entry,
        loop,
        unified,
        pendingOrder,
        bindings,
        mem0,
        accessPolicy,
        lease,
        fencing,
        notification,
      ] = await Promise.all([
        importFrontClawSubpath<FrontClawBootModule>('role-eval/front-claw-boot.js'),
        importFrontClawSubpath<FrontClawEntryModule>('role-eval/employee-entry.js'),
        importFrontClawSubpath<FrontClawLoopModule>('role-eval/employee-loop.js'),
        importFrontClawSubpath<FrontClawUnifiedModule>(
          'role-eval/wecom-bot-unified-handler.js',
        ),
        importFrontClawSubpath<FrontClawPendingOrderModule>(
          'role-eval/pending-order.js',
        ),
        importFrontClawSubpath<FrontClawBindingsModule>(
          'role-eval/wecom-bot-bindings.js',
        ),
        importFrontClawSubpath<FrontClawMem0Module>('opendot/mem0-off.js'),
        importFrontClawSubpath<FrontClawAccessPolicyModule>(
          'role-eval/access-policy.js',
        ),
        importFrontClawSubpath<FrontClawLeaseModule>('opendot/consumer-lease.js'),
        importFrontClawSubpath<FrontClawFencingModule>('role-eval/fencing.js'),
        importFrontClawSubpath<FrontClawNotificationModule>(
          'role-eval/notification-dispatch.js',
        ),
      ]);
      return {
        boot,
        entry,
        loop,
        unified,
        pendingOrder,
        bindings,
        mem0,
        accessPolicy,
        lease,
        fencing,
        notification,
      };
    })();
  }
  return cachedModulesPromise;
}

const sha = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

const nonEmpty = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

function normalizeToolName(name: string): string {
  return name.trim().toLowerCase().replace(/[\s-]+/g, '_');
}

function isDangerousTool(name: string): boolean {
  const normalized = normalizeToolName(name);
  if (DANGEROUS_TOOL_NAMES.has(normalized)) return true;
  if (normalized.startsWith('bash(') || normalized.startsWith('shell(')) {
    return true;
  }
  if (
    normalized.includes('write_file') ||
    normalized.includes('edit_file') ||
    normalized.includes('run_command')
  ) {
    return true;
  }
  return false;
}

/**
 * 放行进 OpenDot 同进程 Agent 前的安全护栏：
 * 确认目标岗位 Profile 状态激活、非宿主机执行模式、未启用 host_claude / 宿主机 Skills、
 * 未放开任意 Shell / 文件写工具，且未向 Agent 上下文注入 PG 账本凭据或连接串。
 */
export function validateTargetAgentProfile(
  profile: TargetAgentProfileSnapshot,
): AgentProfileGuardrailResult {
  if (!profile || typeof profile !== 'object') {
    return { ok: false, reason: 'missing_profile' };
  }
  if (profile.status !== undefined && profile.status !== 'active') {
    return { ok: false, reason: 'profile_inactive' };
  }
  if (profile.executionMode === 'host') {
    return { ok: false, reason: 'host_execution_forbidden' };
  }

  const contextSource =
    profile.contextSource ?? profile.runtimePolicy?.context?.source;
  if (contextSource === 'host_claude') {
    return { ok: false, reason: 'host_claude_context_forbidden' };
  }

  const hostSkillsMode =
    profile.hostSkillsMode ?? profile.runtimePolicy?.skills?.host?.mode;
  if (hostSkillsMode === 'inherit' || hostSkillsMode === 'custom') {
    return { ok: false, reason: 'host_skills_forbidden' };
  }

  if (profile.injectedEnvKeys) {
    for (const key of profile.injectedEnvKeys) {
      if (FORBIDDEN_SECRET_ENV_KEYS.has(key.trim().toUpperCase())) {
        return { ok: false, reason: `forbidden_env_leak:${key}` };
      }
    }
  }

  if (profile.dangerousToolsDisabled === false) {
    return { ok: false, reason: 'dangerous_tools_enabled' };
  }

  const disallowedRaw = [
    ...(profile.disallowedTools ?? []),
    ...(profile.excludedTools ?? []),
  ];
  const disallowedSet = new Set(disallowedRaw.map(normalizeToolName));

  if (Array.isArray(profile.allowedTools)) {
    for (const tool of profile.allowedTools) {
      const normalized = normalizeToolName(tool);
      if (normalized === '*' || normalized === 'all') {
        return { ok: false, reason: 'wildcard_tools_forbidden' };
      }
      if (isDangerousTool(tool) && !disallowedSet.has(normalized)) {
        return { ok: false, reason: `dangerous_tool_allowed:${tool}` };
      }
    }
    return { ok: true };
  }

  if (profile.dangerousToolsDisabled === true) {
    return { ok: true };
  }

  if (disallowedRaw.length > 0) {
    const missing = REQUIRED_DISALLOWED_CORE_TOOLS.filter(
      (req) => !disallowedSet.has(req),
    );
    if (missing.length === 0) return { ok: true };
    return {
      ok: false,
      reason: `missing_disallowed_tools:${missing.join(',')}`,
    };
  }

  return { ok: false, reason: 'tool_policy_not_restricted' };
}

function readOpenDotClaudeConfig(providerIdOverride?: string): {
  providerId: string | null;
  config: ClaudeProviderConfig;
} {
  try {
    const selectedId =
      providerIdOverride?.trim() ||
      getDefaultProviderId() ||
      getEnabledProviders()[0]?.id ||
      null;
    if (selectedId) {
      const resolved = resolveProviderById(selectedId, {
        requireEnabled: true,
      });
      return { providerId: selectedId, config: resolved.config };
    }
  } catch {
    // 禁用或读取失败时回退安全空配置或 env
  }
  try {
    return { providerId: null, config: getClaudeProviderConfig() };
  } catch {
    return {
      providerId: null,
      config: {
        anthropicBaseUrl: '',
        anthropicAuthToken: '',
        anthropicApiKey: '',
        claudeCodeOauthToken: '',
        claudeOAuthCredentials: null,
        anthropicModel: '',
        updatedAt: null,
      },
    };
  }
}

/**
 * 读取 OpenDot src/runtime-config.ts 中当前生效的模型配置，并结合 FC_MODEL_* 环境变量决定桩或真模型模式。
 * 遵循 front-claw R7：默认永远为 stub，不会在默认/单测路径偷偷外发网络请求。
 */
export function resolveOpenDotClassifierConfig(
  options: {
    env?: Record<string, string | undefined>;
    providerId?: string;
    modelConfig?: WeComFrontClawBridgeOptions['modelConfig'];
    timeoutMs?: number;
  } = {},
): OpenDotClassifierRuntimeConfig {
  const env = options.env ?? process.env;
  const objConfig =
    options.modelConfig && typeof options.modelConfig === 'object'
      ? options.modelConfig
      : undefined;
  const modeEnv = env.FC_MODEL_MODE?.trim();
  const mode: 'stub' | 'live' =
    modeEnv === 'live' || modeEnv === 'stub'
      ? modeEnv
      : objConfig?.mode === 'live' || objConfig?.mode === 'stub'
        ? objConfig.mode
        : 'stub';

  const rawTimeout =
    env.FC_MODEL_TIMEOUT_MS !== undefined && env.FC_MODEL_TIMEOUT_MS !== ''
      ? Number(env.FC_MODEL_TIMEOUT_MS)
      : (options.timeoutMs ?? objConfig?.timeoutMs ?? DEFAULT_MODEL_TIMEOUT_MS);
  const timeoutMs = Math.max(
    50,
    Math.min(
      Number.isFinite(rawTimeout) ? rawTimeout : DEFAULT_MODEL_TIMEOUT_MS,
      60_000,
    ),
  );

  const { providerId, config } = readOpenDotClaudeConfig(options.providerId);
  const baseUrl =
    env.FC_MODEL_ENDPOINT?.trim() ||
    objConfig?.endpoint?.trim() ||
    config.anthropicBaseUrl.trim() ||
    env.ANTHROPIC_BASE_URL?.trim() ||
    'https://api.anthropic.com';
  const model =
    objConfig?.model?.trim() ||
    config.anthropicModel.trim() ||
    env.ANTHROPIC_MODEL?.trim() ||
    '';
  const apiKey =
    (config.anthropicApiKey || env.ANTHROPIC_API_KEY || '').trim() || undefined;
  const authToken =
    (
      config.anthropicAuthToken ||
      config.claudeOAuthCredentials?.accessToken ||
      config.claudeCodeOauthToken ||
      env.ANTHROPIC_AUTH_TOKEN ||
      ''
    ).trim() || undefined;

  return {
    mode,
    providerId,
    baseUrl,
    model,
    ...(apiKey ? { apiKey } : {}),
    ...(authToken ? { authToken } : {}),
    timeoutMs,
  };
}

function buildAnthropicMessagesUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  if (trimmed.endsWith('/v1/messages')) return trimmed;
  if (trimmed.endsWith('/v1')) return `${trimmed}/messages`;
  return `${trimmed}/v1/messages`;
}

function parseStrictJsonObject(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return undefined;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed
      : undefined;
  } catch {
    return undefined;
  }
}

function uncertainModelOutput() {
  return {
    intent: 'unknown' as const,
    object: null,
    action: null,
    slots: {},
    confidence: 0,
    uncertain: true,
  };
}

/**
 * 基于 OpenDot 运行时配置构造 R7 分类器。
 * 任何非 JSON、超时或网络异常均交由 runModelClassifier / validateModelChain 兜底成 uncertain（追问澄清），绝不放行。
 */
export function createModelClassifierFromOpenDotConfig(
  runtime: OpenDotClassifierRuntimeConfig,
  customComplete?: WeComFrontClawBridgeOptions['openDotModelComplete'],
): ModelClassifier | undefined {
  if (runtime.mode !== 'live') return undefined;

  if (customComplete) {
    return async ({ text, signal }) => {
      const raw = await customComplete({
        system: MODEL_CLASSIFIER_SYSTEM_PROMPT,
        user: text.slice(0, 2000),
        signal,
        config: runtime,
      });
      return parseStrictJsonObject(raw) ?? uncertainModelOutput();
    };
  }

  const credential = runtime.authToken ?? runtime.apiKey;
  if (!credential || !runtime.model || !runtime.baseUrl) {
    return async () => uncertainModelOutput();
  }

  const url = buildAnthropicMessagesUrl(runtime.baseUrl);
  return async ({ text, signal }) => {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json',
      'anthropic-version': '2023-06-01',
    };
    if (runtime.apiKey) headers['x-api-key'] = runtime.apiKey;
    if (runtime.authToken) headers.authorization = `Bearer ${runtime.authToken}`;

    const res = await fetch(url, {
      method: 'POST',
      headers,
      signal,
      body: JSON.stringify({
        model: runtime.model,
        max_tokens: 256,
        temperature: 0,
        system: MODEL_CLASSIFIER_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: text.slice(0, 2000) }],
      }),
    });
    if (!res.ok) throw new Error(`opendot_model_http_${res.status}`);
    const payload = (await res.json()) as {
      content?: Array<{ type?: string; text?: string }>;
    };
    const combined = Array.isArray(payload.content)
      ? payload.content
          .filter((item) => item?.type === 'text' && typeof item.text === 'string')
          .map((item) => item.text as string)
          .join('')
      : '';
    return parseStrictJsonObject(combined) ?? uncertainModelOutput();
  };
}

function isM03OrPermissionDenial(
  result: RoutedResult,
  mods: FrontClawModules,
): boolean {
  if (result.target === 'marketing-unavailable') return true;
  const combined = result.replies.join('\n');
  if (!combined) return false;
  return (
    combined.includes(mods.loop.ACCESS_DENIED) ||
    combined.includes(mods.loop.DENIED) ||
    combined.includes(mods.entry.MARKETING_UNAVAILABLE) ||
    combined.includes(mods.loop.STALE_CONSUMER) ||
    combined.startsWith('Front Claw：不能做——')
  );
}

async function resolveDbWorkspaceProfileSnapshot(
  workspaceJid: string,
): Promise<TargetAgentProfileSnapshot | undefined> {
  try {
    const dbMod = await import('./db.js');
    const group = dbMod.getRegisteredGroup(workspaceJid);
    if (!group) return undefined;
    const profile = dbMod.peekAgentProfileForWorkspace(
      group.folder,
      group.created_by ?? null,
    );
    return {
      workspaceJid,
      executionMode: group.executionMode ?? 'container',
      ...(profile
        ? {
            profileId: profile.id,
            status: profile.status,
            contextSource: profile.runtime_policy.context.source,
            hostSkillsMode: profile.runtime_policy.skills.host?.mode ?? 'disabled',
            runtimePolicy: {
              context: profile.runtime_policy.context,
              skills: profile.runtime_policy.skills,
            },
          }
        : {}),
    };
  } catch {
    return undefined;
  }
}

/**
 * 创建企微 ⇄ Front Claw ⇄ OpenDot 原生三态前置桥接器（对应 Issue #3）。
 */
export async function createWeComFrontClawBridge(
  options: WeComFrontClawBridgeOptions = {},
): Promise<WeComFrontClawBridge> {
  const mods = await loadFrontClawModules();
  const env = options.env ?? process.env;
  const now = options.now ?? (() => new Date());

  mods.mem0.assertMem0Off(env);
  const rawCaps =
    options.platformCapabilitiesRaw ?? env.FRONT_CLAW_OPENDOT_CAPABILITIES;
  const platformCapabilities = (() => {
    if (rawCaps === undefined) return undefined;
    const names = rawCaps
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean);
    const known = new Set<string>(mods.accessPolicy.CAPABILITIES);
    if (names.some((name) => !known.has(name))) {
      throw new Error('invalid_platform_capabilities');
    }
    return Object.freeze([...new Set(names)]);
  })();

  const budgetMs =
    typeof options.budgetMs === 'number' &&
    Number.isFinite(options.budgetMs) &&
    options.budgetMs > 0
      ? options.budgetMs
      : DEFAULT_BUDGET_MS;

  const openDotRuntime =
    options.useOpenDotModelConfig !== false
      ? resolveOpenDotClassifierConfig({
          env,
          ...(options.openDotProviderId !== undefined
            ? { providerId: options.openDotProviderId }
            : {}),
          ...(options.modelConfig !== undefined
            ? { modelConfig: options.modelConfig }
            : {}),
          ...(options.modelClassifyTimeoutMs !== undefined
            ? { timeoutMs: options.modelClassifyTimeoutMs }
            : {}),
        })
      : undefined;

  const requestedModelTimeoutMs =
    options.modelClassifyTimeoutMs ??
    openDotRuntime?.timeoutMs ??
    DEFAULT_MODEL_TIMEOUT_MS;
  // 保证模型分类超时永远早于外层请求截止时间，超时一定收口到 clarify（handled）而不是 budget timeout（failed）。
  const effectiveModelTimeoutMs =
    budgetMs >= 200
      ? Math.min(requestedModelTimeoutMs, Math.max(50, Math.floor(budgetMs * 0.6)))
      : requestedModelTimeoutMs;

  const resolvedModelClassifier =
    options.modelClassify ??
    (openDotRuntime
      ? createModelClassifierFromOpenDotConfig(
          openDotRuntime,
          options.openDotModelComplete,
        )
      : undefined);

  let sendHandler = options.sendNotification;
  let bootRef: FrontClawBootInstance | undefined;
  let lease: ReturnType<FrontClawLeaseModule['createConsumerLease']> | undefined;
  let leaseTimer: ReturnType<typeof setInterval> | undefined;
  let closing = false;
  let closed = false;

  const isLeaseHeld = (): boolean => (lease ? lease.held() === true : true);

  const boot = await mods.boot.bootFrontClaw({
    env,
    now,
    employeeLoop: true,
    accessPolicy: true,
    ...(options.root !== undefined ? { root: options.root } : {}),
    ...(options.maintenanceIntervalMs !== undefined
      ? { maintenanceIntervalMs: options.maintenanceIntervalMs }
      : {}),
    ...(platformCapabilities ? { platformCapabilities } : {}),
    ...(options.open ? { open: options.open as () => Promise<never> } : {}),
    ...(options.onEmployeeTrace ? { onEmployeeTrace: options.onEmployeeTrace } : {}),
    model: {
      complete: async () => ({ type: 'chat', text: 'Front Claw 在。' }),
    },
    send: async ({ toPersonId, text }: { toPersonId: string; text: string }) => {
      if (closing || !isLeaseHeld() || !sendHandler || !bootRef) {
        return 'not_sent';
      }
      const person = bootRef.store.getPerson
        ? await bootRef.store.getPerson(toPersonId)
        : null;
      if (!person) return 'not_sent';
      try {
        return await sendHandler({
          toPersonId,
          memberId: person.memberId,
          text,
        });
      } catch {
        return 'unknown';
      }
    },
    router: {
      passthroughMarketing: true,
      budgetMs,
      modelClassifyTimeoutMs: effectiveModelTimeoutMs,
      ...(resolvedModelClassifier ? { modelClassify: resolvedModelClassifier } : {}),
      ...(options.modelConfig !== undefined && !resolvedModelClassifier
        ? { modelConfig: options.modelConfig }
        : {}),
      ...(options.semantic !== undefined ? { semantic: options.semantic } : {}),
      ...(options.onObservation ? { onObservation: options.onObservation } : {}),
      ...(options.onRoute ? { onRoute: options.onRoute } : {}),
    },
  });
  bootRef = boot;

  const leaseEnabled = options.lease?.enabled ?? boot.driver === 'postgres';
  if (leaseEnabled) {
    const ttlMs = options.lease?.ttlMs ?? DEFAULT_LEASE_MS;
    const renewMs = options.lease?.renewMs ?? DEFAULT_RENEW_MS;
    if (!(ttlMs > renewMs * 1.2) || renewMs < 1) {
      await boot.close().catch(() => {});
      throw new Error('invalid_bridge_lease_timing');
    }
    const owner =
      options.lease?.owner ??
      `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
    lease = mods.lease.createConsumerLease({
      store: boot.store,
      owner,
      ttlMs,
      now,
      key: options.lease?.key ?? mods.lease.CONSUMER_LEASE_KEY,
    });
    const acquired = await lease.acquire();
    if (!acquired) {
      logger.warn({ owner }, 'Front Claw bridge started without active lease');
    }
    leaseTimer = setInterval(() => {
      if (closing || !lease) return;
      void lease
        .acquire()
        .then((ok) => {
          if (!ok) boot.stopNotificationDispatch();
        })
        .catch(() => {
          boot.stopNotificationDispatch();
        });
    }, renewMs);
    leaseTimer.unref?.();
  }

  async function fenceStillHolds(
    fence: { key: string; owner: string; epoch: number } | undefined,
  ): Promise<boolean> {
    if (!lease) return true;
    if (!fence || !lease.held() || lease.fence()?.epoch !== fence.epoch) {
      return false;
    }
    const raw = (await boot.store.getConfig?.(fence.key).catch(() => null)) ?? null;
    const record = mods.fencing.parseLeaseRecord(raw);
    return mods.fencing.fenceHolds(record, fence, now().getTime());
  }

  type BindingDenial =
    | 'no_binding'
    | 'ambiguous'
    | 'missing_domain'
    | 'inactive'
    | 'mismatch'
    | 'invalid_directory'
    | 'incomplete_profile';

  interface VerifiedIdentity {
    readonly binding: Readonly<BridgeWecomBotBinding>;
    readonly person: Readonly<BridgePerson>;
  }

  async function bindingFor(
    event: Readonly<WeComInboundTextEvent>,
  ): Promise<{ identity: VerifiedIdentity } | { reason: BindingDenial }> {
    if (!nonEmpty(event.botId) || !nonEmpty(event.memberId)) {
      return { reason: 'no_binding' };
    }
    let rows: BridgeWecomBotBinding[];
    try {
      rows = structuredClone(await boot.bindings.listBindings());
    } catch {
      return { reason: 'invalid_directory' };
    }
    if (!Array.isArray(rows) || rows.some((row) => !row || typeof row !== 'object')) {
      return { reason: 'invalid_directory' };
    }

    const memberRows = rows.filter(
      (row) => row.botId === event.botId && row.memberId === event.memberId,
    );
    if (memberRows.length === 0) return { reason: 'no_binding' };

    let snapshots: Readonly<BridgeWecomBotBinding>[];
    try {
      snapshots = memberRows.map((row) =>
        Object.freeze(mods.bindings.snapshotBinding(row)),
      );
    } catch {
      return { reason: 'invalid_directory' };
    }

    let binding: Readonly<BridgeWecomBotBinding>;
    if (event.corpId !== undefined) {
      if (!nonEmpty(event.corpId)) return { reason: 'mismatch' };
      const corpMatches = snapshots.filter((row) => row.corpId === event.corpId);
      if (corpMatches.length === 0) return { reason: 'mismatch' };
      if (corpMatches.length !== 1) return { reason: 'ambiguous' };
      binding = corpMatches[0]!;
      if (!binding.active) return { reason: 'inactive' };
    } else {
      const activeBindings = snapshots.filter((row) => row.active);
      if (activeBindings.length === 0) return { reason: 'inactive' };
      // 缺失 corpId 时，必须存在唯一一条启用中的可信绑定，否则拒绝放行。
      if (activeBindings.length !== 1) return { reason: 'ambiguous' };
      binding = activeBindings[0]!;
    }

    if (!nonEmpty(binding.corpId)) return { reason: 'missing_domain' };

    let person: BridgePerson | null;
    let people: BridgePerson[];
    try {
      person = structuredClone(await boot.store.getPersonByMember(event.memberId));
      people = structuredClone(await boot.store.listPeople());
    } catch {
      return { reason: 'invalid_directory' };
    }

    if (!person) return { reason: 'mismatch' };
    if (!person.active) return { reason: 'inactive' };
    if (
      person.memberId !== binding.memberId ||
      person.accountId !== binding.accountId
    ) {
      return { reason: 'mismatch' };
    }
    if ('corpId' in person && person.corpId !== binding.corpId) {
      return { reason: 'mismatch' };
    }

    // 防 PR-03：姓名/门店档案不完整一律拦在入口外，严禁漏进 OpenDot Agent。
    if (
      !nonEmpty(person.personId) ||
      !nonEmpty(person.accountId) ||
      !nonEmpty(person.storeId) ||
      !nonEmpty(person.displayName) ||
      !nonEmpty(person.storeName)
    ) {
      return { reason: 'incomplete_profile' };
    }

    if (
      people.filter((p) => p.memberId === binding.memberId).length !== 1 ||
      people.filter((p) => p.accountId === binding.accountId).length !== 1
    ) {
      return { reason: 'ambiguous' };
    }

    const current = people.find((p) => p.personId === person!.personId);
    if (
      !current?.active ||
      current.memberId !== binding.memberId ||
      current.accountId !== binding.accountId ||
      !nonEmpty(current.displayName) ||
      !nonEmpty(current.storeId) ||
      !nonEmpty(current.storeName) ||
      ('corpId' in current && current.corpId !== binding.corpId)
    ) {
      return { reason: 'mismatch' };
    }

    return {
      identity: {
        binding,
        person: Object.freeze(person),
      },
    };
  }

  const employeeQueues = new Map<string, Promise<void>>();

  async function processInbound(
    event: Readonly<WeComInboundTextEvent>,
    pendingArrival: Promise<{ sequence: string }>,
  ): Promise<WeComPrecheckOutcome> {
    if (closing || closed || !isLeaseHeld()) {
      return {
        kind: 'failed',
        replies: [mods.loop.STALE_CONSUMER || BRIDGE_STALE_CONSUMER_REPLY],
      };
    }

    const activeFence = lease?.fence() ?? undefined;
    if (activeFence && !(await fenceStillHolds(activeFence))) {
      return {
        kind: 'failed',
        replies: [mods.loop.STALE_CONSUMER || BRIDGE_STALE_CONSUMER_REPLY],
      };
    }

    const resolved = await bindingFor(event);
    if (!('identity' in resolved)) {
      return {
        kind: 'failed',
        replies: [
          resolved.reason === 'incomplete_profile'
            ? BRIDGE_INCOMPLETE_PROFILE_REPLY
            : mods.unified.UNBOUND || BRIDGE_UNBOUND_REPLY,
        ],
      };
    }

    const { binding, person } = resolved.identity;
    const validateBinding = async (): Promise<boolean> => {
      if (closing || closed || !isLeaseHeld()) return false;
      const latest = await bindingFor(event);
      return (
        'identity' in latest &&
        latest.identity.person.personId === person.personId &&
        mods.bindings.sameBinding(binding, latest.identity.binding)
      );
    };

    const arrivedAt =
      event.createTime !== undefined && Number.isFinite(event.createTime)
        ? new Date(event.createTime * 1000).toISOString()
        : undefined;
    const controller = new AbortController();
    const deadline = performance.now() + budgetMs;

    const result = await boot.handler.handleMessage({
      memberId: event.memberId,
      text: event.text,
      messageId: event.messageId,
      ...(arrivedAt ? { arrivedAt } : {}),
      pendingArrival,
      sessionId: sha([
        'opendot',
        binding.corpId,
        event.botId,
        event.memberId,
        binding.accountId,
      ]),
      binding: Object.freeze(structuredClone(binding)),
      validateBinding,
      channelActive: () => !closing && !closed && isLeaseHeld(),
      bindingVersion: binding.version,
      signal: controller.signal,
      deadline,
      ...(activeFence ? { fence: { ...activeFence } } : {}),
    });

    if (activeFence && !(await fenceStillHolds(activeFence))) {
      return {
        kind: 'failed',
        replies: [mods.loop.STALE_CONSUMER || BRIDGE_STALE_CONSUMER_REPLY],
      };
    }

    if (result.state && result.state !== 'completed') {
      return {
        kind: 'failed',
        replies:
          result.replies.length > 0
            ? result.replies
            : [BRIDGE_EXECUTION_FAILED_REPLY],
      };
    }

    if (isM03OrPermissionDenial(result, mods)) {
      return {
        kind: 'failed',
        replies:
          result.replies.length > 0
            ? result.replies
            : [mods.loop.ACCESS_DENIED],
      };
    }

    if (result.pass === true) {
      if (!(await validateBinding())) {
        return {
          kind: 'failed',
          replies: [mods.unified.UNBOUND || BRIDGE_UNBOUND_REPLY],
        };
      }
      const actor = result.actor ?? person;
      if (!nonEmpty(actor.displayName) || !nonEmpty(actor.storeName) || !nonEmpty(actor.storeId)) {
        return {
          kind: 'failed',
          replies: [BRIDGE_INCOMPLETE_PROFILE_REPLY],
        };
      }

      const workspaceJid = await options.resolveWorkspaceJid?.({
        corpId: binding.corpId,
        accountId: actor.accountId,
        memberId: event.memberId,
        storeId: actor.storeId,
        displayName: actor.displayName,
      });

      const profileCtx: TargetProfileLookupContext = {
        corpId: binding.corpId,
        accountId: actor.accountId,
        memberId: event.memberId,
        storeId: actor.storeId,
        displayName: actor.displayName,
        tier: actor.tier,
        ...(workspaceJid ? { workspaceJid } : {}),
      };

      let targetSnapshot: TargetAgentProfileSnapshot | null | undefined =
        options.resolveTargetProfile
          ? await options.resolveTargetProfile(profileCtx)
          : options.targetProfile;

      if (
        !targetSnapshot &&
        !options.resolveTargetProfile &&
        options.checkOpenDotWorkspaceDb &&
        workspaceJid
      ) {
        targetSnapshot = await resolveDbWorkspaceProfileSnapshot(workspaceJid);
      }

      if (options.resolveTargetProfile && !targetSnapshot) {
        return {
          kind: 'failed',
          replies: [BRIDGE_AGENT_GUARDRAIL_DENIED_REPLY],
        };
      }

      if (targetSnapshot) {
        const guardrail = validateTargetAgentProfile(targetSnapshot);
        if (!guardrail.ok) {
          logger.warn(
            {
              reason: guardrail.reason,
              memberId: event.memberId,
              storeId: actor.storeId,
              workspaceJid,
            },
            'Front Claw bridge blocked unsafe target AgentProfile passthrough',
          );
          return {
            kind: 'failed',
            replies: [BRIDGE_AGENT_GUARDRAIL_DENIED_REPLY],
          };
        }
      }

      return {
        kind: 'pass',
        corpId: binding.corpId,
        accountId: actor.accountId,
        storeId: actor.storeId,
        displayName: actor.displayName,
        ...(workspaceJid ? { workspaceJid } : {}),
        ...(result.expiredReminder
          ? { expiredReminder: result.expiredReminder }
          : {}),
      };
    }

    return {
      kind: 'handled',
      replies:
        result.replies.length > 0
          ? result.replies
          : [mods.entry.CLARIFY_REPLY],
    };
  }

  function precheck(event: WeComInboundTextEvent): Promise<WeComPrecheckOutcome> {
    if (closing || closed) {
      return Promise.resolve({
        kind: 'failed',
        replies: [mods.loop.STALE_CONSUMER || BRIDGE_STALE_CONSUMER_REPLY],
      });
    }
    const frozenEvent = Object.freeze(structuredClone(event));
    // D183：收包瞬间同步锁定到达序号，严禁延后到员工串行队列或模型分类之后。
    const pendingArrival = mods.pendingOrder.capturePendingArrival(boot.store);
    void pendingArrival.catch(() => {});

    const queueKey = sha([frozenEvent.botId ?? '', frozenEvent.memberId ?? '']);
    const previous = employeeQueues.get(queueKey) ?? Promise.resolve();

    let resolveOutcome!: (outcome: WeComPrecheckOutcome) => void;
    const outcomePromise = new Promise<WeComPrecheckOutcome>((resolve) => {
      resolveOutcome = resolve;
    });

    const run = previous
      .catch(() => {})
      .then(async () => {
        try {
          const outcome = await processInbound(frozenEvent, pendingArrival);
          resolveOutcome(outcome);
        } catch (err) {
          logger.warn({ err }, 'Front Claw bridge precheck failed unexpectedly');
          resolveOutcome({
            kind: 'failed',
            replies: [BRIDGE_EXECUTION_FAILED_REPLY],
          });
        }
      });

    employeeQueues.set(queueKey, run);
    void run.finally(() => {
      if (employeeQueues.get(queueKey) === run) {
        employeeQueues.delete(queueKey);
      }
    });

    return outcomePromise;
  }

  return {
    precheck,
    driver: boot.driver,
    isActive: () => !closing && !closed && isLeaseHeld(),
    leaseHeld: () => isLeaseHeld(),
    startMaintenance: () => boot.startMaintenance(),
    startNotificationDispatch(sender, dispatchOptions) {
      const dispatcherChannel = mods.notification.createBotNotificationSender(
        sender,
        { active: () => !closing && !closed && isLeaseHeld() },
      );
      return boot.startNotificationDispatch(dispatcherChannel, dispatchOptions);
    },
    stopNotificationDispatch: () => boot.stopNotificationDispatch(),
    async close() {
      closing = true;
      if (leaseTimer) {
        clearInterval(leaseTimer);
        leaseTimer = undefined;
      }
      boot.stopNotificationDispatch();
      await Promise.allSettled([...employeeQueues.values()]);
      await lease?.release().catch(() => {});
      await boot.close();
      closed = true;
    },
  };
}
