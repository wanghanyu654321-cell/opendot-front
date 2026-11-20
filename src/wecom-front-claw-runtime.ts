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
import { ensureBundledWeComMarketingSkill } from './wecom-front-claw-skills.js';

export const WECOM_MANAGED_WORKSPACE_JID = 'web:wecom-front-claw';
export const WECOM_MANAGED_WORKSPACE_FOLDER = 'wecom-front-claw';
export const WECOM_MANAGED_WORKSPACE_JID_PREFIX = `${WECOM_MANAGED_WORKSPACE_JID}:`;
export const WECOM_MANAGED_WORKSPACE_FOLDER_PREFIX = `${WECOM_MANAGED_WORKSPACE_FOLDER}-`;
export const WECOM_SAFE_PROFILE_NAME = 'Front Claw Safe Marketing';

const SYSTEM_WECOM_OWNER_ID = 'front-claw-system';
const DEFAULT_LEASE_CHECK_INTERVAL_MS = 1000;

export function deriveEmployeeWeComWorkspace(ctx: {
  corpId: string;
  botId: string;
  memberId: string;
}): { jid: string; folder: string } {
  const digest = createHash('sha256')
    .update(JSON.stringify([ctx.corpId, ctx.botId, ctx.memberId]))
    .digest('hex')
    .slice(0, 16);
  return {
    jid: `${WECOM_MANAGED_WORKSPACE_JID_PREFIX}${digest}`,
    folder: `${WECOM_MANAGED_WORKSPACE_FOLDER_PREFIX}${digest}`,
  };
}

export function isWeComManagedWorkspaceFolder(
  folder: string | undefined,
): boolean {
  return (
    folder === WECOM_MANAGED_WORKSPACE_FOLDER ||
    Boolean(
      folder &&
        folder.startsWith(WECOM_MANAGED_WORKSPACE_FOLDER_PREFIX) &&
        folder.length > WECOM_MANAGED_WORKSPACE_FOLDER_PREFIX.length,
    )
  );
}

export function isWeComManagedWorkspaceJid(jid: string | undefined): boolean {
  return (
    jid === WECOM_MANAGED_WORKSPACE_JID ||
    Boolean(
      jid &&
        jid.startsWith(WECOM_MANAGED_WORKSPACE_JID_PREFIX) &&
        jid.length > WECOM_MANAGED_WORKSPACE_JID_PREFIX.length,
    )
  );
}

function parseWeComC2cJid(
  baseJid: string,
): { corpId: string; memberId: string } | null {
  const prefix = 'wecom:c2c:';
  if (!baseJid.startsWith(prefix)) return null;
  const rest = baseJid.slice(prefix.length);
  const splitAt = rest.indexOf(':');
  if (splitAt <= 0 || splitAt >= rest.length - 1) return null;
  return {
    corpId: rest.slice(0, splitAt),
    memberId: rest.slice(splitAt + 1),
  };
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
    throw new DefinitiveChannelDeliveryError(
      `wecom_blocked:${outcome.reason}`,
    );
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
  readonly outbox: Omit<DeliverChannelOutboxInput, 'delivery'>;
}): Promise<ChannelOutboxDeliveryResult> {
  let capturedOutcome: WeComOutboxDeliveryOutcome | null = null;
  const startedAt = Date.now();
  const result = await deliverChannelOutboxItem({
    ...params.outbox,
    delivery: {
      mode: 'single',
      send: async () => {
        const outcome = await runInWeComOutboxContext(() =>
          params.imManager.sendMessageWithReceipt(
            params.targetJid,
            params.text,
            { correlationId: params.correlationId },
          ),
        );
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

function buildSafeMarketingRuntimePolicy(marketingSkillId?: string) {
  return {
    context: { source: 'managed' as const },
    skills: marketingSkillId
      ? {
          mode: 'custom' as const,
          ids: [marketingSkillId],
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

function isSafeMarketingProfile(
  profile: AgentProfile | undefined,
  marketingSkillId?: string,
): boolean {
  if (
    !profile ||
    profile.status !== 'active' ||
    profile.is_default !== false ||
    profile.name !== WECOM_SAFE_PROFILE_NAME ||
    profile.runtime_policy.context.source !== 'managed' ||
    profile.runtime_policy.skills.host?.mode !== 'disabled' ||
    profile.runtime_policy.mcp.mode !== 'disabled'
  ) {
    return false;
  }
  const skills = profile.runtime_policy.skills;
  if (marketingSkillId) {
    return (
      skills.mode === 'custom' &&
      skills.ids.length === 1 &&
      skills.ids[0] === marketingSkillId
    );
  }
  return skills.mode === 'disabled' && skills.ids.length === 0;
}

function findOrCreateSafeMarketingProfile(
  ownerUserId: string,
  marketingSkillId?: string,
): string {
  const existing = listAgentProfilesForUser(ownerUserId).find(
    (profile) =>
      profile.status === 'active' &&
      !profile.is_default &&
      profile.name === WECOM_SAFE_PROFILE_NAME,
  );
  if (existing) {
    if (isSafeMarketingProfile(existing, marketingSkillId)) {
      return existing.id;
    }
    const updated = updateAgentProfile(existing.id, ownerUserId, {
      runtimePolicy: buildSafeMarketingRuntimePolicy(marketingSkillId),
    });
    return updated?.id ?? existing.id;
  }

  const created = createAgentProfile({
    ownerUserId,
    name: WECOM_SAFE_PROFILE_NAME,
    identityPrompt:
      '你是企业微信非店务营销咨询助手，仅基于当前受控工作区回答内容营销与咨询问题。严禁伪造店务账本、严禁声称已写库或执行脚本。',
    promptMode: 'replace',
    includeClaudePreset: false,
    runtimePolicy: buildSafeMarketingRuntimePolicy(marketingSkillId),
  });
  return created.id;
}

function ensureSafeProfileBinding(
  folder: string,
  ownerUserId: string,
  marketingSkillId?: string,
): void {
  const mappedId = getWorkspaceAgentProfileId(folder);
  const mapped = mappedId ? getAgentProfile(mappedId) : undefined;
  if (isSafeMarketingProfile(mapped, marketingSkillId)) {
    return;
  }
  if (
    mapped &&
    mapped.status === 'active' &&
    !mapped.is_default &&
    mapped.name === WECOM_SAFE_PROFILE_NAME &&
    mapped.owner_user_id === ownerUserId
  ) {
    const updated = updateAgentProfile(mapped.id, ownerUserId, {
      runtimePolicy: buildSafeMarketingRuntimePolicy(marketingSkillId),
    });
    if (updated && isSafeMarketingProfile(updated, marketingSkillId)) {
      return;
    }
  }
  const profileId = findOrCreateSafeMarketingProfile(
    ownerUserId,
    marketingSkillId,
  );
  assignWorkspaceAgentProfile(folder, profileId, 'assistant');
}

function ensureManagedWeComWorkspace(params: {
  workspaceJid: string;
  workspaceFolder?: string;
  workspaceName?: string;
  ownerUserId: string;
  resolveMarketingSkillId?: (ownerUserId: string) => string | undefined;
  getGroup: (jid: string) => RegisteredGroup | undefined;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
  groupsDir: string;
}): RegisteredGroup | undefined {
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
          params.resolveMarketingSkillId?.(params.ownerUserId),
        );
        return migrated;
      }
      const effectiveOwnerId = existing.created_by || params.ownerUserId;
      ensureSafeProfileBinding(
        existing.folder,
        effectiveOwnerId,
        params.resolveMarketingSkillId?.(effectiveOwnerId),
      );
    }
    return existing;
  }

  const defaultFolder =
    params.workspaceJid === WECOM_MANAGED_WORKSPACE_JID
      ? WECOM_MANAGED_WORKSPACE_FOLDER
      : params.workspaceJid.startsWith(WECOM_MANAGED_WORKSPACE_JID_PREFIX)
        ? `${WECOM_MANAGED_WORKSPACE_FOLDER_PREFIX}${params.workspaceJid.slice(WECOM_MANAGED_WORKSPACE_JID_PREFIX.length)}`
        : undefined;
  const folder = params.workspaceFolder ?? defaultFolder;
  if (!folder) {
    return undefined;
  }

  fs.mkdirSync(path.join(params.groupsDir, folder), {
    recursive: true,
  });

  const group: RegisteredGroup = {
    name: params.workspaceName ?? '企微内容营销工作区',
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
    params.resolveMarketingSkillId?.(params.ownerUserId),
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

  const requestedMarketingSkillId = (
    env.FRONT_CLAW_WECOM_MARKETING_SKILL_ID ?? ''
  ).trim();
  const marketingSkillByOwner = new Map<string, string | null>();
  const resolveMarketingSkillForOwner = (
    targetOwnerId: string,
  ): string | undefined => {
    if (!requestedMarketingSkillId) {
      return undefined;
    }
    if (marketingSkillByOwner.has(targetOwnerId)) {
      return marketingSkillByOwner.get(targetOwnerId) ?? undefined;
    }
    const targetSkillsDir =
      deps.userSkillsDir ?? path.join(DATA_DIR, 'skills', targetOwnerId);
    try {
      const synced = ensureBundledWeComMarketingSkill({
        userSkillsDir: targetSkillsDir,
        skillId: requestedMarketingSkillId,
      });
      marketingSkillByOwner.set(targetOwnerId, synced.skillId);
      return synced.skillId;
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
      marketingSkillByOwner.set(targetOwnerId, null);
      return undefined;
    }
  };
  const enabledMarketingSkillId =
    resolveMarketingSkillForOwner(ownerUserId) ?? null;

  const workspaceJid =
    env.FRONT_CLAW_WECOM_WORKSPACE_JID?.trim() || WECOM_MANAGED_WORKSPACE_JID;
  const managedWorkspaceEnabled = workspaceJid === WECOM_MANAGED_WORKSPACE_JID;
  const groupsDir = deps.groupsDir ?? GROUPS_DIR;
  const managedGroup = ensureManagedWeComWorkspace({
    workspaceJid,
    ownerUserId,
    resolveMarketingSkillId: resolveMarketingSkillForOwner,
    getGroup: deps.getGroup,
    registerGroup: deps.registerGroup,
    groupsDir,
  });

  const employeeWorkspaceByChat = new Map<
    string,
    { jid: string; folder: string }
  >();
  const ensureEmployeeTargetWorkspace = (ctx: {
    corpId: string;
    memberId: string;
    displayName?: string;
  }): { jid: string; folder: string } | undefined => {
    if (!managedWorkspaceEnabled) {
      return undefined;
    }
    const derived = deriveEmployeeWeComWorkspace({
      corpId: ctx.corpId,
      botId,
      memberId: ctx.memberId,
    });
    ensureManagedWeComWorkspace({
      workspaceJid: derived.jid,
      workspaceFolder: derived.folder,
      workspaceName: `企微内容营销工作区 (${ctx.displayName || ctx.memberId})`,
      ownerUserId,
      resolveMarketingSkillId: resolveMarketingSkillForOwner,
      getGroup: deps.getGroup,
      registerGroup: deps.registerGroup,
      groupsDir,
    });
    const baseC2cJid = `wecom:c2c:${ctx.corpId}:${ctx.memberId}`;
    employeeWorkspaceByChat.set(baseC2cJid, derived);
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
    if (isWeComManagedWorkspaceJid(existingJid)) {
      ensureManagedWeComWorkspace({
        workspaceJid: existingJid,
        ownerUserId,
        resolveMarketingSkillId: resolveMarketingSkillForOwner,
        getGroup: deps.getGroup,
        registerGroup: deps.registerGroup,
        groupsDir,
      });
      continue;
    }
    if (!existingJid.startsWith('wecom:')) {
      continue;
    }
    const baseJid = channelConversationJid(existingJid);
    const parsedC2c = managedWorkspaceEnabled
      ? parseWeComC2cJid(baseJid)
      : null;
    if (
      parsedC2c &&
      (existingGroup.target_main_jid === WECOM_MANAGED_WORKSPACE_JID ||
        existingGroup.created_by === SYSTEM_WECOM_OWNER_ID)
    ) {
      const derived = ensureEmployeeTargetWorkspace(parsedC2c);
      if (derived && existingJid !== baseJid) {
        deps.registerGroup(existingJid, {
          ...existingGroup,
          created_by:
            existingGroup.created_by === SYSTEM_WECOM_OWNER_ID
              ? ownerUserId
              : existingGroup.created_by,
          channel_account_id: existingGroup.channel_account_id || botId,
          folder: derived.folder,
          target_main_jid: derived.jid,
          executionMode: 'container',
          is_home: false,
        });
      }
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
          displayName: ctx.displayName,
        })?.jid ?? workspaceJid),
    resolveTargetProfile:
      deps.bridgeOptions?.resolveTargetProfile ??
      ((ctx) =>
        resolveTargetProfileSnapshot({
          workspaceJid: ctx.workspaceJid ?? workspaceJid,
          getGroup: deps.getGroup,
        })),
  };

  const rawBridge = await createWeComFrontClawBridge(bridgeOptions);
  const observedPrecheck: WeComFrontClawBridge['precheck'] = async (event) => {
    try {
      const outcome = await rawBridge.precheck(event);
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
        ...(outcome.kind === 'pass' ? { storeId: outcome.storeId } : {}),
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
      const decision = await bridge.authorizeOutbound({
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
    const resolvedTarget = (() => {
      if (!managedWorkspaceEnabled) {
        return {
          jid: workspaceJid,
          folder:
            managedGroup?.folder ??
            deps.getGroup(workspaceJid)?.folder ??
            WECOM_MANAGED_WORKSPACE_FOLDER,
        };
      }
      const cached = employeeWorkspaceByChat.get(baseJid);
      if (cached) return cached;
      const parsedC2c = parseWeComC2cJid(baseJid);
      if (parsedC2c) {
        const derived = ensureEmployeeTargetWorkspace(parsedC2c);
        if (derived) return derived;
      }
      return {
        jid: workspaceJid,
        folder: managedGroup?.folder ?? WECOM_MANAGED_WORKSPACE_FOLDER,
      };
    })();

    deps.onNewChat(ownerUserId, resolvedTarget.folder)(jid, name);
    const group = deps.getGroup(baseJid);
    if (!group) return;
    const withFallback = applyChannelAccountRegistrationFallback(
      group,
      botId,
      resolvedTarget.jid,
    );
    const nextGroup: RegisteredGroup = managedWorkspaceEnabled
      ? {
          ...withFallback,
          created_by:
            withFallback.created_by === SYSTEM_WECOM_OWNER_ID
              ? ownerUserId
              : withFallback.created_by,
          folder: resolvedTarget.folder,
          target_main_jid: resolvedTarget.jid,
          executionMode: 'container',
          is_home: false,
        }
      : withFallback.executionMode === 'host' || withFallback.is_home
        ? { ...withFallback, executionMode: 'container', is_home: false }
        : withFallback;
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
    await bridge.close().catch((err) =>
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
