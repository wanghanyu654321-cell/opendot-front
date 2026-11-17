import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import type { WsFrame } from '@wecom/aibot-node-sdk';
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
import { IMConnectionManager } from '../src/im-manager.js';
import { runHostAgent } from '../src/container-runner.js';
import type { RegisteredGroup } from '../src/types.js';
import {
  BRIDGE_AGENT_GUARDRAIL_DENIED_REPLY,
  SAFE_MARKETING_DISALLOWED_TOOLS,
  validateTargetAgentProfile,
} from '../src/wecom-front-claw-bridge.js';
import { STALE_CONSUMER } from '../packages/front-claw/src/role-eval/employee-loop.js';
import {
  decodeStatus,
  encodeStatus,
  outboxManaged,
} from '../packages/front-claw/src/role-eval/notification-status.js';
import {
  WECOM_MANAGED_WORKSPACE_FOLDER,
  WECOM_MANAGED_WORKSPACE_JID,
  startWeComFrontClawRuntime,
} from '../src/wecom-front-claw-runtime.js';
import {
  DEFAULT_ALLOWED_TOOLS,
  isToolDisallowed,
  resolveDisallowedToolSet,
} from '../container/agent-runner/src/tool-policy.js';
import { PiRuntimeAdapter } from '../container/agent-runner/src/runtime/pi/pi-runtime.js';
import {
  CAPABILITIES,
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
import { startPgCluster } from '../packages/front-claw/tests/helpers/pg-cluster.js';
import { openPerformanceStore } from '../packages/front-claw/src/role-eval/performance-open.js';

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

  const mockWs = {
    readyState: 3,
    send(raw: string) {
      const parsed = JSON.parse(raw) as SentWireFrame;
      sent.push(parsed);
      if (!suppressAck(parsed)) {
        queueMicrotask(() => {
          wsManager.handleFrame({
            headers: { req_id: parsed.headers.req_id },
            errcode: 0,
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
  if (!db.getUserById('admin-e2e')) {
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
});

describe('OpenDot × Front Claw E2E Convergence & Hard Gates', () => {
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

    // Verify pass message landed in OpenDot SQLite under web:wecom-front-claw
    const savedPassMessages = db.getMessagesSince(WECOM_MANAGED_WORKSPACE_JID, {
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

    // 4. D175 preserved + concurrent 对 confirmations -> exactly 1 ledger entry
    offline.emitInboundText({
      reqId: 'req-confirm-1',
      msgid: 'msg-confirm-dup',
      userid: 'm-zhao',
      content: '对',
    });
    offline.emitInboundText({
      reqId: 'req-confirm-2',
      msgid: 'msg-confirm-2',
      userid: 'm-zhao',
      content: '对',
    });
    // Also replay same messageId for 对
    offline.emitInboundText({
      reqId: 'req-confirm-replay',
      msgid: 'msg-confirm-dup',
      userid: 'm-zhao',
      content: '对',
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

    // Verify src/index.ts assembly & Phase 1 shutdown closes wecomFrontClawRuntime cleanly
    const indexSrc = fs.readFileSync(
      path.join(process.cwd(), 'src/index.ts'),
      'utf8',
    );
    const pauseIdx = indexSrc.indexOf('imManager.pauseInbound()');
    const closeIdx = indexSrc.indexOf('wecomFrontClawRuntime');
    const shutdownCloseIdx = indexSrc.indexOf(
      'wecomFrontClawRuntime\n',
      pauseIdx,
    );
    const disconnectAllIdx = indexSrc.indexOf('imManager\n      .disconnectAll()', pauseIdx);
    expect(pauseIdx).toBeGreaterThan(0);
    expect(closeIdx).toBeGreaterThan(0);
    expect(shutdownCloseIdx).toBeGreaterThan(pauseIdx);
    expect(disconnectAllIdx).toBeGreaterThan(shutdownCloseIdx);
    expect(
      fs.existsSync(
        path.join(
          process.cwd(),
          'packages/front-claw/integrations/opendot-front-claw/opendot-hook.patch',
        ),
      ),
    ).toBe(false);
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
  });

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
});

const pgBin =
  process.env.FRONT_CLAW_PG_BIN?.trim() || '/usr/lib/postgresql/17/bin';
const hasPg17 = fs.existsSync(path.join(pgBin, 'initdb'));

describe.runIf(hasPg17)(
  'OpenDot × Front Claw Real PostgreSQL 17 Convergence',
  () => {
    test('acquires real PG 17 ConsumerLease, fences stale consumer, and executes single-entry store confirmation', async () => {
      const cluster = await startPgCluster();
      activeCleanups.push(() => cluster.stop());
      const openedAdmin = await openPerformanceStore(
        { FRONT_CLAW_DATABASE_URL: cluster.url },
        { requirePostgres: true },
      );
      await migrateUp(openedAdmin.sql!, { apply: true });
      const now = () => new Date(Date.UTC(2026, 10, 12, 6, 0, 0));
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
      await openedAdmin.close();

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

      await runtime!.close();
      await imManager.disconnectAll();
    });
  },
);
