import fs from 'node:fs';
import path from 'node:path';
import { applyChannelAccountRegistrationFallback } from './channel-account-routing.js';
import { channelConversationJid } from './channel-address.js';
import { GROUPS_DIR } from './config.js';
import {
  assignWorkspaceAgentProfile,
  createAgentProfile,
  getAgentProfileForWorkspace,
  getEarliestActiveAdmin,
  listAgentProfilesForUser,
  listUsers,
} from './db.js';
import type { WeComConnectConfig } from './im-manager.js';
import { IMConnectionManager } from './im-manager.js';
import { logger } from './logger.js';
import { getContainerEnvConfig } from './runtime-config.js';
import { RegisteredGroup } from './types.js';
import {
  SAFE_MARKETING_DISALLOWED_TOOLS,
  type TargetAgentProfileSnapshot,
  type WeComFrontClawBridge,
  type WeComFrontClawBridgeOptions,
  createWeComFrontClawBridge,
} from './wecom-front-claw-bridge.js';

export const WECOM_MANAGED_WORKSPACE_JID = 'web:wecom-front-claw';
export const WECOM_MANAGED_WORKSPACE_FOLDER = 'wecom-front-claw';
export const WECOM_SAFE_PROFILE_NAME = 'Front Claw Safe Marketing';

const SYSTEM_WECOM_OWNER_ID = 'front-claw-system';
const DEFAULT_LEASE_CHECK_INTERVAL_MS = 1000;

export interface WeComFrontClawRuntimeDeps {
  readonly env?: Record<string, string | undefined>;
  readonly imManager: IMConnectionManager;
  readonly getGroup: (jid: string) => RegisteredGroup | undefined;
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
}

export interface WeComFrontClawRuntimeHandle {
  readonly botId: string;
  readonly ownerUserId: string;
  readonly workspaceJid: string;
  readonly workspaceFolder: string;
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
  if (explicit) {
    return { userId: explicit, hasPersistedUser: true };
  }
  const configured = env.FRONT_CLAW_WECOM_OWNER_USER_ID?.trim();
  if (configured) {
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

function findOrCreateSafeMarketingProfile(ownerUserId: string): string {
  const existing = listAgentProfilesForUser(ownerUserId).find(
    (profile) =>
      profile.status === 'active' &&
      profile.name === WECOM_SAFE_PROFILE_NAME &&
      profile.runtime_policy.context.source === 'managed' &&
      profile.runtime_policy.skills.host?.mode === 'disabled' &&
      profile.runtime_policy.mcp.mode === 'disabled',
  );
  if (existing) return existing.id;

  const created = createAgentProfile({
    ownerUserId,
    name: WECOM_SAFE_PROFILE_NAME,
    identityPrompt:
      '你是企业微信非店务营销咨询助手，仅基于当前受控工作区回答内容营销与咨询问题。严禁伪造店务账本、严禁声称已写库或执行脚本。',
    promptMode: 'replace',
    includeClaudePreset: false,
    runtimePolicy: {
      context: { source: 'managed' },
      skills: { mode: 'disabled', host: { mode: 'disabled' } },
      mcp: { mode: 'disabled' },
    },
  });
  return created.id;
}

function ensureManagedWeComWorkspace(params: {
  workspaceJid: string;
  ownerUserId: string;
  getGroup: (jid: string) => RegisteredGroup | undefined;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
  groupsDir: string;
}): RegisteredGroup | undefined {
  const existing = params.getGroup(params.workspaceJid);
  if (existing) {
    return existing;
  }
  if (params.workspaceJid !== WECOM_MANAGED_WORKSPACE_JID) {
    return undefined;
  }

  fs.mkdirSync(path.join(params.groupsDir, WECOM_MANAGED_WORKSPACE_FOLDER), {
    recursive: true,
  });

  const group: RegisteredGroup = {
    name: '企微内容营销工作区',
    folder: WECOM_MANAGED_WORKSPACE_FOLDER,
    added_at: new Date().toISOString(),
    created_by: params.ownerUserId,
    is_home: false,
    executionMode: 'container',
  };
  params.registerGroup(WECOM_MANAGED_WORKSPACE_JID, group);

  const boundProfile = getAgentProfileForWorkspace(
    group.folder,
    group.created_by,
  );
  if (!boundProfile) {
    const profileId = findOrCreateSafeMarketingProfile(params.ownerUserId);
    assignWorkspaceAgentProfile(group.folder, profileId, 'assistant');
  }

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
    logger.warn(
      { botId },
      'No active OpenDot user found; WeCom passthrough outbound replies require an initialized admin/user',
    );
  }
  const ownerUserId = ownerResolution.userId;

  const workspaceJid =
    env.FRONT_CLAW_WECOM_WORKSPACE_JID?.trim() || WECOM_MANAGED_WORKSPACE_JID;
  const groupsDir = deps.groupsDir ?? GROUPS_DIR;
  const managedGroup = ensureManagedWeComWorkspace({
    workspaceJid,
    ownerUserId,
    getGroup: deps.getGroup,
    registerGroup: deps.registerGroup,
    groupsDir,
  });

  const bridgeOptions: WeComFrontClawBridgeOptions = {
    ...deps.bridgeOptions,
    env: deps.bridgeOptions?.env ?? env,
    resolveWorkspaceJid:
      deps.bridgeOptions?.resolveWorkspaceJid ?? (() => workspaceJid),
    resolveTargetProfile:
      deps.bridgeOptions?.resolveTargetProfile ??
      ((ctx) =>
        resolveTargetProfileSnapshot({
          workspaceJid: ctx.workspaceJid ?? workspaceJid,
          getGroup: deps.getGroup,
        })),
  };

  const bridge = await createWeComFrontClawBridge(bridgeOptions);
  if (deps.startMaintenance !== false) {
    bridge.startMaintenance();
  }

  const baseOnNewChat = deps.onNewChat(
    ownerUserId,
    managedGroup?.folder ?? WECOM_MANAGED_WORKSPACE_FOLDER,
  );
  const onNewChat = (jid: string, name: string) => {
    baseOnNewChat(jid, name);
    const baseJid = channelConversationJid(jid);
    const group = deps.getGroup(baseJid);
    if (!group) return;
    const withFallback = applyChannelAccountRegistrationFallback(
      group,
      botId,
      workspaceJid,
    );
    const safeGroup: RegisteredGroup =
      withFallback.executionMode === 'host' || withFallback.is_home
        ? { ...withFallback, executionMode: 'container', is_home: false }
        : withFallback;
    if (safeGroup !== group) {
      deps.registerGroup(baseJid, safeGroup);
    }
  };

  const connected = await deps.imManager.connectUserWeCom(
    ownerUserId,
    {
      botId,
      secret,
      enabled: true,
      precheck: bridge.precheck,
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
    },
  );

  if (!connected) {
    logger.warn(
      { botId, driver: bridge.driver, leaseHeld: bridge.leaseHeld() },
      'WeCom channel failed to connect; closing Front Claw bridge',
    );
    await bridge.close().catch((err) =>
      logger.warn({ err, botId }, 'Error closing Front Claw bridge after failed WeCom connect'),
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
