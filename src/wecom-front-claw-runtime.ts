import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { applyChannelAccountRegistrationFallback } from './channel-account-routing.js';
import { channelConversationJid } from './channel-address.js';
import {
  DefinitiveChannelDeliveryError,
  deliverChannelOutboxItem,
  type ChannelOutboxDeliveryResult,
  type DeliverChannelOutboxInput,
} from './channel-outbox-delivery.js';
import { getChannelTurnRun } from './channel-reliability-store.js';
import { DATA_DIR, GROUPS_DIR } from './config.js';
import {
  assignWorkspaceAgentProfile,
  createAgentProfile,
  getAgentProfile,
  getAllRegisteredGroups,
  getEarliestActiveAdmin,
  getWorkspaceAgentProfileId,
  listAgentProfilesForUser,
  listUsers,
  getAgentProfileForWorkspace,
  updateAgentProfile,
} from './db.js';
import type { WeComConnectConfig } from './im-manager.js';
import { IMConnectionManager } from './im-manager.js';
import { logger } from './logger.js';
import {
  observeWeComDelivery,
  observeWeComOutboundAuth,
  observeWeComPrecheck,
} from './personal-agent/host-observability.js';
import { getContainerEnvConfig } from './runtime-config.js';
import { type AgentProfile, RegisteredGroup } from './types.js';
import { wecomInputContext } from './wecom.js';
import type {
  WeComDeliveryOutcomeEvent,
  WeComOutboundAuthorizePort,
  WeComOutboxDeliveryOutcome,
} from './wecom.js';
import {
  BRIDGE_AGENT_GUARDRAIL_DENIED_REPLY,
  SAFE_MARKETING_DISALLOWED_TOOLS,
  type TargetAgentProfileSnapshot,
  type WeComFrontClawBridge,
  type WeComFrontClawBridgeOptions,
  createWeComFrontClawBridge,
} from './wecom-front-claw-bridge.js';
import {
  WECOM_ROLE_SKILL_IDS,
  WECOM_SOFT_ROLES,
  type WeComSoftRole,
  buildWeComTrainingKnowledgeContext,
  ensureBundledWeComMarketingSkill,
  ensureBundledWeComRoleSkills,
} from './wecom-front-claw-skills.js';

export const WECOM_MANAGED_WORKSPACE_JID = 'web:wecom-front-claw';
export const WECOM_MANAGED_WORKSPACE_FOLDER = 'wecom-front-claw';
export const WECOM_MANAGED_WORKSPACE_JID_PREFIX = `${WECOM_MANAGED_WORKSPACE_JID}:`;
export const WECOM_MANAGED_WORKSPACE_FOLDER_PREFIX = `${WECOM_MANAGED_WORKSPACE_FOLDER}-`;
export const WECOM_SAFE_PROFILE_NAME = 'Front Claw Safe Marketing';

export const WECOM_SAFE_ROLE_PROFILE_NAMES: Readonly<
  Record<WeComSoftRole, string>
> = {
  marketing: WECOM_SAFE_PROFILE_NAME,
  training: 'Front Claw Safe Training',
  manager_ops: 'Front Claw Safe Manager Ops',
  reception_ads: 'Front Claw Safe Reception Ads',
};

const WECOM_SAFE_ROLE_WORKSPACE_LABELS: Readonly<
  Record<WeComSoftRole, string>
> = {
  marketing: '企微内容营销工作区',
  training: '企微教学培训工作区',
  manager_ops: '企微店长复盘工作区',
  reception_ads: '企微接待与投流工作区',
};

const WECOM_SAFE_ROLE_IDENTITY_PROMPTS: Readonly<
  Record<WeComSoftRole, string>
> = {
  marketing:
    '你是企业微信非店务营销咨询助手，仅基于当前受控工作区回答内容营销与咨询问题。严禁伪造店务账本、严禁声称已写库或执行脚本。',
  training:
    '你是企业微信教学培训与家访带教助手，仅基于受控培训参考资料解答家访五步法、带教演练与组织诊断。严禁伪造店务账本、严禁声称已写库或执行脚本。',
  manager_ops:
    '你是企业微信店长经营复盘助手，仅基于系统注入的本店只读经营快照提供复盘诊断与管理建议。严禁伪造店务账本、严禁声称已写库或改账。',
  reception_ads:
    '你是企业微信客户接待与投流诊断助手，仅基于当前受控工作区提供接待异议话术与团购投流复盘建议。严禁伪造店务账本、严禁声称已写库或执行脚本。',
};

const SYSTEM_WECOM_OWNER_ID = 'front-claw-system';
const DEFAULT_LEASE_CHECK_INTERVAL_MS = 1000;

function isKnownWeComSoftRole(
  value: string | undefined,
): value is WeComSoftRole {
  return Boolean(
    value && (WECOM_SOFT_ROLES as readonly string[]).includes(value),
  );
}

export function parseEnabledWeComSoftRoles(
  raw: string | undefined,
): ReadonlySet<WeComSoftRole> {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return new Set<WeComSoftRole>(WECOM_SOFT_ROLES);
  }
  const parsed = trimmed
    .split(',')
    .map((item) => item.trim())
    .filter(isKnownWeComSoftRole);
  return new Set<WeComSoftRole>(parsed.length > 0 ? parsed : ['marketing']);
}

export function deriveWeComEmployeeWorkspace(ctx: {
  corpId: string;
  botId: string;
  memberId: string;
  storeId?: string;
  targetRole?: WeComSoftRole;
}): { jid: string; folder: string; role: WeComSoftRole } {
  const role: WeComSoftRole = isKnownWeComSoftRole(ctx.targetRole)
    ? ctx.targetRole
    : 'marketing';
  const storeId = ctx.storeId?.trim();
  if (!storeId) throw Error('wecom_workspace_store_required');
  const seed = [ctx.corpId, ctx.botId, ctx.memberId, storeId, role];
  const digest = createHash('sha256')
    .update(JSON.stringify(seed))
    .digest('hex')
    .slice(0, 16);
  return {
    role,
    jid: `${WECOM_MANAGED_WORKSPACE_JID_PREFIX}${role}:${digest}`,
    folder: `${WECOM_MANAGED_WORKSPACE_FOLDER_PREFIX}${role}-${digest}`,
  };
}

export function deriveEmployeeWeComWorkspace(ctx: {
  corpId: string;
  botId: string;
  memberId: string;
  storeId?: string;
  targetRole?: WeComSoftRole;
}): { jid: string; folder: string } {
  const { jid, folder } = deriveWeComEmployeeWorkspace(ctx);
  return { jid, folder };
}

export function inferWeComRoleFromWorkspaceJid(
  workspaceJid: string | undefined,
): WeComSoftRole {
  if (
    !workspaceJid ||
    !workspaceJid.startsWith(WECOM_MANAGED_WORKSPACE_JID_PREFIX)
  ) {
    return 'marketing';
  }
  const rest = workspaceJid.slice(WECOM_MANAGED_WORKSPACE_JID_PREFIX.length);
  const colonIdx = rest.indexOf(':');
  if (colonIdx <= 0) return 'marketing';
  const candidate = rest.slice(0, colonIdx);
  return isKnownWeComSoftRole(candidate) ? candidate : 'marketing';
}

export function isWeComManagedWorkspaceFolder(
  folder: string | undefined,
): boolean {
  return (
    folder === WECOM_MANAGED_WORKSPACE_FOLDER ||
    Boolean(
      folder &&
      /^wecom-front-claw-(?:(?:marketing|training|manager_ops|reception_ads)-)?[a-z0-9][a-z0-9_-]*$/i.test(
        folder,
      ),
    )
  );
}

export function isWeComManagedWorkspaceJid(jid: string | undefined): boolean {
  return (
    jid === WECOM_MANAGED_WORKSPACE_JID ||
    Boolean(
      jid &&
      /^web:wecom-front-claw:(?:(?:marketing|training|manager_ops|reception_ads):)?[a-z0-9][a-z0-9_-]*$/i.test(
        jid,
      ),
    )
  );
}

const SAFE_TELEMETRY_CODE = /^[a-zA-Z0-9._:-]{1,64}$/;

const OBSERVATION_ROUTE_MAP: Readonly<Record<string, string>> = {
  快通道: 'fast_path',
  模型: 'model',
  追问: 'clarify',
};

const OBSERVATION_GATE_REASON_MAP: Readonly<Record<string, string>> = {
  未命中: 'not_applicable',
  不适用: 'not_applicable',
  通过: 'accepted',
  放行: 'accepted',
  追问: 'uncertain',
  澄清: 'uncertain',
  拿不准: 'uncertain',
  金额: 'amount',
  金额异常: 'amount',
  金额不明: 'amount',
  权限: 'permission',
  越权: 'permission',
  未授权: 'permission',
  拒绝: 'permission',
  跨店: 'store_out_of_scope',
  超时: 'timeout',
  未绑定: 'unbound',
  限流: 'rate_limit',
  格式错误: 'invalid_format',
  格式不符: 'invalid_format',
  多意图: 'multi_intent',
  客户名无效: 'not_customer_name',
  模型候选拒绝: 'model_candidate_rejected',
  护栏拒绝: 'guardrail_denied',
  租约失效: 'lease_lost',
};

const OBSERVATION_ERROR_CATEGORY_MAP: Readonly<Record<string, string>> = {
  无: 'none',
  正常: 'none',
  超时: 'timeout',
  取消: 'cancelled',
  已取消: 'cancelled',
  限流: 'rate_limit',
  模型异常: 'model_error',
  模型错误: 'model_error',
  格式错误: 'schema',
  结构错误: 'schema',
  金额异常: 'amount',
  金额错误: 'amount',
  权限不足: 'permission',
  越权: 'permission',
  未授权: 'permission',
  拿不准: 'uncertain',
  不确定: 'uncertain',
  兜底: 'fallback',
  回退: 'fallback',
  未绑定: 'unbound',
  租约失效: 'lease_lost',
};

const inWeComOutboxContext = new AsyncLocalStorage<boolean>();

export function runInWeComOutboxContext<T>(fn: () => Promise<T>): Promise<T> {
  return inWeComOutboxContext.run(true, fn);
}

export function normalizeWeComObservationRoute(
  route: string | undefined,
): string {
  const trimmed = typeof route === 'string' ? route.trim() : '';
  if (!trimmed) return 'unknown_route';
  const mapped = OBSERVATION_ROUTE_MAP[trimmed];
  if (mapped) return mapped;
  return SAFE_TELEMETRY_CODE.test(trimmed) ? trimmed : 'unknown_route';
}

export function normalizeWeComObservationGateReason(
  reason: string | undefined,
): string {
  const trimmed = typeof reason === 'string' ? reason.trim() : '';
  if (!trimmed) return 'none';
  const mapped = OBSERVATION_GATE_REASON_MAP[trimmed];
  if (mapped) return mapped;
  return SAFE_TELEMETRY_CODE.test(trimmed) ? trimmed : 'redacted';
}

export function normalizeWeComObservationErrorCategory(
  category: string | undefined,
): string {
  const trimmed = typeof category === 'string' ? category.trim() : '';
  if (!trimmed) return 'none';
  const mapped = OBSERVATION_ERROR_CATEGORY_MAP[trimmed];
  if (mapped) return mapped;
  return SAFE_TELEMETRY_CODE.test(trimmed) ? trimmed : 'redacted';
}

/**
 * 将 #6 WeComOutboxDeliveryOutcome 映射为 #4 通用 Outbox (deliverChannelOutboxItem) 契约：
 * - accepted → 返回真实 providerMessageId（Outbox 落 delivered）；
 * - blocked(0块) / 首块 rejected(0块) → 抛 DefinitiveChannelDeliveryError（不设 retryAt，落 failed）；
 * - unknown 或任意 sentChunkCount > 0 的半成中断 → 抛普通 Error（锁死 uncertain 且禁止自动重发）。
 */
export function resolveWeComOutboxReceipt(
  outcome: WeComOutboxDeliveryOutcome,
): { providerMessageId: string } {
  if (outcome.state === 'accepted') {
    const providerMessageId = outcome.providerMessageId.trim();
    if (!providerMessageId) {
      throw new Error('wecom_accepted_missing_provider_message_id');
    }
    return { providerMessageId };
  }
  if (outcome.state === 'blocked') {
    const sentChunkCount = Number(
      (outcome as { sentChunkCount?: number }).sentChunkCount ?? 0,
    );
    if (sentChunkCount > 0) {
      throw new Error(
        `wecom_partial_blocked:${outcome.reason}:sent_chunks=${sentChunkCount}`,
      );
    }
    throw new DefinitiveChannelDeliveryError(`wecom_blocked:${outcome.reason}`);
  }
  if (outcome.state === 'rejected' && outcome.sentChunkCount === 0) {
    const codeSuffix =
      typeof outcome.apiErrorCode === 'number'
        ? `:code=${outcome.apiErrorCode}`
        : '';
    throw new DefinitiveChannelDeliveryError(
      `wecom_rejected:${outcome.reason}${codeSuffix}`,
    );
  }
  throw new Error(
    `wecom_${outcome.state}:${outcome.reason}:sent_chunks=${outcome.sentChunkCount}`,
  );
}

export async function deliverWeComTextViaOutbox(params: {
  readonly imManager: Pick<IMConnectionManager, 'sendMessageWithReceipt'>;
  readonly targetJid: string;
  readonly text: string;
  readonly correlationId: string;
  readonly workspaceJid?: string;
  readonly outbox: Omit<DeliverChannelOutboxInput, 'delivery'>;
}): Promise<ChannelOutboxDeliveryResult> {
  let capturedOutcome: WeComOutboxDeliveryOutcome | null = null;
  const startedAt = Date.now();
  const result = await deliverChannelOutboxItem({
    ...params.outbox,
    delivery: {
      mode: 'single',
      send: async () => {
        const send = () =>
          runInWeComOutboxContext(() =>
            params.imManager.sendMessageWithReceipt(
              params.targetJid,
              params.text,
              { correlationId: params.correlationId },
            ),
          );
        const turn = getChannelTurnRun(params.outbox.turnRunId);
        const outcome =
          turn?.correlationId &&
          params.workspaceJid &&
          turn.sourceJid === params.targetJid &&
          turn.accountId === params.outbox.accountId &&
          turn.provider === 'wecom'
            ? await wecomInputContext.run(
                Object.freeze({
                  messageId: turn.correlationId,
                  workspaceJid: params.workspaceJid,
                }),
                send,
              )
            : await wecomInputContext.exit(send);
        if (!outcome) {
          throw new DefinitiveChannelDeliveryError(
            'wecom_receipt_delivery_unavailable',
          );
        }
        capturedOutcome = outcome;
        return resolveWeComOutboxReceipt(outcome);
      },
    },
  });
  const settledOutcome = capturedOutcome as WeComOutboxDeliveryOutcome | null;
  if (settledOutcome !== null) {
    observeWeComDelivery({
      correlationId: params.correlationId,
      botId: params.outbox.accountId,
      outboxStatus: result.status,
      wecomState: settledOutcome.state,
      chunkCount:
        settledOutcome.state === 'accepted'
          ? settledOutcome.chunkCount
          : settledOutcome.sentChunkCount,
      durationMs: Math.max(0, Date.now() - startedAt),
    });
  }
  return result;
}

export interface WeComFrontClawRuntimeDeps {
  readonly env?: Record<string, string | undefined>;
  readonly imManager: IMConnectionManager;
  readonly getGroup: (jid: string) => RegisteredGroup | undefined;
  readonly listGroups?: () => Record<string, RegisteredGroup>;
  readonly registerGroup: (jid: string, group: RegisteredGroup) => void;
  readonly onNewChat: (
    userId: string,
    homeFolder: string,
  ) => (chatJid: string, chatName: string) => void;
  readonly onMessage?: (
    chatJid: string,
    text: string,
    senderName: string,
  ) => void;
  readonly onCommand?: (
    chatJid: string,
    command: string,
    senderImId?: string,
  ) => Promise<string | null>;
  readonly resolveGroupFolder?: (jid: string) => string | undefined;
  readonly resolveEffectiveChatJid?: (chatJid: string) => {
    effectiveJid: string;
    agentId: string | null;
    sourceJid?: string;
  } | null;
  readonly onAgentMessage?: (baseChatJid: string, agentId: string) => void;
  readonly isChatAuthorized?: (jid: string) => boolean;
  readonly onPairAttempt?: (
    jid: string,
    chatName: string,
    code: string,
  ) => Promise<boolean>;
  readonly ownerUserId?: string;
  readonly bridgeOptions?: WeComFrontClawBridgeOptions;
  readonly wecomConnection?: Partial<
    Pick<
      WeComConnectConfig,
      | 'client'
      | 'createClient'
      | 'connect'
      | 'disconnect'
      | 'connectClient'
      | 'disconnectClient'
      | 'sendTimeoutMs'
      | 'leaseCheckIntervalMs'
      | 'leaseRenewIntervalMs'
      | 'defaultCorpId'
    >
  >;
  readonly dispatchOptions?: {
    intervalMs?: number;
    onEvent?: (event: unknown) => void;
  };
  readonly startMaintenance?: boolean;
  readonly groupsDir?: string;
  readonly userSkillsDir?: string;
}

export interface WeComFrontClawRuntimeHandle {
  readonly botId: string;
  readonly ownerUserId: string;
  readonly workspaceJid: string;
  readonly workspaceFolder: string;
  readonly marketingSkillId: string | null;
  readonly enabledRoles: readonly WeComSoftRole[];
  readonly roleSkillIds: Readonly<Record<WeComSoftRole, readonly string[]>>;
  readonly bridge: WeComFrontClawBridge;
  readonly dispatchStatus: 'started' | 'disabled' | 'already';
  isConnected(): boolean;
  close(): Promise<void>;
}

function resolveWeComOwnerUserId(
  env: Record<string, string | undefined>,
  explicitOwnerUserId?: string,
): { userId: string; hasPersistedUser: boolean } {
  const explicit = explicitOwnerUserId?.trim();
  if (explicit && explicit !== SYSTEM_WECOM_OWNER_ID) {
    return { userId: explicit, hasPersistedUser: true };
  }
  const configured = env.FRONT_CLAW_WECOM_OWNER_USER_ID?.trim();
  if (configured && configured !== SYSTEM_WECOM_OWNER_ID) {
    return { userId: configured, hasPersistedUser: true };
  }
  const admin = getEarliestActiveAdmin();
  if (admin) {
    return { userId: admin.id, hasPersistedUser: true };
  }
  const firstActiveUser = listUsers({
    status: 'active',
    pageSize: 10,
  }).users.find((user) => user.status === 'active');
  if (firstActiveUser) {
    return { userId: firstActiveUser.id, hasPersistedUser: true };
  }
  return { userId: SYSTEM_WECOM_OWNER_ID, hasPersistedUser: false };
}

function buildSafeRoleRuntimePolicy(skillIds: readonly string[]) {
  return {
    context: { source: 'managed' as const },
    skills:
      skillIds.length > 0
        ? {
            mode: 'custom' as const,
            ids: [...skillIds],
            host: { mode: 'disabled' as const, ids: [] as string[] },
          }
        : {
            mode: 'disabled' as const,
            ids: [] as string[],
            host: { mode: 'disabled' as const, ids: [] as string[] },
          },
    mcp: { mode: 'disabled' as const, ids: [] as string[] },
  };
}

function isSafeRoleProfile(
  profile: AgentProfile | undefined,
  role: WeComSoftRole,
  skillIds: readonly string[],
): boolean {
  const expectedName = WECOM_SAFE_ROLE_PROFILE_NAMES[role];
  const expectedPrompt = WECOM_SAFE_ROLE_IDENTITY_PROMPTS[role];
  if (
    !profile ||
    profile.status !== 'active' ||
    profile.is_default !== false ||
    profile.name !== expectedName ||
    profile.identity_prompt !== expectedPrompt ||
    profile.runtime_policy.context.source !== 'managed' ||
    profile.runtime_policy.skills.host?.mode !== 'disabled' ||
    profile.runtime_policy.mcp.mode !== 'disabled'
  ) {
    return false;
  }
  const skills = profile.runtime_policy.skills;
  if (skillIds.length > 0) {
    return (
      skills.mode === 'custom' &&
      skills.ids.length === skillIds.length &&
      skillIds.every((id, index) => skills.ids[index] === id)
    );
  }
  return skills.mode === 'disabled' && skills.ids.length === 0;
}

function findOrCreateSafeRoleProfile(
  ownerUserId: string,
  role: WeComSoftRole,
  skillIds: readonly string[],
): string {
  const expectedName = WECOM_SAFE_ROLE_PROFILE_NAMES[role];
  const expectedPrompt = WECOM_SAFE_ROLE_IDENTITY_PROMPTS[role];
  const existing = listAgentProfilesForUser(ownerUserId).find(
    (profile) =>
      profile.status === 'active' &&
      !profile.is_default &&
      profile.name === expectedName,
  );
  if (existing) {
    if (isSafeRoleProfile(existing, role, skillIds)) {
      return existing.id;
    }
    const updated = updateAgentProfile(existing.id, ownerUserId, {
      identityPrompt: expectedPrompt,
      runtimePolicy: buildSafeRoleRuntimePolicy(skillIds),
    });
    return updated?.id ?? existing.id;
  }

  const created = createAgentProfile({
    ownerUserId,
    name: expectedName,
    identityPrompt: expectedPrompt,
    promptMode: 'replace',
    includeClaudePreset: false,
    runtimePolicy: buildSafeRoleRuntimePolicy(skillIds),
  });
  return created.id;
}

function ensureSafeProfileBinding(
  folder: string,
  ownerUserId: string,
  role: WeComSoftRole,
  skillIds: readonly string[],
): void {
  const expectedName = WECOM_SAFE_ROLE_PROFILE_NAMES[role];
  const expectedPrompt = WECOM_SAFE_ROLE_IDENTITY_PROMPTS[role];
  const mappedId = getWorkspaceAgentProfileId(folder);
  const mapped = mappedId ? getAgentProfile(mappedId) : undefined;
  if (isSafeRoleProfile(mapped, role, skillIds)) {
    return;
  }
  if (
    mapped &&
    mapped.status === 'active' &&
    !mapped.is_default &&
    mapped.name === expectedName &&
    mapped.owner_user_id === ownerUserId
  ) {
    const updated = updateAgentProfile(mapped.id, ownerUserId, {
      identityPrompt: expectedPrompt,
      runtimePolicy: buildSafeRoleRuntimePolicy(skillIds),
    });
    if (updated && isSafeRoleProfile(updated, role, skillIds)) {
      return;
    }
  }
  const profileId = findOrCreateSafeRoleProfile(ownerUserId, role, skillIds);
  assignWorkspaceAgentProfile(folder, profileId, 'assistant');
}

function defaultManagedFolderForWorkspaceJid(
  workspaceJid: string,
): string | undefined {
  if (workspaceJid === WECOM_MANAGED_WORKSPACE_JID) {
    return WECOM_MANAGED_WORKSPACE_FOLDER;
  }
  if (!workspaceJid.startsWith(WECOM_MANAGED_WORKSPACE_JID_PREFIX)) {
    return undefined;
  }
  const suffix = workspaceJid
    .slice(WECOM_MANAGED_WORKSPACE_JID_PREFIX.length)
    .replace(/:/g, '-');
  return suffix
    ? `${WECOM_MANAGED_WORKSPACE_FOLDER_PREFIX}${suffix}`
    : undefined;
}

function ensureManagedWeComWorkspace(params: {
  workspaceJid: string;
  workspaceFolder?: string;
  workspaceName?: string;
  targetRole?: WeComSoftRole;
  ownerUserId: string;
  resolveRoleSkillIds?: (
    ownerUserId: string,
    role: WeComSoftRole,
  ) => readonly string[];
  getGroup: (jid: string) => RegisteredGroup | undefined;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
  groupsDir: string;
}): RegisteredGroup | undefined {
  const role =
    params.targetRole ?? inferWeComRoleFromWorkspaceJid(params.workspaceJid);
  const existing = params.getGroup(params.workspaceJid);
  if (existing) {
    if (isWeComManagedWorkspaceJid(params.workspaceJid)) {
      if (
        existing.created_by === SYSTEM_WECOM_OWNER_ID &&
        params.ownerUserId !== SYSTEM_WECOM_OWNER_ID
      ) {
        const migrated: RegisteredGroup = {
          ...existing,
          created_by: params.ownerUserId,
          executionMode: existing.executionMode ?? 'container',
          is_home: false,
        };
        params.registerGroup(params.workspaceJid, migrated);
        ensureSafeProfileBinding(
          migrated.folder,
          params.ownerUserId,
          role,
          params.resolveRoleSkillIds?.(params.ownerUserId, role) ?? [],
        );
        return migrated;
      }
      const effectiveOwnerId = existing.created_by || params.ownerUserId;
      ensureSafeProfileBinding(
        existing.folder,
        effectiveOwnerId,
        role,
        params.resolveRoleSkillIds?.(effectiveOwnerId, role) ?? [],
      );
    }
    return existing;
  }

  const defaultFolder = defaultManagedFolderForWorkspaceJid(
    params.workspaceJid,
  );
  const folder = params.workspaceFolder ?? defaultFolder;
  if (!folder) {
    return undefined;
  }

  fs.mkdirSync(path.join(params.groupsDir, folder), {
    recursive: true,
  });

  const group: RegisteredGroup = {
    name: params.workspaceName ?? WECOM_SAFE_ROLE_WORKSPACE_LABELS[role],
    folder,
    added_at: new Date().toISOString(),
    created_by: params.ownerUserId,
    is_home: false,
    executionMode: 'container',
  };
  params.registerGroup(params.workspaceJid, group);
  ensureSafeProfileBinding(
    group.folder,
    params.ownerUserId,
    role,
    params.resolveRoleSkillIds?.(params.ownerUserId, role) ?? [],
  );

  return group;
}

function resolveTargetProfileSnapshot(params: {
  workspaceJid: string;
  getGroup: (jid: string) => RegisteredGroup | undefined;
}): TargetAgentProfileSnapshot | null {
  const group = params.getGroup(params.workspaceJid);
  if (!group) return null;

  const profile = getAgentProfileForWorkspace(group.folder, group.created_by);
  if (!profile) {
    return {
      workspaceJid: params.workspaceJid,
      status: 'missing',
      executionMode: group.executionMode ?? 'container',
    };
  }

  const containerEnv = getContainerEnvConfig(group.folder);
  const disallowedTools =
    group.executionMode !== 'host' ? [...SAFE_MARKETING_DISALLOWED_TOOLS] : [];

  return {
    profileId: profile.id,
    workspaceJid: params.workspaceJid,
    status: profile.status,
    executionMode: group.executionMode ?? 'container',
    contextSource: profile.runtime_policy.context.source,
    hostSkillsMode: profile.runtime_policy.skills.host?.mode ?? 'disabled',
    runtimePolicy: {
      context: profile.runtime_policy.context,
      skills: profile.runtime_policy.skills,
    },
    disallowedTools,
    injectedEnvKeys: Object.keys(containerEnv.customEnv ?? {}),
  };
}

export async function startWeComFrontClawRuntime(
  deps: WeComFrontClawRuntimeDeps,
): Promise<WeComFrontClawRuntimeHandle | null> {
  const env = deps.env ?? process.env;
  if ((env.FRONT_CLAW_WECOM_ENABLED ?? '').trim() !== '1') {
    return null;
  }

  const botId = env.FRONT_CLAW_WECOM_BOT_ID?.trim() ?? '';
  const secret = env.FRONT_CLAW_WECOM_BOT_SECRET?.trim() ?? '';
  if (!botId || !secret) {
    logger.warn(
      {
        hasBotId: Boolean(botId),
        hasSecret: Boolean(secret),
      },
      'FRONT_CLAW_WECOM_ENABLED=1 requires FRONT_CLAW_WECOM_BOT_ID and FRONT_CLAW_WECOM_BOT_SECRET; skipping WeCom runtime',
    );
    return null;
  }

  const ownerResolution = resolveWeComOwnerUserId(env, deps.ownerUserId);
  if (!ownerResolution.hasPersistedUser) {
    logger.error(
      { botId },
      'No active OpenDot user found; initialize an admin user (e.g. `node dist/reset-admin.js admin <strong-password>`) and restart before starting WeCom Front Claw runtime',
    );
    return null;
  }
  const ownerUserId = ownerResolution.userId;

  const enabledRolesSet = parseEnabledWeComSoftRoles(
    env.FRONT_CLAW_WECOM_ENABLED_ROLES,
  );
  const enabledRoles = [...enabledRolesSet] as const;

  const hasExplicitMarketingSkillOverride =
    Object.prototype.hasOwnProperty.call(
      env,
      'FRONT_CLAW_WECOM_MARKETING_SKILL_ID',
    );
  const requestedMarketingSkillId = (
    env.FRONT_CLAW_WECOM_MARKETING_SKILL_ID ?? ''
  ).trim();
  const roleSkillsEnabled =
    (env.FRONT_CLAW_WECOM_ROLE_SKILLS_ENABLED ?? '1').trim() !== '0';

  const roleSkillsByOwner = new Map<string, readonly string[]>();
  const resolveRoleSkillIdsForOwner = (
    targetOwnerId: string,
    role: WeComSoftRole,
  ): readonly string[] => {
    const effectiveRole: WeComSoftRole = enabledRolesSet.has(role)
      ? role
      : 'marketing';
    const cacheKey = `${targetOwnerId}:${effectiveRole}`;
    if (roleSkillsByOwner.has(cacheKey)) {
      return roleSkillsByOwner.get(cacheKey)!;
    }
    const targetSkillsDir =
      deps.userSkillsDir ?? path.join(DATA_DIR, 'skills', targetOwnerId);

    if (effectiveRole === 'marketing' && hasExplicitMarketingSkillOverride) {
      if (!requestedMarketingSkillId) {
        roleSkillsByOwner.set(cacheKey, []);
        return [];
      }
      try {
        const synced = ensureBundledWeComMarketingSkill({
          userSkillsDir: targetSkillsDir,
          skillId: requestedMarketingSkillId,
        });
        const ids = [synced.skillId];
        roleSkillsByOwner.set(cacheKey, ids);
        return ids;
      } catch (err) {
        logger.error(
          {
            err,
            botId,
            ownerUserId: targetOwnerId,
            skillId: requestedMarketingSkillId,
          },
          'Failed to sync/verify bundled WeCom marketing skill; keeping Safe Marketing Profile skills disabled (fail-closed)',
        );
        roleSkillsByOwner.set(cacheKey, []);
        return [];
      }
    }

    if (!roleSkillsEnabled || !enabledRolesSet.has(effectiveRole)) {
      roleSkillsByOwner.set(cacheKey, []);
      return [];
    }

    try {
      const synced = ensureBundledWeComRoleSkills({
        userSkillsDir: targetSkillsDir,
        role: effectiveRole,
        skillIds: WECOM_ROLE_SKILL_IDS[effectiveRole],
      });
      roleSkillsByOwner.set(cacheKey, synced.skillIds);
      return synced.skillIds;
    } catch (err) {
      logger.error(
        {
          err,
          botId,
          ownerUserId: targetOwnerId,
          role: effectiveRole,
        },
        'Failed to sync/verify bundled WeCom role skills; keeping role profile skills disabled (fail-closed)',
      );
      roleSkillsByOwner.set(cacheKey, []);
      return [];
    }
  };

  const roleSkillIds = {
    marketing: resolveRoleSkillIdsForOwner(ownerUserId, 'marketing'),
    training: resolveRoleSkillIdsForOwner(ownerUserId, 'training'),
    manager_ops: resolveRoleSkillIdsForOwner(ownerUserId, 'manager_ops'),
    reception_ads: resolveRoleSkillIdsForOwner(ownerUserId, 'reception_ads'),
  } as const;
  const enabledMarketingSkillId = roleSkillIds.marketing[0] ?? null;

  const workspaceJid =
    env.FRONT_CLAW_WECOM_WORKSPACE_JID?.trim() || WECOM_MANAGED_WORKSPACE_JID;
  const managedWorkspaceEnabled = workspaceJid === WECOM_MANAGED_WORKSPACE_JID;
  const groupsDir = deps.groupsDir ?? GROUPS_DIR;
  const managedGroup = ensureManagedWeComWorkspace({
    workspaceJid,
    targetRole: 'marketing',
    ownerUserId,
    resolveRoleSkillIds: resolveRoleSkillIdsForOwner,
    getGroup: deps.getGroup,
    registerGroup: deps.registerGroup,
    groupsDir,
  });

  const ensureEmployeeTargetWorkspace = (ctx: {
    corpId: string;
    memberId: string;
    storeId?: string;
    targetRole?: WeComSoftRole;
    displayName?: string;
  }): { jid: string; folder: string; role: WeComSoftRole } | undefined => {
    if (!managedWorkspaceEnabled) {
      return undefined;
    }
    const requestedRole: WeComSoftRole =
      ctx.targetRole && enabledRolesSet.has(ctx.targetRole)
        ? ctx.targetRole
        : 'marketing';
    const derived = deriveWeComEmployeeWorkspace({
      corpId: ctx.corpId,
      botId,
      memberId: ctx.memberId,
      storeId: ctx.storeId,
      targetRole: requestedRole,
    });
    const existing = deps.getGroup(derived.jid);
    if (existing && existing.folder !== derived.folder) return undefined;
    const label = WECOM_SAFE_ROLE_WORKSPACE_LABELS[derived.role];
    ensureManagedWeComWorkspace({
      workspaceJid: derived.jid,
      workspaceFolder: derived.folder,
      workspaceName: `${label} (${ctx.displayName || ctx.memberId})`,
      targetRole: derived.role,
      ownerUserId,
      resolveRoleSkillIds: resolveRoleSkillIdsForOwner,
      getGroup: deps.getGroup,
      registerGroup: deps.registerGroup,
      groupsDir,
    });
    const baseC2cJid = `wecom:c2c:${ctx.corpId}:${ctx.memberId}`;
    const existingC2c = deps.getGroup(baseC2cJid);
    if (
      existingC2c &&
      (existingC2c.created_by === SYSTEM_WECOM_OWNER_ID ||
        !existingC2c.channel_account_id ||
        existingC2c.target_main_jid !== derived.jid ||
        existingC2c.folder !== derived.folder ||
        existingC2c.executionMode === 'host' ||
        existingC2c.is_home)
    ) {
      deps.registerGroup(baseC2cJid, {
        ...existingC2c,
        created_by:
          existingC2c.created_by === SYSTEM_WECOM_OWNER_ID
            ? ownerUserId
            : existingC2c.created_by,
        channel_account_id: existingC2c.channel_account_id || botId,
        folder: derived.folder,
        target_main_jid: derived.jid,
        executionMode: 'container',
        is_home: false,
      });
    }
    return derived;
  };

  // 自愈历史上 front-claw-system 归属与旧共享 web:wecom-front-claw 员工路由
  const historicalGroups = (deps.listGroups ?? getAllRegisteredGroups)();
  for (const [existingJid, existingGroup] of Object.entries(historicalGroups)) {
    if (!existingJid.startsWith('wecom:')) {
      continue;
    }
    if (existingGroup.created_by === SYSTEM_WECOM_OWNER_ID) {
      deps.registerGroup(existingJid, {
        ...existingGroup,
        created_by: ownerUserId,
      });
    }
  }

  const recentObservations = new Map<
    string,
    {
      route: string;
      gateReason: string;
      modelMs: number;
      errorCategory: string;
    }
  >();

  const bridgeOptions: WeComFrontClawBridgeOptions = {
    ...deps.bridgeOptions,
    env: deps.bridgeOptions?.env ?? env,
    onObservation: (record) => {
      if (recentObservations.size >= 1024) {
        const oldest = recentObservations.keys().next().value;
        if (oldest !== undefined) recentObservations.delete(oldest);
      }
      recentObservations.set(record.requestId, {
        route: normalizeWeComObservationRoute(record.route),
        gateReason: normalizeWeComObservationGateReason(record.gateReason),
        modelMs: record.modelMs,
        errorCategory: normalizeWeComObservationErrorCategory(
          record.errorCategory,
        ),
      });
      deps.bridgeOptions?.onObservation?.(record);
    },
    resolveWorkspaceJid:
      deps.bridgeOptions?.resolveWorkspaceJid ??
      ((ctx) =>
        ensureEmployeeTargetWorkspace({
          corpId: ctx.corpId,
          memberId: ctx.memberId,
          storeId: ctx.storeId,
          targetRole: ctx.targetRole,
          displayName: ctx.displayName,
        })?.jid ?? workspaceJid),
    resolveTargetProfile:
      deps.bridgeOptions?.resolveTargetProfile ??
      ((ctx) =>
        resolveTargetProfileSnapshot({
          workspaceJid: ctx.workspaceJid ?? workspaceJid,
          getGroup: deps.getGroup,
        })),
    resolveTrainingContext:
      deps.bridgeOptions?.resolveTrainingContext ??
      ((params) => {
        if (!enabledRolesSet.has('training')) {
          return undefined;
        }
        try {
          const result = buildWeComTrainingKnowledgeContext({
            query: params.query,
            accountId: params.accountId,
            workspaceJid: params.workspaceJid,
          });
          return result.formattedContext.trim() || undefined;
        } catch (err) {
          logger.warn(
            { err, botId, workspaceJid: params.workspaceJid },
            'Failed to build WeCom training knowledge context; continuing without training reference',
          );
          return undefined;
        }
      }),
  };

  const rawBridge = await createWeComFrontClawBridge(bridgeOptions);
  const observedPrecheck: WeComFrontClawBridge['precheck'] = async (event) => {
    try {
      let outcome = await rawBridge.precheck(event);
      if (outcome.kind === 'pass') {
        const expected =
          outcome.targetRole &&
          outcome.storeId &&
          deriveWeComEmployeeWorkspace({
            corpId: outcome.corpId,
            botId,
            memberId: event.memberId,
            storeId: outcome.storeId,
            targetRole: outcome.targetRole,
          });
        if (
          !managedWorkspaceEnabled ||
          !expected ||
          outcome.workspaceJid !== expected.jid ||
          deps.getGroup(expected.jid)?.folder !== expected.folder
        ) {
          outcome = {
            kind: 'failed',
            replies: [BRIDGE_AGENT_GUARDRAIL_DENIED_REPLY],
          };
        }
      }
      const correlationId = event.messageId.trim() || event.reqId;
      const obs = recentObservations.get(event.messageId);
      const isGuardrailDenied =
        outcome.kind === 'failed' &&
        outcome.replies.includes(BRIDGE_AGENT_GUARDRAIL_DENIED_REPLY);
      const route = obs ? obs.route : 'precheck_gate';
      const gateReason = isGuardrailDenied
        ? 'guardrail_denied'
        : obs
          ? obs.gateReason
          : outcome.kind === 'failed'
            ? 'precheck_rejected'
            : 'not_applicable';
      const modelMs = obs?.modelMs ?? 0;
      const errorCategory =
        isGuardrailDenied && (!obs || obs.errorCategory === 'none')
          ? 'guardrail_denied'
          : obs
            ? obs.errorCategory
            : outcome.kind === 'failed'
              ? 'precheck_failed'
              : 'none';
      observeWeComPrecheck({
        correlationId,
        botId: event.botId,
        memberId: event.memberId,
        ...(outcome.kind === 'pass'
          ? {
              storeId: outcome.storeId,
              ...(outcome.targetRole ? { targetRole: outcome.targetRole } : {}),
              ...(outcome.principal?.tier
                ? { tier: outcome.principal.tier }
                : {}),
              readonlyContextInjected: Boolean(outcome.readonlyContext?.trim()),
            }
          : {}),
        route,
        gateReason,
        modelMs,
        errorCategory,
        outcomeKind: outcome.kind,
      });
      return outcome;
    } finally {
      recentObservations.delete(event.messageId);
    }
  };
  const bridge: WeComFrontClawBridge = {
    precheck: observedPrecheck,
    driver: rawBridge.driver,
    authorizeOutbound: rawBridge.authorizeOutbound.bind(rawBridge),
    isActive: () => rawBridge.isActive(),
    leaseHeld: () => rawBridge.leaseHeld(),
    startMaintenance: () => rawBridge.startMaintenance(),
    startNotificationDispatch: (sender, options) =>
      rawBridge.startNotificationDispatch(sender, options),
    stopNotificationDispatch: () => rawBridge.stopNotificationDispatch(),
    close: () => rawBridge.close(),
  };

  if (deps.startMaintenance !== false) {
    bridge.startMaintenance();
  }

  const authorizeOutbound: WeComOutboundAuthorizePort = async (input) => {
    const correlationId =
      input.correlationId?.trim() || `${input.botId}:${input.chatId}`;
    try {
      const scope = input.scope;
      const decision = !scope
        ? { allowed: false as const, reason: 'missing_admitted_scope' }
        : await bridge.authorizeOutbound({
            botId: input.botId,
            principal: scope.principal,
            accountId: scope.accountId,
            storeId: scope.storeId,
            targetRole: scope.targetRole,
            memberId: input.memberId,
            ...(input.corpId !== undefined ? { corpId: input.corpId } : {}),
            capability: 'marketing',
          });
      observeWeComOutboundAuth({
        correlationId,
        botId: input.botId,
        memberId: input.memberId,
        allowed: decision.allowed,
        reason: decision.allowed ? 'allowed' : decision.reason,
        ...(decision.allowed ? { policyVersion: decision.policyVersion } : {}),
      });
      return decision;
    } catch {
      observeWeComOutboundAuth({
        correlationId,
        botId: input.botId,
        memberId: input.memberId,
        allowed: false,
        reason: 'auth_check_failed',
      });
      return { allowed: false, reason: 'auth_check_failed' };
    }
  };

  const onDeliveryOutcome = (event: WeComDeliveryOutcomeEvent): void => {
    if (inWeComOutboxContext.getStore() === true) {
      return;
    }
    const wecomOutcome = event.outcome;
    const outboxStatus =
      wecomOutcome.state === 'accepted'
        ? 'delivered'
        : wecomOutcome.state === 'blocked'
          ? 'failed'
          : wecomOutcome.state === 'rejected' &&
              wecomOutcome.sentChunkCount === 0
            ? 'failed'
            : 'uncertain';
    observeWeComDelivery({
      correlationId:
        event.correlationId?.trim() || `${event.botId}:${event.chatId}`,
      botId: event.botId,
      outboxStatus,
      wecomState: wecomOutcome.state,
      chunkCount:
        wecomOutcome.state === 'accepted'
          ? wecomOutcome.chunkCount
          : wecomOutcome.sentChunkCount,
    });
  };

  const onNewChat = (jid: string, name: string) => {
    const baseJid = channelConversationJid(jid);
    const admitted = wecomInputContext.getStore()?.workspaceJid;
    if (
      !managedWorkspaceEnabled ||
      !admitted ||
      !isWeComManagedWorkspaceJid(admitted)
    )
      return;
    const target = deps.getGroup(admitted);
    if (!target) return;
    const resolvedTarget = { jid: admitted, folder: target.folder };

    deps.onNewChat(ownerUserId, resolvedTarget.folder)(jid, name);
    const group = deps.getGroup(baseJid);
    if (!group) return;
    const withFallback = applyChannelAccountRegistrationFallback(
      group,
      botId,
      resolvedTarget.jid,
    );
    const nextGroup: RegisteredGroup = {
      ...withFallback,
      created_by:
        withFallback.created_by === SYSTEM_WECOM_OWNER_ID
          ? ownerUserId
          : withFallback.created_by,
      folder: resolvedTarget.folder,
      target_main_jid: resolvedTarget.jid,
      executionMode: 'container',
      is_home: false,
    };
    const changed =
      nextGroup.target_main_jid !== group.target_main_jid ||
      nextGroup.folder !== group.folder ||
      nextGroup.created_by !== group.created_by ||
      nextGroup.channel_account_id !== group.channel_account_id ||
      nextGroup.executionMode !== group.executionMode ||
      nextGroup.is_home !== group.is_home;
    if (changed) {
      deps.registerGroup(baseJid, nextGroup);
    }
  };

  const connected = await deps.imManager.connectUserWeCom(
    ownerUserId,
    {
      botId,
      secret,
      enabled: true,
      precheck: observedPrecheck,
      authorizeOutbound,
      onDeliveryOutcome,
      lease: {
        acquire: async () => bridge.isActive(),
        held: () => bridge.leaseHeld(),
      },
      leaseCheckIntervalMs:
        deps.wecomConnection?.leaseCheckIntervalMs ??
        DEFAULT_LEASE_CHECK_INTERVAL_MS,
      ...deps.wecomConnection,
    },
    onNewChat,
    {
      accountId: botId,
      scopeIncomingJids: false,
      ignoreMessagesBefore: Date.now(),
      onCommand: deps.onCommand,
      onMessage: deps.onMessage,
      resolveGroupFolder: deps.resolveGroupFolder,
      resolveEffectiveChatJid: deps.resolveEffectiveChatJid,
      onAgentMessage: deps.onAgentMessage,
      isChatAuthorized: deps.isChatAuthorized,
      onPairAttempt: deps.onPairAttempt,
      isTrustedManagedWorkspaceJid: isWeComManagedWorkspaceJid,
    },
  );

  if (!connected) {
    logger.warn(
      { botId, driver: bridge.driver, leaseHeld: bridge.leaseHeld() },
      'WeCom channel failed to connect; closing Front Claw bridge',
    );
    await bridge
      .close()
      .catch((err) =>
        logger.warn(
          { err, botId },
          'Error closing Front Claw bridge after failed WeCom connect',
        ),
      );
    return null;
  }

  const dispatchStatus = bridge.startNotificationDispatch(
    {
      notify: async (memberId, content, scope, beforeSend) => {
        const outcome = await deps.imManager.notifyUserWeCom(
          ownerUserId,
          botId,
          memberId,
          content,
          scope,
          beforeSend,
        );
        if (outcome.state === 'accepted') return { state: 'accepted' };
        if (outcome.state === 'unknown') return { state: 'unknown' };
        return { state: 'blocked' };
      },
    },
    deps.dispatchOptions,
  );

  logger.info(
    {
      botId,
      ownerUserId,
      workspaceJid,
      marketingSkillId: enabledMarketingSkillId,
      enabledRoles,
      roleSkillIds,
      driver: bridge.driver,
      leaseHeld: bridge.leaseHeld(),
      dispatchStatus,
    },
    'WeCom Front Claw native runtime started',
  );

  let closing = false;
  return {
    botId,
    ownerUserId,
    workspaceJid,
    workspaceFolder: managedGroup?.folder ?? WECOM_MANAGED_WORKSPACE_FOLDER,
    marketingSkillId: enabledMarketingSkillId,
    enabledRoles,
    roleSkillIds,
    bridge,
    dispatchStatus,
    isConnected: () =>
      deps.imManager.isChannelAccountConnected(ownerUserId, 'wecom', botId),
    async close(): Promise<void> {
      if (closing) return;
      closing = true;
      bridge.stopNotificationDispatch();
      await bridge.close();
    },
  };
}
