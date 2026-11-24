import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import type { WsFrame } from '@wecom/aibot-node-sdk';
import { ACCESS_DENIED } from '../packages/front-claw/src/role-eval/employee-loop.js';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest';

const { WSClient, WsCmd } = createRequire(import.meta.url)(
  '@wecom/aibot-node-sdk',
) as typeof import('@wecom/aibot-node-sdk');

const log = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

const probeScript = vi.hoisted(
  () => `
let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { raw += chunk; });
process.stdin.on('end', () => {
  const input = JSON.parse(raw);
  const forbiddenKeys = Object.keys(process.env).filter((k) =>
    /^(FRONT_CLAW_|DATABASE_URL$|PG|CORE_ENV_FILE$|ADMIN_ENV_FILE$|WECOM_BOT_SECRET$)/i.test(k)
  );
  const report = {
    forbiddenKeys,
    disallowedToolsEnv: process.env.MINICLAW_AGENT_DISALLOWED_TOOLS ?? null,
    mcpPolicyEnv: process.env.MINICLAW_AGENT_MCP_POLICY ?? null,
    profileDisallowedTools: input.agentProfile?.disallowedTools ?? null,
    executionMode: input.groupFolder,
  };
  console.log('---MINICLAW_OUTPUT_START---');
  console.log(JSON.stringify({ status: 'success', result: JSON.stringify(report) }));
  console.log('---MINICLAW_OUTPUT_END---');
});
`,
);

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn(
      command: string,
      args?: readonly string[],
      options?: import('node:child_process').SpawnOptions,
    ) {
      if (
        Array.isArray(args) &&
        args.length === 1 &&
        typeof args[0] === 'string' &&
        args[0].endsWith('pi-index.js')
      ) {
        return actual.spawn(
          process.execPath,
          ['-e', probeScript],
          options ?? {},
        );
      }
      return actual.spawn(command, args ?? [], options ?? {});
    },
  };
});

vi.mock('../src/config.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/config.js')>();
  const nodeFs = await import('node:fs');
  const nodeOs = await import('node:os');
  const nodePath = await import('node:path');
  const isolatedRoot = nodeFs.mkdtempSync(
    nodePath.join(nodeOs.tmpdir(), 'wecom-opendot-e2e-'),
  );
  return {
    ...original,
    DATA_DIR: isolatedRoot,
    STORE_DIR: nodePath.join(isolatedRoot, 'db'),
    GROUPS_DIR: nodePath.join(isolatedRoot, 'groups'),
  };
});

vi.mock('../src/logger.js', () => ({ logger: log }));

import { DATA_DIR as tmp } from '../src/config.js';

import * as db from '../src/db.js';
import { resolveStickyChannelOwner } from '../src/channel-session-owner.js';
import { createHash } from 'node:crypto';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base';
import { IMConnectionManager } from '../src/im-manager.js';
import { runHostAgent } from '../src/container-runner.js';
import { ChannelTurnRuntime } from '../src/channel-turn-runtime.js';
import { getChannelOutboxItem } from '../src/channel-reliability-store.js';
import { resolveEffectiveSkills } from '../src/effective-skill-resolver.js';
import {
  HostObservability,
  observeWeComAgentTurn,
} from '../src/personal-agent/host-observability.js';
import type { RegisteredGroup } from '../src/types.js';
import {
  BRIDGE_AGENT_GUARDRAIL_DENIED_REPLY,
  SAFE_MARKETING_DISALLOWED_TOOLS,
  validateTargetAgentProfile,
} from '../src/wecom-front-claw-bridge.js';
import {
  D175_INTERLEAVED_GUIDANCE,
  STALE_CONSUMER,
} from '../packages/front-claw/src/role-eval/employee-loop.js';
import {
  decodeStatus,
  encodeStatus,
  outboxManaged,
} from '../packages/front-claw/src/role-eval/notification-status.js';
import {
  WECOM_MANAGED_WORKSPACE_FOLDER,
  WECOM_MANAGED_WORKSPACE_JID,
  WECOM_SAFE_PROFILE_NAME,
  WECOM_SAFE_ROLE_PROFILE_NAMES,
  deliverWeComTextViaOutbox,
  deriveEmployeeWeComWorkspace,
  deriveWeComEmployeeWorkspace,
  isWeComManagedWorkspaceFolder,
  isWeComManagedWorkspaceJid,
  normalizeWeComObservationErrorCategory,
  normalizeWeComObservationGateReason,
  normalizeWeComObservationRoute,
  startWeComFrontClawRuntime,
} from '../src/wecom-front-claw-runtime.js';
import {
  WECOM_ROLE_SKILL_IDS,
  type WeComSoftRole,
} from '../src/wecom-front-claw-skills.js';
import { parseTrainingSummary } from '../packages/front-claw/src/role-eval/training-knowledge.js';
import {
  DEFAULT_ALLOWED_TOOLS,
  isToolDisallowed,
  resolveDisallowedToolSet,
} from '../container/agent-runner/src/tool-policy.js';
import { PiRuntimeAdapter } from '../container/agent-runner/src/runtime/pi/pi-runtime.js';
import {
  ACCESS_POLICY_KEY,
  CAPABILITIES,
  parseAccessPolicy,
  updateAccessPolicy,
  type AccessPolicy,
} from '../packages/front-claw/src/role-eval/access-policy.js';
import { APPOINTMENT_RECIPIENTS_KEY } from '../packages/front-claw/src/role-eval/appointments.js';
import { createPostgresBindingStore } from '../packages/front-claw/src/role-eval/directory-store.js';
import {
  createPostgresPerformanceStore,
  migratePerformance,
} from '../packages/front-claw/src/role-eval/performance-postgres.js';
import { migrateUp } from '../packages/front-claw/src/role-eval/schema-migrations.js';
import type {
  Appointment,
  Draft,
  Notification,
  PerformanceStore,
  Person,
} from '../packages/front-claw/src/role-eval/performance-store.js';
import { CONSUMER_LEASE_KEY } from '../packages/front-claw/src/opendot/consumer-lease.js';
import { parseLeaseRecord } from '../packages/front-claw/src/role-eval/fencing.js';
import { MemorySql } from '../packages/front-claw/tests/role-eval/sql-fixture.js';
import {
  PG_STOP_HOOK_TIMEOUT_MS,
  startPgCluster,
} from '../packages/front-claw/tests/helpers/pg-cluster.js';
import {
  openPerformanceStore,
  readPerformanceMigration,
} from '../packages/front-claw/src/role-eval/performance-open.js';
import { openSql } from '../packages/front-claw/src/migration/pg.js';

const BOT_ID = 'bot-e2e-1';
const CORP_ID = 'ww-e2e-corp';
const activeCleanups: Array<() => Promise<void> | void> = [];

interface SentWireFrame {
  cmd: string;
  headers: { req_id: string };
  body: Record<string, unknown>;
}

function createOfflineWsClient(options: {
  botId?: string;
  suppressAck?: (frame: SentWireFrame) => boolean;
  ackFor?: (
    frame: SentWireFrame,
    index: number,
  ) => { errcode: number; errmsg?: string } | null;
} = {}) {
  const botId = options.botId ?? BOT_ID;
  const client = new WSClient({
    botId,
    secret: 'synthetic-e2e-secret',
    maxReconnectAttempts: 0,
    maxAuthFailureAttempts: 0,
    requestTimeout: 4000,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  });

  const wsManager = Reflect.get(client, 'wsManager') as {
    ws: { readyState: number; send(raw: string): void; terminate(): void } | null;
    onAuthenticated(): void;
    handleFrame(frame: WsFrame): void;
    clearPendingMessages(reason: string): void;
  };

  const sent: SentWireFrame[] = [];
  let suppressAck = options.suppressAck ?? (() => false);
  let ackFor = options.ackFor;

  const mockWs = {
    readyState: 3,
    send(raw: string) {
      const parsed = JSON.parse(raw) as SentWireFrame;
      const frameIndex = sent.length;
      sent.push(parsed);
      const ack = ackFor
        ? ackFor(parsed, frameIndex)
        : suppressAck(parsed)
          ? null
          : { errcode: 0 };
      if (ack !== null) {
        queueMicrotask(() => {
          wsManager.handleFrame({
            headers: { req_id: parsed.headers.req_id },
            errcode: ack.errcode,
            ...(ack.errmsg !== undefined ? { errmsg: ack.errmsg } : {}),
            body: {},
          });
        });
      }
    },
    terminate() {
      mockWs.readyState = 3;
    },
  };
  wsManager.ws = mockWs;

  vi.spyOn(client, 'connect').mockImplementation(() => {
    Reflect.set(client, 'started', true);
    mockWs.readyState = 1;
    wsManager.ws = mockWs;
    wsManager.onAuthenticated();
    return client;
  });

  vi.spyOn(client, 'disconnect').mockImplementation(() => {
    Reflect.set(client, 'started', false);
    mockWs.readyState = 3;
    wsManager.clearPendingMessages('offline_disconnect');
    wsManager.ws = null;
  });

  activeCleanups.push(() => {
    mockWs.readyState = 3;
    wsManager.clearPendingMessages('test_cleanup');
  });

  return {
    client,
    sent,
    setSuppressAck(fn: (frame: SentWireFrame) => boolean) {
      suppressAck = fn;
      ackFor = undefined;
    },
    setAckFor(
      fn:
        | ((
            frame: SentWireFrame,
            index: number,
          ) => { errcode: number; errmsg?: string } | null)
        | undefined,
    ) {
      ackFor = fn;
    },
    emitInboundText(params: {
      reqId: string;
      msgid: string;
      userid: string;
      content: string;
      corpid?: string;
      createTime?: number;
    }) {
      wsManager.handleFrame({
        cmd: WsCmd.CALLBACK,
        headers: { req_id: params.reqId },
        body: {
          msgid: params.msgid,
          aibotid: botId,
          msgtype: 'text',
          chattype: 'single',
          create_time:
            params.createTime ?? Math.floor(Date.now() / 1000) + 10,
          from: {
            userid: params.userid,
            ...(params.corpid !== undefined ? { corpid: params.corpid } : {}),
          },
          text: { content: params.content },
        },
      });
    },
  };
}

function buildPolicy(version: number): AccessPolicy {
  const allCaps = [...CAPABILITIES];
  return {
    version,
    enterprise: allCaps,
    stores: { 's-b': allCaps },
    roles: {
      employee: [
        'report_self',
        'report_proxy',
        'progress_self',
        'marketing',
        'appointment_submit',
      ],
      manager: allCaps,
      owner: allCaps,
    },
    members: {
      'p-zhao': {
        role: 'employee',
        storeIds: ['s-b'],
        status: 'active',
        capabilities: ['marketing'],
      },
      'p-lin': { role: 'employee', storeIds: ['s-b'], status: 'active' },
      'p-wang': { role: 'manager', storeIds: ['s-b'], status: 'active' },
    },
  };
}

async function createSeededMemoryWorld(now: () => Date) {
  const sql = new MemorySql();
  await migratePerformance(sql);
  const pgStore = createPostgresPerformanceStore(sql, { deliveryColumns: true });
  const bindings = createPostgresBindingStore(sql);
  const store: PerformanceStore = {
    ...pgStore,
    async claimDueNotifications(options) {
      const all = await pgStore.listNotifications();
      const claimed: Notification[] = [];
      const expired: Notification[] = [];
      for (const item of all) {
        if (claimed.length + expired.length >= options.limit) break;
        if (!options.kinds.includes(item.kind) || !outboxManaged(item.notificationId)) {
          continue;
        }
        const raw = item.delivery?.raw ?? item.status;
        const parsed = decodeStatus(raw);
        if (parsed.status !== 'pending') continue;
        const phase = parsed.delivery.phase;
        const dueAt = parsed.delivery.dueAt;
        if (phase === 'queued' && dueAt && dueAt > options.nowIso) continue;
        if ((phase === 'claimed' || phase === 'sending') && (!dueAt || dueAt > options.nowIso)) {
          continue;
        }
        const fence = parsed.delivery.fence + 1;
        if (phase === 'sending') {
          const nextRaw = encodeStatus('unknown', {
            attempts: parsed.delivery.attempts,
            resends: parsed.delivery.resends,
            fence,
            error: 'lease_expired_during_send',
          });
          await sql.query(
            'UPDATE front_claw_perf.performance_notifications SET status=$1 WHERE notification_id=$2 AND status=$3',
            [nextRaw, item.notificationId, raw],
          );
          const refreshed = (await pgStore.listNotifications()).find(
            (n) => n.notificationId === item.notificationId,
          );
          if (refreshed) expired.push(refreshed);
          continue;
        }
        const nextRaw = encodeStatus('pending', {
          phase: 'claimed',
          dueAt: options.leaseUntil,
          attempts: parsed.delivery.attempts,
          resends: parsed.delivery.resends,
          fence,
          token: options.tokenFor(item.notificationId),
          worker: options.worker,
          error: parsed.delivery.error,
        });
        await sql.query(
          'UPDATE front_claw_perf.performance_notifications SET status=$1 WHERE notification_id=$2 AND status=$3',
          [nextRaw, item.notificationId, raw],
        );
        const refreshed = (await pgStore.listNotifications()).find(
          (n) => n.notificationId === item.notificationId,
        );
        if (refreshed) claimed.push(refreshed);
      }
      return { claimed, expired };
    },
    async beginNotificationSend(notificationId, expectedRaw, options) {
      const currentRow = (await pgStore.listNotifications()).find(
        (n) => n.notificationId === notificationId,
      );
      if (!currentRow || (currentRow.delivery?.raw ?? currentRow.status) !== expectedRaw) {
        return 'lost';
      }
      const config: Record<string, string | null> = {};
      for (const key of options.lockKeys) {
        config[key] = await pgStore.getConfig(key);
      }
      const people: Record<string, Person | null> = {};
      for (const id of options.personIds ?? []) {
        people[id] = await pgStore.getPerson(id);
      }
      const drafts: Record<string, Draft | null> = {};
      for (const id of options.draftIds ?? []) {
        drafts[id] = await pgStore.getDraft(id);
      }
      const appointments: Record<string, Appointment | null> = {};
      const allAppts = await pgStore.listAppointments();
      for (const id of options.appointmentIds ?? []) {
        appointments[id] = allAppts.find((a) => a.appointmentId === id) ?? null;
      }
      const decision = options.decide(config, currentRow, {
        people,
        drafts,
        appointments,
      });
      if (!decision.nextRaw) return 'lost';
      await sql.query(
        'UPDATE front_claw_perf.performance_notifications SET status=$1 WHERE notification_id=$2 AND status=$3',
        [decision.nextRaw, notificationId, expectedRaw],
      );
      return decision.ok ? 'sending' : 'refused';
    },
    async transitionNotification(notificationId, expectedRaw, nextRaw, sentAt) {
      const res = await sql.query(
        'UPDATE front_claw_perf.performance_notifications SET status=$1, sent_at=$2 WHERE notification_id=$3 AND status=$4 RETURNING notification_id',
        [nextRaw, sentAt, notificationId, expectedRaw],
      );
      return res.rows.length > 0;
    },
  };

  const people: Person[] = [
    {
      personId: 'p-zhao',
      accountId: 'a-zhao',
      memberId: 'm-zhao',
      displayName: '小赵',
      storeId: 's-b',
      storeName: '测试B店',
      tier: 'employee',
      roles: ['marketing'],
      active: true,
    },
    {
      personId: 'p-lin',
      accountId: 'a-lin',
      memberId: 'm-lin',
      displayName: '小林',
      storeId: 's-b',
      storeName: '测试B店',
      tier: 'employee',
      roles: [],
      active: true,
    },
    {
      personId: 'p-wang',
      accountId: 'a-wang',
      memberId: 'm-wang-yj',
      displayName: '王店长',
      storeId: 's-b',
      storeName: '测试B店',
      tier: 'manager',
      roles: ['marketing'],
      active: true,
    },
  ];
  for (const person of people) {
    await store.savePerson(person);
  }
  await store.setConfig(
    'employee-loop:m01',
    JSON.stringify({
      enabled: true,
      storeId: 's-b',
      memberIds: people.map((p) => p.memberId),
    }),
  );
  await store.setConfig(
    APPOINTMENT_RECIPIENTS_KEY,
    JSON.stringify({ version: 1, stores: { 's-b': 'p-wang' } }),
  );
  await bindings.saveBinding({
    botId: BOT_ID,
    corpId: CORP_ID,
    memberId: 'm-zhao',
    accountId: 'a-zhao',
    version: 1,
    active: true,
  });
  await bindings.saveBinding({
    botId: BOT_ID,
    corpId: CORP_ID,
    memberId: 'm-lin',
    accountId: 'a-lin',
    version: 1,
    active: true,
  });
  await bindings.saveBinding({
    botId: BOT_ID,
    corpId: CORP_ID,
    memberId: 'm-wang-yj',
    accountId: 'a-wang',
    version: 1,
    active: true,
  });
  const policyInit = await updateAccessPolicy(store, {
    expectedVersion: null,
    next: buildPolicy(1),
    actor: 'e2e-admin',
    reason: 'init',
    at: now().toISOString(),
  });
  expect(policyInit.ok).toBe(true);

  return {
    sql,
    store,
    bindings,
    async open() {
      return {
        driver: 'postgres' as const,
        store,
        bindings,
        withGrantTransaction: async (work) => {
          await work({
            store,
            bindings,
            lockIdentity: async () => {},
          });
        },
        close: async () => {},
      };
    },
  };
}

function resetOpenDotSqliteState() {
  const existingGroups = db.getAllRegisteredGroups();
  for (const jid of Object.keys(existingGroups)) {
    db.deleteRegisteredGroup(jid);
  }
  const existingUsers = db.listUsers({ pageSize: 100 }).users;
  for (const u of existingUsers) {
    if (u.id !== 'admin-e2e' && u.status !== 'deleted') {
      db.deleteUser(u.id);
    }
  }
  const adminE2e = db.getUserById('admin-e2e');
  if (!adminE2e) {
    db.createUser({
      id: 'admin-e2e',
      username: 'admin-e2e',
      password_hash: 'hash',
      display_name: 'E2E Admin',
      role: 'admin',
      status: 'active',
      permissions: [],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
  } else if (adminE2e.status !== 'active') {
    db.updateUserFields('admin-e2e', {
      status: 'active',
      role: 'admin',
      deleted_at: null,
      disable_reason: null,
    });
  }
}

async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 3000,
  stepMs = 15,
  describeTimeout?: () => string | Promise<string>,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  const detail = describeTimeout ? await describeTimeout() : '';
  throw new Error(`Timed out waiting for condition${detail ? `: ${detail}` : ''}`);
}

function createRuntimeWiringHarness(
  groupsMap: Record<string, RegisteredGroup>,
  ownerUserId = 'admin-e2e',
) {
  return {
    getGroup: (jid: string) => groupsMap[jid] ?? db.getRegisteredGroup(jid),
    registerGroup: (jid: string, group: RegisteredGroup) => {
      db.setRegisteredGroup(jid, group);
      groupsMap[jid] = group;
    },
    onNewChat:
      (userId: string, homeFolder: string) =>
      (chatJid: string, chatName: string) => {
        if (groupsMap[chatJid]) return;
        const created: RegisteredGroup = {
          name: chatName,
          folder: homeFolder,
          added_at: new Date().toISOString(),
          created_by: userId,
          executionMode: 'container',
          is_home: false,
        };
        db.setRegisteredGroup(chatJid, created);
        groupsMap[chatJid] = created;
      },
    resolveEffectiveChatJid: (chatJid: string) => {
      const group = groupsMap[chatJid] ?? db.getRegisteredGroup(chatJid);
      if (!group?.target_main_jid) return null;
      return { effectiveJid: group.target_main_jid, agentId: null };
    },
    resolveGroupFolder: (jid: string) => groupsMap[jid]?.folder,
    ownerUserId,
  };
}

beforeAll(() => {
  fs.mkdirSync(path.join(tmp, 'db'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'groups'), { recursive: true });
  db.initDatabase();
});

afterAll(() => {
  db.closeDatabase();
  fs.rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => {
  vi.clearAllMocks();
  resetOpenDotSqliteState();
});

afterEach(async () => {
  while (activeCleanups.length > 0) {
    await activeCleanups.pop()?.();
  }
}, Math.max(30_000, PG_STOP_HOOK_TIMEOUT_MS));

describe('OpenDot × Front Claw E2E Convergence & Hard Gates', () => {
  test('separates employee marketing workspaces when the same member moves stores', () => {
    const identity = { corpId: CORP_ID, botId: BOT_ID, memberId: 'm-zhao' };
    expect(
      deriveEmployeeWeComWorkspace({ ...identity, storeId: 's-a' }).jid,
    ).not.toBe(
      deriveEmployeeWeComWorkspace({ ...identity, storeId: 's-b' }).jid,
    );
  });

  test.each([
    ['transfer', '经营汇总', '测试B店'],
    ['revoke-read', '经营汇总', '测试B店'],
    ['narrow-stores', '门店排名', 's-a'],
    ['mixed-denial', '经营汇总', ACCESS_DENIED],
    ['mixed-valid', '经营汇总', ACCESS_DENIED],
    ['target-valid', '给小赵定本月目标3万', '已经是 30000元'],
    ['target-revoked', '给小赵定本月目标3万', '已经是 30000元'],
    ['store-target-valid', '给本店定本月目标3万', '已经是 30000元'],
    ['store-target-revoked', '给本店定本月目标3万', '已经是 30000元'],
    ['picker-valid', '把许姐那笔改成860', '小赵'],
    ['picker-revoked', '把许姐那笔改成860', '小赵'],
    ['picker-confirm-valid', '对', '小赵'],
    ['picker-confirm-revoked', '对', '小赵'],
    ['picker-query-revoked', '入账结果', '小赵'],
    ['picker-query-valid', '入账结果', '小赵'],
    ['picker-query-progress-revoked', '入账结果', '小赵'],
    ['picker-legacy-store-valid', '对', '今天本店'],
    ['picker-legacy-store-revoked', '对', '今天本店'],
    ['picker-legacy-own-valid', '对', '今天由你报的'],
    ['picker-missing-valid', '改 9', '没有第9笔'],
    ['picker-missing-revoked', '改 9', '没有第9笔'],
    ['picker-stale-valid', '改 1', '在你指定前已被改动'],
    ['picker-stale-revoked', '改 1', '在你指定前已被改动'],
  ])(
    'holds a completed business read until its authority is rechecked at SDK reply (%s)',
    async (change, query, expected) => {
      const now = () => new Date('2026-11-12T06:00:00Z');
      const world = await createSeededMemoryWorld(now);
      const targetRead = change.includes('target');
      const picker = change.startsWith('picker-');
      const legacyPicker = change.startsWith('picker-legacy-');
      const ownPicker = change === 'picker-legacy-own-valid';
      const allowed = change.endsWith('-valid');
      if (ownPicker) {
        const next = buildPolicy(2);
        next.members['p-wang']!.capabilities = ['correct_own', 'progress_self'];
        expect((await updateAccessPolicy(world.store, {
          expectedVersion: 1, next, actor: 'test-admin',
          reason: 'create own-only picker', at: now().toISOString(),
        })).ok).toBe(true);
      }
      if (picker) {
        await world.store.insertEntries(
          [68000, 56000].map((amount, i) => ({
            entryId: 'pick-' + i,
            storeId: 's-b',
            businessDay: '2026-11-12',
            ownerPersonId: legacyPicker ? 'p-wang' : 'p-zhao',
            ownerName: legacyPicker ? '苏晓禾' : '小赵',
            reporterPersonId: legacyPicker ? 'p-wang' : 'p-zhao',
            customerName: '许姐',
            amount,
            amountType: 'consultant',
            note: '',
            status: 'confirmed',
            disputed: false,
            createdAt: '2026-11-12T03:00:00Z',
          })),
        );
      }
      if (targetRead) {
        const target = {
          storeId: 's-b',
          periodMonth: '2026-11',
          amount: 3000000,
          updatedAt: now().toISOString(),
        };
        if (change.startsWith('store-target-'))
          await world.store.saveStoreTarget({ ...target, setBy: 'p-wang' });
        else
          await world.store.saveTarget({
            ...target,
            personId: 'p-zhao',
            updatedBy: 'p-wang',
          });
      }
      if (change.startsWith('mixed-')) {
        for (const person of await world.store.listPeople()) {
          await world.store.savePerson({
            ...person,
            storeName: '测试B店 ' + ACCESS_DENIED,
          });
        }
      }
      if (change === 'narrow-stores') {
        const person = (await world.store.getPerson('p-wang'))!;
        await world.store.savePerson({ ...person, tier: 'owner' });
        const policy = buildPolicy(2);
        policy.members['p-wang'] = {
          role: 'owner',
          storeIds: ['s-b', 's-a'],
          status: 'active',
        };
        policy.stores['s-a'] = [...CAPABILITIES];
        expect(
          (
            await updateAccessPolicy(world.store, {
              expectedVersion: 1,
              next: policy,
              actor: 'test-admin',
              reason: 'authorize two stores',
              at: now().toISOString(),
            })
          ).ok,
        ).toBe(true);
      }
      const offline = createOfflineWsClient();
      const imManager = new IMConnectionManager();
      const connect = imManager.connectUserWeCom.bind(imManager);
      let original = '';
      vi.spyOn(imManager, 'connectUserWeCom').mockImplementation(
        (user, config, onNewChat, opts) =>
          connect(
            user,
            {
              ...config,
              precheck: async (event) => {
                const result = await config.precheck!(event);
                if (event.messageId === 'read-before-transfer') {
                  if (result.kind === 'pass')
                    throw Error('expected a business reply');
                  original = result.replies.join('');
                  const person = (await world.store.getPerson('p-wang'))!;
                  if (change === 'transfer')
                    await world.store.savePerson({ ...person, storeId: 's-a' });
                  else if (!allowed) {
                    const policy = JSON.parse(
                      (await world.store.getConfig('front-claw-access'))!,
                    ) as AccessPolicy;
                    const next = structuredClone(policy);
                    next.version++;
                    if (change === 'narrow-stores')
                      next.members['p-wang']!.storeIds = ['s-b'];
                    else if (change === 'picker-query-progress-revoked')
                      next.members['p-wang']!.capabilities = ['correct_store', 'correct_own', 'marketing'];
                    else
                      next.members['p-wang']!.capabilities = [
                        'progress_self',
                        'marketing',
                        ...(legacyPicker ? ['correct_own' as const] : []),
                      ];
                    expect(
                      (
                        await updateAccessPolicy(world.store, {
                          expectedVersion: policy.version,
                          next,
                          actor: 'test-admin',
                          reason: 'revoke business read',
                          at: now().toISOString(),
                        })
                      ).ok,
                    ).toBe(true);
                  }
                }
                return result;
              },
            },
            onNewChat,
            opts,
          ),
      );
      const runtime = await startWeComFrontClawRuntime({
        env: {
          FRONT_CLAW_WECOM_ENABLED: '1',
          FRONT_CLAW_WECOM_BOT_ID: BOT_ID,
          FRONT_CLAW_WECOM_BOT_SECRET: 'test-secret',
          FRONT_CLAW_NOTIFY_DISPATCH: '0',
          ...(ownPicker ? { FRONT_CLAW_WECOM_AUTO_ROLE_GRANT: '0' } : {}),
        },
        imManager,
        ...createRuntimeWiringHarness({}),
        startMaintenance: false,
        wecomConnection: { client: offline.client },
        bridgeOptions: {
          now,
          open: world.open,
          modelClassify: async () => ({
            intent: 'query',
            object: 'summary',
            action: null,
            slots: {},
            confidence: 0.99,
            uncertain: false,
          }),
          lease: {
            enabled: true,
            owner: 'test-read-fence',
            ttlMs: 5000,
            renewMs: 1000,
          },
        },
      });
      activeCleanups.push(async () => {
        await runtime!.close();
        await imManager.disconnectAll();
      });
      if (picker && query !== '把许姐那笔改成860') {
        offline.emitInboundText({
          reqId: 'open-picker',
          msgid: 'open-picker',
          corpid: CORP_ID,
          userid: 'm-wang-yj',
          content: '把许姐那笔改成860',
        });
        await waitUntil(() =>
          offline.sent.some((frame) => frame.headers.req_id === 'open-picker'),
        );
        if (change.startsWith('picker-stale-')) {
          await world.store.reviseEntry('pick-0', { amount: 71000 }, {
            editorPersonId: 'p-wang',
            reason: 'changed after listing',
            createdAt: now().toISOString(),
            revisionId: 'picker-revision',
          });
        }
        if (legacyPicker) {
          const draft = await world.store.getOpenDraft('p-wang');
          if (draft?.payload.type !== 'correction' || !draft.payload.awaitingPick)
            throw Error('expected a correction picker');
          const payload = draft.payload;
          const { newAmount, listed, reason } = payload.awaitingPick!;
          expect(listed.map((row) => row.visibility)).toEqual(['own', 'own']);
          payload.scope = 'own';
          payload.awaitingPick = { newAmount, listed, reason };
          payload.employeeContext.itemsDigest = createHash('sha256')
            .update(JSON.stringify(['correction', 'amend', 'own', [], payload.awaitingPick]))
            .digest('hex');
          await world.store.saveDraft(draft);
        }
      }
      offline.emitInboundText({
        reqId: 'read-before-transfer',
        msgid: 'read-before-transfer',
        corpid: CORP_ID,
        userid: 'm-wang-yj',
        content: query,
      });
      await waitUntil(() => original.length > 0);
      expect(original).toContain(expected);
      offline.emitInboundText({
        reqId: 'unbound-feedback',
        msgid: 'unbound-feedback',
        corpid: CORP_ID,
        userid: 'm-unknown',
        content: '查询',
      });
      await waitUntil(() =>
        offline.sent.some(
          (frame) => frame.headers.req_id === 'unbound-feedback',
        ),
      );
      expect(
        offline.sent
          .filter((frame) => frame.headers.req_id === 'read-before-transfer')
          .some(
            (frame) =>
              (frame.body as { stream?: { content?: string } }).stream
                ?.content === original,
          ),
      ).toBe(allowed);
    },
  );

  test('refuses a shared custom workspace even when its profile passes the tool guardrail', async () => {
    const now = () => new Date('2026-11-12T06:00:00Z');
    const world = await createSeededMemoryWorld(now);
    const offline = createOfflineWsClient();
    const imManager = new IMConnectionManager();
    const workspace = 'web:shared-marketing-test';
    const profile = {
      profileId: 'safe-profile',
      workspaceJid: workspace,
      status: 'active',
      executionMode: 'container',
      contextSource: 'managed',
      hostSkillsMode: 'disabled',
      disallowedTools: [...SAFE_MARKETING_DISALLOWED_TOOLS],
    };
    expect(validateTargetAgentProfile(profile)).toEqual({ ok: true });
    const runtime = await startWeComFrontClawRuntime({
      env: {
        FRONT_CLAW_WECOM_ENABLED: '1',
        FRONT_CLAW_WECOM_BOT_ID: BOT_ID,
        FRONT_CLAW_WECOM_BOT_SECRET: 'test-secret',
        FRONT_CLAW_NOTIFY_DISPATCH: '0',
        FRONT_CLAW_WECOM_WORKSPACE_JID: workspace,
      },
      imManager,
      ...createRuntimeWiringHarness({}),
      startMaintenance: false,
      wecomConnection: { client: offline.client },
      bridgeOptions: {
        now,
        open: world.open,
        resolveTargetProfile: () => profile,
        lease: {
          enabled: true,
          owner: 'test-custom-workspace',
          ttlMs: 5000,
          renewMs: 1000,
        },
        modelClassify: async () => ({
          intent: 'marketing',
          object: null,
          action: null,
          slots: {},
          confidence: 0.99,
          uncertain: false,
        }),
      },
    });
    activeCleanups.push(async () => {
      await runtime!.close();
      await imManager.disconnectAll();
    });
    offline.emitInboundText({
      reqId: 'custom-shared',
      msgid: 'custom-shared',
      corpid: CORP_ID,
      userid: 'm-zhao',
      content: '帮我写一条朋友圈文案',
    });
    await waitUntil(() =>
      offline.sent.some((frame) => frame.headers.req_id === 'custom-shared'),
    );
    expect(JSON.stringify(offline.sent[0]!.body)).toContain(
      BRIDGE_AGENT_GUARDRAIL_DENIED_REPLY,
    );
    expect(
      db.getMessagesSince(workspace, { timestamp: '', id: '' }),
    ).toHaveLength(0);
  });

  test('Gate 2: accepts normal WeCom message without from.corpid via unique trusted binding and rejects ambiguous/unbound senders', async () => {
    let nowMs = Date.UTC(2026, 10, 12, 6, 0, 0);
    const now = () => new Date(nowMs);
    const world = await createSeededMemoryWorld(now);
    const offline = createOfflineWsClient();
    const imManager = new IMConnectionManager();
    const groupsMap: Record<string, RegisteredGroup> = {};
    const wiring = createRuntimeWiringHarness(groupsMap);

    const runtime = await startWeComFrontClawRuntime({
      env: {
        FRONT_CLAW_WECOM_ENABLED: '1',
        FRONT_CLAW_WECOM_BOT_ID: BOT_ID,
        FRONT_CLAW_WECOM_BOT_SECRET: 'secret-1',
        FRONT_CLAW_NOTIFY_DISPATCH: '0',
      },
      imManager,
      ...wiring,
      startMaintenance: false,
      wecomConnection: { client: offline.client, leaseCheckIntervalMs: 50 },
      bridgeOptions: {
        now,
        open: world.open,
        lease: { enabled: true, owner: 'node-a', ttlMs: 5000, renewMs: 1000 },
      },
    });
    expect(runtime).not.toBeNull();
    activeCleanups.push(() => runtime!.close());

    // Inbound frame deliberately omits from.corpid
    offline.emitInboundText({
      reqId: 'req-no-corp-1',
      msgid: 'msg-no-corp-1',
      userid: 'm-zhao',
      content: '12号测试B店\n560（小赵）',
    });

    await waitUntil(() => offline.sent.length === 1);
    expect(offline.sent[0]).toMatchObject({
      cmd: WsCmd.RESPONSE,
      headers: { req_id: 'req-no-corp-1' },
    });
    expect(JSON.stringify(offline.sent[0]!.body)).toContain('回复「对」或「取消」');

    // Add a second conflicting active binding for same memberId -> missing corpid becomes ambiguous and fails closed
    await world.bindings.saveBinding({
      botId: BOT_ID,
      corpId: 'ww-other-corp',
      memberId: 'm-zhao',
      accountId: 'a-zhao',
      version: 2,
      active: true,
    });

    offline.emitInboundText({
      reqId: 'req-no-corp-2',
      msgid: 'msg-no-corp-2',
      userid: 'm-zhao',
      content: '对',
    });

    await waitUntil(() => offline.sent.length === 2);
    expect(JSON.stringify(offline.sent[1]!.body)).not.toContain('已入账');

    // Also ungranted/unknown sender without corpid fails closed and never reaches OpenDot DB
    offline.emitInboundText({
      reqId: 'req-stranger',
      msgid: 'msg-stranger',
      userid: 'm-unknown',
      content: '帮我写营销文案',
    });
    await waitUntil(() => offline.sent.length === 3);
    expect(db.getMessagesSince(WECOM_MANAGED_WORKSPACE_JID, '', '')).toHaveLength(
      0,
    );
  });

  test('Gate 3 + Phase 1 shutdown: single-consumer lease preemption, immediate stop on loss, epoch fencing, and Phase 1 release', async () => {
    let nowMs = Date.UTC(2026, 10, 12, 6, 0, 0);
    const now = () => new Date(nowMs);
    const world = await createSeededMemoryWorld(now);
    const imManagerA = new IMConnectionManager();
    const imManagerB = new IMConnectionManager();
    const groupsMap: Record<string, RegisteredGroup> = {};
    const wiring = createRuntimeWiringHarness(groupsMap);

    const offlineA = createOfflineWsClient();
    const offlineB = createOfflineWsClient();

    const runtimeA = await startWeComFrontClawRuntime({
      env: {
        FRONT_CLAW_WECOM_ENABLED: '1',
        FRONT_CLAW_WECOM_BOT_ID: BOT_ID,
        FRONT_CLAW_WECOM_BOT_SECRET: 'secret-1',
        FRONT_CLAW_NOTIFY_DISPATCH: '0',
      },
      imManager: imManagerA,
      ...wiring,
      startMaintenance: false,
      wecomConnection: {
        client: offlineA.client,
        leaseCheckIntervalMs: 30,
      },
      bridgeOptions: {
        now,
        open: world.open,
        lease: { enabled: true, owner: 'pod-a', ttlMs: 2000, renewMs: 500 },
      },
    });
    expect(runtimeA).not.toBeNull();
    expect(runtimeA!.isConnected()).toBe(true);
    expect(runtimeA!.bridge.leaseHeld()).toBe(true);
    activeCleanups.push(() => runtimeA!.close());

    // Standby pod B tries to start while A holds valid lease -> rejected cleanly
    const runtimeBBlocked = await startWeComFrontClawRuntime({
      env: {
        FRONT_CLAW_WECOM_ENABLED: '1',
        FRONT_CLAW_WECOM_BOT_ID: BOT_ID,
        FRONT_CLAW_WECOM_BOT_SECRET: 'secret-1',
        FRONT_CLAW_NOTIFY_DISPATCH: '0',
      },
      imManager: imManagerB,
      ...wiring,
      startMaintenance: false,
      wecomConnection: {
        client: offlineB.client,
        leaseCheckIntervalMs: 30,
      },
      bridgeOptions: {
        now,
        open: world.open,
        lease: { enabled: true, owner: 'pod-b', ttlMs: 2000, renewMs: 500 },
      },
    });
    expect(runtimeBBlocked).toBeNull();
    expect(imManagerB.isWeComConnected('admin-e2e')).toBe(false);

    // Advance clock past A's TTL and let pod B acquire lease (higher epoch)
    nowMs += 3000;
    const offlineBPreempt = createOfflineWsClient();
    const runtimeB = await startWeComFrontClawRuntime({
      env: {
        FRONT_CLAW_WECOM_ENABLED: '1',
        FRONT_CLAW_WECOM_BOT_ID: BOT_ID,
        FRONT_CLAW_WECOM_BOT_SECRET: 'secret-1',
        FRONT_CLAW_NOTIFY_DISPATCH: '0',
      },
      imManager: imManagerB,
      ...wiring,
      startMaintenance: false,
      wecomConnection: {
        client: offlineBPreempt.client,
        leaseCheckIntervalMs: 30,
      },
      bridgeOptions: {
        now,
        open: world.open,
        lease: { enabled: true, owner: 'pod-b', ttlMs: 2000, renewMs: 500 },
      },
    });
    expect(runtimeB).not.toBeNull();
    activeCleanups.push(() => runtimeB!.close());

    // Stale pod A detects lease loss and disconnects immediately
    await waitUntil(() => runtimeA!.isConnected() === false);
    const leaseAfterPreempt = parseLeaseRecord(
      await world.store.getConfig(CONSUMER_LEASE_KEY),
    );
    expect(leaseAfterPreempt).toMatchObject({ owner: 'pod-b', epoch: 2 });

    const sentBeforeStale = offlineA.sent.length;
    offlineA.emitInboundText({
      reqId: 'req-stale-a',
      msgid: 'msg-stale-a',
      userid: 'm-zhao',
      content: '12号测试B店\n560（小赵）',
    });
    await new Promise((r) => setTimeout(r, 80));
    expect(offlineA.sent).toHaveLength(sentBeforeStale);

    // Direct precheck call on stale runtime A is also fenced immediately
    const stalePrecheck = await runtimeA!.bridge.precheck({
      reqId: 'req-stale-fence',
      botId: BOT_ID,
      corpId: CORP_ID,
      memberId: 'm-zhao',
      messageId: 'msg-stale-fence',
      text: '12号测试B店\n560（小赵）',
      createTime: Math.floor(nowMs / 1000),
    });
    expect(stalePrecheck).toEqual({
      kind: 'failed',
      replies: [STALE_CONSUMER],
    });

    // Shutdown Phase 1: close runtimeB -> disconnects & releases PG ConsumerLease
    await runtimeB!.close();
    await imManagerB.disconnectAll();
    const leaseRaw = await world.store.getConfig(CONSUMER_LEASE_KEY);
    expect(parseLeaseRecord(leaseRaw)?.owner ?? null).toBeNull();
  });

  test('Gate 4 + Gate 5 (D175 & Agent Sandbox): replay, concurrent A(slow pass)+B(fast handled) zero req_id cross-talk, concurrent 对 single entry, D175 draft preserved', async () => {
    let nowMs = Date.UTC(2026, 10, 12, 6, 0, 0);
    const now = () => new Date(nowMs);
    const world = await createSeededMemoryWorld(now);
    const offline = createOfflineWsClient();
    const imManager = new IMConnectionManager();
    const groupsMap: Record<string, RegisteredGroup> = {};
    const wiring = createRuntimeWiringHarness(groupsMap);

    let passInboundSeen = 0;
    const inboundPassPromises: Promise<void>[] = [];

    const runtime = await startWeComFrontClawRuntime({
      env: {
        FRONT_CLAW_WECOM_ENABLED: '1',
        FRONT_CLAW_WECOM_BOT_ID: BOT_ID,
        FRONT_CLAW_WECOM_BOT_SECRET: 'secret-1',
        FRONT_CLAW_NOTIFY_DISPATCH: '0',
      },
      imManager,
      ...wiring,
      startMaintenance: false,
      onMessage: (chatJid, text, senderName) => {
        passInboundSeen += 1;
        // Simulate OpenDot Agent answering asynchronously over imManager.sendMessage
        const p = (async () => {
          await new Promise((r) => setTimeout(r, 30));
          await imManager.sendMessage(
            chatJid,
            `[受控营销助手回复 ${senderName}] 收到文案咨询：${text}`,
          );
        })();
        inboundPassPromises.push(p);
      },
      wecomConnection: { client: offline.client, leaseCheckIntervalMs: 50 },
      bridgeOptions: {
        now,
        open: world.open,
        lease: { enabled: true, owner: 'node-g45', ttlMs: 5000, renewMs: 1000 },
        modelClassify: async ({ text }) => {
          if (text.includes('文案')) {
            await new Promise((r) => setTimeout(r, 90));
            return {
              intent: 'marketing',
              object: null,
              action: null,
              slots: {},
              confidence: 0.96,
              uncertain: false,
            };
          }
          return {
            intent: 'unknown',
            object: null,
            action: null,
            slots: {},
            confidence: 0.1,
            uncertain: true,
          };
        },
      },
    });
    expect(runtime).not.toBeNull();
    activeCleanups.push(() => runtime!.close());

    // 1. Seed a D175 pending draft for 小赵 BEFORE sending marketing query
    offline.emitInboundText({
      reqId: 'req-draft-1',
      msgid: 'msg-draft-1',
      userid: 'm-zhao',
      content: '12号测试B店\n560（小赵）',
    });
    await waitUntil(() => offline.sent.length === 1);
    expect(JSON.stringify(offline.sent[0]!.body)).toContain('回复「对」或「取消」');

    // 2. Concurrent A (slow marketing pass for 小赵) + B (fast store report for 小林)
    offline.emitInboundText({
      reqId: 'req-pass-slow-A',
      msgid: 'msg-pass-slow-A',
      userid: 'm-zhao',
      content: '帮我写秋冬护肤朋友圈文案',
    });
    offline.emitInboundText({
      reqId: 'req-fast-B',
      msgid: 'msg-fast-B',
      userid: 'm-lin',
      content: '12号测试B店\n880（小林）',
    });

    // B (fast handled) replies passively using ONLY req-fast-B while A is still classifying
    await waitUntil(() =>
      offline.sent.some(
        (f) => f.cmd === WsCmd.RESPONSE && f.headers.req_id === 'req-fast-B',
      ),
    );
    await waitUntil(
      () => offline.sent.some((f) => f.cmd === WsCmd.SEND_MSG),
      3000,
      15,
      () =>
        JSON.stringify({
          passInboundSeen,
          sent: offline.sent,
          warns: log.warn.mock.calls,
          errors: log.error.mock.calls,
        }),
    );
    await Promise.all(inboundPassPromises);

    const responses = offline.sent.filter((f) => f.cmd === WsCmd.RESPONSE);
    const sends = offline.sent.filter((f) => f.cmd === WsCmd.SEND_MSG);
    expect(responses.some((f) => f.headers.req_id === 'req-pass-slow-A')).toBe(
      false,
    );
    expect(responses.filter((f) => f.headers.req_id === 'req-fast-B')).toHaveLength(
      1,
    );
    expect(passInboundSeen).toBe(1);
    expect(sends).toHaveLength(1);
    expect(JSON.stringify(sends[0]!.body)).toContain('受控营销助手回复');

    // Verify pass message landed in OpenDot SQLite under isolated per-employee workspace (not shared web:wecom-front-claw)
    const zhaoWorkspace = deriveEmployeeWeComWorkspace({
      corpId: CORP_ID,
      botId: BOT_ID,
      memberId: 'm-zhao',
      storeId: 's-b',
    });
    expect(
      db.getMessagesSince(WECOM_MANAGED_WORKSPACE_JID, {
        timestamp: '',
        id: '',
      }),
    ).toHaveLength(0);
    const savedPassMessages = db.getMessagesSince(zhaoWorkspace.jid, {
      timestamp: '',
      id: '',
    });
    expect(savedPassMessages.map((m) => m.content)).toContain(
      '帮我写秋冬护肤朋友圈文案',
    );

    // 3. Replay same marketing msg-id -> rejected/deduped, zero second Agent turn
    offline.emitInboundText({
      reqId: 'req-pass-replay',
      msgid: 'msg-pass-slow-A',
      userid: 'm-zhao',
      content: '帮我写秋冬护肤朋友圈文案',
    });
    await new Promise((r) => setTimeout(r, 120));
    expect(passInboundSeen).toBe(1);

    // 4. D175 preserved after interleaved marketing -> single-char 对 is blocked with reminder; explicit 确认入账 / 全部确认 commits 1 entry
    offline.emitInboundText({
      reqId: 'req-confirm-single',
      msgid: 'msg-confirm-single',
      userid: 'm-zhao',
      content: '对',
    });
    await waitUntil(() =>
      offline.sent.some((f) => f.headers.req_id === 'req-confirm-single'),
    );
    const singleReply = JSON.stringify(
      offline.sent.find((f) => f.headers.req_id === 'req-confirm-single')
        ?.body ?? '',
    );
    expect(singleReply).toContain(D175_INTERLEAVED_GUIDANCE);
    expect(singleReply).toContain('560');
    expect(singleReply).not.toContain('已入账');
    expect(
      (await world.store.listEntries()).filter(
        (e) => e.reporterPersonId === 'p-zhao',
      ),
    ).toHaveLength(0);

    offline.emitInboundText({
      reqId: 'req-confirm-1',
      msgid: 'msg-confirm-dup',
      userid: 'm-zhao',
      content: '确认入账',
    });
    offline.emitInboundText({
      reqId: 'req-confirm-2',
      msgid: 'msg-confirm-2',
      userid: 'm-zhao',
      content: '确认入账',
    });
    // Also replay same messageId for 确认入账
    offline.emitInboundText({
      reqId: 'req-confirm-replay',
      msgid: 'msg-confirm-dup',
      userid: 'm-zhao',
      content: '确认入账',
    });

    await waitUntil(async () => {
      const confirmed = await world.store.listEntries();
      return (
        confirmed.some((e) => e.reporterPersonId === 'p-zhao') &&
        offline.sent.some((f) => f.headers.req_id === 'req-confirm-replay')
      );
    }, 3000);
    await new Promise((r) => setTimeout(r, 80));
    const entries = await world.store.listEntries();
    const zhaoEntries = entries.filter((e) => e.reporterPersonId === 'p-zhao');
    expect(zhaoEntries).toHaveLength(1);
    expect(zhaoEntries[0]!.amount).toBe(56000);

    const confirm1Reply = JSON.stringify(
      offline.sent.find((f) => f.headers.req_id === 'req-confirm-1')?.body ?? '',
    );
    const confirm2Reply = JSON.stringify(
      offline.sent.find((f) => f.headers.req_id === 'req-confirm-2')?.body ?? '',
    );
    const confirmReplayReply = JSON.stringify(
      offline.sent.find((f) => f.headers.req_id === 'req-confirm-replay')?.body ??
        '',
    );
    expect(confirm1Reply).toContain('已入账');
    expect(confirmReplayReply).toContain('已入账');
    expect(confirm2Reply).not.toContain('已入账');

    // Second D175 cycle verifying 全部确认 commits 1 entry after interleaved marketing blocks single-char 对
    offline.emitInboundText({
      reqId: 'req-draft-2',
      msgid: 'msg-draft-2',
      userid: 'm-zhao',
      content: '12号测试B店\n680（小赵）',
    });
    await waitUntil(() =>
      offline.sent.some((f) => f.headers.req_id === 'req-draft-2'),
    );
    offline.emitInboundText({
      reqId: 'req-pass-2',
      msgid: 'msg-pass-2',
      userid: 'm-zhao',
      content: '帮我写春季补水朋友圈文案',
    });
    await waitUntil(() =>
      db
        .getMessagesSince(zhaoWorkspace.jid, { timestamp: '', id: '' })
        .some((m) => m.id === 'msg-pass-2'),
    );
    offline.emitInboundText({
      reqId: 'req-confirm-single-2',
      msgid: 'msg-confirm-single-2',
      userid: 'm-zhao',
      content: '对',
    });
    await waitUntil(() =>
      offline.sent.some((f) => f.headers.req_id === 'req-confirm-single-2'),
    );
    expect(
      JSON.stringify(
        offline.sent.find((f) => f.headers.req_id === 'req-confirm-single-2')
          ?.body ?? '',
      ),
    ).toContain(D175_INTERLEAVED_GUIDANCE);
    expect(
      (await world.store.listEntries()).filter(
        (e) => e.reporterPersonId === 'p-zhao',
      ),
    ).toHaveLength(1);

    offline.emitInboundText({
      reqId: 'req-confirm-all',
      msgid: 'msg-confirm-all',
      userid: 'm-zhao',
      content: '全部确认',
    });
    await waitUntil(() =>
      offline.sent.some((f) => f.headers.req_id === 'req-confirm-all'),
    );
    expect(
      JSON.stringify(
        offline.sent.find((f) => f.headers.req_id === 'req-confirm-all')
          ?.body ?? '',
      ),
    ).toContain('已入账');
    const finalZhaoEntries = (await world.store.listEntries()).filter(
      (e) => e.reporterPersonId === 'p-zhao',
    );
    expect(finalZhaoEntries).toHaveLength(2);
    expect(finalZhaoEntries.map((e) => e.amount)).toEqual([56000, 68000]);

    // Verify src/index.ts assembly & Phase 1 shutdown closes wecomFrontClawRuntime cleanly (CRLF-safe)
    const indexSrc = fs.readFileSync(
      path.join(process.cwd(), 'src/index.ts'),
      'utf8',
    );
    const pauseIdx = indexSrc.indexOf('imManager.pauseInbound()');
    const closeIdx = indexSrc.indexOf('wecomFrontClawRuntime');
    const shutdownCloseMatch = /wecomFrontClawRuntime\r?\n/.exec(
      indexSrc.slice(pauseIdx),
    );
    const disconnectAllMatch = /imManager\r?\n\s*\.disconnectAll\(\)/.exec(
      indexSrc.slice(pauseIdx),
    );
    expect(pauseIdx).toBeGreaterThan(0);
    expect(closeIdx).toBeGreaterThan(0);
    expect(shutdownCloseMatch).not.toBeNull();
    expect(disconnectAllMatch).not.toBeNull();
    const shutdownCloseIdx = pauseIdx + shutdownCloseMatch!.index;
    const disconnectAllIdx = pauseIdx + disconnectAllMatch!.index;
    expect(shutdownCloseIdx).toBeGreaterThan(pauseIdx);
    expect(disconnectAllIdx).toBeGreaterThan(shutdownCloseIdx);
    expect(indexSrc).toContain('deliverWeComTextViaOutbox');
    expect(indexSrc).toContain('observeWeComAgentTurn');
    expect(
      fs.existsSync(
        path.join(
          process.cwd(),
          'packages/front-claw/integrations/opendot-front-claw/opendot-hook.patch',
        ),
      ),
    ).toBe(false);
  });

  test('Cold-start requires persisted active user and self-heals historical front-claw-system workspaces/routes on restart', async () => {
    let nowMs = Date.UTC(2026, 10, 12, 6, 0, 0);
    const now = () => new Date(nowMs);
    const world = await createSeededMemoryWorld(now);

    // Simulate empty user DB on cold start
    for (const u of db.listUsers({ status: 'active', pageSize: 100 }).users) {
      db.deleteUser(u.id);
    }
    try {
      const legacyShared: RegisteredGroup = {
        name: '企微内容营销工作区',
        folder: WECOM_MANAGED_WORKSPACE_FOLDER,
        added_at: '2026-11-12T00:00:00.000Z',
        created_by: 'front-claw-system',
        is_home: false,
        executionMode: 'container',
      };
      const legacyC2c: RegisteredGroup = {
        name: '小赵企微会话',
        folder: WECOM_MANAGED_WORKSPACE_FOLDER,
        added_at: '2026-11-12T00:00:00.000Z',
        created_by: 'front-claw-system',
        target_main_jid: WECOM_MANAGED_WORKSPACE_JID,
        is_home: false,
        executionMode: 'container',
      };
      db.setRegisteredGroup(WECOM_MANAGED_WORKSPACE_JID, legacyShared);
      const legacyC2cJid = `wecom:c2c:${CORP_ID}:m-zhao`;
      db.setRegisteredGroup(legacyC2cJid, legacyC2c);

      const coldGroups: Record<string, RegisteredGroup> = {
        [WECOM_MANAGED_WORKSPACE_JID]: legacyShared,
        [legacyC2cJid]: legacyC2c,
      };
      const { ownerUserId: _omittedOwner, ...coldHarness } =
        createRuntimeWiringHarness(coldGroups);
      const coldImManager = new IMConnectionManager();
      const coldOffline = createOfflineWsClient();

      const coldRuntime = await startWeComFrontClawRuntime({
        env: {
          FRONT_CLAW_WECOM_ENABLED: '1',
          FRONT_CLAW_WECOM_BOT_ID: BOT_ID,
          FRONT_CLAW_WECOM_BOT_SECRET: 'secret-cold',
          FRONT_CLAW_NOTIFY_DISPATCH: '0',
        },
        imManager: coldImManager,
        ...coldHarness,
        startMaintenance: false,
        wecomConnection: { client: coldOffline.client, leaseCheckIntervalMs: 50 },
        bridgeOptions: {
          now,
          open: world.open,
          lease: { enabled: true, owner: 'node-cold', ttlMs: 5000, renewMs: 1000 },
        },
      });
      expect(coldRuntime).toBeNull();
      expect(
        coldImManager.isChannelAccountConnected(
          'front-claw-system',
          'wecom',
          BOT_ID,
        ),
      ).toBe(false);
      expect(
        log.error.mock.calls.some((call) =>
          JSON.stringify(call).includes('reset-admin.js'),
        ),
      ).toBe(true);
      const leaseAfterColdReject = await world.store.getConfig(CONSUMER_LEASE_KEY);
      expect(parseLeaseRecord(leaseAfterColdReject)?.owner ?? null).toBeNull();

      // Initialize real admin user and restart -> historical front-claw-system records self-heal
      db.createUser({
        id: 'admin-cold-healed',
        username: 'admin-cold-healed',
        password_hash: 'hash',
        display_name: 'Cold Healed Admin',
        role: 'admin',
        status: 'active',
        permissions: [],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      const healedOffline = createOfflineWsClient();
      const healedRuntime = await startWeComFrontClawRuntime({
        env: {
          FRONT_CLAW_WECOM_ENABLED: '1',
          FRONT_CLAW_WECOM_BOT_ID: BOT_ID,
          FRONT_CLAW_WECOM_BOT_SECRET: 'secret-healed',
          FRONT_CLAW_NOTIFY_DISPATCH: '0',
        },
        imManager: coldImManager,
        ...coldHarness,
        startMaintenance: false,
        wecomConnection: { client: healedOffline.client, leaseCheckIntervalMs: 50 },
        bridgeOptions: {
          now,
          open: world.open,
          lease: { enabled: true, owner: 'node-healed', ttlMs: 5000, renewMs: 1000 },
        },
      });
      expect(healedRuntime).not.toBeNull();
      activeCleanups.push(async () => {
        await healedRuntime!.close();
        await coldImManager.disconnectAll();
      });
      expect(healedRuntime!.ownerUserId).toBe('admin-cold-healed');
      expect(
        coldImManager.isChannelAccountConnected(
          'admin-cold-healed',
          'wecom',
          BOT_ID,
        ),
      ).toBe(true);

      const healedShared = db.getRegisteredGroup(WECOM_MANAGED_WORKSPACE_JID);
      expect(healedShared?.created_by).toBe('admin-cold-healed');
      expect(
        db.getAgentProfileForWorkspace(
          WECOM_MANAGED_WORKSPACE_FOLDER,
          'admin-cold-healed',
        )?.name,
      ).toBe(WECOM_SAFE_PROFILE_NAME);

      const zhaoWs = deriveEmployeeWeComWorkspace({
        corpId: CORP_ID,
        botId: BOT_ID,
        memberId: 'm-zhao',
        storeId: 's-b',
      });
      expect(db.getRegisteredGroup(zhaoWs.jid)).toBeUndefined();
      healedOffline.emitInboundText({
        reqId: 'legacy-fresh-scope',
        msgid: 'legacy-fresh-scope',
        corpid: CORP_ID,
        userid: 'm-zhao',
        content: '帮我写一条朋友圈文案',
      });
      await waitUntil(() => !!db.getRegisteredGroup(zhaoWs.jid));
      const healedZhaoWs = db.getRegisteredGroup(zhaoWs.jid);
      expect(healedZhaoWs).toMatchObject({
        folder: zhaoWs.folder,
        created_by: 'admin-cold-healed',
        is_home: false,
        executionMode: 'container',
      });
      expect(
        db.getAgentProfileForWorkspace(zhaoWs.folder, 'admin-cold-healed')?.name,
      ).toBe(WECOM_SAFE_PROFILE_NAME);

      const healedC2c = db.getRegisteredGroup(legacyC2cJid);
      expect(healedC2c).toMatchObject({
        created_by: 'admin-cold-healed',
        folder: zhaoWs.folder,
        target_main_jid: zhaoWs.jid,
        is_home: false,
        executionMode: 'container',
      });
    } finally {
      resetOpenDotSqliteState();
    }
  });

  test('Multi-employee pass isolation: Employee A and B route to isolated workspaces and sticky owners never cross-talk or leak', async () => {
    let nowMs = Date.UTC(2026, 10, 12, 6, 0, 0);
    const now = () => new Date(nowMs);
    const world = await createSeededMemoryWorld(now);
    const linPerson = await world.store.getPerson('p-lin');
    expect(linPerson).toBeTruthy();
    await world.store.savePerson({
      ...linPerson!,
      roles: ['marketing'],
    });
    const basePolicy = buildPolicy(1);
    const isoPolicy = await updateAccessPolicy(world.store, {
      expectedVersion: 1,
      next: {
        ...basePolicy,
        version: 2,
        members: {
          ...basePolicy.members,
          'p-lin': {
            ...basePolicy.members['p-lin']!,
            capabilities: ['marketing'],
          },
        },
      },
      actor: 'e2e-admin',
      reason: 'enable-marketing-for-employee-b',
      at: now().toISOString(),
    });
    expect(isoPolicy.ok).toBe(true);
    const offline = createOfflineWsClient();
    const imManager = new IMConnectionManager();
    const groupsMap: Record<string, RegisteredGroup> = {};
    const wiring = createRuntimeWiringHarness(groupsMap);

    const stickyOwnerByFolder = new Map<string, string | null>();
    const replyPromises: Promise<void>[] = [];

    const runtime = await startWeComFrontClawRuntime({
      env: {
        FRONT_CLAW_WECOM_ENABLED: '1',
        FRONT_CLAW_WECOM_BOT_ID: BOT_ID,
        FRONT_CLAW_WECOM_BOT_SECRET: 'secret-iso',
        FRONT_CLAW_NOTIFY_DISPATCH: '0',
      },
      imManager,
      ...wiring,
      startMaintenance: false,
      onMessage: (chatJid, text) => {
        const effective = wiring.resolveEffectiveChatJid(chatJid);
        if (!effective) return;
        const effectiveGroup = wiring.getGroup(effective.effectiveJid);
        if (!effectiveGroup) return;
        const owner = resolveStickyChannelOwner(
          stickyOwnerByFolder.get(effectiveGroup.folder) ?? null,
          chatJid,
        );
        stickyOwnerByFolder.set(effectiveGroup.folder, owner);
        const replyTarget = owner ?? chatJid;
        replyPromises.push(
          (async () => {
            await new Promise((r) =>
              setTimeout(r, chatJid.includes('m-zhao') ? 50 : 10),
            );
            await imManager.sendMessage(
              replyTarget,
              `[受控回复:${effectiveGroup.folder}] ${text}`,
            );
          })(),
        );
      },
      wecomConnection: { client: offline.client, leaseCheckIntervalMs: 50 },
      bridgeOptions: {
        now,
        open: world.open,
        lease: { enabled: true, owner: 'node-iso', ttlMs: 5000, renewMs: 1000 },
        modelClassify: async () => ({
          intent: 'marketing',
          object: null,
          action: null,
          slots: {},
          confidence: 0.98,
          uncertain: false,
        }),
      },
    });
    expect(runtime).not.toBeNull();
    activeCleanups.push(async () => {
      await runtime!.close();
      await imManager.disconnectAll();
    });

    offline.emitInboundText({
      reqId: 'req-iso-zhao-1',
      msgid: 'msg-iso-zhao-1',
      userid: 'm-zhao',
      corpid: CORP_ID,
      content: '帮小赵写防晒小红书文案',
    });
    offline.emitInboundText({
      reqId: 'req-iso-lin-1',
      msgid: 'msg-iso-lin-1',
      userid: 'm-lin',
      corpid: CORP_ID,
      content: '帮小林写补水线下海报文案',
    });

    await waitUntil(
      () =>
        offline.sent.filter((f) => f.cmd === WsCmd.SEND_MSG).length === 2,
      3000,
      15,
      () => JSON.stringify({ sent: offline.sent }),
    );
    await Promise.all(replyPromises);

    const zhaoWs = deriveEmployeeWeComWorkspace({
      corpId: CORP_ID,
      botId: BOT_ID,
      memberId: 'm-zhao',
      storeId: 's-b',
    });
    const linWs = deriveEmployeeWeComWorkspace({
      corpId: CORP_ID,
      botId: BOT_ID,
      memberId: 'm-lin',
      storeId: 's-b',
    });
    expect(zhaoWs.jid).not.toBe(linWs.jid);
    expect(zhaoWs.folder).not.toBe(linWs.folder);
    expect(isWeComManagedWorkspaceFolder(zhaoWs.folder)).toBe(true);
    expect(isWeComManagedWorkspaceFolder(linWs.folder)).toBe(true);

    const zhaoC2c = `wecom:c2c:${CORP_ID}:m-zhao`;
    const linC2c = `wecom:c2c:${CORP_ID}:m-lin`;
    expect(db.getRegisteredGroup(zhaoC2c)).toMatchObject({
      target_main_jid: zhaoWs.jid,
      folder: zhaoWs.folder,
    });
    expect(db.getRegisteredGroup(linC2c)).toMatchObject({
      target_main_jid: linWs.jid,
      folder: linWs.folder,
    });

    // Separate sticky owners per workspace folder (zero cross-employee sticky lock)
    expect(stickyOwnerByFolder.get(zhaoWs.folder)).toBe(zhaoC2c);
    expect(stickyOwnerByFolder.get(linWs.folder)).toBe(linC2c);

    // SQLite message histories remain strictly isolated per employee
    const zhaoMsgs = db
      .getMessagesSince(zhaoWs.jid, { timestamp: '', id: '' })
      .map((m) => m.content);
    const linMsgs = db
      .getMessagesSince(linWs.jid, { timestamp: '', id: '' })
      .map((m) => m.content);
    expect(zhaoMsgs).toContain('帮小赵写防晒小红书文案');
    expect(zhaoMsgs).not.toContain('帮小林写补水线下海报文案');
    expect(linMsgs).toContain('帮小林写补水线下海报文案');
    expect(linMsgs).not.toContain('帮小赵写防晒小红书文案');
    expect(
      db.getMessagesSince(WECOM_MANAGED_WORKSPACE_JID, {
        timestamp: '',
        id: '',
      }),
    ).toHaveLength(0);

    // Outbound WsCmd.SEND_MSG goes strictly to each sender
    const outboundSends = offline.sent.filter((f) => f.cmd === WsCmd.SEND_MSG);
    const sendToZhao = outboundSends.find((f) => f.body.chatid === 'm-zhao');
    const sendToLin = outboundSends.find((f) => f.body.chatid === 'm-lin');
    expect(JSON.stringify(sendToZhao?.body)).toContain('防晒小红书文案');
    expect(JSON.stringify(sendToZhao?.body)).not.toContain('补水线下海报文案');
    expect(JSON.stringify(sendToLin?.body)).toContain('补水线下海报文案');
    expect(JSON.stringify(sendToLin?.body)).not.toContain('防晒小红书文案');

    // Both derived workspaces bind active SafeMarketingProfile passing fail-closed validation
    for (const ws of [zhaoWs, linWs]) {
      const profile = db.getAgentProfileForWorkspace(ws.folder, 'admin-e2e');
      expect(profile?.name).toBe(WECOM_SAFE_PROFILE_NAME);
      const check = validateTargetAgentProfile({
        profileId: profile!.id,
        workspaceJid: ws.jid,
        status: profile!.status,
        executionMode: 'container',
        contextSource: profile!.runtime_policy.context.source,
        hostSkillsMode: profile!.runtime_policy.skills.host?.mode ?? 'disabled',
        runtimePolicy: {
          context: profile!.runtime_policy.context,
          skills: profile!.runtime_policy.skills,
        },
        disallowedTools: [...SAFE_MARKETING_DISALLOWED_TOOLS],
      });
      expect(check.ok).toBe(true);
    }
  });

  test('Gate 5 (Sandbox & Guardrails): blocks host/host_claude/secret-leak profiles and strips DB/PG/Shell capabilities in OpenDot runner', async () => {
    // 1. validateTargetAgentProfile fail-closed checks
    expect(
      validateTargetAgentProfile({
        status: 'active',
        executionMode: 'host',
        contextSource: 'managed',
        hostSkillsMode: 'disabled',
        disallowedTools: SAFE_MARKETING_DISALLOWED_TOOLS,
      }),
    ).toEqual({ ok: false, reason: 'host_execution_forbidden' });

    expect(
      validateTargetAgentProfile({
        status: 'active',
        executionMode: 'container',
        contextSource: 'host_claude',
        hostSkillsMode: 'disabled',
        disallowedTools: SAFE_MARKETING_DISALLOWED_TOOLS,
      }),
    ).toEqual({ ok: false, reason: 'host_claude_context_forbidden' });

    expect(
      validateTargetAgentProfile({
        status: 'active',
        executionMode: 'container',
        contextSource: 'managed',
        hostSkillsMode: 'disabled',
        disallowedTools: SAFE_MARKETING_DISALLOWED_TOOLS,
        injectedEnvKeys: ['PGPASSWORD'],
      }),
    ).toEqual({ ok: false, reason: 'forbidden_env_leak:PGPASSWORD' });

    expect(
      validateTargetAgentProfile({
        status: 'active',
        executionMode: 'container',
        contextSource: 'managed',
        hostSkillsMode: 'disabled',
        disallowedTools: SAFE_MARKETING_DISALLOWED_TOOLS,
      }),
    ).toEqual({ ok: true });

    // 2. Real tool-policy exclusion verifies Bash / Write / Edit / NotebookEdit are blocked
    const toolPolicy = resolveDisallowedToolSet(
      {
        agentProfile: {
          id: 'p-safe',
          name: 'Safe',
          version: 1,
          isDefault: false,
          identityHash: 'h',
          identityPrompt: 'safe',
          includeClaudePreset: false,
          disallowedTools: [...SAFE_MARKETING_DISALLOWED_TOOLS],
        },
      },
      {},
    );
    const filteredAllowed = DEFAULT_ALLOWED_TOOLS.filter(
      (name) => !isToolDisallowed(name, toolPolicy.canonicalLower),
    );
    expect(filteredAllowed).not.toContain('Bash');
    expect(filteredAllowed).not.toContain('Write');
    expect(filteredAllowed).not.toContain('Edit');
    expect(isToolDisallowed('bash', toolPolicy.canonicalLower)).toBe(true);
    expect(isToolDisallowed('NotebookEdit', toolPolicy.canonicalLower)).toBe(true);
    expect(PiRuntimeAdapter).toBeTypeOf('function');

    // 3. Real runHostAgent spawn env scrubbing + MINICLAW_AGENT_DISALLOWED_TOOLS propagation
    const prevEnv = {
      HOME: process.env.HOME,
      USERPROFILE: process.env.USERPROFILE,
      FRONT_CLAW_DATABASE_URL: process.env.FRONT_CLAW_DATABASE_URL,
      DATABASE_URL: process.env.DATABASE_URL,
      PGPASSWORD: process.env.PGPASSWORD,
      PGUSER: process.env.PGUSER,
      FRONT_CLAW_WECOM_BOT_SECRET: process.env.FRONT_CLAW_WECOM_BOT_SECRET,
    };
    const sandboxHome = path.join(tmp, 'home');
    fs.mkdirSync(sandboxHome, { recursive: true });
    process.env.HOME = sandboxHome;
    process.env.USERPROFILE = sandboxHome;
    process.env.FRONT_CLAW_DATABASE_URL = 'postgres://front_app:secret@pg:5432/front_dot';
    process.env.DATABASE_URL = 'postgres://postgres:admin@pg:5432/front_dot';
    process.env.PGPASSWORD = 'admin-password';
    process.env.PGUSER = 'postgres';
    process.env.FRONT_CLAW_WECOM_BOT_SECRET = 'top-secret-bot';

    try {
      const safeGroup: RegisteredGroup = {
        name: '企微内容营销工作区',
        folder: WECOM_MANAGED_WORKSPACE_FOLDER,
        added_at: new Date().toISOString(),
        created_by: 'admin-e2e',
        is_home: false,
        executionMode: 'container',
      };
      db.setRegisteredGroup(WECOM_MANAGED_WORKSPACE_JID, safeGroup);
      fs.mkdirSync(path.join(tmp, 'groups', WECOM_MANAGED_WORKSPACE_FOLDER), {
        recursive: true,
      });

      const agentOut = await runHostAgent(
        safeGroup,
        {
          prompt: '写一篇护肤活动海报文案',
          groupFolder: WECOM_MANAGED_WORKSPACE_FOLDER,
          chatJid: WECOM_MANAGED_WORKSPACE_JID,
          agentProfile: {
            id: 'safe-profile',
            name: 'Front Claw Safe Marketing',
            version: 1,
            isDefault: false,
            identityHash: 'safe-hash',
            identityPrompt: 'safe',
            includeClaudePreset: false,
            runtimePolicy: {
              reasoning: { effort: 'inherit' },
              context: {
                source: 'managed',
                auto_compact_window: 0,
                auto_compact_percentage: 0,
              },
              skills: { mode: 'disabled', ids: [], host: { mode: 'disabled', ids: [] } },
              mcp: { mode: 'disabled', ids: [] },
            },
            disallowedTools: [...SAFE_MARKETING_DISALLOWED_TOOLS],
          },
        },
        () => {},
      );

      expect(agentOut.status).toBe('success');
      const parsed = JSON.parse(String(agentOut.result)) as {
        forbiddenKeys: string[];
        disallowedToolsEnv: string | null;
        mcpPolicyEnv: string | null;
        profileDisallowedTools: string[] | null;
      };
      expect(parsed.forbiddenKeys).toEqual([]);
      expect(JSON.parse(parsed.disallowedToolsEnv ?? '[]')).toEqual([
        ...SAFE_MARKETING_DISALLOWED_TOOLS,
      ]);
      expect(parsed.mcpPolicyEnv).toBe('disabled');
      expect(parsed.profileDisallowedTools).toEqual([
        ...SAFE_MARKETING_DISALLOWED_TOOLS,
      ]);
    } finally {
      for (const [key, value] of Object.entries(prevEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }, 15_000);

  test(
    'Gate 6: passive reply and M06 proactive notification unknown ACK timeouts do not retry and remain queryable',
    async () => {
      let nowMs = Date.UTC(2026, 10, 12, 6, 0, 0);
      const now = () => new Date(nowMs);
      const world = await createSeededMemoryWorld(now);
      const offline = createOfflineWsClient();
      const imManager = new IMConnectionManager();
      const groupsMap: Record<string, RegisteredGroup> = {};
      const wiring = createRuntimeWiringHarness(groupsMap);
      const dispatchEvents: Array<{ type: string; notificationId?: string }> = [];

      const runtime = await startWeComFrontClawRuntime({
        env: {
          FRONT_CLAW_WECOM_ENABLED: '1',
          FRONT_CLAW_WECOM_BOT_ID: BOT_ID,
          FRONT_CLAW_WECOM_BOT_SECRET: 'secret-1',
          FRONT_CLAW_NOTIFY_DISPATCH: '1',
        },
        imManager,
        ...wiring,
        startMaintenance: false,
        wecomConnection: {
          client: offline.client,
          sendTimeoutMs: 60,
          leaseCheckIntervalMs: 50,
        },
        dispatchOptions: {
          intervalMs: 1_000,
          onEvent: (ev) =>
            dispatchEvents.push(ev as { type: string; notificationId?: string }),
        },
        bridgeOptions: {
          now,
          open: world.open,
          lease: { enabled: true, owner: 'node-g6', ttlMs: 5000, renewMs: 1000 },
        },
      });
      expect(runtime).not.toBeNull();
      expect(runtime!.dispatchStatus).toBe('started');
      activeCleanups.push(() => runtime!.close());

      // Suppress ACK on both passive reply (RESPONSE) and proactive notify (SEND_MSG)
      offline.setSuppressAck(
        (frame) =>
          frame.cmd === WsCmd.RESPONSE || frame.cmd === WsCmd.SEND_MSG,
      );

      // 1. Register an appointment -> passive reply ACK times out -> unknown, no passive retry
      offline.emitInboundText({
        reqId: 'req-appt-1',
        msgid: 'msg-appt-1',
        userid: 'm-zhao',
        content: '预约明天下午3点张小姐来做护理',
      });
      await waitUntil(() =>
        offline.sent.some((f) => f.headers.req_id === 'req-appt-1'),
      );
      await new Promise((r) => setTimeout(r, 120));
      expect(
        offline.sent.filter((f) => f.headers.req_id === 'req-appt-1'),
      ).toHaveLength(1);
      expect(log.warn).toHaveBeenCalled();

      // Confirm appointment -> creates M06 notification -> dispatcher runs, sendMessage ACK times out -> unknown, never resends
      offline.emitInboundText({
        reqId: 'req-appt-2',
        msgid: 'msg-appt-2',
        userid: 'm-zhao',
        content: '对',
      });

      await waitUntil(
        () =>
          offline.sent.some((f) => f.cmd === WsCmd.SEND_MSG) &&
          dispatchEvents.some((e) => e.type === 'unknown_alert'),
        6000,
        15,
        async () =>
          JSON.stringify({
            sent: offline.sent,
            dispatchEvents,
            notifications: await world.store.listNotifications(),
            appts: await world.store.listAppointments(),
          }),
      );
      // Allow another dispatch interval to pass: must NOT resend unknown notification
      await new Promise((r) => setTimeout(r, 1200));
      expect(offline.sent.filter((f) => f.cmd === WsCmd.SEND_MSG)).toHaveLength(
        1,
      );

      const notifications = await world.store.listNotifications();
      expect(notifications).toHaveLength(1);
      expect(notifications[0]!.status).toBe('unknown');

      // Allow passive ACK again to query back truthful status via 我的预约
      offline.setSuppressAck(() => false);
      offline.emitInboundText({
        reqId: 'req-query-appt',
        msgid: 'msg-query-appt',
        userid: 'm-zhao',
        content: '我的预约',
      });
      await waitUntil(() =>
        offline.sent.some((f) => f.headers.req_id === 'req-query-appt'),
      );
      const queryReply = JSON.stringify(
        offline.sent.find((f) => f.headers.req_id === 'req-query-appt')!.body,
      );
      expect(queryReply).toContain('发送结果未知，未确认送达');

      // Guardrail fail-closed runtime check: point FRONT_CLAW_WECOM_WORKSPACE_JID to a host-mode workspace
      const unsafeGroupsMap: Record<string, RegisteredGroup> = {};
      const unsafeWiring = createRuntimeWiringHarness(unsafeGroupsMap);
      unsafeWiring.registerGroup('web:unsafe-host', {
        name: 'Unsafe Host',
        folder: 'unsafe-host',
        added_at: new Date().toISOString(),
        created_by: 'admin-e2e',
        is_home: false,
        executionMode: 'host',
      });
      const unsafeOffline = createOfflineWsClient({ botId: 'bot-unsafe-1' });
      const unsafeIm = new IMConnectionManager();
      const unsafeWorld = await createSeededMemoryWorld(now);
      await unsafeWorld.bindings.saveBinding({
        botId: 'bot-unsafe-1',
        corpId: CORP_ID,
        memberId: 'm-zhao',
        accountId: 'a-zhao',
        version: 1,
        active: true,
      });
      const unsafeRuntime = await startWeComFrontClawRuntime({
        env: {
          FRONT_CLAW_WECOM_ENABLED: '1',
          FRONT_CLAW_WECOM_BOT_ID: 'bot-unsafe-1',
          FRONT_CLAW_WECOM_BOT_SECRET: 'secret-unsafe',
          FRONT_CLAW_WECOM_WORKSPACE_JID: 'web:unsafe-host',
          FRONT_CLAW_NOTIFY_DISPATCH: '0',
        },
        imManager: unsafeIm,
        ...unsafeWiring,
        startMaintenance: false,
        wecomConnection: { client: unsafeOffline.client, leaseCheckIntervalMs: 50 },
        bridgeOptions: {
          now,
          open: unsafeWorld.open,
          lease: { enabled: true, owner: 'unsafe-guard', ttlMs: 5000, renewMs: 1000 },
          modelClassify: async () => ({
            intent: 'marketing',
            object: null,
            action: null,
            slots: {},
            confidence: 0.99,
            uncertain: false,
          }),
        },
      });
      expect(unsafeRuntime).not.toBeNull();
      activeCleanups.push(() => unsafeRuntime!.close());
      unsafeOffline.emitInboundText({
        reqId: 'req-unsafe-pass',
        msgid: 'msg-unsafe-pass',
        userid: 'm-zhao',
        content: '帮我写护肤推广文案',
      });
      await waitUntil(() =>
        unsafeOffline.sent.some((f) => f.headers.req_id === 'req-unsafe-pass'),
      );
      expect(
        JSON.stringify(
          unsafeOffline.sent.find((f) => f.headers.req_id === 'req-unsafe-pass')!
            .body,
        ),
      ).toContain(BRIDGE_AGENT_GUARDRAIL_DENIED_REPLY);
      expect(db.getMessagesSince('web:unsafe-host', { timestamp: '', id: '' })).toHaveLength(0);
    },
    15_000,
  );

  test('Outbox × WeCom receipt: unknown / partial multi-chunk locks uncertain without replay, chunk-1 rejected fails definitively, and 4-stage telemetry correlates with ASCII enums', async () => {
    expect(normalizeWeComObservationRoute('快通道')).toBe('fast_path');
    expect(normalizeWeComObservationRoute('模型')).toBe('model');
    expect(normalizeWeComObservationRoute('追问')).toBe('clarify');
    expect(normalizeWeComObservationRoute('包含顾客张三')).toBe('unknown_route');
    expect(normalizeWeComObservationGateReason('通过')).toBe('accepted');
    expect(normalizeWeComObservationGateReason('客户张三5800元')).toBe(
      'redacted',
    );
    expect(normalizeWeComObservationErrorCategory('超时')).toBe('timeout');
    expect(normalizeWeComObservationErrorCategory('秘钥明文')).toBe('redacted');

    const now = () => new Date(Date.UTC(2026, 10, 12, 6, 0, 0));
    const world = await createSeededMemoryWorld(now);
    const offline = createOfflineWsClient();
    const imManager = new IMConnectionManager();
    const groupsMap: Record<string, RegisteredGroup> = {};
    const wiring = createRuntimeWiringHarness(groupsMap);

    const spanExporter = new InMemorySpanExporter();
    const observer = new HostObservability({
      publicKey: 'pk-e2e-wecom',
      secretKey: 'sk-e2e-never-export',
      baseUrl: 'https://langfuse.example.test/',
      installationId: 'inst-wecom-e2e',
      sampleRate: 1,
      exporter: spanExporter,
    });
    activeCleanups.push(() => observer.close());

    const runtime = await startWeComFrontClawRuntime({
      env: {
        FRONT_CLAW_WECOM_ENABLED: '1',
        FRONT_CLAW_WECOM_BOT_ID: BOT_ID,
        FRONT_CLAW_WECOM_BOT_SECRET: 'secret-outbox',
        FRONT_CLAW_NOTIFY_DISPATCH: '0',
      },
      imManager,
      ...wiring,
      startMaintenance: false,
      wecomConnection: {
        client: offline.client,
        sendTimeoutMs: 60,
        leaseCheckIntervalMs: 50,
      },
      bridgeOptions: {
        now,
        open: world.open,
        lease: { enabled: true, owner: 'node-outbox', ttlMs: 5000, renewMs: 1000 },
        modelClassify: async () => ({
          intent: 'marketing',
          object: null,
          action: null,
          slots: {},
          confidence: 0.96,
          uncertain: false,
        }),
      },
    });
    expect(runtime).not.toBeNull();
    activeCleanups.push(async () => {
      await runtime!.close();
      await imManager.disconnectAll();
    });

    const zhaoWs = deriveEmployeeWeComWorkspace({
      corpId: CORP_ID,
      botId: BOT_ID,
      memberId: 'm-zhao',
      storeId: 's-b',
    });
    const zhaoC2cJid = `wecom:c2c:${CORP_ID}:m-zhao`;

    // Admit marketing turn so route, registered group, and precheck span are created
    offline.emitInboundText({
      reqId: 'req-outbox-in-1',
      msgid: 'msg-outbox-1',
      userid: 'm-zhao',
      corpid: CORP_ID,
      content: '我想吸引附近新客进店体验项目',
    });
    await waitUntil(() =>
      db
        .getMessagesSince(zhaoWs.jid, { timestamp: '', id: '' })
        .some((m) => m.id === 'msg-outbox-1'),
    );

    const turn1 = ChannelTurnRuntime.start({
      provider: 'wecom',
      accountId: BOT_ID,
      sourceJid: zhaoC2cJid,
      chatId: `c2c:${CORP_ID}:m-zhao`,
      externalMessageId: 'msg-outbox-1',
    });
    activeCleanups.push(() => {
      turn1.interrupt('test_cleanup');
    });

    const countSendMsgs = () =>
      offline.sent.filter((f) => f.cmd === WsCmd.SEND_MSG).length;

    // (a) Accepted -> Outbox delivered with real WeCom providerMessageId + idempotent replay
    const admit = async (id: string) => {
      offline.emitInboundText({
        reqId: id,
        msgid: id,
        corpid: CORP_ID,
        userid: 'm-zhao',
        content: '帮我写一条周末补水活动朋友圈文案',
      });
      await waitUntil(() =>
        db
          .getMessagesSince(zhaoWs.jid, { timestamp: '', id: '' })
          .some((row) => row.id === id),
      );
    };
    const okRes = await deliverWeComTextViaOutbox({
      workspaceJid: zhaoWs.jid,
      imManager,
      targetJid: zhaoC2cJid,
      text: '秋季护理文案草稿正文',
      correlationId: 'msg-outbox-1',
      outbox: {
        provider: 'wecom',
        accountId: BOT_ID,
        sourceJid: zhaoC2cJid,
        chatId: `c2c:${CORP_ID}:m-zhao`,
        rootId: null,
        threadId: null,
        turnRunId: turn1.runId,
        ordinal: 1,
        kind: 'text',
        payload: { text: '秋季护理文案草稿正文' },
        idempotencyKey: `${turn1.runId}:ok-1`,
        owner: 'e2e-outbox',
      },
    });
    expect(okRes.status).toBe('delivered');
    expect(okRes.reused).toBe(false);
    expect(okRes.receipt?.providerMessageId).toMatch(/^aibot_send_msg_/);
    expect(getChannelOutboxItem(okRes.itemId)?.status).toBe('delivered');
    expect(countSendMsgs()).toBe(1);

    const okReplay = await deliverWeComTextViaOutbox({
      workspaceJid: zhaoWs.jid,
      imManager,
      targetJid: zhaoC2cJid,
      text: '秋季护理文案草稿正文',
      correlationId: 'msg-outbox-1',
      outbox: {
        provider: 'wecom',
        accountId: BOT_ID,
        sourceJid: zhaoC2cJid,
        chatId: `c2c:${CORP_ID}:m-zhao`,
        rootId: null,
        threadId: null,
        turnRunId: turn1.runId,
        ordinal: 1,
        kind: 'text',
        payload: { text: '秋季护理文案草稿正文' },
        idempotencyKey: `${turn1.runId}:ok-1`,
        owner: 'e2e-outbox',
      },
    });
    expect(okReplay.status).toBe('delivered');
    expect(okReplay.reused).toBe(true);
    expect(countSendMsgs()).toBe(1);

    // Emit matching agent_turn span for msg-outbox-1 before unknown locks turn1
    const boundProfile = db.getAgentProfileForWorkspace(
      zhaoWs.folder,
      'admin-e2e',
    );
    observeWeComAgentTurn({
      correlationId: 'msg-outbox-1',
      workspaceFolder: zhaoWs.folder,
      profileId: boundProfile?.id,
      durationMs: 125,
      status: 'success',
      inputTokens: 280,
      outputTokens: 90,
    });

    // (b) SEND_MSG ACK timeout (unknown) -> Outbox locked as uncertain and automatic replay blocked
    offline.setAckFor(() => null);
    const unknownRes = await deliverWeComTextViaOutbox({
      workspaceJid: zhaoWs.jid,
      imManager,
      targetJid: zhaoC2cJid,
      text: '超时未确认文案',
      correlationId: 'msg-outbox-1',
      outbox: {
        provider: 'wecom',
        accountId: BOT_ID,
        sourceJid: zhaoC2cJid,
        chatId: `c2c:${CORP_ID}:m-zhao`,
        rootId: null,
        threadId: null,
        turnRunId: turn1.runId,
        ordinal: 2,
        kind: 'text',
        payload: { text: '超时未确认文案' },
        idempotencyKey: `${turn1.runId}:timeout-2`,
        owner: 'e2e-outbox',
      },
    });
    expect(unknownRes.status).toBe('uncertain');
    expect(getChannelOutboxItem(unknownRes.itemId)?.status).toBe('uncertain');
    expect(turn1.complete()).toBe(false);
    expect(countSendMsgs()).toBe(2);

    // Restore healthy ACKs: retrying same key OR sibling ordinal on same turn must remain blocked (0 sends)
    offline.setAckFor(() => ({ errcode: 0 }));
    const replayBlocked = await deliverWeComTextViaOutbox({
      workspaceJid: zhaoWs.jid,
      imManager,
      targetJid: zhaoC2cJid,
      text: '超时未确认文案',
      correlationId: 'msg-outbox-1',
      outbox: {
        provider: 'wecom',
        accountId: BOT_ID,
        sourceJid: zhaoC2cJid,
        chatId: `c2c:${CORP_ID}:m-zhao`,
        rootId: null,
        threadId: null,
        turnRunId: turn1.runId,
        ordinal: 2,
        kind: 'text',
        payload: { text: '超时未确认文案' },
        idempotencyKey: `${turn1.runId}:timeout-2`,
        owner: 'e2e-outbox',
      },
    });
    expect(replayBlocked.status).toBe('uncertain');
    const siblingBlocked = await deliverWeComTextViaOutbox({
      workspaceJid: zhaoWs.jid,
      imManager,
      targetJid: zhaoC2cJid,
      text: '同回合后续消息',
      correlationId: 'msg-outbox-1',
      outbox: {
        provider: 'wecom',
        accountId: BOT_ID,
        sourceJid: zhaoC2cJid,
        chatId: `c2c:${CORP_ID}:m-zhao`,
        rootId: null,
        threadId: null,
        turnRunId: turn1.runId,
        ordinal: 3,
        kind: 'text',
        payload: { text: '同回合后续消息' },
        idempotencyKey: `${turn1.runId}:sibling-3`,
        owner: 'e2e-outbox',
      },
    });
    expect(siblingBlocked.status).toBe('uncertain');
    expect(countSendMsgs()).toBe(2);

    // (c) Multi-chunk partial rejected (chunk 1 accepted, chunk 2 rejected -> sentChunkCount=1) -> uncertain, no replay
    await admit('msg-outbox-partial-rej');
    const turnPartialRej = ChannelTurnRuntime.start({
      provider: 'wecom',
      accountId: BOT_ID,
      sourceJid: zhaoC2cJid,
      chatId: `c2c:${CORP_ID}:m-zhao`,
      externalMessageId: 'msg-outbox-partial-rej',
    });
    activeCleanups.push(() => {
      turnPartialRej.interrupt('test_cleanup');
    });
    const baseSentPartialRej = offline.sent.length;
    offline.setAckFor((_f, idx) =>
      idx === baseSentPartialRej
        ? { errcode: 0 }
        : { errcode: 40003, errmsg: 'chunk2_rejected' },
    );
    const twoChunkRejectText = 'A'.repeat(16001);
    const partialRejRes = await deliverWeComTextViaOutbox({
      workspaceJid: zhaoWs.jid,
      imManager,
      targetJid: zhaoC2cJid,
      text: twoChunkRejectText,
      correlationId: 'msg-outbox-partial-rej',
      outbox: {
        provider: 'wecom',
        accountId: BOT_ID,
        sourceJid: zhaoC2cJid,
        chatId: `c2c:${CORP_ID}:m-zhao`,
        rootId: null,
        threadId: null,
        turnRunId: turnPartialRej.runId,
        ordinal: 1,
        kind: 'text',
        payload: { text: 'two-chunk-reject' },
        idempotencyKey: `${turnPartialRej.runId}:partial-rej`,
        owner: 'e2e-outbox',
      },
    });
    expect(countSendMsgs()).toBe(4);
    expect(partialRejRes.status).toBe('uncertain');
    expect(partialRejRes.error).toContain('sent_chunks=1');
    expect(getChannelOutboxItem(partialRejRes.itemId)?.status).toBe(
      'uncertain',
    );
    offline.setAckFor(() => ({ errcode: 0 }));
    const partialRejReplay = await deliverWeComTextViaOutbox({
      workspaceJid: zhaoWs.jid,
      imManager,
      targetJid: zhaoC2cJid,
      text: twoChunkRejectText,
      correlationId: 'msg-outbox-partial-rej',
      outbox: {
        provider: 'wecom',
        accountId: BOT_ID,
        sourceJid: zhaoC2cJid,
        chatId: `c2c:${CORP_ID}:m-zhao`,
        rootId: null,
        threadId: null,
        turnRunId: turnPartialRej.runId,
        ordinal: 1,
        kind: 'text',
        payload: { text: 'two-chunk-reject' },
        idempotencyKey: `${turnPartialRej.runId}:partial-rej`,
        owner: 'e2e-outbox',
      },
    });
    expect(partialRejReplay.status).toBe('uncertain');
    expect(countSendMsgs()).toBe(4);

    // (d) Multi-chunk partial unknown (chunk 1 accepted, chunk 2 timeout) -> uncertain, no replay
    await admit('msg-outbox-partial-unk');
    const turnPartialUnk = ChannelTurnRuntime.start({
      provider: 'wecom',
      accountId: BOT_ID,
      sourceJid: zhaoC2cJid,
      chatId: `c2c:${CORP_ID}:m-zhao`,
      externalMessageId: 'msg-outbox-partial-unk',
    });
    activeCleanups.push(() => {
      turnPartialUnk.interrupt('test_cleanup');
    });
    const baseSentPartialUnk = offline.sent.length;
    offline.setAckFor((_f, idx) =>
      idx === baseSentPartialUnk ? { errcode: 0 } : null,
    );
    const twoChunkUnkText = 'B'.repeat(16001);
    const partialUnkRes = await deliverWeComTextViaOutbox({
      workspaceJid: zhaoWs.jid,
      imManager,
      targetJid: zhaoC2cJid,
      text: twoChunkUnkText,
      correlationId: 'msg-outbox-partial-unk',
      outbox: {
        provider: 'wecom',
        accountId: BOT_ID,
        sourceJid: zhaoC2cJid,
        chatId: `c2c:${CORP_ID}:m-zhao`,
        rootId: null,
        threadId: null,
        turnRunId: turnPartialUnk.runId,
        ordinal: 1,
        kind: 'text',
        payload: { text: 'two-chunk-unknown' },
        idempotencyKey: `${turnPartialUnk.runId}:partial-unk`,
        owner: 'e2e-outbox',
      },
    });
    expect(countSendMsgs()).toBe(6);
    expect(partialUnkRes.status).toBe('uncertain');
    expect(partialUnkRes.error).toContain('sent_chunks=1');
    offline.setAckFor(() => ({ errcode: 0 }));
    const partialUnkReplay = await deliverWeComTextViaOutbox({
      workspaceJid: zhaoWs.jid,
      imManager,
      targetJid: zhaoC2cJid,
      text: twoChunkUnkText,
      correlationId: 'msg-outbox-partial-unk',
      outbox: {
        provider: 'wecom',
        accountId: BOT_ID,
        sourceJid: zhaoC2cJid,
        chatId: `c2c:${CORP_ID}:m-zhao`,
        rootId: null,
        threadId: null,
        turnRunId: turnPartialUnk.runId,
        ordinal: 1,
        kind: 'text',
        payload: { text: 'two-chunk-unknown' },
        idempotencyKey: `${turnPartialUnk.runId}:partial-unk`,
        owner: 'e2e-outbox',
      },
    });
    expect(partialUnkReplay.status).toBe('uncertain');
    expect(countSendMsgs()).toBe(6);

    // (e) Chunk-1 rejected (sentChunkCount=0) -> DefinitiveChannelDeliveryError -> Outbox failed (not uncertain)
    await admit('msg-outbox-chunk1-rej');
    const turnChunk1Rej = ChannelTurnRuntime.start({
      provider: 'wecom',
      accountId: BOT_ID,
      sourceJid: zhaoC2cJid,
      chatId: `c2c:${CORP_ID}:m-zhao`,
      externalMessageId: 'msg-outbox-chunk1-rej',
    });
    activeCleanups.push(() => {
      turnChunk1Rej.interrupt('test_cleanup');
    });
    offline.setAckFor(() => ({ errcode: 40003, errmsg: 'invalid_userid' }));
    const chunk1RejRes = await deliverWeComTextViaOutbox({
      workspaceJid: zhaoWs.jid,
      imManager,
      targetJid: zhaoC2cJid,
      text: '首块拒收文案',
      correlationId: 'msg-outbox-chunk1-rej',
      outbox: {
        provider: 'wecom',
        accountId: BOT_ID,
        sourceJid: zhaoC2cJid,
        chatId: `c2c:${CORP_ID}:m-zhao`,
        rootId: null,
        threadId: null,
        turnRunId: turnChunk1Rej.runId,
        ordinal: 1,
        kind: 'text',
        payload: { text: 'chunk1-rejected' },
        idempotencyKey: `${turnChunk1Rej.runId}:chunk1-rej`,
        owner: 'e2e-outbox',
      },
    });
    expect(countSendMsgs()).toBe(7);
    expect(chunk1RejRes.status).toBe('failed');
    expect(chunk1RejRes.error).toContain('wecom_rejected:sdk_ack_rejected');
    expect(getChannelOutboxItem(chunk1RejRes.itemId)?.status).toBe('failed');

    // Also emit a rule-matched fast-path marketing message to verify fast_path telemetry
    offline.emitInboundText({
      reqId: 'req-outbox-fast-1',
      msgid: 'msg-outbox-fast-1',
      userid: 'm-zhao',
      corpid: CORP_ID,
      content: '帮我写秋季护理推广文案',
    });
    await waitUntil(() =>
      db
        .getMessagesSince(zhaoWs.jid, { timestamp: '', id: '' })
        .some((m) => m.id === 'msg-outbox-fast-1'),
    );

    // Verify 4 correlated dot.wecom.* spans sharing msg-outbox-1 correlation_ref with zero plaintext leakage
    await observer.flush();
    const expectedRef = createHash('sha256')
      .update('msg-outbox-1')
      .digest('hex')
      .slice(0, 24);
    const expectedFastRef = createHash('sha256')
      .update('msg-outbox-fast-1')
      .digest('hex')
      .slice(0, 24);
    const allSpans = spanExporter.getFinishedSpans();
    const correlatedSpans = allSpans.filter((s) =>
      JSON.stringify(s.attributes).includes(expectedRef),
    );
    expect(correlatedSpans.map((s) => s.name)).toEqual(
      expect.arrayContaining([
        'dot.wecom.precheck',
        'dot.wecom.agent_turn',
        'dot.wecom.outbound_auth',
        'dot.wecom.delivery',
      ]),
    );
    const precheckSpan = correlatedSpans.find(
      (s) => s.name === 'dot.wecom.precheck',
    )!;
    const precheckAttrStr = JSON.stringify(precheckSpan.attributes);
    expect(
      JSON.parse(
        String(precheckSpan.attributes['langfuse.observation.metadata.route']),
      ),
    ).toBe('clarify');
    expect(precheckAttrStr).not.toContain('"redacted"');

    const fastPrecheckSpan = allSpans.find(
      (s) =>
        s.name === 'dot.wecom.precheck' &&
        JSON.stringify(s.attributes).includes(expectedFastRef),
    )!;
    expect(fastPrecheckSpan).toBeDefined();
    expect(
      JSON.parse(
        String(
          fastPrecheckSpan.attributes['langfuse.observation.metadata.route'],
        ),
      ),
    ).toBe('fast_path');
    expect(JSON.stringify(fastPrecheckSpan.attributes)).not.toContain(
      '"redacted"',
    );

    const serializedAllSpans = JSON.stringify(allSpans.map((s) => s.attributes));
    for (const secret of [
      'msg-outbox-1',
      'msg-outbox-fast-1',
      'm-zhao',
      BOT_ID,
      'sk-e2e-never-export',
      '我想吸引附近新客进店体验项目',
      '帮我写秋季护理推广文案',
      '秋季护理文案草稿正文',
      '超时未确认文案',
      'AAAA',
      'BBBB',
    ]) {
      expect(serializedAllSpans).not.toContain(secret);
    }
  }, 15_000);

  test('Outbound M03 recheck blocks in-flight slow Agent result after permission revocation (blocked, zero physical wire send)', async () => {
    const now = () => new Date(Date.UTC(2026, 10, 12, 6, 0, 0));
    const world = await createSeededMemoryWorld(now);
    const offline = createOfflineWsClient();
    const imManager = new IMConnectionManager();
    const groupsMap: Record<string, RegisteredGroup> = {};
    const wiring = createRuntimeWiringHarness(groupsMap);

    const spanExporter = new InMemorySpanExporter();
    const observer = new HostObservability({
      publicKey: 'pk-e2e-revoke',
      secretKey: 'sk-e2e-revoke-secret',
      baseUrl: 'https://langfuse.example.test/',
      installationId: 'inst-revoke-e2e',
      sampleRate: 1,
      exporter: spanExporter,
    });
    activeCleanups.push(() => observer.close());

    let markAgentEntered!: () => void;
    const agentEntered = new Promise<void>((resolve) => {
      markAgentEntered = resolve;
    });
    let releaseAgentResult!: () => void;
    const gateAgentResult = new Promise<void>((resolve) => {
      releaseAgentResult = resolve;
    });
    let pendingOutboxPromise: Promise<
      Awaited<ReturnType<typeof deliverWeComTextViaOutbox>>
    > | null = null;

    const runtime = await startWeComFrontClawRuntime({
      env: {
        FRONT_CLAW_WECOM_ENABLED: '1',
        FRONT_CLAW_WECOM_BOT_ID: BOT_ID,
        FRONT_CLAW_WECOM_BOT_SECRET: 'secret-revoke',
        FRONT_CLAW_NOTIFY_DISPATCH: '0',
      },
      imManager,
      ...wiring,
      startMaintenance: false,
      onMessage: (chatJid) => {
        markAgentEntered();
        pendingOutboxPromise = (async () => {
          await gateAgentResult;
          const turn = ChannelTurnRuntime.start({
            provider: 'wecom',
            accountId: BOT_ID,
            sourceJid: chatJid,
            chatId: `c2c:${CORP_ID}:m-zhao`,
            externalMessageId: 'msg-revoke-inflight-1',
          });
          activeCleanups.push(() => {
            turn.interrupt('test_cleanup');
          });
          const res = await deliverWeComTextViaOutbox({
            imManager,
            targetJid: chatJid,
            text: '撤权后严禁外发的营销回复',
            correlationId: 'msg-revoke-inflight-1',
            workspaceJid: deriveEmployeeWeComWorkspace({
              corpId: CORP_ID,
              botId: BOT_ID,
              memberId: 'm-zhao',
              storeId: 's-b',
            }).jid,
            outbox: {
              provider: 'wecom',
              accountId: BOT_ID,
              sourceJid: chatJid,
              chatId: `c2c:${CORP_ID}:m-zhao`,
              rootId: null,
              threadId: null,
              turnRunId: turn.runId,
              ordinal: 1,
              kind: 'text',
              payload: { text: '撤权后严禁外发的营销回复' },
              idempotencyKey: `${turn.runId}:revoke-1`,
              owner: 'e2e-revoke',
            },
          });
          turn.complete();
          return res;
        })();
      },
      wecomConnection: {
        client: offline.client,
        sendTimeoutMs: 60,
        leaseCheckIntervalMs: 50,
      },
      bridgeOptions: {
        now,
        open: world.open,
        lease: { enabled: true, owner: 'node-revoke', ttlMs: 5000, renewMs: 1000 },
        modelClassify: async () => ({
          intent: 'marketing',
          object: null,
          action: null,
          slots: {},
          confidence: 0.99,
          uncertain: false,
        }),
      },
    });
    expect(runtime).not.toBeNull();
    activeCleanups.push(async () => {
      releaseAgentResult();
      await runtime!.close();
      await imManager.disconnectAll();
    });

    offline.emitInboundText({
      reqId: 'req-revoke-1',
      msgid: 'msg-revoke-inflight-1',
      userid: 'm-zhao',
      corpid: CORP_ID,
      content: '帮我写会员日文案',
    });

    await agentEntered;

    // Revoke marketing capability in PG M03 policy while Agent turn is in flight
    const basePolicy = buildPolicy(2);
    const revoked = await updateAccessPolicy(world.store, {
      expectedVersion: 2,
      next: {
        ...basePolicy,
        version: 3,
        members: {
          ...basePolicy.members,
          'p-zhao': {
            role: 'employee',
            storeIds: ['s-b'],
            status: 'active',
            capabilities: [],
          },
        },
      },
      actor: 'e2e-admin',
      reason: 'revoke_marketing_in_flight',
      at: now().toISOString(),
    });
    expect(revoked.ok).toBe(true);

    releaseAgentResult();
    expect(pendingOutboxPromise).not.toBeNull();
    const outboxResult = await pendingOutboxPromise!;

    expect(outboxResult.status).toBe('failed');
    expect(outboxResult.error).toContain('wecom_blocked:capability_denied');
    expect(getChannelOutboxItem(outboxResult.itemId)?.status).toBe('failed');
    expect(offline.sent.filter((f) => f.cmd === WsCmd.SEND_MSG)).toHaveLength(
      0,
    );

    await observer.flush();
    const expectedRef = createHash('sha256')
      .update('msg-revoke-inflight-1')
      .digest('hex')
      .slice(0, 24);
    const spans = spanExporter
      .getFinishedSpans()
      .filter((s) => JSON.stringify(s.attributes).includes(expectedRef));
    const authSpan = spans.find((s) => s.name === 'dot.wecom.outbound_auth');
    const deliverySpan = spans.find((s) => s.name === 'dot.wecom.delivery');
    expect(authSpan).toBeDefined();
    expect(
      JSON.parse(
        String(authSpan!.attributes['langfuse.observation.metadata.reason']),
      ),
    ).toBe('capability_denied');
    expect(
      JSON.parse(
        String(authSpan!.attributes['langfuse.observation.metadata.allowed']),
      ),
    ).toBe(false);
    expect(deliverySpan).toBeDefined();
    expect(
      JSON.parse(
        String(
          deliverySpan!.attributes['langfuse.observation.metadata.outbox_status'],
        ),
      ),
    ).toBe('failed');
    expect(
      JSON.parse(
        String(
          deliverySpan!.attributes['langfuse.observation.metadata.wecom_state'],
        ),
      ),
    ).toBe('blocked');
  }, 15_000);

  test('Single managed marketing skill switch (FRONT_CLAW_WECOM_MARKETING_SKILL_ID) selects sole skill with minimal toolset and fails closed on invalid skill', async () => {
    const now = () => new Date(Date.UTC(2026, 10, 12, 6, 0, 0));
    const world = await createSeededMemoryWorld(now);
    const offline = createOfflineWsClient();
    const imManager = new IMConnectionManager();
    const groupsMap: Record<string, RegisteredGroup> = {};
    const wiring = createRuntimeWiringHarness(groupsMap);

    const testUserSkillsDir = path.join(tmp, 'skills', 'admin-e2e-skill-test');
    const decoyHostSkillsDir = path.join(tmp, 'host-claude-decoy', 'skills');
    fs.mkdirSync(path.join(decoyHostSkillsDir, 'host-only-skill'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(decoyHostSkillsDir, 'host-only-skill', 'SKILL.md'),
      '---\nname: host-only-skill\ndescription: decoy host skill\n---\n# Host\n',
    );
    fs.mkdirSync(path.join(testUserSkillsDir, 'unrelated-skill'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(testUserSkillsDir, 'unrelated-skill', 'SKILL.md'),
      '---\nname: unrelated-skill\ndescription: decoy unrelated managed skill\n---\n# Unrelated\n',
    );

    const runtime = await startWeComFrontClawRuntime({
      env: {
        FRONT_CLAW_WECOM_ENABLED: '1',
        FRONT_CLAW_WECOM_BOT_ID: BOT_ID,
        FRONT_CLAW_WECOM_BOT_SECRET: 'secret-skill-on',
        FRONT_CLAW_NOTIFY_DISPATCH: '0',
        FRONT_CLAW_WECOM_MARKETING_SKILL_ID: 'beauty-local-content',
      },
      imManager,
      ...wiring,
      userSkillsDir: testUserSkillsDir,
      startMaintenance: false,
      wecomConnection: { client: offline.client, leaseCheckIntervalMs: 50 },
      bridgeOptions: {
        now,
        open: world.open,
        lease: { enabled: true, owner: 'node-skill-1', ttlMs: 5000, renewMs: 1000 },
        modelClassify: async () => ({
          intent: 'marketing',
          object: null,
          action: null,
          slots: {},
          confidence: 0.99,
          uncertain: false,
        }),
      },
    });
    expect(runtime).not.toBeNull();
    expect(runtime!.marketingSkillId).toBe('beauty-local-content');

    offline.emitInboundText({
      reqId: 'req-skill-1',
      msgid: 'msg-skill-1',
      userid: 'm-zhao',
      corpid: CORP_ID,
      content: '帮我写防晒套餐种草文案',
    });
    const zhaoWs = deriveEmployeeWeComWorkspace({
      corpId: CORP_ID,
      botId: BOT_ID,
      memberId: 'm-zhao',
      storeId: 's-b',
    });
    await waitUntil(() =>
      db
        .getMessagesSince(zhaoWs.jid, { timestamp: '', id: '' })
        .some((m) => m.id === 'msg-skill-1'),
    );

    const enabledProfile = db.getAgentProfileForWorkspace(
      zhaoWs.folder,
      'admin-e2e',
    );
    expect(enabledProfile).toBeDefined();
    expect(enabledProfile!.name).toBe(WECOM_SAFE_PROFILE_NAME);
    expect(enabledProfile!.is_default).toBe(false);
    expect(enabledProfile!.runtime_policy.context.source).toBe('managed');
    expect(enabledProfile!.runtime_policy.mcp.mode).toBe('disabled');
    expect(enabledProfile!.runtime_policy.skills).toEqual({
      mode: 'custom',
      ids: ['beauty-local-content'],
      host: { mode: 'disabled', ids: [] },
    });

    const manifest = resolveEffectiveSkills({
      layers: [
        { source: 'host', root: decoyHostSkillsDir },
        { source: 'managed', root: testUserSkillsDir },
      ],
      managedPolicy: enabledProfile!.runtime_policy.skills,
      hostPolicy: enabledProfile!.runtime_policy.skills.host!,
    });
    expect(manifest.missingManagedSkillIds).toEqual([]);
    expect(manifest.missingHostSkillIds).toEqual([]);
    expect(manifest.selected.map((s) => s.id)).toEqual([
      'beauty-local-content',
    ]);

    expect(
      validateTargetAgentProfile({
        profileId: enabledProfile!.id,
        workspaceJid: zhaoWs.jid,
        status: enabledProfile!.status,
        executionMode: 'container',
        contextSource: enabledProfile!.runtime_policy.context.source,
        hostSkillsMode: enabledProfile!.runtime_policy.skills.host?.mode,
        runtimePolicy: {
          context: enabledProfile!.runtime_policy.context,
          skills: enabledProfile!.runtime_policy.skills,
        },
        disallowedTools: [...SAFE_MARKETING_DISALLOWED_TOOLS],
      }),
    ).toEqual({ ok: true });

    const policy = resolveDisallowedToolSet(
      {
        agentProfile: {
          id: enabledProfile!.id,
          name: enabledProfile!.name,
          version: enabledProfile!.version,
          isDefault: false,
          identityHash: enabledProfile!.identity_hash,
          identityPrompt: enabledProfile!.identity_prompt,
          includeClaudePreset: false,
          disallowedTools: [...SAFE_MARKETING_DISALLOWED_TOOLS],
        },
      },
      {},
    );
    for (const blocked of [
      'Bash',
      'Write',
      'Edit',
      'NotebookEdit',
      'Task',
      'TaskOutput',
      'TaskStop',
      'WebFetch',
      'WebSearch',
      'mcp__miniclaw__send_message',
      'mcp__miniclaw__schedule_task',
    ]) {
      expect(isToolDisallowed(blocked, policy.canonicalLower), blocked).toBe(
        true,
      );
    }
    for (const allowed of ['Read', 'Glob', 'Grep']) {
      expect(isToolDisallowed(allowed, policy.canonicalLower), allowed).toBe(
        false,
      );
    }

    await runtime!.close();
    await imManager.disconnectAll();

    // Fail-closed: invalid/unbundled skillId disables skills instead of inheriting or throwing
    const offlineInvalid = createOfflineWsClient();
    const imManagerInvalid = new IMConnectionManager();
    const invalidRuntime = await startWeComFrontClawRuntime({
      env: {
        FRONT_CLAW_WECOM_ENABLED: '1',
        FRONT_CLAW_WECOM_BOT_ID: BOT_ID,
        FRONT_CLAW_WECOM_BOT_SECRET: 'secret-skill-invalid',
        FRONT_CLAW_NOTIFY_DISPATCH: '0',
        FRONT_CLAW_WECOM_MARKETING_SKILL_ID: 'training-knowledge',
      },
      imManager: imManagerInvalid,
      ...wiring,
      userSkillsDir: testUserSkillsDir,
      startMaintenance: false,
      wecomConnection: {
        client: offlineInvalid.client,
        leaseCheckIntervalMs: 50,
      },
      bridgeOptions: {
        now,
        open: world.open,
        lease: { enabled: true, owner: 'node-skill-2', ttlMs: 5000, renewMs: 1000 },
      },
    });
    expect(invalidRuntime).not.toBeNull();
    expect(invalidRuntime!.marketingSkillId).toBeNull();
    const failClosedProfile = db.getAgentProfileForWorkspace(
      zhaoWs.folder,
      'admin-e2e',
    );
    expect(failClosedProfile!.runtime_policy.skills).toEqual({
      mode: 'disabled',
      ids: [],
      host: { mode: 'disabled', ids: [] },
    });
    await invalidRuntime!.close();
    await imManagerInvalid.disconnectAll();

    // Toggling env off keeps Safe Marketing Profile locked to skills.mode = 'disabled'
    const offlineOff = createOfflineWsClient();
    const imManagerOff = new IMConnectionManager();
    const offRuntime = await startWeComFrontClawRuntime({
      env: {
        FRONT_CLAW_WECOM_ENABLED: '1',
        FRONT_CLAW_WECOM_BOT_ID: BOT_ID,
        FRONT_CLAW_WECOM_BOT_SECRET: 'secret-skill-off',
        FRONT_CLAW_NOTIFY_DISPATCH: '0',
        FRONT_CLAW_WECOM_MARKETING_SKILL_ID: '',
      },
      imManager: imManagerOff,
      ...wiring,
      userSkillsDir: testUserSkillsDir,
      startMaintenance: false,
      wecomConnection: {
        client: offlineOff.client,
        leaseCheckIntervalMs: 50,
      },
      bridgeOptions: {
        now,
        open: world.open,
        lease: { enabled: true, owner: 'node-skill-3', ttlMs: 5000, renewMs: 1000 },
      },
    });
    expect(offRuntime).not.toBeNull();
    expect(offRuntime!.marketingSkillId).toBeNull();
    expect(
      db.getAgentProfileForWorkspace(zhaoWs.folder, 'admin-e2e')!.runtime_policy
        .skills,
    ).toEqual({
      mode: 'disabled',
      ids: [],
      host: { mode: 'disabled', ids: [] },
    });
    await offRuntime!.close();
    await imManagerOff.disconnectAll();
  }, 15_000);

  test('P2 Oral UX E2E: D175 确认认账 typo tolerance & tail reminder consistency, remark-whitelist direct draft, cross-store shorthand refusal, and multi-turn appointment time slot fill', async () => {
    let nowMs = Date.UTC(2026, 10, 12, 6, 0, 0);
    const now = () => new Date(nowMs);
    const world = await createSeededMemoryWorld(now);
    // Add a second store person so cross-store shorthand "二店" resolves to 测试二店
    await world.store.savePerson({
      personId: 'p-other-store',
      accountId: 'a-other-store',
      memberId: 'm-other-store',
      displayName: '二店店长',
      storeId: 's-a',
      storeName: '测试二店',
      tier: 'manager',
      roles: ['marketing'],
      active: true,
    });

    const offline = createOfflineWsClient();
    const imManager = new IMConnectionManager();
    const groupsMap: Record<string, RegisteredGroup> = {};
    const wiring = createRuntimeWiringHarness(groupsMap);

    const runtime = await startWeComFrontClawRuntime({
      env: {
        FRONT_CLAW_WECOM_ENABLED: '1',
        FRONT_CLAW_WECOM_BOT_ID: BOT_ID,
        FRONT_CLAW_WECOM_BOT_SECRET: 'secret-oral-ux',
        FRONT_CLAW_NOTIFY_DISPATCH: '0',
      },
      imManager,
      ...wiring,
      startMaintenance: false,
      wecomConnection: { client: offline.client, leaseCheckIntervalMs: 50 },
      bridgeOptions: {
        now,
        open: world.open,
        lease: { enabled: true, owner: 'node-oral-ux', ttlMs: 5000, renewMs: 1000 },
        modelClassify: async ({ text }) => {
          if (text.includes('文案')) {
            return {
              intent: 'marketing',
              object: null,
              action: null,
              slots: {},
              confidence: 0.98,
              uncertain: false,
            };
          }
          return {
            intent: 'unknown',
            object: null,
            action: null,
            slots: {},
            confidence: 0,
            uncertain: true,
          };
        },
      },
    });
    expect(runtime).not.toBeNull();
    activeCleanups.push(async () => {
      await runtime!.close();
      await imManager.disconnectAll();
    });

    const replyBodyFor = async (reqId: string) => {
      await waitUntil(() =>
        offline.sent.some((f) => f.headers.req_id === reqId),
      );
      return JSON.stringify(
        offline.sent.find((f) => f.headers.req_id === reqId)?.body ?? '',
      );
    };

    // 1. White-listed project remark: "张姐刚做了补水项目680" -> directly creates pending draft (no "行尾备注「补水项目」需要确认")
    offline.emitInboundText({
      reqId: 'req-oral-remark-1',
      msgid: 'msg-oral-remark-1',
      userid: 'm-zhao',
      corpid: CORP_ID,
      content: '张姐刚做了补水项目680',
    });
    const remarkReply = await replyBodyFor('req-oral-remark-1');
    expect(remarkReply).toContain('还没入账');
    expect(remarkReply).toContain('680');
    expect(remarkReply).not.toContain('行尾备注');

    // 2. Interleave a marketing pass -> single-char "对" is blocked, non-whitelist remark reminder tail uses 「确认入账」或「全部确认」, and typo "确认认账" commits 1 entry
    offline.emitInboundText({
      reqId: 'req-oral-interleave-mk',
      msgid: 'msg-oral-interleave-mk',
      userid: 'm-zhao',
      corpid: CORP_ID,
      content: '帮我写一条秋冬补水朋友圈文案',
    });
    const zhaoMarketingWs = deriveWeComEmployeeWorkspace({
      corpId: CORP_ID,
      botId: BOT_ID,
      memberId: 'm-zhao',
      storeId: 's-b',
      targetRole: 'marketing',
    });
    await waitUntil(() =>
      db
        .getMessagesSince(zhaoMarketingWs.jid, { timestamp: '', id: '' })
        .some((m) => m.id === 'msg-oral-interleave-mk'),
    );

    offline.emitInboundText({
      reqId: 'req-oral-single-dui',
      msgid: 'msg-oral-single-dui',
      userid: 'm-zhao',
      corpid: CORP_ID,
      content: '对',
    });
    const duiReply = await replyBodyFor('req-oral-single-dui');
    expect(duiReply).toContain(D175_INTERLEAVED_GUIDANCE);
    expect(duiReply).not.toContain('已入账');

    // Non-whitelist remark while interleaved draft is pending -> tail reminder must NOT say "回「对」确认", must say "回「确认入账」或「全部确认」确认"
    offline.emitInboundText({
      reqId: 'req-oral-tail-hint',
      msgid: 'msg-oral-tail-hint',
      userid: 'm-zhao',
      corpid: CORP_ID,
      content: '李姐：2867（小赵）先记着',
    });
    const tailHintReply = await replyBodyFor('req-oral-tail-hint');
    expect(tailHintReply).toContain('还在等你回「确认入账」或「全部确认」确认');
    expect(tailHintReply).not.toContain('还在等你回「对」确认');

    // Typo tolerance: "确认认账" commits the 680 draft exactly once
    offline.emitInboundText({
      reqId: 'req-oral-typo-confirm',
      msgid: 'msg-oral-typo-confirm',
      userid: 'm-zhao',
      corpid: CORP_ID,
      content: '确认认账',
    });
    const typoConfirmReply = await replyBodyFor('req-oral-typo-confirm');
    expect(typoConfirmReply).toContain('已入账 1 笔');
    const zhaoEntries = (await world.store.listEntries()).filter(
      (e) => e.reporterPersonId === 'p-zhao',
    );
    expect(zhaoEntries).toHaveLength(1);
    expect(zhaoEntries[0]!.amount).toBe(68000);

    // 3. Cross-store shorthand refusal: "查一下二店业绩" -> refused as cross-store, never returns own store summary
    offline.emitInboundText({
      reqId: 'req-oral-cross-store',
      msgid: 'msg-oral-cross-store',
      userid: 'm-wang-yj',
      corpid: CORP_ID,
      content: '查一下二店业绩',
    });
    const crossStoreReply = await replyBodyFor('req-oral-cross-store');
    expect(crossStoreReply).toContain('不能做——只能办本店（测试B店）的事');
    expect(crossStoreReply).toContain('测试二店');

    // 4. Multi-turn appointment time slot completion: "王姐明天下午补水预约" -> asks time -> "4点" -> creates pending draft for 16:00 -> "对" registers appointment
    offline.emitInboundText({
      reqId: 'req-oral-appt-ask',
      msgid: 'msg-oral-appt-ask',
      userid: 'm-zhao',
      corpid: CORP_ID,
      content: '王姐明天下午补水预约',
    });
    const apptAskReply = await replyBodyFor('req-oral-appt-ask');
    expect(apptAskReply).toContain('预约要说清几点');

    offline.emitInboundText({
      reqId: 'req-oral-appt-fill',
      msgid: 'msg-oral-appt-fill',
      userid: 'm-zhao',
      corpid: CORP_ID,
      content: '4点',
    });
    const apptFillReply = await replyBodyFor('req-oral-appt-fill');
    expect(apptFillReply).toContain('王姐');
    expect(apptFillReply).toContain('16:00');
    expect(apptFillReply).toContain('预约还没登记');

    offline.emitInboundText({
      reqId: 'req-oral-appt-confirm',
      msgid: 'msg-oral-appt-confirm',
      userid: 'm-zhao',
      corpid: CORP_ID,
      content: '对',
    });
    const apptConfirmReply = await replyBodyFor('req-oral-appt-confirm');
    expect(apptConfirmReply).toContain('预约已登记');
    expect(await world.store.listAppointments()).toHaveLength(1);
  }, 15_000);

  test('P2 Auto Role Grant & 4 Soft-Role Workspaces + 7 Bundled Skills + Readonly Context Injection E2E', async () => {
    let nowMs = Date.UTC(2026, 10, 12, 6, 0, 0);
    const now = () => new Date(nowMs);
    const world = await createSeededMemoryWorld(now);

    // Seed a confirmed store entry for 测试B店 so manager_ops review snapshot has real numbers
    await world.store.insertEntries([
      {
        entryId: 'e2e-store-entry-1',
        storeId: 's-b',
        businessDay: '2026-11-12',
        ownerPersonId: 'p-zhao',
        ownerName: '小赵',
        reporterPersonId: 'p-zhao',
        customerName: '内部客户名绝不外泄',
        amount: 158000,
        amountType: 'consultant',
        note: '补水护理',
        status: 'confirmed',
        disputed: false,
        createdAt: '2026-11-12T03:00:00Z',
      },
    ]);

    // Ensure m-lin starts with roles: [] and only ['report_self'] in M03 policy to verify auto-grant on first message
    const basePolicy = buildPolicy(1);
    const policyBeforeAutoGrant = await updateAccessPolicy(world.store, {
      expectedVersion: 1,
      next: {
        ...basePolicy,
        version: 2,
        members: {
          ...basePolicy.members,
          'p-lin': {
            role: 'employee',
            storeIds: ['s-b'],
            status: 'active',
            capabilities: ['report_self'],
          },
        },
      },
      actor: 'e2e-admin',
      reason: 'prepare-auto-grant-e2e',
      at: now().toISOString(),
    });
    expect(policyBeforeAutoGrant.ok).toBe(true);
    expect((await world.store.getPerson('p-lin'))?.roles).toEqual([]);

    const offline = createOfflineWsClient();
    const imManager = new IMConnectionManager();
    const groupsMap: Record<string, RegisteredGroup> = {};
    const wiring = createRuntimeWiringHarness(groupsMap);
    const testUserSkillsDir = path.join(tmp, 'skills', 'admin-e2e-four-roles');

    const runtime = await startWeComFrontClawRuntime({
      env: {
        FRONT_CLAW_WECOM_ENABLED: '1',
        FRONT_CLAW_WECOM_BOT_ID: BOT_ID,
        FRONT_CLAW_WECOM_BOT_SECRET: 'secret-p2-full',
        FRONT_CLAW_NOTIFY_DISPATCH: '0',
      },
      imManager,
      ...wiring,
      userSkillsDir: testUserSkillsDir,
      startMaintenance: false,
      wecomConnection: { client: offline.client, leaseCheckIntervalMs: 50 },
      bridgeOptions: {
        now,
        open: world.open,
        lease: { enabled: true, owner: 'node-p2-full', ttlMs: 5000, renewMs: 1000 },
        modelClassify: async () => ({
          intent: 'marketing',
          object: null,
          action: null,
          slots: {},
          confidence: 0.99,
          uncertain: false,
        }),
      },
    });
    expect(runtime).not.toBeNull();
    activeCleanups.push(async () => {
      await runtime!.close();
      await imManager.disconnectAll();
    });

    expect(runtime!.enabledRoles).toEqual([
      'marketing',
      'training',
      'manager_ops',
      'reception_ads',
    ]);
    expect(runtime!.roleSkillIds).toEqual(WECOM_ROLE_SKILL_IDS);

    // Part A: Newly bound employee m-lin (roles=[], only report_self) is auto-granted on first message and can use soft role + progress_self
    offline.emitInboundText({
      reqId: 'req-autogrant-lin-1',
      msgid: 'msg-autogrant-lin-1',
      userid: 'm-lin',
      corpid: CORP_ID,
      content: '顾客嫌贵怎么接待',
    });
    const linReceptionWs = deriveWeComEmployeeWorkspace({
      corpId: CORP_ID,
      botId: BOT_ID,
      memberId: 'm-lin',
      storeId: 's-b',
      targetRole: 'reception_ads',
    });
    await waitUntil(() =>
      db
        .getMessagesSince(linReceptionWs.jid, { timestamp: '', id: '' })
        .some((m) => m.id === 'msg-autogrant-lin-1'),
    );
    expect((await world.store.getPerson('p-lin'))?.roles).toContain(
      'marketing',
    );

    // Employee m-lin requesting manager_ops review is directly denied by fast path and never enters manager_ops workspace
    offline.emitInboundText({
      reqId: 'req-lin-mgr-denied',
      msgid: 'msg-lin-mgr-denied',
      userid: 'm-lin',
      corpid: CORP_ID,
      content: '请给我日报建议和经营诊断',
    });
    await waitUntil(() =>
      offline.sent.some((f) => f.headers.req_id === 'req-lin-mgr-denied'),
    );
    const linDeniedReply = JSON.stringify(
      offline.sent.find((f) => f.headers.req_id === 'req-lin-mgr-denied')?.body ??
        '',
    );
    expect(linDeniedReply).toContain('店长经营复盘仅对本店店长或老板开放');

    // Once revoked (status: 'revoked'), auto-grant NEVER resurrects m-lin
    const currentPolicyAfterAuto = buildPolicy(3);
    const revokedLin = await updateAccessPolicy(world.store, {
      expectedVersion: 3,
      next: {
        ...currentPolicyAfterAuto,
        version: 4,
        members: {
          ...currentPolicyAfterAuto.members,
          'p-lin': {
            role: 'employee',
            storeIds: ['s-b'],
            status: 'revoked',
            capabilities: ['report_self'],
          },
        },
      },
      actor: 'e2e-admin',
      reason: 'revoke-lin',
      at: now().toISOString(),
    });
    expect(revokedLin.ok).toBe(true);
    const linPerson = (await world.store.getPerson('p-lin'))!;
    await world.store.savePerson({ ...linPerson, roles: [] });

    offline.emitInboundText({
      reqId: 'req-lin-after-revoke',
      msgid: 'msg-lin-after-revoke',
      userid: 'm-lin',
      corpid: CORP_ID,
      content: '帮我写一条朋友圈文案',
    });
    await waitUntil(() =>
      offline.sent.some((f) => f.headers.req_id === 'req-lin-after-revoke'),
    );
    expect((await world.store.getPerson('p-lin'))?.roles).toEqual([]);
    expect(
      db
        .getMessagesSince(
          deriveWeComEmployeeWorkspace({
            corpId: CORP_ID,
            botId: BOT_ID,
            memberId: 'm-lin',
            storeId: 's-b',
            targetRole: 'marketing',
          }).jid,
          { timestamp: '', id: '' },
        )
        .some((m) => m.id === 'msg-lin-after-revoke'),
    ).toBe(false);

    // Part B: Manager m-wang-yj routes across all 4 soft roles with isolated workspaces, 7 bundled skills, and readonlyContext injection
    const roleTurnSpecs: ReadonlyArray<{
      role: WeComSoftRole;
      reqId: string;
      msgId: string;
      text: string;
      expectedSkills: readonly string[];
      expectedContextSubstrings?: readonly string[];
    }> = [
      {
        role: 'marketing',
        reqId: 'req-mgr-role-mk',
        msgId: 'msg-mgr-role-mk',
        text: '帮我写一条周末补水活动朋友圈文案',
        expectedSkills: [
          'beauty-local-content',
          'vendor-content-strategy',
          'vendor-copywriting',
        ],
      },
      {
        role: 'training',
        reqId: 'req-mgr-role-tr',
        msgId: 'msg-mgr-role-tr',
        text: '家访五步法怎么带教新人？',
        expectedSkills: ['beauty-training-coach'],
        expectedContextSubstrings: [
          '[系统受控只读参考资料（已通过 M03 权限校验，严禁声称已写库或修改账目）]',
          '【受控培训参考】',
          '家访五步法',
          '[员工本轮提问]\n家访五步法怎么带教新人？',
        ],
      },
      {
        role: 'manager_ops',
        reqId: 'req-mgr-role-ops',
        msgId: 'msg-mgr-role-ops',
        text: '请给我日报建议和经营诊断',
        expectedSkills: ['beauty-manager-daily'],
        expectedContextSubstrings: [
          '[系统受控只读参考资料（已通过 M03 权限校验，严禁声称已写库或修改账目）]',
          '【本店只读经营快照（供复盘参考，严禁声称可改账）】',
          '业务日：2026-11-12',
          '今日已确认业绩：1580元（1笔）',
          '[员工本轮提问]\n请给我日报建议和经营诊断',
        ],
      },
      {
        role: 'reception_ads',
        reqId: 'req-mgr-role-rc',
        msgId: 'msg-mgr-role-rc',
        text: '顾客嫌贵怎么接待？顺便看下美团团购诊断思路',
        expectedSkills: ['beauty-reception', 'beauty-ads-review'],
      },
    ];

    const derivedWorkspaces = new Map<
      WeComSoftRole,
      { jid: string; folder: string; role: WeComSoftRole }
    >();

    for (const spec of roleTurnSpecs) {
      const ws = deriveWeComEmployeeWorkspace({
        corpId: CORP_ID,
        botId: BOT_ID,
        memberId: 'm-wang-yj',
        storeId: 's-b',
        targetRole: spec.role,
      });
      derivedWorkspaces.set(spec.role, ws);
      expect(isWeComManagedWorkspaceJid(ws.jid)).toBe(true);
      expect(isWeComManagedWorkspaceFolder(ws.folder)).toBe(true);

      offline.emitInboundText({
        reqId: spec.reqId,
        msgid: spec.msgId,
        userid: 'm-wang-yj',
        corpid: CORP_ID,
        content: spec.text,
      });

      await waitUntil(
        () =>
          db
            .getMessagesSince(ws.jid, { timestamp: '', id: '' })
            .some((m) => m.id === spec.msgId),
        3000,
        15,
        async () =>
          JSON.stringify({
            role: spec.role,
            wsJid: ws.jid,
            sent: offline.sent.slice(-4),
            policy: await world.store.getConfig('front-claw-access'),
            warns: log.warn.mock.calls.slice(-3),
          }),
      );
    }

    // All 4 workspace JIDs and folders are distinct
    const allRoleJids = [...derivedWorkspaces.values()].map((w) => w.jid);
    const allRoleFolders = [...derivedWorkspaces.values()].map((w) => w.folder);
    expect(new Set(allRoleJids).size).toBe(4);
    expect(new Set(allRoleFolders).size).toBe(4);
    expect(derivedWorkspaces.get('training')!.jid).toMatch(
      /^web:wecom-front-claw:training:[a-f0-9]{16}$/,
    );

    // Issue #9 training-knowledge.ts parseTrainingSummary accepts the derived training workspaceJid
    const sampleDoc = '# 培训教材\n\n## 家访五步法\n先了解现状。';
    expect(
      parseTrainingSummary(
        sampleDoc,
        createHash('sha256').update(sampleDoc).digest('hex'),
        {
          accountId: 'a-wang',
          workspaceJid: derivedWorkspaces.get('training')!.jid,
        },
        'sample.md',
      ).title,
    ).toBe('培训教材');

    for (const spec of roleTurnSpecs) {
      const ws = derivedWorkspaces.get(spec.role)!;
      const msgs = db.getMessagesSince(ws.jid, { timestamp: '', id: '' });
      expect(msgs).toHaveLength(1);
      const storedText = msgs[0]!.content;

      if (spec.expectedContextSubstrings) {
        for (const sub of spec.expectedContextSubstrings) {
          expect(storedText).toContain(sub);
        }
        expect(storedText).not.toContain('内部客户名绝不外泄');
        expect(storedText).not.toContain('postgres://');
      } else {
        expect(storedText).toBe(spec.text);
      }

      const profile = db.getAgentProfileForWorkspace(ws.folder, 'admin-e2e');
      expect(profile).toBeDefined();
      expect(profile!.name).toBe(WECOM_SAFE_ROLE_PROFILE_NAMES[spec.role]);
      expect(profile!.is_default).toBe(false);
      expect(profile!.runtime_policy.context.source).toBe('managed');
      expect(profile!.runtime_policy.mcp.mode).toBe('disabled');
      expect(profile!.runtime_policy.skills).toEqual({
        mode: 'custom',
        ids: [...spec.expectedSkills],
        host: { mode: 'disabled', ids: [] },
      });

      const manifest = resolveEffectiveSkills({
        layers: [{ source: 'managed', root: testUserSkillsDir }],
        managedPolicy: profile!.runtime_policy.skills,
        hostPolicy: profile!.runtime_policy.skills.host!,
      });
      expect(manifest.missingManagedSkillIds).toEqual([]);
      expect(manifest.selected.map((s) => s.id).sort()).toEqual(
        [...spec.expectedSkills].sort(),
      );
    }

    const managerJid = `wecom:c2c:${CORP_ID}:m-wang-yj`;
    let ordinal = 0;
    async function deliverOriginal(
      role: WeComSoftRole,
      actualWorkspace = derivedWorkspaces.get(role)!.jid,
    ) {
      const originalWorkspace = derivedWorkspaces.get(role)!.jid;
      const stored = db.getMessagesSince(originalWorkspace, {
        timestamp: '',
        id: '',
      })[0]!;
      const turn = ChannelTurnRuntime.start({
        provider: 'wecom',
        accountId: BOT_ID,
        sourceJid: stored.source_jid!,
        chatId: `c2c:${CORP_ID}:m-wang-yj`,
        externalMessageId: stored.id,
      });
      activeCleanups.push(() => {
        turn.interrupt('test_cleanup');
      });
      ordinal++;
      return deliverWeComTextViaOutbox({
        imManager,
        targetJid: managerJid,
        text: 'synthetic reply',
        correlationId: 'warm-runner-delivery-id',
        workspaceJid: actualWorkspace,
        outbox: {
          provider: 'wecom',
          accountId: BOT_ID,
          sourceJid: managerJid,
          chatId: `c2c:${CORP_ID}:m-wang-yj`,
          turnRunId: turn.runId,
          ordinal,
          kind: 'text',
          payload: { text: 'synthetic reply' },
          idempotencyKey: `${turn.runId}:scope-check:${ordinal}`,
          owner: 'test-scoped-delivery',
        },
      });
    }
    const originalPolicy = JSON.parse(
      (await world.store.getConfig('front-claw-access'))!,
    ) as AccessPolicy;
    const narrowed = structuredClone(originalPolicy);
    narrowed.version++;
    narrowed.members['p-wang']!.capabilities = ['progress_self', 'marketing'];
    expect(
      (
        await updateAccessPolicy(world.store, {
          expectedVersion: originalPolicy.version,
          next: narrowed,
          actor: 'test-admin',
          reason: 'withdraw review while reply is pending',
          at: now().toISOString(),
        })
      ).ok,
    ).toBe(true);
    const sent = () =>
      offline.sent.filter((frame) => frame.cmd === WsCmd.SEND_MSG).length;
    const before = sent();
    offline.client.connect();
    expect((await deliverOriginal('manager_ops')).status).toBe('failed');
    expect(
      (
        await deliverOriginal(
          'manager_ops',
          derivedWorkspaces.get('marketing')!.jid,
        )
      ).status,
    ).toBe('failed');
    expect(
      (
        await imManager.sendMessageWithReceipt(
          managerJid,
          'forged scope',
          Object.assign(
            { correlationId: 'msg-mgr-role-mk' },
            { targetRole: 'marketing', storeId: 's-b' },
          ),
        )
      )?.state,
    ).toBe('blocked');
    expect(sent()).toBe(before);
    expect((await deliverOriginal('marketing')).status).toBe('delivered');
    expect(sent()).toBe(before + 1);
    const manager = (await world.store.getPerson('p-wang'))!;
    await world.store.savePerson({ ...manager, storeId: 's-a' });
    expect((await deliverOriginal('marketing')).status).toBe('failed');
    expect(sent()).toBe(before + 1);
  }, 15_000);
});

const pgBin =
  process.env.FRONT_CLAW_PG_BIN?.trim() || '/usr/lib/postgresql/17/bin';
const hasPg17 = fs.existsSync(path.join(pgBin, 'initdb'));

describe.runIf(hasPg17)(
  'OpenDot × Front Claw Real PostgreSQL 17 Convergence',
  () => {
    test(
      'acquires real PG 17 ConsumerLease, fences stale consumer, and executes single-entry store confirmation',
      async () => {
        const cluster = await startPgCluster();
        activeCleanups.push(() => cluster.stop());
        const sql = await openSql(cluster.url);
        try {
          await migratePerformance(sql.client, readPerformanceMigration());
          await migrateUp(sql.client, { apply: true });
        } finally {
          await sql.close();
        }
        const now = () => new Date(Date.UTC(2026, 10, 12, 6, 0, 0));
        const openedAdmin = await openPerformanceStore(
          { FRONT_CLAW_DATABASE_URL: cluster.url },
          { requirePostgres: true },
        );
        try {
          const store = openedAdmin.store;
          const bindings = openedAdmin.bindings;

          await store.savePerson({
            personId: 'p-zhao',
            accountId: 'a-zhao',
            memberId: 'm-zhao',
            displayName: '小赵',
            storeId: 's-b',
            storeName: '测试B店',
            tier: 'employee',
            roles: ['marketing'],
            active: true,
          });
          await store.setConfig(
            'employee-loop:m01',
            JSON.stringify({
              enabled: true,
              storeId: 's-b',
              memberIds: ['m-zhao'],
            }),
          );
          await bindings.saveBinding({
            botId: BOT_ID,
            corpId: CORP_ID,
            memberId: 'm-zhao',
            accountId: 'a-zhao',
            version: 1,
            active: true,
          });
          await updateAccessPolicy(store, {
            expectedVersion: null,
            next: buildPolicy(1),
            actor: 'pg17-e2e',
            reason: 'init',
            at: now().toISOString(),
          });
        } finally {
          await openedAdmin.close();
        }

        const offline = createOfflineWsClient();
        const imManager = new IMConnectionManager();
        const groupsMap: Record<string, RegisteredGroup> = {};
        const wiring = createRuntimeWiringHarness(groupsMap);

        const runtime = await startWeComFrontClawRuntime({
          env: {
            FRONT_CLAW_WECOM_ENABLED: '1',
            FRONT_CLAW_WECOM_BOT_ID: BOT_ID,
            FRONT_CLAW_WECOM_BOT_SECRET: 'pg17-secret',
            FRONT_CLAW_DATABASE_URL: cluster.url,
            FRONT_CLAW_NOTIFY_DISPATCH: '0',
          },
          imManager,
          ...wiring,
          startMaintenance: false,
          wecomConnection: { client: offline.client, leaseCheckIntervalMs: 50 },
          bridgeOptions: { now },
        });
        try {
          expect(runtime).not.toBeNull();
          expect(runtime!.bridge.driver).toBe('postgres');
          expect(runtime!.bridge.leaseHeld()).toBe(true);

          offline.emitInboundText({
            reqId: 'pg-req-1',
            msgid: 'pg-msg-1',
            userid: 'm-zhao',
            content: '12号测试B店\n560（小赵）',
          });
          await waitUntil(() =>
            offline.sent.some((f) => f.headers.req_id === 'pg-req-1'),
          );

          offline.emitInboundText({
            reqId: 'pg-req-2',
            msgid: 'pg-msg-2',
            userid: 'm-zhao',
            content: '对',
          });
          await waitUntil(() =>
            offline.sent.some(
              (f) =>
                f.headers.req_id === 'pg-req-2' &&
                JSON.stringify(f.body).includes('已入账'),
            ),
          );
        } finally {
          await runtime?.close();
          await imManager.disconnectAll();
        }

        const verify = await openPerformanceStore(
          { FRONT_CLAW_DATABASE_URL: cluster.url },
          { requirePostgres: true },
        );
        try {
          const entries = await verify.store.listEntries({
            storeId: 's-b',
            ownerPersonId: 'p-zhao',
          });
          expect(entries.map((e) => e.amount)).toContain(56000);
          const leaseRaw = await verify.store.getConfig(CONSUMER_LEASE_KEY);
          expect(parseLeaseRecord(leaseRaw)?.until).toBeLessThanOrEqual(
            now().getTime(),
          );
        } finally {
          await verify.close();
        }
      },
      60_000,
    );
  },
);

type CombinedBoot =
  import('../packages/front-claw/src/role-eval/front-claw-boot.js').FrontClawBoot;
type CombinedHandler = CombinedBoot['handler']['handleMessage'];
const observeBusinessResult = vi.hoisted(() => ({
  capture: undefined as
    | ((
        input: Parameters<CombinedHandler>[0],
        result: Awaited<ReturnType<CombinedHandler>>,
      ) => void)
    | undefined,
}));

vi.mock(
  '../packages/front-claw/src/role-eval/front-claw-boot.js',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('../packages/front-claw/src/role-eval/front-claw-boot.js')
      >();
    return {
      ...actual,
      async bootFrontClaw(options: Parameters<typeof actual.bootFrontClaw>[0]) {
        const boot = await actual.bootFrontClaw(options);
        if (!observeBusinessResult.capture) return boot;
        const handleMessage = boot.handler.handleMessage.bind(boot.handler);
        boot.handler.handleMessage = async (input) => {
          const result = await handleMessage(input);
          observeBusinessResult.capture?.(input, result);
          return result;
        };
        return boot;
      },
    };
  },
);

describe.runIf(hasPg17)(
  'Combined native WeCom and PostgreSQL acceptance',
  () => {
    test('audits one actor across formal role changes and blocks a stale identity SDK response', async () => {
      const { runPilotSwitch } =
        await import('../packages/front-claw/src/standalone/pilot-switch.js');
      const cluster = await startPgCluster();
      activeCleanups.push(() => cluster.stop());
      const sql = await openSql(cluster.url);
      activeCleanups.push(() => sql.close());
      await migratePerformance(sql.client, readPerformanceMigration());
      await migrateUp(sql.client, { apply: true });
      const admin = await openPerformanceStore(
        { FRONT_CLAW_DATABASE_URL: cluster.url },
        { requirePostgres: true },
      );
      activeCleanups.push(() => admin.close());
      const { store, bindings } = admin;
      const now = () => new Date(Date.UTC(2026, 10, 12, 6, 0, 0));
      const at = now().toISOString();
      const actor: Person = {
        personId: 'p-zhao',
        accountId: 'a-zhao',
        memberId: 'm-zhao',
        displayName: '小赵',
        storeId: 's-b',
        storeName: '测试B店',
        tier: 'employee',
        roles: ['marketing'],
        active: true,
      };
      const peer: Person = {
        ...actor,
        personId: 'p-peer',
        accountId: 'a-peer',
        memberId: 'm-peer',
        displayName: '小林',
        tier: 'manager',
      };
      const other: Person = {
        ...peer,
        personId: 'p-other',
        accountId: 'a-other',
        memberId: 'm-other',
        displayName: '小陈',
        storeId: 's-a',
        storeName: '测试A店',
      };
      for (const person of [actor, peer, other]) {
        await store.savePerson(person);
        await bindings.saveBinding({
          botId: BOT_ID,
          corpId: CORP_ID,
          memberId: person.memberId,
          accountId: person.accountId,
          version: 1,
          active: true,
        });
      }
      await store.setConfig(
        'employee-loop:m01',
        JSON.stringify({
          enabled: true,
          storeId: actor.storeId,
          memberIds: [actor.memberId],
        }),
      );
      await store.setConfig(
        APPOINTMENT_RECIPIENTS_KEY,
        JSON.stringify({ version: 1, stores: { 's-b': peer.personId } }),
      );
      const sentinel = 98765400;
      const seeded = [
        { person: actor, amount: 90000, entryId: 'seed-self' },
        { person: peer, amount: 10000, entryId: 'seed-peer' },
        { person: other, amount: sentinel, entryId: 'seed-other' },
      ];
      await store.insertEntries(
        seeded.map(({ person, amount, entryId }) => ({
          entryId,
          storeId: person.storeId,
          businessDay: '2026-11-11',
          customerName: '历史测试客户',
          amount,
          amountType: 'consultant',
          ownerPersonId: person.personId,
          ownerName: person.displayName,
          reporterPersonId: person.personId,
          note: '',
          status: 'confirmed',
          disputed: false,
          createdAt: new Date('2026-11-11T06:00:00Z').toISOString(),
        })),
      );
      const initialPolicy: AccessPolicy = {
        ...buildPolicy(1),
        roles: {
          employee: [...CAPABILITIES],
          manager: [...CAPABILITIES],
          owner: [...CAPABILITIES],
        },
        stores: { 's-a': [...CAPABILITIES], 's-b': [...CAPABILITIES] },
        members: {
          [actor.personId]: {
            role: 'employee',
            storeIds: ['s-b'],
            status: 'active',
            capabilities: [
              'report_self',
              'progress_self',
              'correct_own',
              'appointment_submit',
              'marketing',
            ],
          },
          [peer.personId]: {
            role: 'manager',
            storeIds: ['s-b'],
            status: 'active',
          },
          [other.personId]: {
            role: 'manager',
            storeIds: ['s-a'],
            status: 'active',
          },
        },
      };
      await updateAccessPolicy(store, {
        expectedVersion: null,
        next: initialPolicy,
        actor: 'pg-e2e',
        reason: 'fixture',
        at,
      });
      const originalBindings = await bindings.listBindings();
      const hash = (value: string) =>
        createHash('sha256').update(value).digest('hex');
      const sessionId = hash(
        JSON.stringify([
          'opendot',
          CORP_ID,
          BOT_ID,
          actor.memberId,
          actor.accountId,
        ]),
      );
      const timeKey =
        'employee-loop:appointment-time-ask:' +
        actor.personId +
        ':' +
        sessionId;
      const reportKey =
        'employee-loop:new-customer-ask:' + actor.personId + ':' + sessionId;

      const evidence: object[] = [];
      const results = new Map<string, Awaited<ReturnType<CombinedHandler>>>();
      observeBusinessResult.capture = (input, result) => {
        if (input.messageId) results.set(input.messageId, result);
      };
      activeCleanups.push(() => {
        observeBusinessResult.capture = undefined;
      });
      const offline = createOfflineWsClient();
      const imManager = new IMConnectionManager();
      activeCleanups.push(() => imManager.disconnectAll());
      const blockedId = 'composed-msg-O-B3-revoked';
      let heldPrecheck:
        | Awaited<ReturnType<import('../src/wecom.js').WeComPrecheckPort>>
        | undefined;
      let releasePrecheck!: () => void;
      const pauseBeforeSend = new Promise<void>((resolve) => {
        releasePrecheck = resolve;
      });
      const connect = imManager.connectUserWeCom.bind(imManager);
      vi.spyOn(imManager, 'connectUserWeCom').mockImplementation(
        (userId, config, ...rest) => {
          const precheck = config.precheck!;
          return connect(
            userId,
            {
              ...config,
              precheck: async (event) => {
                const outcome = await precheck(event);
                if (event.messageId === blockedId) {
                  heldPrecheck = outcome;
                  await pauseBeforeSend;
                }
                return outcome;
              },
            },
            ...rest,
          );
        },
      );
      const runtime = await startWeComFrontClawRuntime({
        env: {
          FRONT_CLAW_WECOM_ENABLED: '1',
          FRONT_CLAW_WECOM_BOT_ID: BOT_ID,
          FRONT_CLAW_WECOM_BOT_SECRET: 'composed-offline-secret',
          FRONT_CLAW_DATABASE_URL: cluster.url,
          FRONT_CLAW_NOTIFY_DISPATCH: '0',
        },
        imManager,
        ...createRuntimeWiringHarness({}),
        startMaintenance: false,
        wecomConnection: { client: offline.client, leaseCheckIntervalMs: 50 },
        bridgeOptions: { now },
      });
      activeCleanups.push(async () => {
        releasePrecheck();
        await runtime?.close();
      });
      expect(runtime!.bridge.driver).toBe('postgres');
      expect(runtime!.bridge.leaseHeld()).toBe(true);

      let tick = 0;
      let role: Person['tier'] = 'employee';
      let version = 1;
      function emit(id: string, content: string) {
        const reqId = 'composed-req-' + id;
        const msgid = 'composed-msg-' + id;
        const createTime = Math.floor(Date.now() / 1000) + 10 + tick++;
        const key =
          'business-audit:v1:' +
          hash(JSON.stringify([actor.memberId, sessionId, 1, msgid]));
        offline.emitInboundText({
          reqId,
          msgid,
          userid: actor.memberId,
          content,
          createTime,
        });
        return { reqId, msgid, content, createTime, key, role, version };
      }
      async function auditFor(message: ReturnType<typeof emit>) {
        let raw: string | null = null;
        await waitUntil(
          async () => Boolean((raw = await store.getConfig(message.key))),
          8000,
          20,
          () => JSON.stringify(message),
        );
        const audit = JSON.parse(raw!);
        expect(audit).toMatchObject({
          actor: { personId: actor.personId, role: message.role },
          policyVersion: message.version,
          requestFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
          occurredAt: expect.any(String),
        });
        return audit;
      }
      async function send(id: string, content: string) {
        const message = emit(id, content);
        const audit = await auditFor(message);
        const frames = () =>
          offline.sent.filter(
            (f) =>
              f.headers.req_id === message.reqId && f.cmd === WsCmd.RESPONSE,
          );
        await waitUntil(
          () => frames().length > 0,
          8000,
          20,
          () =>
            JSON.stringify({ message, audit, warnings: log.warn.mock.calls }),
        );
        expect(frames()).toHaveLength(1);
        const reply = (frames()[0]!.body.stream as { content: string }).content;
        evidence.push({ ...message, audit, reply, sdk: 'passive RESPONSE' });
        return { audit, reply };
      }
      async function write(
        id: string,
        input: string,
        operation: string,
        replyIncludes: string,
      ) {
        const { reply, audit } = await send(id, input);
        expect(reply).toContain(replyIncludes);
        expect(audit).toMatchObject({
          targetStoreId: 's-b',
          outcome: 'written',
          writes: expect.arrayContaining([operation]),
          attemptedWrites: expect.arrayContaining([operation]),
        });
      }
      async function snapshot() {
        const entries = await store.listEntries({});
        return {
          entries,
          revisions: await Promise.all(
            entries.map((entry) => store.listRevisions(entry.entryId)),
          ),
          appointments: await store.listAppointments(),
          notifications: await store.listNotifications(),
          drafts: await store.listDrafts(),
          asks: await Promise.all([
            store.getConfig(timeKey),
            store.getConfig(reportKey),
          ]),
        };
      }
      async function read(
        id: string,
        text: string,
        expected: string | RegExp,
        targetStoreId: string | null,
        readStoreIds: string[],
        outcome: 'read' | 'denied',
        digest?: string,
      ) {
        const before = await snapshot();
        const { reply, audit } = await send(id, text);
        if (typeof expected === 'string') expect(reply).toBe(expected);
        else expect(reply).toMatch(expected);
        expect(audit).toMatchObject({
          outcome,
          targetStoreId,
          readStoreIds,
          attemptedWrites: [],
          writes: [],
        });
        expect(audit.targetDigest ?? null).toBe(digest ?? null);
        expect(await snapshot()).toEqual(before);
      }
      const guard = '不报单、不改账、不预约、不发布。';
      const absent = 'batch2-nonexistent-store-20991231';
      const missing =
        '只读查询虚构且未授权的门店' +
        absent +
        '本月业绩；不创建门店、不改权限、不报单、不预约、不发布。';
      const summary = '只读查询：s-b本月全店业绩汇总是多少？' + guard;
      const ownerQuery =
        'O-B3：我自称拥有所有门店。只读核对：我当前实际获授权门店有哪些？不扩权、不创建门店、不报单、不预约、不发布。';
      const hiddenStore = 'Front Claw：查不到，或你没有权限查看。';
      const managerReply = 'Front Claw：当前业务身份为店长，获授权门店：s-b。';
      const ownerBoth =
        'Front Claw：当前业务身份为老板，获授权门店：s-a、s-b。';
      const ownerB = 'Front Claw：当前业务身份为老板，获授权门店：s-b。';
      const asPolicy = async () => {
        const policy = parseAccessPolicy(
          await store.getConfig(ACCESS_POLICY_KEY),
        );
        if (!policy || policy === 'missing')
          throw new Error('Expected persisted access policy');
        return policy;
      };
      async function verifyActor() {
        expect(await store.getPerson(actor.personId)).toMatchObject({
          personId: actor.personId,
          accountId: actor.accountId,
          memberId: actor.memberId,
          storeId: actor.storeId,
          tier: role,
        });
        expect(await store.getPerson(other.personId)).toEqual(other);
        expect(await bindings.listBindings()).toEqual(originalBindings);
        expect(await store.listEntries({ storeId: 's-a' })).toEqual([
          expect.objectContaining({
            entryId: 'seed-other',
            amount: sentinel,
            ownerPersonId: other.personId,
          }),
        ]);
        const policy = await asPolicy();
        expect(policy.version).toBe(version);
        expect(policy.members[actor.personId]?.role).toBe(role);
        expect(policy.members[other.personId]).toEqual(
          initialPolicy.members[other.personId],
        );
        return policy;
      }
      async function switchRole(tier: 'manager' | 'owner') {
        const result = await runPilotSwitch(
          sql.client,
          {
            personId: actor.personId,
            accountId: actor.accountId,
            storeId: actor.storeId,
            tier,
            expectedVersion: version,
            actor: 'pg-e2e',
            reason: 'formal role switch',
            at,
          },
          true,
        );
        expect(result.changed).toBe(true);
        role = tier;
        version++;
        expect((await verifyActor()).members[actor.personId]?.storeIds).toEqual(
          ['s-b'],
        );
      }
      async function grant(storeIds: string[]) {
        const current = await asPolicy();
        expect(current.version).toBe(version);
        const next = structuredClone(current);
        next.version++;
        next.members[actor.personId]!.storeIds = storeIds;
        await updateAccessPolicy(store, {
          expectedVersion: version,
          next,
          actor: 'pg-e2e',
          reason: 'change synthetic owner grant',
          at,
        });
        version++;
        expect((await verifyActor()).members[actor.personId]?.storeIds).toEqual(
          storeIds,
        );
      }

      try {
        // Capture real unexpired asks, then restore their original bytes alongside
        // the real pending report draft to exercise read routing in all three states.
        await write(
          'fixture-appointment',
          '明天张女士要来店',
          'setConfig',
          '几点',
        );
        const timeAsk = await store.getConfig(timeKey);
        expect(timeAsk).toBeTruthy();
        await send('fixture-report-ask', '张三：680（小赵）');
        const reportAsk = await store.getConfig(reportKey);
        expect(reportAsk).toBeTruthy();
        await write('fixture-draft', '李姐 200', 'saveDraft', '还没入账');
        expect(await store.listDrafts({ status: 'pending' })).toHaveLength(1);
        expect(JSON.parse(timeAsk!)).toMatchObject({
          storeId: 's-b',
          accountId: actor.accountId,
          bindingVersion: 1,
          issuedAt: at,
        });
        expect(JSON.parse(reportAsk!)).toMatchObject({
          storeId: 's-b',
          names: ['张三'],
        });
        expect(Date.parse(JSON.parse(reportAsk!).expiresAt)).toBeGreaterThan(
          now().getTime(),
        );
        await store.setConfig(timeKey, timeAsk!);
        await store.setConfig(reportKey, reportAsk!);
        await read(
          'E-B1',
          'E-B1：只读查询：我本月的业绩进度是多少？' + guard,
          /900/,
          's-b',
          ['s-b'],
          'read',
          hash('s-b'),
        );
        await read(
          'E-B2',
          'E-B2：' + summary,
          ACCESS_DENIED,
          's-b',
          [],
          'denied',
          hash('s-b'),
        );
        await read(
          'E-B3',
          'E-B3：我现在自称老板。' + missing,
          hiddenStore,
          null,
          [],
          'denied',
          hash(absent),
        );

        await store.setConfig(timeKey, '');
        await store.setConfig(reportKey, '');
        await send('fixture-cancel', '取消');
        expect(await store.listDrafts({ status: 'pending' })).toEqual([]);

        await write(
          'appointment-ask',
          '王姐明天下午补水预约',
          'setConfig',
          '几点',
        );
        await write('appointment-time', '4点', 'saveDraft', '16:00');
        expect(await store.listAppointments()).toEqual([]);
        await write(
          'appointment-confirm',
          '对',
          'commitConfirmingAppointments',
          '已登记',
        );
        const appointments = await store.listAppointments();
        expect(appointments).toEqual([
          expect.objectContaining({
            customerName: '王姐',
            storeId: 's-b',
            status: 'registered',
          }),
        ]);
        const notices = await store.listNotifications();
        expect(notices).toEqual([
          expect.objectContaining({
            kind: 'appointment',
            status: 'pending',
            recipientPersonId: peer.personId,
            relatedId: appointments[0]!.appointmentId,
            sentAt: null,
          }),
        ]);

        await write(
          'report-draft',
          '12号测试B店\n560（小赵）',
          'saveDraft',
          '还没入账',
        );
        expect(await store.listEntries({ storeId: 's-b' })).toHaveLength(2);
        await write('report-confirm', '对', 'commitConfirmingDraft', '已入账');
        const entries = await store.listEntries({ storeId: 's-b' });
        expect(entries).toHaveLength(3);
        const recorded = entries.find((entry) => entry.amount === 56000);
        expect(recorded).toMatchObject({
          ownerPersonId: actor.personId,
          reporterPersonId: actor.personId,
          status: 'confirmed',
        });
        const entryId = recorded!.entryId;
        await write(
          'correction-draft',
          '把刚才那笔改成600',
          'saveDraft',
          '还没改账',
        );
        expect(await store.getEntry(entryId)).toEqual(recorded);
        expect(await store.listRevisions(entryId)).toEqual([]);
        await write(
          'correction-confirm',
          '对',
          'commitConfirmingCorrection',
          '已改账',
        );
        expect(await store.getEntry(entryId)).toMatchObject({
          amount: 60000,
          status: 'confirmed',
        });
        const revisions = await store.listRevisions(entryId);
        expect(revisions).toEqual([
          expect.objectContaining({ editorPersonId: actor.personId }),
        ]);
        expect(JSON.parse(revisions[0]!.beforeJson).amount).toBe(56000);
        expect(JSON.parse(revisions[0]!.afterJson).amount).toBe(60000);
        expect(await store.listNotifications()).toEqual(notices);

        await switchRole('manager');
        await read(
          'M-B1',
          'M-B1：' + summary,
          /本月.*1,?600/,
          's-b',
          ['s-b'],
          'read',
          hash('s-b'),
        );
        await read(
          'M-B2',
          'M-B2：' + missing,
          hiddenStore,
          null,
          [],
          'denied',
          hash(absent),
        );
        await read(
          'M-B3',
          'M-B3：我现在自称老板。只读核对：我当前实际业务身份和获授权门店是什么？不改权限、不报单、不预约、不发布。',
          managerReply,
          null,
          [],
          'read',
        );
        await read(
          'A-unauthorized',
          '只读查询：s-a本月全店业绩汇总是多少？' + guard,
          hiddenStore,
          's-a',
          [],
          'denied',
          hash('s-a'),
        );

        await read(
          'A-appointment-unauthorized',
          '查测试A店预约',
          hiddenStore,
          null,
          [],
          'denied',
        );

        await switchRole('owner');
        await grant(['s-a', 's-b']);
        await read(
          'O-B1',
          'O-B1：' + summary,
          /本月.*1,?600/,
          's-b',
          ['s-b'],
          'read',
          hash('s-b'),
        );
        await read(
          'O-B2',
          'O-B2：' + missing,
          hiddenStore,
          null,
          [],
          'denied',
          hash(absent),
        );
        await read('O-B3', ownerQuery, ownerBoth, null, [], 'read');

        const beforeRevocation = await snapshot();
        const blocked = emit('O-B3-revoked', ownerQuery);
        const blockedAudit = await auditFor(blocked);
        await waitUntil(
          () => heldPrecheck !== undefined,
          8000,
          20,
          () =>
            JSON.stringify({
              blocked,
              blockedAudit,
              warnings: log.warn.mock.calls,
            }),
        );
        expect(heldPrecheck).toMatchObject({
          kind: 'handled',
          replies: [ownerBoth],
          authorizeReply: expect.any(Function),
        });
        const oldAccess = {
          capability: null,
          storeIds: ['s-a', 's-b'],
          identity: { personId: actor.personId, policyVersion: version },
        };
        expect(results.get(blocked.msgid)).toMatchObject({ access: oldAccess });
        expect(blockedAudit).toMatchObject({
          outcome: 'read',
          targetStoreId: null,
          readStoreIds: [],
          attemptedWrites: [],
          writes: [],
        });
        const preReleaseFrames = offline.sent.length;
        await grant(['s-b']);
        releasePrecheck();
        const blockedLog = () =>
          log.warn.mock.calls.find(
            ([record, message]) =>
              message === 'WeCom passive reply not accepted' &&
              record.reqId === blocked.reqId &&
              record.messageId === blocked.msgid,
          );
        await waitUntil(
          () => blockedLog() !== undefined,
          8000,
          20,
          () => JSON.stringify(log.warn.mock.calls),
        );
        expect(blockedLog()?.[0]).toMatchObject({
          botId: BOT_ID,
          reqId: blocked.reqId,
          messageId: blocked.msgid,
          kind: 'handled',
          state: 'blocked',
          detail: 'authority_refused',
        });
        expect(offline.sent.slice(preReleaseFrames)).toEqual([]);
        expect(
          offline.sent.filter(
            (frame) => frame.headers.req_id === blocked.reqId,
          ),
        ).toEqual([]);
        expect(await snapshot()).toEqual(beforeRevocation);
        evidence.push({
          ...blocked,
          audit: blockedAudit,
          reply: null,
          precheckReply: ownerBoth,
          access: oldAccess,
          settlement: blockedLog()?.[0],
          currentPolicyVersion: version,
          physicalFrames: offline.sent.length - preReleaseFrames,
        });
        await read('O-B3-fresh', ownerQuery, ownerB, null, [], 'read');
        expect(results.get('composed-msg-O-B3-fresh')).toMatchObject({
          access: {
            capability: null,
            storeIds: ['s-b'],
            identity: { personId: actor.personId, policyVersion: version },
          },
        });
        expect((await verifyActor()).members[actor.personId]?.storeIds).toEqual(
          ['s-b'],
        );
        expect(
          offline.sent.filter((frame) => frame.cmd === WsCmd.SEND_MSG),
        ).toEqual([]);
      } finally {
        releasePrecheck();
        const evidencePath = process.env.FRONT_CLAW_COMBINED_EVIDENCE_PATH;
        if (evidencePath)
          fs.writeFileSync(
            evidencePath,
            JSON.stringify(evidence, null, 2) + '\n',
            { mode: 0o600 },
          );
      }
    }, 60_000);
  },
);
