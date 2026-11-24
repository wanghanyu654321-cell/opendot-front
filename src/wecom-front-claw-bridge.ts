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

export type WeComSoftRole =
  | 'marketing'
  | 'training'
  | 'manager_ops'
  | 'reception_ads';

/**
 * Issue #2 / #3 共享企微前置拦截三态输出（与 docs/OPENDOT-FRONT-MASTER-PLAN.md 对齐）。
 * 放行态仅携带路由身份和脱敏文本，绝不暴露 Front Claw PG store 或数据库连接串。
 */
export type WeComPrecheckOutcome = import('./wecom.js').WeComPrecheckOutcome;

export type WeComPrecheckPort = (
  event: WeComInboundTextEvent,
) => Promise<WeComPrecheckOutcome>;

export interface WeComOutboundAuthRequest {
  readonly principal?: {
    readonly personId: string;
    readonly tier: BridgePerson['tier'];
    readonly bindingVersion: number;
  };
  readonly botId?: string;
  readonly accountId?: string;
  readonly corpId?: string;
  readonly memberId: string;
  readonly storeId?: string;
  readonly capability?: WeComSoftRole;
  readonly targetRole?: WeComSoftRole;
}

export type WeComOutboundAuthResult =
  | {
      readonly allowed: true;
      readonly policyVersion: number;
      readonly personId: string;
      readonly storeId: string;
    }
  | {
      readonly allowed: false;
      readonly reason: string;
    };

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
  savePerson?(person: BridgePerson): Promise<void>;
  listEntries?(filter: { storeId: string }): Promise<
    {
      storeId: string;
      businessDay: string;
      status: string;
      amount: number;
    }[]
  >;
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
  /** PostgreSQL adapters can opt into automatic grants using their own transaction. */
  withGrantTransaction?: (
    work: (transaction: BridgeGrantTransaction) => Promise<void>,
  ) => Promise<void>;
  close(): Promise<void>;
}

export interface BridgeGrantTransaction {
  /** Both stores use the same transaction and roll back if work throws. */
  readonly store: BridgeStoreLike;
  readonly bindings: BridgeBindingStoreLike;
  /** Called after locking the policy and lease, in the same transaction. */
  lockIdentity(personId: string, binding: Readonly<BridgeWecomBotBinding>): Promise<void>;
}

export interface OpenDotClassifierRuntimeConfig {
  mode: 'stub' | 'live';
  providerId: string | null;
  baseUrl: string;
  model: string;
  maxTokens: number;
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

export interface WeComWorkspaceLookupContext {
  readonly corpId: string;
  readonly accountId: string;
  readonly memberId: string;
  readonly storeId: string;
  readonly displayName: string;
  readonly targetRole?: WeComSoftRole;
}

export interface TargetProfileLookupContext extends WeComWorkspaceLookupContext {
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
    ctx: WeComWorkspaceLookupContext,
  ) => Promise<string | undefined> | string | undefined;
  readonly resolveTrainingContext?: (params: {
    readonly query: string;
    readonly corpId: string;
    readonly accountId: string;
    readonly storeId: string;
    readonly workspaceJid?: string;
  }) => Promise<string | undefined> | string | undefined;
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
  authorizeOutbound(
    req: WeComOutboundAuthRequest,
  ): Promise<WeComOutboundAuthResult>;
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
const DEFAULT_CLASSIFIER_MAX_TOKENS = 1024;
const MIN_CLASSIFIER_MAX_TOKENS = 256;
const MAX_CLASSIFIER_MAX_TOKENS = 4096;
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

const MANAGER_REVIEW_DENIED_REPLY =
  'Front Claw：店长经营复盘仅对本店店长或老板开放，你当前没有这项权限。没有读取或写入任何账目。';

export const SAFE_MARKETING_DISALLOWED_TOOLS = [
  'Bash',
  'Write',
  'Edit',
  'NotebookEdit',
  'Task',
  'TaskOutput',
  'TaskStop',
  'WebFetch',
  'WebSearch',
  'mcp__miniclaw__*',
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
  '顶层仅允许这 6 个键：intent, object, action, slots, confidence, uncertain。',
  'intent 仅可为：report | query | amend | withdraw | appointment | target | chitchat | marketing | unknown。',
  'object 仅可为：null | performance | target | completion | entry | appointment | progress | ranking | summary。',
  'action 仅可为：null | query | report | amend | cancel | delete。',
  'slots 仅允许这 6 个键：amountText, customer, employee, index, period, store（禁止输出 customerName、projectName、amount、cents 等未定义键）。',
  '映射规则：',
  '- 员工报业绩：intent="report", object="performance", action="report"，客户称呼放入 slots.customer（须为原文子串），金额原文放入 slots.amountText（绝不猜数字或换算）。',
  '- 查本人业绩/进度：intent="query", object="progress", action="query"；查全店汇总：object="summary", action="query"；查排名：object="ranking", action="query"。',
  '- 改账：intent="amend", object="entry", action="amend"；撤回/作废：intent="withdraw", object="entry", action="cancel"。',
  '- 预约：intent="appointment", object="appointment", action="report"|"query"|"cancel"；目标：intent="target", object="target", action="report"|"query"|"amend"。',
  '- 客套闲聊：intent="chitchat", object=null, action=null, slots={}。',
  '- 营销文案、教学培训/家访带教、客服接待/异议话术、投流团购诊断、店长经营复盘建议等非账本咨询：intent="marketing", object=null, action=null, slots={}。纯查账、报数、改账、预约、设目标仍按上面的店务规则分类。',
  'confidence 为 0..1 数值，uncertain 为布尔值；若拿不准或含糊请设为 {"intent":"unknown","object":null,"action":null,"slots":{},"confidence":0,"uncertain":true}。',
].join('\n');

export function classifyWeComSoftRole(text: string): WeComSoftRole {
  if (
    /培训|带教|家访|五步法|企业诊断|指导员|考核|试卷|演练|新人怎么|课程|作战地图|鱼骨图|热力图|客户盘点|信念|U字形/i.test(
      text,
    )
  ) {
    return 'training';
  }
  if (
    /复盘|经营诊断|经营分析|门店诊断|日报建议|周报建议|旬总结建议|怎么提升业绩|业绩怎么抓|目标怎么拆|挂零怎么管/.test(
      text,
    )
  ) {
    return 'manager_ops';
  }
  if (
    /接待话术|怎么接待|客诉|嫌贵|异议|怎么回复客户|退卡安抚|质检|投流|美团|大众点评|团购诊断|\bROI\b|点击率|线索转化/i.test(
      text,
    )
  ) {
    return 'reception_ads';
  }
  return 'marketing';
}

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
  capturePendingArrival: (store: BridgeStoreLike) => Promise<{
    readonly sequence: string;
    readonly hours: string | null;
  }>;
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

interface AccessPolicySnapshot {
  version: number;
  enterprise: string[];
  stores: Record<string, string[]>;
  roles: Record<BridgePerson['tier'], string[]>;
  members: Record<
    string,
    {
      role: BridgePerson['tier'];
      status: 'active' | 'suspended' | 'revoked';
      storeIds: string[];
      capabilities?: string[];
    }
  >;
}

type RawPolicy = { policy: string | null; highWater: string | null };
type AccessDecision =
  | { allowed: true; version: number; role: BridgePerson['tier'] }
  | { allowed: false; reason: string; version?: number };

interface FrontClawAccessPolicyModule {
  standing: (raw: RawPolicy, person: BridgePerson) => AccessDecision;
  ACCESS_POLICY_KEY: string;
  ACCESS_POLICY_HIGH_WATER_KEY: string;
  CAPABILITIES: readonly string[];
  readPolicy: (store: {
    getConfig: (key: string) => Promise<string | null>;
  }) => Promise<RawPolicy>;
  parseAccessPolicy: (
    raw: string | null,
  ) => AccessPolicySnapshot | null | 'missing';
  updateAccessPolicy: (
    store: Required<
      Pick<BridgeStoreLike, 'insertConfigIfAbsent' | 'updateConfigLocked'>
    >,
    input: {
      expectedVersion: number;
      next: AccessPolicySnapshot;
      actor: string;
      reason: string;
      at: string;
    },
  ) => Promise<{ ok: boolean }>;
  decideAccess: (
    raw: RawPolicy,
    person: BridgePerson | null,
    capability: string,
    storeId: string,
    platform?: readonly string[],
  ) => AccessDecision;
}

const DEFAULT_TIER_CAPABILITIES: Record<
  BridgePerson['tier'],
  readonly string[]
> = {
  employee: [
    'marketing',
    'report_self',
    'progress_self',
    'correct_own',
    'appointment_submit',
  ],
  manager: [
    'marketing',
    'report_self',
    'report_proxy',
    'progress_self',
    'progress_other',
    'store_summary',
    'unreported',
    'target_set',
    'correct_own',
    'correct_store',
    'appointment_submit',
    'appointment_receive',
  ],
  owner: ['marketing'],
};

function withCapabilities(
  current: string[],
  defaults: readonly string[],
): string[] {
  const missing = defaults.filter(
    (capability) => !current.includes(capability),
  );
  return missing.length ? [...current, ...missing] : current;
}

type ConsumerFence = { key: string; owner: string; epoch: number };

interface GrantStores {
  store: BridgeStoreLike;
  bindings: BridgeBindingStoreLike;
}

interface GrantSqlClient {
  query<T>(sql: string, params?: readonly unknown[]): Promise<{ rows: T[] }>;
  transaction<T>(
    work: (query: GrantSqlClient['query']) => Promise<T>,
  ): Promise<T>;
}

interface GrantPgPool {
  connect(): Promise<{
    query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
    release(): void;
  }>;
  end(): Promise<void>;
}

async function openGrantPgPool(
  env: Record<string, string | undefined>,
): Promise<GrantPgPool> {
  const [credentials, db, pg] = await Promise.all([
    importFrontClawSubpath<{
      resolveBusinessDatabaseUrl: (env: Record<string, string | undefined>) => {
        url: string;
      };
    }>('role-eval/credential-file.js'),
    importFrontClawSubpath<{
      applyDatabaseHost: (url: string, host: string | undefined) => string;
    }>('role-eval/performance-open.js'),
    importFrontClawSubpath<{
      loadPgPool: () => Promise<
        new (config: { connectionString: string; max: number }) => GrantPgPool
      >;
    }>('role-eval/pg-pool.js'),
  ]);
  const Pool = await pg.loadPgPool();
  const { url } = credentials.resolveBusinessDatabaseUrl(env);
  return new Pool({
    connectionString: db.applyDatabaseHost(url, env.FRONT_CLAW_DATABASE_HOST),
    max: 1,
  });
}

async function grantTransaction(
  pool: GrantPgPool,
  apply: (transaction: BridgeGrantTransaction) => Promise<void>,
): Promise<void> {
  const [performance, directory, migration] = await Promise.all([
    importFrontClawSubpath<{
      createPostgresPerformanceStore: (
        client: GrantSqlClient,
      ) => BridgeStoreLike;
    }>('role-eval/performance-postgres.js'),
    importFrontClawSubpath<{
      createPostgresBindingStore: (
        client: GrantSqlClient,
      ) => BridgeBindingStoreLike;
    }>('role-eval/directory-store.js'),
    importFrontClawSubpath<{ PERFORMANCE_SCHEMA: string }>(
      'role-eval/performance-migration.js',
    ),
  ]);
  const connection = await pool.connect();
  const query: GrantSqlClient['query'] = async <Row>(
    sql: string,
    params?: readonly unknown[],
  ) => {
    const result = await connection.query(
      sql,
      params ? [...params] : undefined,
    );
    return { rows: result.rows as Row[] };
  };
  // The two stock stores share one transaction, including updateAccessPolicy's nested work.
  const client: GrantSqlClient = { query, transaction: (work) => work(query) };
  try {
    await query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    await query("SET LOCAL lock_timeout = '2s'");
    const schema = migration.PERFORMANCE_SCHEMA;
    await apply({
      store: performance.createPostgresPerformanceStore(client),
      bindings: directory.createPostgresBindingStore(client),
      async lockIdentity(personId, binding) {
        // Keep the kernel's lock order: config, personnel, then binding.
        await query(
          `SELECT person_id FROM ${schema}.performance_people WHERE person_id=$1 FOR UPDATE`,
          [personId],
        );
        await query(
          `SELECT bot_id FROM ${schema}.wecom_bot_bindings WHERE bot_id=$1 AND member_id=$2 FOR SHARE`,
          [binding.botId, binding.memberId],
        );
      },
    });
    await query('COMMIT');
  } catch (error) {
    await query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    connection.release();
  }
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
  metrics: {
    businessDate: (now: Date, cutoff: string, timeZone: string) => string;
  };
  money: { formatYuan: (cents: number) => string };
  storeHours: {
    resolveStoreHours: (
      raw: string | null,
      storeId: string,
    ) => { cutoff: string; timeZone: string } | null;
  };
}

interface RoutedResult {
  access?: {
    capability: string | null;
    storeIds: string[];
    identity?: { personId: string; policyVersion: number };
  };
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
        metrics,
        money,
        storeHours,
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
        importFrontClawSubpath<FrontClawModules['metrics']>(
          'role-eval/metrics.js',
        ),
        importFrontClawSubpath<FrontClawModules['money']>('role-eval/money.js'),
        importFrontClawSubpath<FrontClawModules['storeHours']>(
          'role-eval/store-hours.js',
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
        metrics,
        money,
        storeHours,
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

function parseClassifierMaxTokens(raw: string | number | undefined): number {
  if (typeof raw === 'number') {
    return Number.isInteger(raw) &&
      raw >= MIN_CLASSIFIER_MAX_TOKENS &&
      raw <= MAX_CLASSIFIER_MAX_TOKENS
      ? raw
      : DEFAULT_CLASSIFIER_MAX_TOKENS;
  }
  if (typeof raw !== 'string') return DEFAULT_CLASSIFIER_MAX_TOKENS;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return DEFAULT_CLASSIFIER_MAX_TOKENS;
  const parsed = Number(trimmed);
  return Number.isInteger(parsed) &&
    parsed >= MIN_CLASSIFIER_MAX_TOKENS &&
    parsed <= MAX_CLASSIFIER_MAX_TOKENS
    ? parsed
    : DEFAULT_CLASSIFIER_MAX_TOKENS;
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
    env.FC_MODEL_CLASSIFIER_MODEL?.trim() ||
    objConfig?.model?.trim() ||
    config.anthropicModel.trim() ||
    env.ANTHROPIC_MODEL?.trim() ||
    '';
  const maxTokens = parseClassifierMaxTokens(
    env.FC_MODEL_CLASSIFIER_MAX_TOKENS,
  );
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
    maxTokens,
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
  let trimmed = raw.trim();
  const fenceMatch = /^```(?:json)?\s*\n?([\s\S]*?)\n?\s*```$/i.exec(trimmed);
  if (fenceMatch) {
    trimmed = fenceMatch[1]!.trim();
  }
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
        // Thinking-enabled Anthropic-compatible models (e.g. deepseek-flash) consume thinking_tokens inside max_tokens.
        max_tokens: parseClassifierMaxTokens(runtime.maxTokens),
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

function canonicalDenial(
  result: RoutedResult,
  mods: FrontClawModules,
): string | undefined {
  if (result.target === 'marketing-unavailable')
    return mods.entry.MARKETING_UNAVAILABLE;
  if (result.replies.length !== 1) return undefined;
  return [
    mods.loop.ACCESS_DENIED,
    mods.loop.DENIED,
    mods.entry.MARKETING_UNAVAILABLE,
    mods.loop.STALE_CONSUMER,
  ].find((reply) => reply && reply === result.replies[0]);
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
  const env = { ...(options.env ?? process.env) };
  const open = options.open;
  const now = options.now ?? (() => new Date());
  const autoRoleGrant = env.FRONT_CLAW_WECOM_AUTO_ROLE_GRANT !== '0';

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
  let grantPool: Promise<GrantPgPool> | undefined;
  let withGrantTransaction: BridgeOpenedStore['withGrantTransaction'];
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
    ...(open ? {
      open: async () => {
        const opened = await open();
        withGrantTransaction = opened.withGrantTransaction?.bind(opened);
        return opened;
      },
    } : {}),
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
  if (!open && boot.driver === 'postgres') {
    withGrantTransaction = async (work) => {
      grantPool ??= openGrantPgPool(env);
      await grantTransaction(await grantPool, work);
    };
  }

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
    fence: ConsumerFence | undefined,
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

  const readPolicy = (): Promise<RawPolicy> =>
    mods.accessPolicy.readPolicy({
      getConfig: (key) => boot.store.getConfig!(key),
    });

  function decideManagerReview(
    raw: RawPolicy,
    person: BridgePerson,
    storeId: string,
  ): AccessDecision {
    if (storeId !== person.storeId)
      return { allowed: false, reason: 'store_out_of_scope' };
    if (person.tier !== 'manager' && person.tier !== 'owner') {
      return { allowed: false, reason: 'capability_denied' };
    }
    return mods.accessPolicy.decideAccess(
      raw,
      person,
      'store_summary',
      storeId,
      platformCapabilities,
    );
  }

  function canUseMarketing(raw: RawPolicy, person: BridgePerson): boolean {
    return (
      person.roles.includes('marketing') &&
      mods.accessPolicy.decideAccess(
        raw,
        person,
        'marketing',
        person.storeId,
        platformCapabilities,
      ).allowed
    );
  }

  function planDefaultGrant(
    raw: RawPolicy,
    person: BridgePerson,
  ): { next?: AccessPolicySnapshot; addRole: boolean } | undefined {
    const { accessPolicy } = mods;
    const { personId, storeId, tier } = person;
    const verdict = accessPolicy.decideAccess(
      raw,
      person,
      'marketing',
      storeId,
    );
    if (!verdict.allowed && verdict.reason !== 'capability_denied')
      return undefined;
    const policy = accessPolicy.parseAccessPolicy(raw.policy);
    if (
      !policy ||
      policy === 'missing' ||
      !Object.hasOwn(policy.members, personId)
    )
      return undefined;
    const grant = policy.members[personId]!;
    if (grant.status !== 'active' || grant.capabilities?.length === 0)
      return undefined;

    const defaults = DEFAULT_TIER_CAPABILITIES[tier];
    const storeCaps = Object.hasOwn(policy.stores, storeId)
      ? policy.stores[storeId]!
      : [];
    const enterprise = withCapabilities(policy.enterprise, defaults);
    const storeDefaults = withCapabilities(storeCaps, defaults);
    const tierDefaults = withCapabilities(policy.roles[tier], defaults);
    const memberCaps = grant.capabilities ?? [];
    let memberDefaults = withCapabilities(memberCaps, defaults);
    if (
      memberDefaults !== memberCaps &&
      tier !== 'owner' &&
      memberCaps.every((cap) => cap === 'marketing')
    ) {
      // Preserve regular permissions inherited through an omitted or opt-in-only list.
      memberDefaults = withCapabilities(
        memberDefaults,
        accessPolicy.CAPABILITIES.filter(
          (cap) => accessPolicy.decideAccess(raw, person, cap, storeId).allowed,
        ),
      );
    }
    const addRole = !person.roles.includes('marketing');
    if (
      enterprise === policy.enterprise &&
      storeDefaults === storeCaps &&
      tierDefaults === policy.roles[tier] &&
      memberDefaults === memberCaps
    ) {
      return addRole ? { addRole } : undefined;
    }
    return {
      addRole,
      next: {
        version: policy.version + 1,
        enterprise,
        stores: { ...policy.stores, [storeId]: storeDefaults },
        roles: { ...policy.roles, [tier]: tierDefaults },
        members: {
          ...policy.members,
          [personId]: { ...grant, capabilities: memberDefaults },
        },
      },
    };
  }

  const policyFromLocked = (
    locked: Record<string, string | null>,
  ): RawPolicy => ({
    policy: locked[mods.accessPolicy.ACCESS_POLICY_KEY] ?? null,
    highWater: locked[mods.accessPolicy.ACCESS_POLICY_HIGH_WATER_KEY] ?? null,
  });

  const samePolicy = (a: RawPolicy, b: RawPolicy): boolean =>
    a.policy === b.policy && a.highWater === b.highWater;

  function grantFenceHolds(
    locked: Record<string, string | null>,
    fence?: ConsumerFence,
  ): boolean {
    return (
      !closing &&
      !closed &&
      (!lease ||
        (!!fence &&
          isLeaseHeld() &&
          mods.fencing.fenceHolds(
            mods.fencing.parseLeaseRecord(locked[fence.key] ?? null),
            fence,
            now().getTime(),
          )))
    );
  }

  function updateDefaultPolicy(
    store: BridgeStoreLike,
    raw: RawPolicy,
    next: AccessPolicySnapshot,
    personId: string,
    fence?: ConsumerFence,
  ): Promise<{ ok: boolean }> {
    return mods.accessPolicy.updateAccessPolicy(
      {
        // A validated policy already has a high-water row. Never create it here.
        insertConfigIfAbsent: async () => false,
        updateConfigLocked: (key, extraKeys, mutate) =>
          store.updateConfigLocked!(
            key,
            fence ? [...extraKeys, fence.key] : extraKeys,
            (locked) =>
              samePolicy(raw, policyFromLocked(locked)) &&
              grantFenceHolds(locked, fence)
                ? mutate(locked)
                : null,
          ),
      },
      {
        expectedVersion: next.version - 1,
        next,
        actor: personId,
        reason: 'wecom-binding-auto-role-grant',
        at: now().toISOString(),
      },
    );
  }

  const saveMarketingRole = (store: BridgeStoreLike, person: BridgePerson) =>
    store.savePerson!({
      ...person,
      roles: [...new Set([...person.roles, 'marketing'])],
    });

  async function provisionDefaultGrant(
    identity: VerifiedIdentity,
    refreshPerson: (source?: GrantStores) => Promise<BridgePerson | undefined>,
    fence: ConsumerFence | undefined,
  ): Promise<void> {
    const { binding, person } = identity;
    const store = boot.store;
    if (
      !autoRoleGrant ||
      !store.getConfig ||
      !store.savePerson ||
      !store.updateConfigLocked
    )
      return;
    const raw = await readPolicy();
    if (!planDefaultGrant(raw, person)) return;

    if (withGrantTransaction) {
      await withGrantTransaction(async (db) => {
        const { ACCESS_POLICY_KEY, ACCESS_POLICY_HIGH_WATER_KEY } =
          mods.accessPolicy;
        const keys = fence
          ? [ACCESS_POLICY_KEY, fence.key]
          : [ACCESS_POLICY_KEY];
        let locked: Record<string, string | null> = {};
        await db.store.updateConfigLocked!(
          ACCESS_POLICY_HIGH_WATER_KEY,
          keys,
          (snapshot) => {
            locked = snapshot;
            return null;
          },
        );
        if (!grantFenceHolds(locked, fence)) return;

        await db.lockIdentity(person.personId, binding);
        const current = await refreshPerson(db);
        if (!current || !grantFenceHolds(locked, fence)) return;
        const raw = policyFromLocked(locked);
        const plan = planDefaultGrant(raw, current);
        if (!plan) return;
        if (
          plan.next &&
          !(
            await updateDefaultPolicy(
              db.store,
              raw,
              plan.next,
              current.personId,
              fence,
            )
          ).ok
        ) {
          throw new Error('role_grant_conflict');
        }
        if (plan.addRole) await saveMarketingRole(db.store, current);
        if (!grantFenceHolds(locked, fence))
          throw new Error('role_grant_fenced');
      });
      return;
    }

    // Durable adapters must offer an atomic role/policy transaction.
    if (boot.driver !== 'memory') return;
    // The in-memory adapter uses the versioned API and re-reads after a lost CAS.
    for (let attempt = 0; attempt < 3; attempt++) {
      const current = await refreshPerson();
      if (!current || !(await fenceStillHolds(fence))) return;
      const raw = await readPolicy();
      const plan = planDefaultGrant(raw, current);
      if (!plan) return;
      if (plan.next) {
        const saved = await updateDefaultPolicy(
          store,
          raw,
          plan.next,
          current.personId,
          fence,
        );
        if (saved.ok && !plan.addRole) return;
        continue;
      }
      if (closing || closed || !(await fenceStillHolds(fence))) return;
      await saveMarketingRole(store, current);
      return;
    }
  }

  async function bindingFor(
    event: {
      readonly botId?: string;
      readonly corpId?: string;
      readonly memberId: string;
    },
    source: GrantStores = boot,
  ): Promise<{ identity: VerifiedIdentity } | { reason: BindingDenial }> {
    if (
      (event.botId !== undefined && !nonEmpty(event.botId)) ||
      !nonEmpty(event.memberId)
    ) {
      return { reason: 'no_binding' };
    }
    let rows: BridgeWecomBotBinding[];
    try {
      rows = structuredClone(await source.bindings.listBindings());
    } catch {
      return { reason: 'invalid_directory' };
    }
    if (!Array.isArray(rows) || rows.some((row) => !row || typeof row !== 'object')) {
      return { reason: 'invalid_directory' };
    }

    const memberRows = rows.filter(
      (row) =>
        row.memberId === event.memberId &&
        (event.botId === undefined || row.botId === event.botId),
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
      const corpMatches = snapshots.filter(
        (row) =>
          row.corpId === event.corpId &&
          (event.botId !== undefined || row.active),
      );
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
      person = structuredClone(
        await source.store.getPersonByMember(event.memberId),
      );
      people = structuredClone(await source.store.listPeople());
    } catch {
      return { reason: 'invalid_directory' };
    }

    if (!person) return { reason: 'mismatch' };
    if (person.active !== true) return { reason: 'inactive' };
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
      current?.active !== true ||
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
        person: Object.freeze(current),
      },
    };
  }

  async function refreshBoundPerson(
    identity: VerifiedIdentity,
    source: GrantStores = boot,
    outboundScope?: Pick<WeComOutboundAuthRequest, 'corpId' | 'memberId'>,
  ): Promise<BridgePerson | undefined> {
    if (closing || closed || !isLeaseHeld()) return undefined;
    const { binding, person } = identity;
    const latest = await bindingFor(outboundScope ?? binding, source);
    if (
      !('identity' in latest) ||
      !mods.bindings.sameBinding(binding, latest.identity.binding)
    ) {
      return undefined;
    }
    const current = latest.identity.person;
    return current.personId === person.personId &&
      current.storeId === person.storeId &&
      current.tier === person.tier
      ? current
      : undefined;
  }

  const employeeQueues = new Map<string, Promise<void>>();

  async function readManagerSnapshot(
    actor: BridgePerson,
    rawHours: string | null,
  ): Promise<string> {
    const hours = mods.storeHours.resolveStoreHours(rawHours, actor.storeId);
    if (!hours || !boot.store.listEntries)
      throw new Error('store_snapshot_unavailable');
    const today = mods.metrics.businessDate(
      now(),
      hours.cutoff,
      hours.timeZone,
    );
    const month = today.slice(0, 7);
    const rows = await boot.store.listEntries({ storeId: actor.storeId });
    let todayAmount = 0;
    let todayCount = 0;
    let monthAmount = 0;
    let monthCount = 0;
    for (const row of rows) {
      if (row.storeId !== actor.storeId || row.status !== 'confirmed') continue;
      if (row.businessDay.slice(0, 7) !== month || row.businessDay > today)
        continue;
      monthAmount += row.amount;
      monthCount += 1;
      if (row.businessDay === today) {
        todayAmount += row.amount;
        todayCount += 1;
      }
    }
    return [
      '【本店只读经营快照（供复盘参考，严禁声称可改账）】',
      `业务日：${today}`,
      `今日已确认业绩：${mods.money.formatYuan(todayAmount)}元（${todayCount}笔）`,
      `本月累计已确认业绩：${mods.money.formatYuan(monthAmount)}元（${monthCount}笔）`,
    ].join('\n');
  }

  async function processInbound(
    event: Readonly<WeComInboundTextEvent>,
    pendingArrival: ReturnType<
      FrontClawPendingOrderModule['capturePendingArrival']
    >,
  ): Promise<WeComPrecheckOutcome> {
    if (closing || closed || !isLeaseHeld()) {
      return {
        kind: 'failed',
        replies: [mods.loop.STALE_CONSUMER || BRIDGE_STALE_CONSUMER_REPLY],
      };
    }

    const activeFence = lease?.fence() ?? undefined;
    if (!(await fenceStillHolds(activeFence))) {
      return {
        kind: 'failed',
        replies: [mods.loop.STALE_CONSUMER || BRIDGE_STALE_CONSUMER_REPLY],
      };
    }

    const resolved = nonEmpty(event.botId)
      ? await bindingFor(event)
      : { reason: 'no_binding' };
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
    const refreshPerson = (source?: GrantStores) =>
      refreshBoundPerson(resolved.identity, source);
    try {
      await provisionDefaultGrant(resolved.identity, refreshPerson, activeFence);
    } catch {
      logger.warn('Front Claw automatic role grant failed');
    }
    if (closing || closed || !(await fenceStillHolds(activeFence))) {
      return { kind: 'failed', replies: [mods.loop.STALE_CONSUMER] };
    }
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

    if (!(await fenceStillHolds(activeFence))) {
      return {
        kind: 'failed',
        replies: [mods.loop.STALE_CONSUMER || BRIDGE_STALE_CONSUMER_REPLY],
      };
    }

    const denial = canonicalDenial(result, mods);
    if (denial) return { kind: 'failed', replies: [denial] };

    if (
      result.pass === true &&
      (!result.state || result.state === 'completed')
    ) {
      const actor = await refreshPerson();
      if (!actor) {
        return {
          kind: 'failed',
          replies: [mods.unified.UNBOUND || BRIDGE_UNBOUND_REPLY],
        };
      }
      const targetRole = classifyWeComSoftRole(event.text);
      const canReview = async (candidate: BridgePerson): Promise<boolean> =>
        candidate.tier !== 'employee' &&
        decideManagerReview(await readPolicy(), candidate, candidate.storeId)
          .allowed;
      if (targetRole === 'manager_ops' && !(await canReview(actor))) {
        return {
          kind: 'failed',
          replies: [MANAGER_REVIEW_DENIED_REPLY],
        };
      }

      const lookupCtx: WeComWorkspaceLookupContext = {
        corpId: binding.corpId,
        accountId: actor.accountId,
        memberId: event.memberId,
        storeId: actor.storeId,
        displayName: actor.displayName,
        targetRole,
      };
      const workspaceJid = await options.resolveWorkspaceJid?.(lookupCtx);

      const profileCtx: TargetProfileLookupContext = {
        ...lookupCtx,
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

      let readonlyContext: string | undefined;
      if (
        targetRole === 'manager_ops' ||
        (targetRole === 'training' && options.resolveTrainingContext)
      ) {
        const current = await refreshPerson();
        const raw = await readPolicy();
        if (!current || !canUseMarketing(raw, current)) {
          return {
            kind: 'failed',
            replies: [mods.entry.MARKETING_UNAVAILABLE],
          };
        }
        if (
          targetRole === 'manager_ops' &&
          !decideManagerReview(raw, current, current.storeId).allowed
        ) {
          return { kind: 'failed', replies: [MANAGER_REVIEW_DENIED_REPLY] };
        }
        if (!(await fenceStillHolds(activeFence))) {
          return { kind: 'failed', replies: [mods.loop.STALE_CONSUMER] };
        }
        if (targetRole === 'manager_ops') {
          readonlyContext = await readManagerSnapshot(
            current,
            (await pendingArrival).hours,
          );
        } else {
          const context = await options.resolveTrainingContext?.({
            query: event.text,
            corpId: binding.corpId,
            accountId: actor.accountId,
            storeId: actor.storeId,
            ...(workspaceJid ? { workspaceJid } : {}),
          });
          if (nonEmpty(context) && !/postgres(?:ql)?:\/\//i.test(context)) {
            readonlyContext = context;
          }
        }
      }

      const latest = await refreshPerson();
      const raw = await readPolicy();
      if (
        !latest ||
        !canUseMarketing(raw, latest) ||
        (targetRole === 'manager_ops' &&
          !decideManagerReview(raw, latest, latest.storeId).allowed)
      ) {
        return { kind: 'failed', replies: [mods.entry.MARKETING_UNAVAILABLE] };
      }
      if (!(await fenceStillHolds(activeFence)) || closing || closed) {
        return { kind: 'failed', replies: [mods.loop.STALE_CONSUMER] };
      }

      return {
        kind: 'pass',
        principal: Object.freeze({
          personId: actor.personId,
          tier: actor.tier,
          bindingVersion: binding.version,
        }),
        corpId: binding.corpId,
        accountId: actor.accountId,
        storeId: actor.storeId,
        displayName: actor.displayName,
        targetRole,
        ...(workspaceJid ? { workspaceJid } : {}),
        ...(readonlyContext ? { readonlyContext } : {}),
        ...(result.expiredReminder
          ? { expiredReminder: result.expiredReminder }
          : {}),
      };
    }

    const proof = result.access && structuredClone(result.access);
    const authorizeReply = async () => {
      const current = await refreshPerson();
      if (!current || !(await fenceStillHolds(activeFence))) return false;
      const policy = await readPolicy();
      if (!proof || proof.capability === null) {
        const access = mods.accessPolicy.standing(policy, current);
        return (
          access.allowed &&
          (!proof?.identity ||
            (current.personId === proof.identity.personId &&
              access.version === proof.identity.policyVersion))
        );
      }
      return (
        proof.storeIds.length > 0 &&
        proof.storeIds.every(
          (store) =>
            mods.accessPolicy.decideAccess(
              policy,
              current,
              proof.capability!,
              store,
              platformCapabilities,
            ).allowed,
        )
      );
    };
    // A refusal may contain directory names. Its presentation never exempts it from the gate.
    const failed =
      (result.state !== undefined && result.state !== 'completed') ||
      result.replies.some((reply) => reply.startsWith('Front Claw：不能做——'));
    return {
      kind: failed ? 'failed' : 'handled',
      ...(proof || failed || result.target === 'store'
        ? { authorizeReply }
        : {}),
      replies:
        result.replies.length > 0
          ? result.replies
          : [failed ? BRIDGE_EXECUTION_FAILED_REPLY : mods.entry.CLARIFY_REPLY],
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
        } catch {
          logger.warn('Front Claw bridge precheck failed unexpectedly');
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

  async function authorizeOutbound(
    req: WeComOutboundAuthRequest,
  ): Promise<WeComOutboundAuthResult> {
    try {
      if (closing || closed) {
        return { allowed: false, reason: 'bridge_closed' };
      }
      if (!isLeaseHeld()) {
        return { allowed: false, reason: 'lease_not_held' };
      }
      const activeFence = lease?.fence() ?? undefined;
      if (!(await fenceStillHolds(activeFence))) {
        return { allowed: false, reason: 'lease_not_held' };
      }

      if (!req || typeof req !== 'object' || !nonEmpty(req.memberId)) {
        return { allowed: false, reason: 'invalid_request' };
      }
      if (req.corpId !== undefined && !nonEmpty(req.corpId)) {
        return { allowed: false, reason: 'corp_mismatch' };
      }
      if (req.storeId !== undefined && !nonEmpty(req.storeId)) {
        return { allowed: false, reason: 'store_mismatch' };
      }
      const targetRole = req.targetRole ?? req.capability ?? 'marketing';
      if (
        (targetRole !== 'marketing' &&
          targetRole !== 'training' &&
          targetRole !== 'manager_ops' &&
          targetRole !== 'reception_ads') ||
        (req.capability !== undefined &&
          req.capability !== 'marketing' &&
          req.capability !== targetRole)
      ) {
        return { allowed: false, reason: 'unsupported_capability' };
      }

      let rows: BridgeWecomBotBinding[];
      try {
        rows = structuredClone(await boot.bindings.listBindings());
      } catch {
        return { allowed: false, reason: 'invalid_directory' };
      }
      if (
        !Array.isArray(rows) ||
        rows.some((row) => !row || typeof row !== 'object')
      ) {
        return { allowed: false, reason: 'invalid_directory' };
      }

      const memberRows = rows.filter((row) => row.memberId === req.memberId);
      if (memberRows.length === 0) {
        return { allowed: false, reason: 'no_binding' };
      }

      let snapshots: Readonly<BridgeWecomBotBinding>[];
      try {
        snapshots = memberRows.map((row) =>
          Object.freeze(mods.bindings.snapshotBinding(row)),
        );
      } catch {
        return { allowed: false, reason: 'invalid_directory' };
      }

      let binding: Readonly<BridgeWecomBotBinding>;
      if (req.corpId !== undefined) {
        const corpMatches = snapshots.filter(
          (row) => row.corpId === req.corpId,
        );
        if (corpMatches.length === 0) {
          return { allowed: false, reason: 'corp_mismatch' };
        }
        if (
          new Set(corpMatches.map((row) => row.botId)).size !==
          corpMatches.length
        ) {
          return { allowed: false, reason: 'binding_ambiguous' };
        }
        const activeMatches = corpMatches.filter((row) => row.active);
        if (activeMatches.length === 0) {
          return { allowed: false, reason: 'binding_inactive' };
        }
        if (activeMatches.length !== 1) {
          return { allowed: false, reason: 'binding_ambiguous' };
        }
        binding = activeMatches[0]!;
      } else {
        const activeMatches = snapshots.filter((row) => row.active);
        if (activeMatches.length === 0) {
          return { allowed: false, reason: 'binding_inactive' };
        }
        if (
          activeMatches.length !== 1 ||
          new Set(activeMatches.map((row) => row.corpId)).size !== 1 ||
          new Set(activeMatches.map((row) => row.accountId)).size !== 1
        ) {
          return { allowed: false, reason: 'binding_ambiguous' };
        }
        binding = activeMatches[0]!;
      }

      if (
        (req.botId !== undefined && binding.botId !== req.botId) ||
        (req.accountId !== undefined && binding.accountId !== req.accountId)
      )
        return { allowed: false, reason: 'binding_mismatch' };
      if (!nonEmpty(binding.corpId)) {
        return { allowed: false, reason: 'missing_domain' };
      }

      let person: BridgePerson | null;
      let people: BridgePerson[];
      try {
        person = structuredClone(
          await boot.store.getPersonByMember(req.memberId),
        );
        people = structuredClone(await boot.store.listPeople());
      } catch {
        return { allowed: false, reason: 'invalid_directory' };
      }

      if (!person) return { allowed: false, reason: 'person_not_found' };
      if (person.active !== true)
        return { allowed: false, reason: 'person_inactive' };
      if (
        person.memberId !== binding.memberId ||
        person.accountId !== binding.accountId
      ) {
        return { allowed: false, reason: 'binding_mismatch' };
      }
      if ('corpId' in person && person.corpId !== binding.corpId) {
        return { allowed: false, reason: 'corp_mismatch' };
      }
      if (
        !nonEmpty(person.personId) ||
        !nonEmpty(person.accountId) ||
        !nonEmpty(person.storeId) ||
        !nonEmpty(person.displayName) ||
        !nonEmpty(person.storeName)
      ) {
        return { allowed: false, reason: 'incomplete_profile' };
      }
      if (
        people.filter((p) => p.memberId === binding.memberId).length !== 1 ||
        people.filter((p) => p.accountId === binding.accountId).length !== 1
      ) {
        return { allowed: false, reason: 'person_ambiguous' };
      }
      const current = people.find((p) => p.personId === person!.personId);
      if (
        current?.active !== true ||
        current.memberId !== binding.memberId ||
        current.accountId !== binding.accountId ||
        !nonEmpty(current.displayName) ||
        !nonEmpty(current.storeId) ||
        !nonEmpty(current.storeName) ||
        ('corpId' in current && current.corpId !== binding.corpId)
      ) {
        return { allowed: false, reason: 'person_mismatch' };
      }

      if (typeof boot.store.getConfig !== 'function') {
        return { allowed: false, reason: 'policy_store_unavailable' };
      }
      const targetStoreId = req.storeId ?? current.storeId;
      if (req.accountId !== undefined && targetStoreId !== current.storeId)
        return { allowed: false, reason: 'store_out_of_scope' };
      if (
        targetStoreId !== current.storeId &&
        (targetRole === 'manager_ops' || current.tier !== 'owner')
      ) {
        return { allowed: false, reason: 'store_out_of_scope' };
      }
      if (
        req.principal &&
        (req.principal.personId !== current.personId ||
          req.principal.tier !== current.tier ||
          req.principal.bindingVersion !== binding.version)
      )
        return { allowed: false, reason: 'person_mismatch' };
      const identity = { binding, person: current };
      const refreshPerson = (source?: GrantStores) =>
        refreshBoundPerson(identity, source, req);
      // A reply for an admitted turn must not reinstate permissions that were removed meanwhile.
      if (!req.principal)
        await provisionDefaultGrant(identity, refreshPerson, activeFence);
      const actor = await refreshPerson();
      if (!actor) return { allowed: false, reason: 'person_mismatch' };
      const rawPolicy = await readPolicy();
      const decision = mods.accessPolicy.decideAccess(
        rawPolicy,
        actor,
        'marketing',
        targetStoreId,
        platformCapabilities,
      );
      if (!decision.allowed) {
        return { allowed: false, reason: decision.reason };
      }
      if (!actor.roles.includes('marketing')) {
        return { allowed: false, reason: 'capability_denied' };
      }
      if (targetRole === 'manager_ops') {
        const review = decideManagerReview(rawPolicy, actor, targetStoreId);
        if (!review.allowed) return { allowed: false, reason: review.reason };
      }
      if (!(await fenceStillHolds(activeFence)) || closing || closed) {
        return { allowed: false, reason: 'lease_not_held' };
      }
      return {
        allowed: true,
        policyVersion: decision.version,
        personId: actor.personId,
        storeId: targetStoreId,
      };
    } catch {
      return { allowed: false, reason: 'auth_check_failed' };
    }
  }

  return {
    precheck,
    authorizeOutbound,
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
      try {
        await (await grantPool?.catch(() => undefined))?.end();
      } finally {
        await boot.close();
      }
      closed = true;
    },
  };
}
