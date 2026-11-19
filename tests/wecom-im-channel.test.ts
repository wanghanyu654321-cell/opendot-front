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
const { createWeComChannel } = await import('../src/im-channel.js');
const { parseWeComMemberId } = await import('../src/wecom.js');
import type {
  WeComConsumerLease,
  WeComDeliveryOutcomeEvent,
  WeComOutboundAuthorizePort,
  WeComOutboxDeliveryOutcome,
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
    ackFor?: (
      frame: SentWireFrame,
      index: number,
    ) => { errcode: number; errmsg?: string } | null;
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
  let ackFor = options.ackFor;

  const mockWs = {
    readyState: 3, // CLOSED until connect()
    send(raw: string) {
      const parsed = JSON.parse(raw) as SentWireFrame;
      const index = sent.length;
      sent.push(parsed);
      const ack = ackFor
        ? ackFor(parsed, index)
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

  test('6. sendMessageWithReceipt returns accepted receipt (single & multi-chunk), invokes metadata-only onDeliveryOutcome, and returns null for non-WeCom JIDs', async () => {
    const botId = 'wecom-bot-receipt-ok';
    ensureBotAccount('owner-1', botId);
    const offline = createOfflineWsClient(botId);
    const manager = new IMConnectionManager();
    const events: WeComDeliveryOutcomeEvent[] = [];

    await manager.connectUserWeCom(
      'owner-1',
      {
        botId,
        secret: 'sec-6',
        client: offline.client,
        onDeliveryOutcome: (event) => events.push(event),
      },
      vi.fn(),
    );

    const chatJid = `wecom:c2c:corp-ok:m-ok#account:${botId}`;
    db.setRegisteredGroup(chatJid, {
      name: 'Receipt OK User',
      folder: 'receipt-ok-folder',
      added_at: new Date().toISOString(),
      created_by: 'owner-1',
      channel_account_id: botId,
    });

    const singleOutcome = await manager.sendMessageWithReceipt(
      chatJid,
      '单段回执测试正文',
      { correlationId: 'corr-single-1' },
    );
    expect(offline.sent).toHaveLength(1);
    expect(offline.sent[0]!.cmd).toBe(WsCmd.SEND_MSG);
    expect(singleOutcome).toEqual({
      state: 'accepted',
      providerMessageId: offline.sent[0]!.headers.req_id,
      chunkCount: 1,
    });

    const longBody = 'A'.repeat(16001);
    const multiOutcome = await manager.sendMessageWithReceipt(
      chatJid,
      longBody,
      { correlationId: 'corr-multi-2' },
    );
    expect(offline.sent).toHaveLength(3);
    expect(multiOutcome).toEqual({
      state: 'accepted',
      providerMessageId: offline.sent[2]!.headers.req_id,
      chunkCount: 2,
    });

    expect(events).toEqual([
      {
        botId,
        chatId: 'c2c:corp-ok:m-ok',
        correlationId: 'corr-single-1',
        outcome: singleOutcome,
      },
      {
        botId,
        chatId: 'c2c:corp-ok:m-ok',
        correlationId: 'corr-multi-2',
        outcome: multiOutcome,
      },
    ]);
    const serializedEvents = JSON.stringify(events);
    expect(serializedEvents).not.toContain('单段回执测试正文');
    expect(serializedEvents).not.toContain('AAAA');

    await expect(
      manager.sendMessageWithReceipt('feishu:oc_non_wecom', 'non-wecom'),
    ).resolves.toBeNull();
    await expect(
      manager.sendMessageWithReceipt('web:workspace', 'web-jid'),
    ).resolves.toBeNull();

    await manager.disconnectAll();
  });

  test('7. sendMessageWithReceipt returns blocked (sentChunkCount=0) with zero wire frames when pre-send gates reject', async () => {
    const botId = 'wecom-bot-receipt-blocked';
    ensureBotAccount('owner-1', botId);
    const offline = createOfflineWsClient(botId);
    const manager = new IMConnectionManager();
    const events: WeComDeliveryOutcomeEvent[] = [];

    let leaseHeld = true;
    const lease: WeComConsumerLease = {
      owner: 'worker-auth',
      acquire: async () => leaseHeld,
      held: () => leaseHeld,
    };

    let mode: 'deny' | 'throw' | 'allow' = 'deny';
    const authorizeOutbound: WeComOutboundAuthorizePort = vi.fn(async () => {
      if (mode === 'deny') {
        return { allowed: false, reason: 'member_revoked' };
      }
      if (mode === 'throw') {
        throw new Error('auth_db_down');
      }
      return { allowed: true };
    });

    await manager.connectUserWeCom(
      'owner-1',
      {
        botId,
        secret: 'sec-7',
        client: offline.client,
        lease,
        authorizeOutbound,
        onDeliveryOutcome: (event) => events.push(event),
      },
      vi.fn(),
    );

    const chatJid = `wecom:c2c:corp-auth:m-auth#account:${botId}`;
    db.setRegisteredGroup(chatJid, {
      name: 'Auth Blocked User',
      folder: 'auth-blocked-folder',
      added_at: new Date().toISOString(),
      created_by: 'owner-1',
      channel_account_id: botId,
    });

    // 7a. authorizeOutbound returns allowed=false -> blocked with 0 wire sends
    const denied = await manager.sendMessageWithReceipt(chatJid, '敏感消息', {
      correlationId: 'corr-auth-deny',
    });
    expect(denied).toEqual({
      state: 'blocked',
      reason: 'member_revoked',
      sentChunkCount: 0,
    });
    expect(offline.sent).toHaveLength(0);
    expect(authorizeOutbound).toHaveBeenCalledWith({
      botId,
      chatId: 'c2c:corp-auth:m-auth',
      memberId: 'm-auth',
      corpId: 'corp-auth',
      correlationId: 'corr-auth-deny',
    });

    // 7b. authorizeOutbound throws -> blocked with 0 wire sends
    mode = 'throw';
    const threw = await manager.sendMessageWithReceipt(chatJid, '异常消息');
    expect(threw).toEqual({
      state: 'blocked',
      reason: 'auth_db_down',
      sentChunkCount: 0,
    });
    expect(offline.sent).toHaveLength(0);

    // 7c. Lease lost before send -> disconnects and returns blocked(lease_lost)
    mode = 'allow';
    leaseHeld = false;
    const leaseBlocked = await manager.sendMessageWithReceipt(
      chatJid,
      '失租消息',
    );
    expect(leaseBlocked).toEqual({
      state: 'blocked',
      reason: 'lease_lost',
      sentChunkCount: 0,
    });
    expect(offline.disconnectSpy).toHaveBeenCalledTimes(1);
    expect(offline.sent).toHaveLength(0);

    // 7d. Missing WeCom channel returns blocked via IMManager
    const missingOutcome = await manager.sendMessageWithReceipt(
      'wecom:c2c:corp-missing:m-missing#account:missing-bot',
      '无连接消息',
    );
    expect(missingOutcome).toEqual({
      state: 'blocked',
      reason: 'wecom_channel_not_connected',
      sentChunkCount: 0,
    });

    // 7e. Unconnected createWeComChannel directly returns blocked and notifies observer
    const directEvents: WeComDeliveryOutcomeEvent[] = [];
    const directChannel = createWeComChannel({
      botId: 'direct-unconnected',
      secret: 'sec-direct',
      onDeliveryOutcome: (event) => directEvents.push(event),
    });
    const directOutcome = await directChannel.sendMessageWithReceipt(
      'c2c:corp-x:m-x',
      '未连接直调',
      { correlationId: 'corr-direct' },
    );
    expect(directOutcome).toEqual({
      state: 'blocked',
      reason: 'not_connected',
      sentChunkCount: 0,
    });
    expect(directEvents).toEqual([
      {
        botId: 'direct-unconnected',
        chatId: 'c2c:corp-x:m-x',
        correlationId: 'corr-direct',
        outcome: directOutcome,
      },
    ]);
    expect(events.length).toBeGreaterThanOrEqual(3);

    await manager.disconnectAll();
  });

  test('8. sendMessageWithReceipt reports chunk-1 rejected (sentChunkCount=0) and chunk-1 unknown timeout without retry, keeping sendMessage() backward compatible', async () => {
    vi.useFakeTimers();
    const botId = 'wecom-bot-receipt-fail';
    ensureBotAccount('owner-1', botId);
    const offline = createOfflineWsClient(botId, {
      ackFor: () => ({ errcode: 40003, errmsg: 'invalid userid' }),
    });
    const manager = new IMConnectionManager();

    await manager.connectUserWeCom(
      'owner-1',
      {
        botId,
        secret: 'sec-8',
        client: offline.client,
        sendTimeoutMs: 50,
      },
      vi.fn(),
    );

    const chatJid = `wecom:c2c:corp-fail:m-fail#account:${botId}`;
    db.setRegisteredGroup(chatJid, {
      name: 'Fail User',
      folder: 'fail-folder',
      added_at: new Date().toISOString(),
      created_by: 'owner-1',
      channel_account_id: botId,
    });

    // 8a. Explicit chunk-1 rejection -> rejected, sentChunkCount=0, never retried
    const rejected: WeComOutboxDeliveryOutcome | null =
      await manager.sendMessageWithReceipt(chatJid, '首块拒收测试');
    expect(rejected).toEqual({
      state: 'rejected',
      reason: 'sdk_ack_rejected',
      apiErrorCode: 40003,
      sentChunkCount: 0,
    });
    expect(offline.sent).toHaveLength(1);

    // 8b. Chunk-1 ACK timeout -> unknown, sentChunkCount=0, never retried
    offline.setAckFor(() => null);
    const timeoutPromise = manager.sendMessageWithReceipt(
      chatJid,
      '首块超时测试',
    );
    await vi.advanceTimersByTimeAsync(10);
    expect(offline.sent).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(60);
    const timedOut = await timeoutPromise;
    expect(timedOut).toEqual({
      state: 'unknown',
      reason: 'send_result_unknown',
      sentChunkCount: 0,
    });
    expect(offline.sent).toHaveLength(2);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        botId,
        memberId: 'm-fail',
        detail: 'send_result_unknown',
      }),
      expect.stringContaining('state=unknown'),
    );

    // 8c. Legacy IMManager.sendMessage() still resolves void on accepted and on unknown without throwing
    offline.setAckFor(() => ({ errcode: 0 }));
    await expect(
      manager.sendMessage(chatJid, '旧接口兼容成功'),
    ).resolves.toBeUndefined();
    expect(offline.sent).toHaveLength(3);

    offline.setAckFor(() => null);
    const legacyTimeout = manager.sendMessage(chatJid, '旧接口兼容超时');
    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(60);
    await expect(legacyTimeout).resolves.toBeUndefined();
    expect(offline.sent).toHaveLength(4);

    await manager.disconnectAll();
  });

  test('9. sendMessageWithReceipt aborts immediately on multi-chunk partial delivery (sentChunkCount > 0) for rejection, timeout, authorizeOutbound deny, and lease loss', async () => {
    const botId = 'wecom-bot-receipt-partial';
    ensureBotAccount('owner-1', botId);
    const offline = createOfflineWsClient(botId);
    const manager = new IMConnectionManager();

    let leaseHeld = true;
    const lease: WeComConsumerLease = {
      owner: 'worker-partial',
      acquire: async () => leaseHeld,
      held: () => leaseHeld,
    };

    let authCallCount = 0;
    let authMode: 'allow' | 'deny_second' | 'drop_lease_second' = 'allow';
    const authorizeOutbound: WeComOutboundAuthorizePort = vi.fn(async () => {
      authCallCount += 1;
      if (authMode === 'deny_second' && authCallCount === 2) {
        return { allowed: false, reason: 'revoked_between_chunks' };
      }
      if (authMode === 'drop_lease_second' && authCallCount === 2) {
        leaseHeld = false;
      }
      return { allowed: true };
    });

    await manager.connectUserWeCom(
      'owner-1',
      {
        botId,
        secret: 'sec-9',
        client: offline.client,
        lease,
        authorizeOutbound,
        sendTimeoutMs: 50,
      },
      vi.fn(),
    );

    const chatJid = `wecom:c2c:corp-partial:m-partial#account:${botId}`;
    db.setRegisteredGroup(chatJid, {
      name: 'Partial User',
      folder: 'partial-folder',
      added_at: new Date().toISOString(),
      created_by: 'owner-1',
      channel_account_id: botId,
    });

    // 9a. 3 chunks: chunk 1 accepted, chunk 2 rejected -> aborts before chunk 3, sentChunkCount=1
    offline.setAckFor((_frame, idx) =>
      idx === 0 ? { errcode: 0 } : { errcode: 40003, errmsg: 'rate_limit' },
    );
    const threeChunkTextA = 'A'.repeat(32001);
    const partialRejected = await manager.sendMessageWithReceipt(
      chatJid,
      threeChunkTextA,
    );
    expect(offline.sent).toHaveLength(2);
    expect(partialRejected).toEqual({
      state: 'rejected',
      reason: 'sdk_ack_rejected',
      apiErrorCode: 40003,
      sentChunkCount: 1,
    });

    // 9b. 3 chunks: chunk 1 accepted, chunk 2 ACK timeout -> aborts before chunk 3, sentChunkCount=1
    vi.useFakeTimers();
    const sentBeforeTimeout = offline.sent.length;
    offline.setAckFor((_frame, idx) =>
      idx === sentBeforeTimeout ? { errcode: 0 } : null,
    );
    const partialTimeoutPromise = manager.sendMessageWithReceipt(
      chatJid,
      'B'.repeat(32001),
    );
    await vi.advanceTimersByTimeAsync(10);
    expect(offline.sent).toHaveLength(sentBeforeTimeout + 2);
    await vi.advanceTimersByTimeAsync(60);
    const partialTimedOut = await partialTimeoutPromise;
    expect(partialTimedOut).toEqual({
      state: 'unknown',
      reason: 'send_result_unknown',
      sentChunkCount: 1,
    });
    expect(offline.sent).toHaveLength(sentBeforeTimeout + 2);
    vi.useRealTimers();

    // 9c. 2 chunks: chunk 1 accepted, chunk 2 authorizeOutbound denies -> aborts before wire send 2, returns unknown with sentChunkCount=1
    authCallCount = 0;
    authMode = 'deny_second';
    const sentBeforeDeny = offline.sent.length;
    offline.setAckFor(() => ({ errcode: 0 }));
    const partialDenied = await manager.sendMessageWithReceipt(
      chatJid,
      'C'.repeat(16001),
    );
    expect(offline.sent).toHaveLength(sentBeforeDeny + 1);
    expect(partialDenied).toEqual({
      state: 'unknown',
      reason: 'revoked_between_chunks',
      sentChunkCount: 1,
    });

    // 9d. 2 chunks: chunk 1 accepted, lease lost before chunk 2 -> disconnects and returns unknown with sentChunkCount=1
    authCallCount = 0;
    authMode = 'drop_lease_second';
    const sentBeforeLeaseDrop = offline.sent.length;
    const partialLeaseDropped = await manager.sendMessageWithReceipt(
      chatJid,
      'D'.repeat(16001),
    );
    expect(offline.sent).toHaveLength(sentBeforeLeaseDrop + 1);
    expect(partialLeaseDropped).toEqual({
      state: 'unknown',
      reason: 'lease_lost',
      sentChunkCount: 1,
    });

    await manager.disconnectAll();
  });

  test('10. inbound slow-path dedupes by stable channel identity before routing (prevents cross-role replay) and keeps durable hasStoredMessage fallback', async () => {
    const botId = 'wecom-bot-idem';
    ensureBotAccount('owner-1', botId);
    const offline = createOfflineWsClient(botId);
    const manager = new IMConnectionManager();
    const expectedScopedJid = `wecom:c2c:corp-idem:m-idem#account:${botId}`;
    const otherScopedJid = `wecom:c2c:corp-idem:m-other#account:${botId}`;

    db.setRegisteredGroup(expectedScopedJid, {
      name: 'Idem Employee',
      folder: 'idem-folder',
      added_at: new Date().toISOString(),
      created_by: 'owner-1',
      channel_account_id: botId,
      target_main_jid: 'web:base-idem',
    });
    db.setRegisteredGroup(otherScopedJid, {
      name: 'Other Employee',
      folder: 'other-folder',
      added_at: new Date().toISOString(),
      created_by: 'owner-1',
      channel_account_id: botId,
      target_main_jid: 'web:base-idem',
    });

    let nextWorkspace = 'web:wecom-front-claw:role-a';
    const precheck: WeComPrecheckPort = vi.fn(async (event) => ({
      kind: 'pass',
      corpId: event.corpId ?? 'corp-idem',
      accountId: `acc-${event.memberId}`,
      storeId: 'store-idem',
      displayName: event.memberId,
      workspaceJid: nextWorkspace,
    }));

    const resolveEffectiveChatJid = vi.fn(() => ({
      effectiveJid: 'web:base-idem',
      agentId: null,
    }));
    const isTrustedManagedWorkspaceJid = vi.fn((ws: string) =>
      ws.startsWith('web:wecom-front-claw:'),
    );

    await manager.connectUserWeCom(
      'owner-1',
      {
        botId,
        secret: 'sec-10',
        client: offline.client,
        precheck,
      },
      vi.fn(),
      {
        resolveEffectiveChatJid,
        isTrustedManagedWorkspaceJid,
      },
    );

    // First delivery into role-a
    offline.emitInboundText({
      reqId: 'req-idem-1',
      msgid: 'msg-idem-1',
      userid: 'm-idem',
      corpid: 'corp-idem',
      content: '跨岗幂等第一条',
    });
    await vi.waitFor(() =>
      expect(spies.notifyNewImMessage).toHaveBeenCalledTimes(1),
    );
    expect(resolveEffectiveChatJid).toHaveBeenCalledTimes(1);
    expect(isTrustedManagedWorkspaceJid).toHaveBeenCalledTimes(1);
    expect(
      db.getMessagesSince('web:wecom-front-claw:role-a', {
        timestamp: '',
        id: '',
      }),
    ).toHaveLength(1);

    // Replay same (corpId, botId, memberId, messageId) after role switch to role-b -> dropped BEFORE routing
    nextWorkspace = 'web:wecom-front-claw:role-b';
    offline.emitInboundText({
      reqId: 'req-idem-2',
      msgid: 'msg-idem-1',
      userid: 'm-idem',
      corpid: 'corp-idem',
      content: '跨岗幂等重放',
    });
    await vi.waitFor(() => expect(precheck).toHaveBeenCalledTimes(2));
    await new Promise((r) => setTimeout(r, 40));
    expect(resolveEffectiveChatJid).toHaveBeenCalledTimes(1);
    expect(isTrustedManagedWorkspaceJid).toHaveBeenCalledTimes(1);
    expect(spies.storeMessageDirect).toHaveBeenCalledTimes(1);
    expect(
      db.getMessagesSince('web:wecom-front-claw:role-b', {
        timestamp: '',
        id: '',
      }),
    ).toHaveLength(0);

    // Different memberId with same messageId is NOT conflated and enters role-b normally
    offline.emitInboundText({
      reqId: 'req-idem-3',
      msgid: 'msg-idem-1',
      userid: 'm-other',
      corpid: 'corp-idem',
      content: '另一成员同msgid',
    });
    await vi.waitFor(() =>
      expect(spies.notifyNewImMessage).toHaveBeenCalledTimes(2),
    );
    expect(
      db.getMessagesSince('web:wecom-front-claw:role-b', {
        timestamp: '',
        id: '',
      }),
    ).toHaveLength(1);

    await manager.disconnectAll();

    // Fresh connection (empty in-memory admittedPassKeys) still blocks replay via durable hasStoredMessage
    const offlineRestart = createOfflineWsClient(botId);
    const managerRestart = new IMConnectionManager();
    nextWorkspace = 'web:wecom-front-claw:role-a';
    await managerRestart.connectUserWeCom(
      'owner-1',
      {
        botId,
        secret: 'sec-10',
        client: offlineRestart.client,
        precheck,
      },
      vi.fn(),
      {
        resolveEffectiveChatJid,
        isTrustedManagedWorkspaceJid,
      },
    );
    offlineRestart.emitInboundText({
      reqId: 'req-idem-4',
      msgid: 'msg-idem-1',
      userid: 'm-idem',
      corpid: 'corp-idem',
      content: '重启后持久化兜底重放',
    });
    await vi.waitFor(() => expect(precheck).toHaveBeenCalledTimes(4));
    await new Promise((r) => setTimeout(r, 40));
    expect(spies.notifyNewImMessage).toHaveBeenCalledTimes(2);
    expect(spies.storeMessageDirect).toHaveBeenCalledTimes(2);

    await managerRestart.disconnectAll();
  });

  test('11. controlled dynamic outcome.workspaceJid preserves resolveAdmittedChannelRoute gate, avoids onNewChat overwrite, and falls back safely for untrusted targets', async () => {
    const botId = 'wecom-bot-dynamic-route';
    ensureBotAccount('owner-1', botId);
    const offline = createOfflineWsClient(botId);
    const manager = new IMConnectionManager();

    const admittedJid = `wecom:c2c:corp-dyn:m-dyn#account:${botId}`;
    const rejectedJid = `wecom:c2c:corp-dyn:m-rejected#account:${botId}`;
    db.setRegisteredGroup(admittedJid, {
      name: 'Dynamic Employee',
      folder: 'dyn-base-folder',
      added_at: new Date().toISOString(),
      created_by: 'owner-1',
      channel_account_id: botId,
      target_main_jid: 'web:base-ws',
    });
    db.setRegisteredGroup(rejectedJid, {
      name: 'Disabled Employee',
      folder: 'dyn-disabled-folder',
      added_at: new Date().toISOString(),
      created_by: 'owner-1',
      channel_account_id: botId,
    });

    const workspaceByMsg: Record<string, string | undefined> = {
      'msg-rejected-route': 'web:wecom-front-claw:role-sales',
      'msg-trusted-sales': 'web:wecom-front-claw:role-sales',
      'msg-trusted-ops': 'web:wecom-front-claw:role-ops',
      'msg-forged-ws': 'web:evil-hijack',
    };

    const precheck: WeComPrecheckPort = vi.fn(async (event) => ({
      kind: 'pass',
      corpId: event.corpId ?? 'corp-dyn',
      accountId: 'acc-dyn',
      storeId: 'store-dyn',
      displayName: event.memberId,
      workspaceJid: workspaceByMsg[event.messageId],
    }));

    const onNewChat = vi.fn((chatJid: string) => {
      db.setRegisteredGroup(chatJid, {
        name: 'Overwritten',
        folder: 'overwritten-folder',
        added_at: new Date().toISOString(),
        created_by: 'owner-1',
        channel_account_id: botId,
        target_main_jid: 'web:overwritten-by-onNewChat',
      });
    });
    const onMessage = vi.fn();

    await manager.connectUserWeCom(
      'owner-1',
      {
        botId,
        secret: 'sec-11',
        client: offline.client,
        precheck,
      },
      onNewChat,
      {
        onMessage,
        resolveEffectiveChatJid: (chatJid) => {
          if (chatJid === admittedJid) {
            return { effectiveJid: 'web:base-ws', agentId: null };
          }
          return null;
        },
        isTrustedManagedWorkspaceJid: (ws) =>
          ws.startsWith('web:wecom-front-claw:'),
      },
    );

    // 11a. Rejected by resolveEffectiveChatJid -> dropped even when workspaceJid is trusted (never bypasses admission)
    offline.emitInboundText({
      reqId: 'req-dyn-rej',
      msgid: 'msg-rejected-route',
      userid: 'm-rejected',
      corpid: 'corp-dyn',
      content: '未准入渠道不可绕过',
    });
    await vi.waitFor(() => expect(precheck).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 40));
    expect(onNewChat).not.toHaveBeenCalled();
    expect(spies.storeMessageDirect).not.toHaveBeenCalled();
    expect(onMessage).not.toHaveBeenCalled();
    expect(
      db.getMessagesSince('web:wecom-front-claw:role-sales', {
        timestamp: '',
        id: '',
      }),
    ).toHaveLength(0);

    // 11b. Admitted + trusted dynamic workspaceJid routes across roles without invoking onNewChat overwrite
    offline.emitInboundText({
      reqId: 'req-dyn-sales',
      msgid: 'msg-trusted-sales',
      userid: 'm-dyn',
      corpid: 'corp-dyn',
      content: '去销售岗工作区',
    });
    await vi.waitFor(() =>
      expect(spies.notifyNewImMessage).toHaveBeenCalledTimes(1),
    );

    offline.emitInboundText({
      reqId: 'req-dyn-ops',
      msgid: 'msg-trusted-ops',
      userid: 'm-dyn',
      corpid: 'corp-dyn',
      content: '切到运营岗工作区',
    });
    await vi.waitFor(() =>
      expect(spies.notifyNewImMessage).toHaveBeenCalledTimes(2),
    );

    expect(onNewChat).not.toHaveBeenCalled();
    expect(db.getRegisteredGroup(admittedJid)?.target_main_jid).toBe(
      'web:base-ws',
    );
    expect(spies.storeMessageDirect).toHaveBeenNthCalledWith(
      1,
      'msg-trusted-sales',
      'web:wecom-front-claw:role-sales',
      'wecom:m-dyn',
      'm-dyn',
      '去销售岗工作区',
      expect.any(String),
      false,
      { sourceJid: admittedJid },
    );
    expect(spies.storeMessageDirect).toHaveBeenNthCalledWith(
      2,
      'msg-trusted-ops',
      'web:wecom-front-claw:role-ops',
      'wecom:m-dyn',
      'm-dyn',
      '切到运营岗工作区',
      expect.any(String),
      false,
      { sourceJid: admittedJid },
    );
    expect(onMessage).toHaveBeenNthCalledWith(
      1,
      admittedJid,
      '去销售岗工作区',
      'm-dyn',
    );
    expect(onMessage).toHaveBeenNthCalledWith(
      2,
      admittedJid,
      '切到运营岗工作区',
      'm-dyn',
    );

    // Replying to sourceJid routes outbound via WsCmd.SEND_MSG to m-dyn
    const replyReceipt = await manager.sendMessageWithReceipt(
      admittedJid,
      '动态工作区回推到来源单聊',
    );
    expect(replyReceipt).toMatchObject({ state: 'accepted', chunkCount: 1 });
    expect(offline.sent[0]!.cmd).toBe(WsCmd.SEND_MSG);
    expect(offline.sent[0]!.body).toMatchObject({ chatid: 'm-dyn' });

    // 11c. Untrusted/forged outcome.workspaceJid is ignored and falls back to resolved.targetJid
    offline.emitInboundText({
      reqId: 'req-dyn-forged',
      msgid: 'msg-forged-ws',
      userid: 'm-dyn',
      corpid: 'corp-dyn',
      content: '伪造目标工作区测试',
    });
    await vi.waitFor(() =>
      expect(spies.notifyNewImMessage).toHaveBeenCalledTimes(3),
    );
    expect(
      db.getMessagesSince('web:evil-hijack', { timestamp: '', id: '' }),
    ).toHaveLength(0);
    expect(
      db
        .getMessagesSince('web:base-ws', { timestamp: '', id: '' })
        .map((m) => m.id),
    ).toContain('msg-forged-ws');

    await manager.disconnectAll();

    // 11d. Without isTrustedManagedWorkspaceJid (or resolveEffectiveChatJid), workspaceJid is never trusted
    const botPlain = 'wecom-bot-no-trust-hook';
    ensureBotAccount('owner-1', botPlain);
    const offlinePlain = createOfflineWsClient(botPlain);
    const managerPlain = new IMConnectionManager();
    const plainJid = `wecom:c2c:corp-plain:m-plain#account:${botPlain}`;

    await managerPlain.connectUserWeCom(
      'owner-1',
      {
        botId: botPlain,
        secret: 'sec-11d',
        client: offlinePlain.client,
        precheck: async () => ({
          kind: 'pass',
          corpId: 'corp-plain',
          accountId: 'acc-plain',
          storeId: 'store-plain',
          displayName: 'Plain User',
          workspaceJid: 'web:unverified-ws',
        }),
      },
      vi.fn(),
    );

    offlinePlain.emitInboundText({
      reqId: 'req-plain-1',
      msgid: 'msg-plain-1',
      userid: 'm-plain',
      corpid: 'corp-plain',
      content: '无信任钩子回退来源JID',
    });
    await vi.waitFor(() =>
      expect(spies.notifyNewImMessage).toHaveBeenCalledTimes(4),
    );
    expect(
      db.getMessagesSince('web:unverified-ws', { timestamp: '', id: '' }),
    ).toHaveLength(0);
    expect(
      db.getMessagesSince(plainJid, { timestamp: '', id: '' }).map((m) => m.id),
    ).toContain('msg-plain-1');

    await managerPlain.disconnectAll();
  });
});
