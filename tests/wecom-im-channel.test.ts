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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wecom-im-channel-'));

const log = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

const spies = vi.hoisted(() => ({
  callOrder: [] as string[],
  broadcastNewMessage: vi.fn(),
  notifyNewImMessage: vi.fn(),
  storeChatMetadata: vi.fn(),
  storeMessageDirect: vi.fn(),
}));

vi.mock('../src/config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/config.js')>()),
  DATA_DIR: tmp,
  STORE_DIR: path.join(tmp, 'db'),
  GROUPS_DIR: path.join(tmp, 'groups'),
}));

vi.mock('../src/logger.js', () => ({ logger: log }));

vi.mock('../src/web.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/web.js')>();
  return {
    ...real,
    broadcastNewMessage: (...args: unknown[]) => {
      spies.callOrder.push('broadcastNewMessage');
      spies.broadcastNewMessage(...args);
    },
  };
});

vi.mock('../src/message-notifier.js', async (importOriginal) => {
  const real =
    await importOriginal<typeof import('../src/message-notifier.js')>();
  return {
    ...real,
    notifyNewImMessage: () => {
      spies.callOrder.push('notifyNewImMessage');
      spies.notifyNewImMessage();
    },
  };
});

vi.mock('../src/db.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/db.js')>();
  return {
    ...real,
    storeChatMetadata: (chatJid: string, timestamp: string, name?: string) => {
      spies.callOrder.push('storeChatMetadata');
      spies.storeChatMetadata(chatJid, timestamp, name);
      return real.storeChatMetadata(chatJid, timestamp, name);
    },
    storeMessageDirect: (
      msgId: string,
      chatJid: string,
      sender: string,
      senderName: string,
      content: string,
      timestamp: string,
      isFromMe: boolean,
      opts?: Parameters<typeof real.storeMessageDirect>[7],
    ) => {
      spies.callOrder.push('storeMessageDirect');
      spies.storeMessageDirect(
        msgId,
        chatJid,
        sender,
        senderName,
        content,
        timestamp,
        isFromMe,
        opts,
      );
      return real.storeMessageDirect(
        msgId,
        chatJid,
        sender,
        senderName,
        content,
        timestamp,
        isFromMe,
        opts,
      );
    },
  };
});

const db = await import('../src/db.js');
const { CHANNEL_PREFIXES, getChannelFromJid } =
  await import('../src/channel-prefixes.js');
const { getImChannelCapabilities } =
  await import('../src/im-channel-capabilities.js');
const { IMConnectionManager } = await import('../src/im-manager.js');
const { parseWeComMemberId } = await import('../src/wecom.js');
import type {
  WeComConsumerLease,
  WeComPrecheckOutcome,
  WeComPrecheckPort,
} from '../src/wecom.js';

interface SentWireFrame {
  cmd: string;
  headers: { req_id: string };
  body: Record<string, unknown>;
}

const activeCleanups: Array<() => void> = [];

function createOfflineWsClient(
  botId: string,
  options: {
    autoAuthenticate?: boolean;
    suppressAck?: (frame: SentWireFrame) => boolean;
  } = {},
) {
  const client = new WSClient({
    botId,
    secret: 'synthetic-secret',
    maxReconnectAttempts: 0,
    maxAuthFailureAttempts: 0,
    requestTimeout: 4000,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  });

  const wsManager = Reflect.get(client, 'wsManager') as {
    ws: {
      readyState: number;
      send(data: string): void;
      terminate(): void;
    } | null;
    isConnected: boolean;
    onMessage(frame: WsFrame): void;
    onAuthenticated(): void;
    onDisconnected(reason: string): void;
    handleFrame(frame: WsFrame): void;
    clearPendingMessages(reason: string): void;
  };

  const sent: SentWireFrame[] = [];
  let suppressAck = options.suppressAck ?? (() => false);

  const mockWs = {
    readyState: 3, // CLOSED until connect()
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

  const connectSpy = vi.spyOn(client, 'connect').mockImplementation(() => {
    Reflect.set(client, 'started', true);
    mockWs.readyState = 1; // OPEN
    wsManager.ws = mockWs;
    if (options.autoAuthenticate !== false) {
      wsManager.onAuthenticated();
    }
    return client;
  });

  const disconnectSpy = vi
    .spyOn(client, 'disconnect')
    .mockImplementation(() => {
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
    connectSpy,
    disconnectSpy,
    setSuppressAck(fn: (frame: SentWireFrame) => boolean) {
      suppressAck = fn;
    },
    authenticate() {
      mockWs.readyState = 1;
      wsManager.ws = mockWs;
      wsManager.onAuthenticated();
    },
    emitInboundText(params: {
      reqId: string;
      msgid: string;
      userid: string;
      content: string;
      corpid?: string;
      aibotid?: string;
      chattype?: 'single' | 'group';
      create_time?: number;
    }) {
      wsManager.onMessage({
        cmd: WsCmd.CALLBACK,
        headers: { req_id: params.reqId },
        body: {
          msgid: params.msgid,
          aibotid: params.aibotid ?? botId,
          msgtype: 'text',
          chattype: params.chattype ?? 'single',
          create_time: params.create_time ?? 1794448800,
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

function resetDbTables() {
  const now = new Date().toISOString();
  // Re-initialize / clean messages, chats, registered_groups, channel_accounts, users
  for (const userId of ['owner-1']) {
    if (!db.getUserById(userId)) {
      db.createUser({
        id: userId,
        username: userId,
        password_hash: 'test',
        display_name: 'Owner 1',
        role: 'member',
        status: 'active',
        permissions: [],
        created_at: now,
        updated_at: now,
      });
    }
  }
}

beforeAll(() => {
  fs.mkdirSync(path.join(tmp, 'db'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'groups'), { recursive: true });
  db.initDatabase();
  resetDbTables();
});

afterAll(() => {
  db.closeDatabase();
  fs.rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => {
  vi.clearAllMocks();
  spies.callOrder.length = 0;
});

afterEach(() => {
  while (activeCleanups.length > 0) {
    activeCleanups.pop()?.();
  }
  vi.useRealTimers();
});

function ensureBotAccount(ownerUserId: string, botId: string) {
  const existing = db.getChannelAccount(botId);
  if (!existing) {
    db.createChannelAccount({
      id: botId,
      owner_user_id: ownerUserId,
      provider: 'wecom' as unknown as Parameters<
        typeof db.createChannelAccount
      >[0]['provider'],
      name: `WeCom ${botId}`,
      secret_ref: `wecom-secret:${botId}`,
      enabled: true,
      auth_status: 'authorized',
    });
  }
}

describe('WeCom IMChannel registration & routing primitives', () => {
  test('registers wecom prefix and capabilities and parses memberId from c2c JIDs', () => {
    expect(CHANNEL_PREFIXES.wecom).toBe('wecom:');
    expect(getChannelFromJid('wecom:c2c:corp-1:m-1#account:bot-1')).toBe(
      'wecom',
    );
    expect(getImChannelCapabilities('wecom')).toMatchObject({
      channel_type: 'wecom',
      can_bind_workspace: true,
      can_bind_session: true,
      supports_thread_map: false,
      supports_file_send: false,
    });
    expect(parseWeComMemberId('c2c:corp-1:member-42')).toBe('member-42');
    expect(parseWeComMemberId('wecom:c2c:corp-1:member-42#account:bot-1')).toBe(
      'member-42',
    );
  });
});

describe('WeCom IMChannel integration contracts', () => {
  test('1. handled fast path replies via current frame req_id (WsCmd.RESPONSE) without calling storeMessageDirect', async () => {
    const botId = 'wecom-bot-handled';
    ensureBotAccount('owner-1', botId);
    const offline = createOfflineWsClient(botId);
    const manager = new IMConnectionManager();
    const onNewChat = vi.fn();

    const precheck: WeComPrecheckPort = vi.fn(
      async (): Promise<WeComPrecheckOutcome> => ({
        kind: 'handled',
        replies: ['已收到报数 560，请回复「对」确认。'],
      }),
    );

    const connected = await manager.connectUserWeCom(
      'owner-1',
      {
        botId,
        secret: 'sec-1',
        client: offline.client,
        precheck,
      },
      onNewChat,
    );
    expect(connected).toBe(true);
    expect(manager.isWeComConnected('owner-1')).toBe(true);

    offline.emitInboundText({
      reqId: 'req-handled-101',
      msgid: 'msg-handled-101',
      userid: 'm-zhao',
      content: '12号测试B店\n560（小赵）',
    });

    await vi.waitFor(() => expect(offline.sent).toHaveLength(1));
    expect(offline.sent[0]).toEqual({
      cmd: WsCmd.RESPONSE,
      headers: { req_id: 'req-handled-101' },
      body: {
        msgtype: 'stream',
        stream: {
          id: expect.any(String),
          finish: true,
          content: '已收到报数 560，请回复「对」确认。',
        },
      },
    });
    expect(spies.storeMessageDirect).not.toHaveBeenCalled();
    expect(spies.storeChatMetadata).not.toHaveBeenCalled();
    expect(onNewChat).not.toHaveBeenCalled();
    expect(spies.broadcastNewMessage).not.toHaveBeenCalled();
    expect(spies.notifyNewImMessage).not.toHaveBeenCalled();

    await manager.disconnectAll();
  });

  test('2. failed fast path replies via current frame req_id and never leaks into storeMessageDirect', async () => {
    const botId = 'wecom-bot-failed';
    ensureBotAccount('owner-1', botId);
    const offline = createOfflineWsClient(botId);
    const manager = new IMConnectionManager();
    const onNewChat = vi.fn();

    const precheck: WeComPrecheckPort = vi.fn(
      async (): Promise<WeComPrecheckOutcome> => ({
        kind: 'failed',
        replies: ['当前企微成员未绑定门店内角色，已拒绝。'],
      }),
    );

    await manager.connectUserWeCom(
      'owner-1',
      {
        botId,
        secret: 'sec-2',
        client: offline.client,
        precheck,
      },
      onNewChat,
    );

    offline.emitInboundText({
      reqId: 'req-failed-202',
      msgid: 'msg-failed-202',
      userid: 'm-unbound',
      content: '帮我记一笔 999',
    });

    await vi.waitFor(() => expect(offline.sent).toHaveLength(1));
    expect(offline.sent[0]).toEqual({
      cmd: WsCmd.RESPONSE,
      headers: { req_id: 'req-failed-202' },
      body: {
        msgtype: 'stream',
        stream: {
          id: expect.any(String),
          finish: true,
          content: '当前企微成员未绑定门店内角色，已拒绝。',
        },
      },
    });
    expect(spies.storeMessageDirect).not.toHaveBeenCalled();
    expect(spies.storeChatMetadata).not.toHaveBeenCalled();
    expect(onNewChat).not.toHaveBeenCalled();
    expect(spies.broadcastNewMessage).not.toHaveBeenCalled();
    expect(spies.notifyNewImMessage).not.toHaveBeenCalled();

    await manager.disconnectAll();
  });

  test('3. concurrent A (slow pass) + B (fast handled): B replies immediately with req_id(B), A routes via imManager.sendMessage using WsCmd.SEND_MSG with zero req_id cross-talk', async () => {
    const botId = 'wecom-bot-concurrent';
    ensureBotAccount('owner-1', botId);
    const offline = createOfflineWsClient(botId);
    const manager = new IMConnectionManager();

    let releaseA!: () => void;
    const gateA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });

    const precheck: WeComPrecheckPort = vi.fn(async (event) => {
      if (event.messageId === 'msg-A') {
        await gateA;
        return {
          kind: 'pass',
          corpId: 'corp-main',
          accountId: 'acc-marketing',
          storeId: 'store-b',
          displayName: '林营销',
        };
      }
      return {
        kind: 'handled',
        replies: ['B 快路径已秒回'],
      };
    });

    const onNewChat = vi.fn((chatJid: string, chatName: string) => {
      spies.callOrder.push('onNewChat');
      db.setRegisteredGroup(chatJid, {
        name: chatName,
        folder: 'wecom-marketing-folder',
        added_at: new Date().toISOString(),
        created_by: 'owner-1',
        channel_account_id: botId,
      });
    });

    await manager.connectUserWeCom(
      'owner-1',
      {
        botId,
        secret: 'sec-3',
        client: offline.client,
        precheck,
      },
      onNewChat,
    );

    // Send A first (blocks inside precheck), then B concurrently while A is still pending
    offline.emitInboundText({
      reqId: 'req-A',
      msgid: 'msg-A',
      userid: 'member-a',
      content: '帮我写一条周年庆朋友圈文案',
    });
    offline.emitInboundText({
      reqId: 'req-B',
      msgid: 'msg-B',
      userid: 'member-b',
      content: '我的进度',
    });

    // B replies immediately via WsCmd.RESPONSE with req-B even though A is still pending
    await vi.waitFor(() => expect(offline.sent).toHaveLength(1));
    expect(offline.sent[0]).toMatchObject({
      cmd: WsCmd.RESPONSE,
      headers: { req_id: 'req-B' },
      body: {
        msgtype: 'stream',
        stream: { finish: true, content: 'B 快路径已秒回' },
      },
    });
    expect(spies.storeMessageDirect).not.toHaveBeenCalled();

    // Release A -> slow path admits A with scoped JID and strict persistence order
    releaseA();
    const expectedScopedJid = `wecom:c2c:corp-main:member-a#account:${botId}`;
    await vi.waitFor(() =>
      expect(spies.notifyNewImMessage).toHaveBeenCalledTimes(1),
    );

    expect(spies.callOrder).toEqual([
      'storeChatMetadata',
      'onNewChat',
      'storeMessageDirect',
      'broadcastNewMessage',
      'notifyNewImMessage',
    ]);
    expect(spies.storeChatMetadata).toHaveBeenCalledWith(
      expectedScopedJid,
      expect.any(String),
      '林营销',
    );
    expect(onNewChat).toHaveBeenCalledWith(expectedScopedJid, '林营销');
    expect(spies.storeMessageDirect).toHaveBeenCalledWith(
      'msg-A',
      expectedScopedJid,
      'wecom:member-a',
      '林营销',
      '帮我写一条周年庆朋友圈文案',
      expect.any(String),
      false,
      { sourceJid: expectedScopedJid },
    );
    expect(spies.broadcastNewMessage).toHaveBeenCalledWith(
      expectedScopedJid,
      expect.objectContaining({
        id: 'msg-A',
        chat_jid: expectedScopedJid,
        source_jid: expectedScopedJid,
        sender: 'wecom:member-a',
        sender_name: '林营销',
        content: '帮我写一条周年庆朋友圈文案',
        is_from_me: false,
      }),
      undefined,
    );

    // Agent finishes A and calls imManager.sendMessage -> MUST use WsCmd.SEND_MSG with fresh UUID req_id
    await manager.sendMessage(expectedScopedJid, '周年庆朋友圈文案如下：...');
    expect(offline.sent).toHaveLength(2);
    const sendMsgFrame = offline.sent[1]!;
    expect(sendMsgFrame.cmd).toBe(WsCmd.SEND_MSG);
    expect(sendMsgFrame.headers.req_id).not.toBe('req-A');
    expect(sendMsgFrame.headers.req_id).not.toBe('req-B');
    expect(sendMsgFrame.headers.req_id.startsWith(`${WsCmd.SEND_MSG}_`)).toBe(
      true,
    );
    expect(sendMsgFrame.body).toEqual({
      chatid: 'member-a',
      chat_type: 1,
      msgtype: 'markdown',
      markdown: { content: '周年庆朋友圈文案如下：...' },
    });

    await manager.disconnectAll();
  });

  test('4. unknown ACK timeout neither switches/retries SEND_MSG nor throws to imManager', async () => {
    vi.useFakeTimers();
    const botId = 'wecom-bot-unknown';
    ensureBotAccount('owner-1', botId);
    const offline = createOfflineWsClient(botId, {
      suppressAck: () => true,
    });
    const manager = new IMConnectionManager();

    const precheck: WeComPrecheckPort = vi.fn(
      async (): Promise<WeComPrecheckOutcome> => ({
        kind: 'handled',
        replies: ['快路径ACK超时测试'],
      }),
    );

    await manager.connectUserWeCom(
      'owner-1',
      {
        botId,
        secret: 'sec-4',
        client: offline.client,
        precheck,
        sendTimeoutMs: 50,
      },
      vi.fn(),
    );

    // 4a. Passive reply ACK timeout -> logs warn, NO SEND_MSG fallback, NO second attempt
    offline.emitInboundText({
      reqId: 'req-unknown-reply',
      msgid: 'msg-unknown-reply',
      userid: 'm-timeout',
      content: '查进度',
    });

    await vi.advanceTimersByTimeAsync(10);
    expect(offline.sent).toHaveLength(1);
    expect(offline.sent[0]!.cmd).toBe(WsCmd.RESPONSE);

    await vi.advanceTimersByTimeAsync(60);
    expect(offline.sent).toHaveLength(1);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        botId,
        reqId: 'req-unknown-reply',
        detail: 'send_result_unknown',
      }),
      expect.stringContaining('state=unknown'),
    );

    // 4b. Proactive imManager.sendMessage ACK timeout -> logs warn, resolves normally (does not throw), NO retry
    const chatJid = `wecom:c2c:corp-u:m-timeout#account:${botId}`;
    db.setRegisteredGroup(chatJid, {
      name: 'Timeout User',
      folder: 'timeout-folder',
      added_at: new Date().toISOString(),
      created_by: 'owner-1',
      channel_account_id: botId,
    });

    let settled = false;
    let thrown: unknown = null;
    const sendPromise = manager
      .sendMessage(chatJid, '主动通知超时测试')
      .then(() => {
        settled = true;
      })
      .catch((err) => {
        thrown = err;
      });

    await vi.advanceTimersByTimeAsync(10);
    expect(offline.sent).toHaveLength(2);
    expect(offline.sent[1]!.cmd).toBe(WsCmd.SEND_MSG);

    await vi.advanceTimersByTimeAsync(60);
    await sendPromise;
    expect(thrown).toBeNull();
    expect(settled).toBe(true);
    expect(offline.sent).toHaveLength(2); // never retried!
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        botId,
        memberId: 'm-timeout',
        detail: 'send_result_unknown',
      }),
      expect.stringContaining('state=unknown'),
    );

    await manager.disconnectAll();
  });

  test('5. consumer lease gate blocks connect before lease acquisition and disconnects + blocks inbound/outbound on lease loss', async () => {
    const botId = 'wecom-bot-lease';
    ensureBotAccount('owner-1', botId);

    // 5a. Lease denied -> WSClient is never created or connected
    const createClientDenied = vi.fn();
    const deniedLease: WeComConsumerLease = {
      owner: 'worker-denied',
      acquire: vi.fn(async () => false),
      held: vi.fn(() => false),
      release: vi.fn(async () => undefined),
    };
    const manager = new IMConnectionManager();
    const deniedConnected = await manager.connectUserWeCom(
      'owner-1',
      {
        botId,
        secret: 'sec-5',
        lease: deniedLease,
        createClient: createClientDenied,
      },
      vi.fn(),
    );
    expect(deniedConnected).toBe(false);
    expect(deniedLease.acquire).toHaveBeenCalledTimes(1);
    expect(createClientDenied).not.toHaveBeenCalled();
    expect(manager.isWeComConnected('owner-1')).toBe(false);

    // 5b. Lease acquired -> connected -> lease lost -> auto-disconnect and block inbound + outbound
    let leaseHeld = true;
    const activeLease: WeComConsumerLease = {
      owner: 'worker-1',
      acquire: vi.fn(async () => leaseHeld),
      held: vi.fn(() => leaseHeld),
      release: vi.fn(async () => {
        leaseHeld = false;
      }),
    };
    const offline = createOfflineWsClient(botId);
    const precheck = vi.fn(
      async (): Promise<WeComPrecheckOutcome> => ({
        kind: 'handled',
        replies: ['should-not-run'],
      }),
    );

    const activeConnected = await manager.connectUserWeCom(
      'owner-1',
      {
        botId,
        secret: 'sec-5',
        lease: activeLease,
        client: offline.client,
        precheck,
      },
      vi.fn(),
    );
    expect(activeConnected).toBe(true);
    expect(offline.connectSpy).toHaveBeenCalledTimes(1);
    expect(manager.isWeComConnected('owner-1')).toBe(true);

    const chatJid = `wecom:c2c:corp-lease:m-lease#account:${botId}`;
    db.setRegisteredGroup(chatJid, {
      name: 'Lease User',
      folder: 'lease-folder',
      added_at: new Date().toISOString(),
      created_by: 'owner-1',
      channel_account_id: botId,
    });

    // Lose the lease
    leaseHeld = false;

    // Inbound frame arrives after lease loss -> auto-disconnects WSClient and drops frame
    offline.emitInboundText({
      reqId: 'req-after-lease-loss',
      msgid: 'msg-after-lease-loss',
      userid: 'm-lease',
      content: '失租后的消息',
    });
    await Promise.resolve();
    expect(offline.disconnectSpy).toHaveBeenCalledTimes(1);
    expect(precheck).not.toHaveBeenCalled();
    expect(spies.storeMessageDirect).not.toHaveBeenCalled();
    expect(offline.sent).toHaveLength(0);
    expect(manager.isWeComConnected('owner-1')).toBe(false);

    // Outbound sendMessage after lease loss -> rejected and sends 0 frames
    await expect(
      manager.sendMessage(chatJid, '失租后禁止推送'),
    ).rejects.toThrow('No IM channel available');
    expect(offline.sent).toHaveLength(0);

    // Also test outbound-triggered auto-disconnect on a fresh leased connection
    leaseHeld = true;
    const offlineOutbound = createOfflineWsClient(botId);
    await manager.connectUserWeCom(
      'owner-1',
      {
        botId,
        secret: 'sec-5',
        lease: activeLease,
        client: offlineOutbound.client,
        precheck,
      },
      vi.fn(),
    );
    expect(manager.isWeComConnected('owner-1')).toBe(true);

    leaseHeld = false;
    await expect(
      manager.sendMessage(chatJid, '失租后首次出站即断连'),
    ).rejects.toThrow('No IM channel available');
    expect(offlineOutbound.disconnectSpy).toHaveBeenCalledTimes(1);
    expect(offlineOutbound.sent).toHaveLength(0);
    expect(manager.isWeComConnected('owner-1')).toBe(false);

    await manager.disconnectAll();
  });
});
