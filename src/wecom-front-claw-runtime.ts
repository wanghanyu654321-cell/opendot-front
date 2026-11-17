import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { applyChannelAccountRegistrationFallback } from './channel-account-routing.js';
import { channelConversationJid } from './channel-address.js';
import { GROUPS_DIR } from './config.js';
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
} from './db.js';
import type { WeComConnectConfig } from './im-manager.js';
import { IMConnectionManager } from './im-manager.js';
import { logger } from './logger.js';
import { getContainerEnvConfig } from './runtime-config.js';
import { type AgentProfile, RegisteredGroup } from './types.js';
import {
  SAFE_MARKETING_DISALLOWED_TOOLS,
  type TargetAgentProfileSnapshot,
  type WeComFrontClawBridge,
  type WeComFrontClawBridgeOptions,
  createWeComFrontClawBridge,
} from './wecom-front-claw-bridge.js';

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

function isSafeMarketingProfile(profile: AgentProfile | undefined): boolean {
  return Boolean(
    profile &&
      profile.status === 'active' &&
      profile.name === WECOM_SAFE_PROFILE_NAME &&
      profile.runtime_policy.context.source === 'managed' &&
      profile.runtime_policy.skills.host?.mode === 'disabled' &&
      profile.runtime_policy.mcp.mode === 'disabled',
  );
}

function ensureSafeProfileBinding(folder: string, ownerUserId: string): void {
  const mappedId = getWorkspaceAgentProfileId(folder);
  const mapped = mappedId ? getAgentProfile(mappedId) : undefined;
  if (isSafeMarketingProfile(mapped)) {
    return;
  }
  const profileId = findOrCreateSafeMarketingProfile(ownerUserId);
  assignWorkspaceAgentProfile(folder, profileId, 'assistant');
}

function ensureManagedWeComWorkspace(params: {
  workspaceJid: string;
  workspaceFolder?: string;
  workspaceName?: string;
  ownerUserId: string;
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
        ensureSafeProfileBinding(migrated.folder, params.ownerUserId);
        return migrated;
      }
      ensureSafeProfileBinding(
        existing.folder,
        existing.created_by || params.ownerUserId,
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
  ensureSafeProfileBinding(group.folder, params.ownerUserId);

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

  const workspaceJid =
    env.FRONT_CLAW_WECOM_WORKSPACE_JID?.trim() || WECOM_MANAGED_WORKSPACE_JID;
  const managedWorkspaceEnabled = workspaceJid === WECOM_MANAGED_WORKSPACE_JID;
  const groupsDir = deps.groupsDir ?? GROUPS_DIR;
  const managedGroup = ensureManagedWeComWorkspace({
    workspaceJid,
    ownerUserId,
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

  const bridgeOptions: WeComFrontClawBridgeOptions = {
    ...deps.bridgeOptions,
    env: deps.bridgeOptions?.env ?? env,
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

  const bridge = await createWeComFrontClawBridge(bridgeOptions);
  if (deps.startMaintenance !== false) {
    bridge.startMaintenance();
  }

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
