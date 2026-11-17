import { createHash, randomUUID } from 'node:crypto';
import { WSClient, WsCmd, type WsFrame } from '@wecom/aibot-node-sdk';
import {
  hasStoredMessage,
  storeChatMetadata,
  storeMessageDirect,
} from './db.js';
import { notifyNewImMessage } from './message-notifier.js';
import { broadcastNewMessage } from './web.js';
import { logger } from './logger.js';
import {
  ChannelRouteRejectedError,
  resolveAdmittedChannelRoute,
} from './channel-admission.js';

// ─── Cross-Issue Contract Types (Issue #2 & Issue #3) ───────────

export interface WeComInboundTextEvent {
  readonly reqId: string;
  readonly botId: string;
  readonly corpId?: string;
  readonly memberId: string;
  readonly messageId: string;
  readonly text: string;
  readonly createTime?: number;
}

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

// ─── Consumer Lease Port (compatible with packages/front-claw ConsumerLease) ───

export interface WeComConsumerLease {
  readonly owner?: string;
  acquire(): Promise<boolean>;
  held(): boolean;
  release?(): Promise<void>;
}

export type ConsumerLease = WeComConsumerLease;

// ─── Connection Configuration & Options ─────────────────────────

export type WeComSdkClient = Pick<
  WSClient,
  | 'on'
  | 'off'
  | 'isConnected'
  | 'reply'
  | 'sendMessage'
  | 'connect'
  | 'disconnect'
>;

export interface WeComConnectionConfig {
  botId: string;
  secret: string;
  precheck?: WeComPrecheckPort;
  lease?: WeComConsumerLease;
  /** Optional offline/test WSClient instance or factory */
  client?: WeComSdkClient;
  createClient?: () => WeComSdkClient;
  /** Optional lifecycle hooks for offline/test WSClient */
  connect?: (client: WeComSdkClient) => void;
  disconnect?: (client: WeComSdkClient) => void;
  connectClient?: (client: WeComSdkClient) => void;
  disconnectClient?: (client: WeComSdkClient) => void;
  /** Bounded ACK timeout in ms for reply/notify (1..4000, default 3000) */
  sendTimeoutMs?: number;
  /** Optional periodic lease held() check interval in ms */
  leaseCheckIntervalMs?: number;
  /** Optional periodic lease acquire() renewal interval in ms */
  leaseRenewIntervalMs?: number;
  /** Fallback corpId when precheck is omitted and inbound frame has no corpid */
  defaultCorpId?: string;
}

export interface WeComConnectOpts {
  onReady?: () => void;
  onNewChat: (jid: string, name: string) => void;
  onMessage?: (chatJid: string, text: string, senderName: string) => void;
  ignoreMessagesBefore?: number;
  isChatAuthorized?: (jid: string) => boolean;
  onPairAttempt?: (
    jid: string,
    chatName: string,
    code: string,
  ) => Promise<boolean>;
  onCommand?: (
    chatJid: string,
    command: string,
    senderImId?: string,
  ) => Promise<string | null>;
  resolveGroupFolder?: (jid: string) => string | undefined;
  resolveEffectiveChatJid?: (chatJid: string) => {
    effectiveJid: string;
    agentId: string | null;
    sourceJid?: string;
  } | null;
  onAgentMessage?: (baseChatJid: string, agentId: string) => void;
  normalizeIncomingJid?: (jid: string) => string;
  shouldDeferInbound?: () => boolean;
}

export interface WeComConnection {
  connect(opts: WeComConnectOpts): Promise<boolean>;
  disconnect(): Promise<void>;
  sendMessage(
    chatId: string,
    text: string,
    localImagePaths?: string[],
  ): Promise<void>;
  notify?(
    memberId: string,
    content: string,
    scope: BotReadScope,
    beforeSend: () => Promise<void>,
  ): Promise<BotSendOutcome>;
  isConnected(): boolean;
}

// ─── Bot Transport / SDK / Sender Primitives ────────────────────

export interface BotReadScope {
  readonly signal: AbortSignal;
  readonly deadline: number;
}

export interface BotEvent {
  reqId: string;
  botId: string;
  memberId: string;
  corpId?: string;
  messageId: string;
  createTime?: number;
  action:
    | { kind: 'text'; text: string }
    | { kind: 'confirm'; reportId: string; hash: string; taskId?: string };
}

export interface BotReplyPlan {
  reqId: string;
  body: {
    msgtype: 'stream';
    stream: { id: string; finish: true; content: string };
  };
}

export interface BotSendOutcome {
  state: 'blocked' | 'accepted' | 'rejected' | 'unknown';
  apiErrorCode: number | null;
  msgid: null;
  detail: string;
  ackReqId?: string;
}

const MAX_BOT_CONTENT_BYTES = 16384;
const claimedClients = new WeakSet<object>();
const notStarted = new WeakSet<object>();

export function isBotSdkNotStarted(error: unknown): boolean {
  return typeof error === 'object' && error !== null && notStarted.has(error);
}

const safe = (value: unknown, max = 200): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= max &&
  !/[\u0000-\u0020]/.test(value);

export function normalizeBotFrame(input: unknown): BotEvent {
  const record = (v: unknown): Record<string, unknown> =>
    v !== null && typeof v === 'object' && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : {};
  const str = (v: unknown, max: number): v is string =>
    typeof v === 'string' &&
    v.length > 0 &&
    v.length <= max &&
    !/[\u0000-\u001f]/.test(v);
  const frame = record(input);
  const body = record(frame.body);
  const from = record(body.from);
  const reqId = record(frame.headers).req_id;
  if (
    !str(reqId, 200) ||
    !str(body.aibotid, 120) ||
    !str(body.msgid, 512) ||
    !str(from.userid, 120) ||
    body.chattype !== 'single' ||
    (from.corpid !== undefined && !str(from.corpid, 120))
  ) {
    throw new Error('unsupported_event');
  }
  const time = body.create_time;
  if (
    time !== undefined &&
    (!Number.isSafeInteger(time) ||
      (time as number) < 0 ||
      !Number.isFinite(new Date((time as number) * 1000).getTime()))
  ) {
    throw new Error('unsupported_event');
  }
  const base = {
    reqId,
    botId: body.aibotid,
    memberId: from.userid,
    messageId: body.msgid,
    ...(from.corpid !== undefined ? { corpId: from.corpid as string } : {}),
    ...(time !== undefined ? { createTime: time as number } : {}),
  };
  const content = record(body.text).content;
  if (
    frame.cmd === 'aibot_msg_callback' &&
    body.msgtype === 'text' &&
    typeof content === 'string' &&
    content.trim() &&
    content.length <= 4000
  ) {
    return { ...base, action: { kind: 'text', text: content } };
  }
  throw new Error('unsupported_event');
}

type Operation = { scope: BotReadScope; epoch: number; admitted: boolean };

function createBotSdkAdapter(options: {
  client: WeComSdkClient;
  maxRequestIds?: number;
}) {
  const { client } = options;
  const maxRequestIds = options.maxRequestIds ?? 50000;
  if (
    !client ||
    typeof client.reply !== 'function' ||
    typeof client.on !== 'function' ||
    typeof client.off !== 'function'
  ) {
    throw new Error('invalid_bot_sdk');
  }
  if (claimedClients.has(client)) {
    throw new Error('sdk_client_claimed');
  }
  claimedClients.add(client);

  const ids = new Set<string>();
  let authenticated = false;
  let closed = false;
  let epoch = 0;

  const invalidate = () => {
    authenticated = false;
    epoch++;
  };
  const authenticate = () => {
    epoch++;
    authenticated = true;
  };
  const invalidatingEvents = [
    'connected',
    'disconnected',
    'reconnecting',
    'error',
    'event.disconnected_event',
  ] as const;
  for (const event of invalidatingEvents) {
    client.on(event, invalidate);
  }
  client.on('authenticated', authenticate);

  const ready = () => !closed && authenticated && client.isConnected;
  const fail = (operation: Operation | undefined, code: string): never => {
    const error = new Error(code);
    if (!operation?.admitted) notStarted.add(error);
    throw error;
  };
  const check = (operation: Operation) => {
    if (
      operation.scope.signal.aborted ||
      !Number.isFinite(operation.scope.deadline) ||
      performance.now() >= operation.scope.deadline
    ) {
      fail(operation, 'sdk_cancelled');
    }
    if (!ready() || operation.epoch !== epoch) {
      fail(operation, 'sdk_session_changed');
    }
  };
  const begin = (scope: BotReadScope | undefined): Operation => {
    if (!scope || !(scope.signal instanceof AbortSignal)) {
      return fail(undefined, 'sdk_scope_required');
    }
    const operation: Operation = {
      scope: { signal: scope.signal, deadline: scope.deadline },
      epoch,
      admitted: false,
    };
    check(operation);
    return operation;
  };
  const correlated = (value: unknown, reqId: string): value is WsFrame => {
    const frame = value as WsFrame | undefined;
    return (
      !!frame &&
      frame.headers?.req_id === reqId &&
      Number.isSafeInteger(frame.errcode) &&
      typeof frame.errcode === 'number' &&
      frame.errcode >= 0
    );
  };
  const wire = (
    operation: Operation,
    reqId: string,
    body: Record<string, unknown>,
    cmd: string,
  ): Promise<WsFrame> => {
    check(operation);
    if (
      !safe(reqId) ||
      reqId.startsWith(WsCmd.SUBSCRIBE) ||
      reqId.startsWith(WsCmd.HEARTBEAT) ||
      ids.has(reqId)
    ) {
      fail(operation, 'sdk_request_not_admitted');
    }
    if (ids.size >= maxRequestIds) {
      const oldest = ids.values().next().value;
      if (oldest !== undefined) ids.delete(oldest);
    }
    ids.add(reqId);
    operation.admitted = true;
    let result: Promise<WsFrame>;
    try {
      result = client.reply({ headers: { req_id: reqId } }, body, cmd);
    } catch {
      throw new Error('sdk_result_unknown');
    }
    return result.then(
      (frame) => {
        check(operation);
        if (!correlated(frame, reqId)) throw new Error('sdk_result_unknown');
        if (frame.errcode !== 0) throw frame;
        return frame;
      },
      (error) => {
        check(operation);
        if (correlated(error, reqId) && error.errcode !== 0) throw error;
        throw new Error('sdk_result_unknown');
      },
    );
  };
  const fresh = (cmd: string) => `${cmd}_${randomUUID()}`;

  return {
    ready,
    currentEpoch: () => epoch,
    async reply(
      frame: { headers: { req_id: string } },
      body: BotReplyPlan['body'],
      scope?: BotReadScope,
    ) {
      const operation = begin(scope);
      const copy = structuredClone(body);
      if (
        copy?.msgtype !== 'stream' ||
        !safe(copy.stream?.id) ||
        copy.stream.finish !== true ||
        typeof copy.stream.content !== 'string' ||
        !copy.stream.content.trim() ||
        Buffer.byteLength(copy.stream.content) > MAX_BOT_CONTENT_BYTES
      ) {
        return fail(operation, 'invalid_bot_message');
      }
      const content = {
        msgtype: 'stream' as const,
        stream: {
          id: copy.stream.id,
          finish: true as const,
          content: copy.stream.content,
        },
      };
      return wire(operation, frame.headers.req_id, content, WsCmd.RESPONSE);
    },
    async sendMessage(
      member: string,
      body: { msgtype: 'markdown'; markdown: { content: string } },
      scope?: BotReadScope,
    ) {
      const operation = begin(scope);
      if (!safe(member, 120)) return fail(operation, 'invalid_bot_target');
      if (
        body.msgtype !== 'markdown' ||
        typeof body.markdown?.content !== 'string' ||
        !body.markdown.content.trim() ||
        Buffer.byteLength(body.markdown.content) > MAX_BOT_CONTENT_BYTES
      ) {
        return fail(operation, 'invalid_bot_message');
      }
      const content = {
        msgtype: 'markdown',
        markdown: { content: body.markdown.content },
      };
      return wire(
        operation,
        fresh(WsCmd.SEND_MSG),
        { chatid: member, chat_type: 1, ...content },
        WsCmd.SEND_MSG,
      );
    },
    close() {
      if (closed) return;
      closed = true;
      invalidate();
      for (const event of invalidatingEvents) {
        client.off(event, invalidate);
      }
      client.off('authenticated', authenticate);
    },
  };
}

function createBotSender(options: {
  sdk: ReturnType<typeof createBotSdkAdapter>;
  timeoutMs?: number;
}) {
  const { sdk } = options;
  const timeout = options.timeoutMs ?? 3000;
  const closing = new AbortController();
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 4000) {
    throw new Error('invalid_bot_sender');
  }
  const outcome = (
    state: BotSendOutcome['state'],
    detail: string,
  ): BotSendOutcome => ({
    state,
    apiErrorCode: null,
    msgid: null,
    detail,
  });

  async function execute(
    scope: BotReadScope,
    beforeSend: (scope: BotReadScope) => Promise<void>,
    invoke: (child: BotReadScope) => Promise<unknown>,
    expectedReqId?: string,
  ): Promise<BotSendOutcome> {
    const deadline = Math.min(scope.deadline, performance.now() + timeout);
    const signal = scope.signal;
    const expired = () =>
      closing.signal.aborted ||
      signal.aborted ||
      !Number.isFinite(deadline) ||
      performance.now() >= deadline;
    if (expired()) return outcome('blocked', 'budget_exhausted');
    const child = new AbortController();
    return new Promise((resolve) => {
      let done = false;
      let attempted = false;
      const finish = (value: BotSendOutcome) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', cancel);
        closing.signal.removeEventListener('abort', cancel);
        child.abort();
        resolve(value);
      };
      const cancel = () =>
        finish(
          outcome(
            attempted ? 'unknown' : 'blocked',
            attempted ? 'send_result_unknown' : 'budget_exhausted',
          ),
        );
      const timer = setTimeout(
        cancel,
        Math.max(1, deadline - performance.now()),
      );
      signal.addEventListener('abort', cancel, { once: true });
      closing.signal.addEventListener('abort', cancel, { once: true });

      const ack = (value: unknown, rejection = false): BotSendOutcome => {
        const frame = value as {
          headers?: { req_id?: unknown };
          errcode?: unknown;
        } | null;
        const reqId = frame?.headers?.req_id;
        const code = frame?.errcode;
        if (
          !safe(reqId) ||
          (expectedReqId !== undefined && reqId !== expectedReqId) ||
          typeof code !== 'number' ||
          !Number.isSafeInteger(code) ||
          code < 0 ||
          (rejection && code === 0)
        ) {
          return outcome('unknown', 'send_result_unknown');
        }
        return {
          state: code === 0 ? 'accepted' : 'rejected',
          apiErrorCode: code,
          msgid: null,
          detail: code === 0 ? 'sdk_ack_accepted' : 'sdk_ack_rejected',
          ackReqId: reqId,
        };
      };

      void Promise.resolve()
        .then(async () => {
          if (expired() || done) {
            cancel();
            return;
          }
          if (!sdk.ready()) {
            finish(outcome('blocked', 'not_connected'));
            return;
          }
          await beforeSend({ signal: child.signal, deadline });
          if (expired() || done) {
            cancel();
            return;
          }
          if (!sdk.ready()) {
            finish(outcome('blocked', 'not_connected'));
            return;
          }
          attempted = true;
          const response = await invoke({ signal: child.signal, deadline });
          if (!done) {
            if (expired()) cancel();
            else finish(ack(response));
          }
        })
        .catch((error) => {
          if (done) return;
          if (isBotSdkNotStarted(error)) {
            finish(outcome('blocked', 'sdk_not_started'));
            return;
          }
          if (expired()) {
            cancel();
            return;
          }
          finish(
            attempted
              ? ack(error, true)
              : outcome('blocked', 'authority_refused'),
          );
        });
    });
  }

  return {
    reply(
      plan: BotReplyPlan,
      scope: BotReadScope,
      beforeSend: (scope: BotReadScope) => Promise<void>,
    ) {
      const copy = structuredClone(plan);
      if (
        !safe(copy.reqId) ||
        typeof copy.body?.stream?.content !== 'string' ||
        !copy.body.stream.content.trim() ||
        Buffer.byteLength(copy.body.stream.content) > MAX_BOT_CONTENT_BYTES
      ) {
        throw new Error('invalid_bot_reply');
      }
      return execute(
        scope,
        beforeSend,
        (child) =>
          sdk.reply({ headers: { req_id: copy.reqId } }, copy.body, child),
        copy.reqId,
      );
    },
    notify(
      member: string,
      content: string,
      scope: BotReadScope,
      beforeSend: (scope: BotReadScope) => Promise<void>,
    ) {
      if (
        !safe(member) ||
        member.length > 120 ||
        typeof content !== 'string' ||
        !content.trim() ||
        Buffer.byteLength(content) > MAX_BOT_CONTENT_BYTES
      ) {
        throw new Error('invalid_bot_reply');
      }
      return execute(scope, beforeSend, (child) =>
        sdk.sendMessage(
          member,
          { msgtype: 'markdown', markdown: { content } },
          child,
        ),
      );
    },
    close() {
      closing.abort();
    },
  };
}

// ─── Helpers ────────────────────────────────────────────────────

/**
 * Parse a WeCom chatId (after or before extractProviderTarget) to extract memberId.
 * Supported forms:
 * - `wecom:c2c:${corpId}:${memberId}#account:${botId}`
 * - `wecom:c2c:${corpId}:${memberId}`
 * - `c2c:${corpId}:${memberId}`
 * - `c2c:${memberId}`
 * - `${memberId}`
 */
export function parseWeComMemberId(chatId: string): string | null {
  const withoutFragment = chatId.split('#')[0]?.trim() ?? '';
  if (!withoutFragment) return null;
  const withoutPrefix = withoutFragment.startsWith('wecom:')
    ? withoutFragment.slice('wecom:'.length)
    : withoutFragment;
  if (withoutPrefix.startsWith('c2c:')) {
    const rest = withoutPrefix.slice('c2c:'.length);
    if (!rest) return null;
    const colonIdx = rest.indexOf(':');
    if (colonIdx === -1) {
      return rest.trim() || null;
    }
    const corpId = rest.slice(0, colonIdx).trim();
    const memberId = rest.slice(colonIdx + 1).trim();
    if (!corpId || !memberId) return null;
    return memberId;
  }
  if (withoutPrefix.startsWith('group:')) {
    return null;
  }
  return withoutPrefix.includes(':') ? null : withoutPrefix;
}

function splitUtf8Chunks(text: string, maxBytes: number): string[] {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return [text];
  const chunks: string[] = [];
  let current = '';
  let currentBytes = 0;
  for (const char of text) {
    const charBytes = Buffer.byteLength(char, 'utf8');
    if (currentBytes + charBytes > maxBytes && current) {
      if (current.trim()) chunks.push(current);
      current = char;
      currentBytes = charBytes;
    } else {
      current += char;
      currentBytes += charBytes;
    }
  }
  if (current.trim()) chunks.push(current);
  return chunks;
}

function truncateUtf8(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  let result = '';
  let bytes = 0;
  for (const char of text) {
    const charBytes = Buffer.byteLength(char, 'utf8');
    if (bytes + charBytes > maxBytes) break;
    result += char;
    bytes += charBytes;
  }
  return result;
}

const silentSdkLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

const lateErrorSink = () => {};

// ─── WeCom Connection Factory ───────────────────────────────────

export function createWeComConnection(
  config: WeComConnectionConfig,
): WeComConnection {
  const botId = config.botId?.trim() ?? '';
  const secret = config.secret?.trim() ?? '';
  const sendTimeoutMs = config.sendTimeoutMs ?? 3000;

  let client: WeComSdkClient | null = null;
  let sdk: ReturnType<typeof createBotSdkAdapter> | null = null;
  let sender: ReturnType<typeof createBotSender> | null = null;
  let textListener: ((frame: unknown) => void) | null = null;
  let readyListener: (() => void) | null = null;
  let leaseCheckTimer: ReturnType<typeof setInterval> | null = null;
  let leaseRenewTimer: ReturnType<typeof setInterval> | null = null;
  let stopping = false;
  let closed = true;
  const admittedPassKeys = new Set<string>();
  const MAX_ADMITTED_PASS_KEYS = 2048;

  function disconnectSync(): void {
    if (closed && !client && !leaseCheckTimer && !leaseRenewTimer) return;
    stopping = true;
    closed = true;

    if (leaseCheckTimer) {
      clearInterval(leaseCheckTimer);
      leaseCheckTimer = null;
    }
    if (leaseRenewTimer) {
      clearInterval(leaseRenewTimer);
      leaseRenewTimer = null;
    }

    const activeClient = client;
    const activeListener = textListener;
    const activeReadyListener = readyListener;
    const activeSender = sender;
    const activeSdk = sdk;

    client = null;
    textListener = null;
    readyListener = null;
    sender = null;
    sdk = null;

    if (activeClient) {
      try {
        activeClient.on('error', lateErrorSink);
      } catch {
        /* ignore */
      }
      if (activeListener) {
        try {
          activeClient.off('message.text', activeListener as never);
        } catch {
          /* ignore */
        }
      }
      if (activeReadyListener) {
        try {
          activeClient.off('authenticated', activeReadyListener);
        } catch {
          /* ignore */
        }
      }
    }
    try {
      activeSender?.close();
    } catch {
      /* ignore */
    }
    try {
      activeSdk?.close();
    } catch {
      /* ignore */
    }
    if (activeClient) {
      const disconnectFn = config.disconnect ?? config.disconnectClient;
      try {
        if (disconnectFn) {
          disconnectFn(activeClient);
        } else {
          activeClient.disconnect();
        }
      } catch {
        /* ignore disconnect error during shutdown/lease loss */
      }
    }
  }

  function ensureLeaseHeld(): boolean {
    if (!config.lease) return true;
    let held = false;
    try {
      held = config.lease.held() === true;
    } catch {
      held = false;
    }
    if (!held) {
      if (!closed) {
        logger.warn(
          { botId },
          'WeCom consumer lease lost; disconnecting WSClient immediately',
        );
        disconnectSync();
      }
      return false;
    }
    return true;
  }

  async function sendProactiveText(
    chatId: string,
    memberId: string,
    text: string,
  ): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) return;
    const chunks = splitUtf8Chunks(trimmed, MAX_BOT_CONTENT_BYTES - 384);
    for (const chunk of chunks) {
      if (!ensureLeaseHeld()) return;
      if (stopping || closed || !sender || !sdk?.ready()) {
        logger.warn(
          { botId, chatId },
          'WeCom channel not connected, skip sending message',
        );
        return;
      }

      const scope: BotReadScope = {
        signal: AbortSignal.timeout(sendTimeoutMs),
        deadline: performance.now() + sendTimeoutMs,
      };

      const outcome = await sender.notify(memberId, chunk, scope, async () => {
        if (stopping || closed || !ensureLeaseHeld() || !sdk?.ready()) {
          throw new Error('channel_closed');
        }
      });

      if (outcome.state === 'unknown') {
        logger.warn(
          {
            botId,
            chatId,
            memberId,
            detail: outcome.detail,
          },
          'WeCom proactive sendMessage ACK timed out (state=unknown); not retrying or throwing',
        );
        return;
      }

      if (outcome.state !== 'accepted') {
        logger.warn(
          {
            botId,
            chatId,
            memberId,
            state: outcome.state,
            apiErrorCode: outcome.apiErrorCode,
            detail: outcome.detail,
          },
          'WeCom proactive sendMessage was not accepted',
        );
        return;
      }
    }
  }

  async function handleInboundFrame(
    rawFrame: unknown,
    opts: WeComConnectOpts,
  ): Promise<void> {
    if (stopping || closed) return;
    if (!ensureLeaseHeld()) return;
    if (!sdk?.ready()) return;

    let parsed: BotEvent;
    try {
      parsed = normalizeBotFrame(structuredClone(rawFrame));
    } catch {
      return;
    }
    if (parsed.botId !== botId || parsed.action.kind !== 'text') {
      return;
    }

    if (
      opts.ignoreMessagesBefore &&
      parsed.createTime !== undefined &&
      parsed.createTime * 1000 < opts.ignoreMessagesBefore
    ) {
      return;
    }

    const capturedEpoch = sdk.currentEpoch();
    const inboundEvent: WeComInboundTextEvent = Object.freeze({
      reqId: parsed.reqId,
      botId: parsed.botId,
      ...(parsed.corpId !== undefined ? { corpId: parsed.corpId } : {}),
      memberId: parsed.memberId,
      messageId: parsed.messageId,
      text: parsed.action.text,
      ...(parsed.createTime !== undefined
        ? { createTime: parsed.createTime }
        : {}),
    });

    let outcome: WeComPrecheckOutcome;
    try {
      outcome = config.precheck
        ? await config.precheck(inboundEvent)
        : {
            kind: 'pass',
            corpId: inboundEvent.corpId ?? config.defaultCorpId ?? 'default',
            accountId: botId,
            storeId: 'default',
            displayName: inboundEvent.memberId,
          };
    } catch (err) {
      logger.error(
        { err, botId, messageId: inboundEvent.messageId },
        'WeCom precheck threw unexpectedly; dropping message without passing to Agent',
      );
      return;
    }

    if (stopping || closed) return;
    if (!ensureLeaseHeld()) return;

    // ── Fast Path: handled | failed -> passive reply via frozen event.reqId (WsCmd.RESPONSE) ──
    if (outcome.kind !== 'pass') {
      const joinedReply = outcome.replies
        .map((r) => r.trim())
        .filter(Boolean)
        .join('\n\n');
      const replyText = truncateUtf8(joinedReply, MAX_BOT_CONTENT_BYTES);
      if (!replyText || !sender || !sdk) {
        return;
      }

      const streamId = createHash('sha256')
        .update(`front-claw-opendot-reply|${inboundEvent.reqId}`)
        .digest('hex')
        .slice(0, 32);
      const scope: BotReadScope = {
        signal: AbortSignal.timeout(sendTimeoutMs),
        deadline: performance.now() + sendTimeoutMs,
      };

      const sendOutcome = await sender.reply(
        {
          reqId: inboundEvent.reqId,
          body: {
            msgtype: 'stream',
            stream: {
              id: streamId,
              finish: true,
              content: replyText,
            },
          },
        },
        scope,
        async () => {
          if (
            stopping ||
            closed ||
            !ensureLeaseHeld() ||
            !sdk ||
            capturedEpoch !== sdk.currentEpoch() ||
            !sdk.ready()
          ) {
            throw new Error('channel_changed');
          }
        },
      );

      if (sendOutcome.state === 'unknown') {
        logger.warn(
          {
            botId,
            reqId: inboundEvent.reqId,
            messageId: inboundEvent.messageId,
            kind: outcome.kind,
            detail: sendOutcome.detail,
          },
          'WeCom passive reply ACK timed out (state=unknown); not retrying or switching to SEND_MSG',
        );
      } else if (sendOutcome.state !== 'accepted') {
        logger.warn(
          {
            botId,
            reqId: inboundEvent.reqId,
            messageId: inboundEvent.messageId,
            kind: outcome.kind,
            state: sendOutcome.state,
            apiErrorCode: sendOutcome.apiErrorCode,
            detail: sendOutcome.detail,
          },
          'WeCom passive reply not accepted',
        );
      }
      return;
    }

    // ── Slow Path: pass -> admit into OpenDot message pipeline (never touches req_id) ──
    if (opts.shouldDeferInbound?.() === true) {
      logger.info(
        { botId, messageId: inboundEvent.messageId },
        'WeCom inbound pass message deferred',
      );
      return;
    }

    const rawJid = `wecom:c2c:${outcome.corpId}:${inboundEvent.memberId}`;
    const jid = opts.normalizeIncomingJid
      ? opts.normalizeIncomingJid(rawJid)
      : rawJid;
    const senderName = outcome.displayName || inboundEvent.memberId;
    const chatName = senderName;
    const timestamp =
      inboundEvent.createTime !== undefined
        ? new Date(inboundEvent.createTime * 1000).toISOString()
        : new Date().toISOString();
    const senderId = `wecom:${inboundEvent.memberId}`;

    storeChatMetadata(jid, timestamp, chatName);
    opts.onNewChat(jid, chatName);

    let targetJid = outcome.workspaceJid || jid;
    let agentId: string | null = null;
    if (opts.resolveEffectiveChatJid) {
      try {
        const resolved = resolveAdmittedChannelRoute(
          jid,
          opts.resolveEffectiveChatJid,
        );
        if (!resolved) {
          logger.warn(
            { jid },
            'WeCom message dropped: binding resolver rejected route',
          );
          return;
        }
        targetJid = resolved.targetJid;
        agentId = resolved.routing?.agentId ?? null;
      } catch (err) {
        if (err instanceof ChannelRouteRejectedError) {
          logger.warn(
            { jid },
            'WeCom message dropped: binding resolver rejected route',
          );
          return;
        }
        throw err;
      }
    }

    if (targetJid !== jid) {
      storeChatMetadata(targetJid, timestamp, chatName);
    }
    const passDedupeKey = `${targetJid}\0${inboundEvent.messageId}`;
    let alreadyStored = admittedPassKeys.has(passDedupeKey);
    if (!alreadyStored) {
      try {
        alreadyStored = hasStoredMessage?.(targetJid, inboundEvent.messageId) === true;
      } catch {
        alreadyStored = false;
      }
    }
    if (alreadyStored) {
      logger.debug(
        { botId, targetJid, messageId: inboundEvent.messageId },
        'Duplicate WeCom inbound pass message ignored',
      );
      return;
    }
    admittedPassKeys.add(passDedupeKey);
    if (admittedPassKeys.size > MAX_ADMITTED_PASS_KEYS) {
      const oldest = admittedPassKeys.values().next().value;
      if (oldest !== undefined) admittedPassKeys.delete(oldest);
    }

    storeMessageDirect(
      inboundEvent.messageId,
      targetJid,
      senderId,
      senderName,
      inboundEvent.text,
      timestamp,
      false,
      { sourceJid: jid },
    );
    broadcastNewMessage(
      targetJid,
      {
        id: inboundEvent.messageId,
        chat_jid: targetJid,
        source_jid: jid,
        sender: senderId,
        sender_name: senderName,
        content: inboundEvent.text,
        timestamp,
        is_from_me: false,
      },
      agentId ?? undefined,
    );
    notifyNewImMessage();
    opts.onMessage?.(jid, inboundEvent.text, senderName);
    if (agentId) {
      opts.onAgentMessage?.(jid, agentId);
    }

    if (outcome.expiredReminder?.trim()) {
      await sendProactiveText(
        jid,
        inboundEvent.memberId,
        outcome.expiredReminder.trim(),
      );
    }
  }

  return {
    async connect(opts: WeComConnectOpts): Promise<boolean> {
      if (!botId || !secret) {
        logger.info('WeCom botId/secret not configured, skipping connection');
        return false;
      }

      if (config.lease) {
        let acquired = false;
        try {
          acquired = (await config.lease.acquire()) === true;
        } catch (err) {
          logger.warn(
            { err, botId },
            'WeCom consumer lease acquire threw error',
          );
          acquired = false;
        }
        if (!acquired || !config.lease.held()) {
          logger.info(
            { botId },
            'WeCom consumer lease not acquired, skipping WSClient connect',
          );
          return false;
        }
      }

      stopping = false;
      closed = false;

      try {
        const wsClient =
          config.client ??
          (config.createClient
            ? config.createClient()
            : new WSClient({
                botId,
                secret,
                maxReconnectAttempts: 0,
                maxAuthFailureAttempts: 0,
                requestTimeout: 4000,
                logger: silentSdkLogger,
              }));

        const sdkAdapter = createBotSdkAdapter({ client: wsClient });
        const botSender = createBotSender({
          sdk: sdkAdapter,
          timeoutMs: sendTimeoutMs,
        });

        client = wsClient;
        sdk = sdkAdapter;
        sender = botSender;

        let readyFired = false;
        const fireReady = () => {
          if (!readyFired && !stopping && !closed) {
            readyFired = true;
            opts.onReady?.();
          }
        };
        readyListener = fireReady;
        wsClient.on('authenticated', fireReady);

        textListener = (frame: unknown) => {
          void handleInboundFrame(frame, opts).catch((err) => {
            logger.error({ err, botId }, 'Error in WeCom message handler');
          });
        };
        wsClient.on('message.text', textListener as never);

        const connectFn = config.connect ?? config.connectClient;
        if (connectFn) {
          connectFn(wsClient);
        } else {
          wsClient.connect();
        }

        if (
          config.lease &&
          config.leaseCheckIntervalMs &&
          config.leaseCheckIntervalMs > 0
        ) {
          leaseCheckTimer = setInterval(() => {
            ensureLeaseHeld();
          }, config.leaseCheckIntervalMs);
          leaseCheckTimer.unref?.();
        }
        if (
          config.lease &&
          config.leaseRenewIntervalMs &&
          config.leaseRenewIntervalMs > 0
        ) {
          leaseRenewTimer = setInterval(() => {
            if (stopping || closed || !config.lease) return;
            void config.lease
              .acquire()
              .then((ok) => {
                if (!ok || !config.lease?.held()) {
                  logger.warn(
                    { botId },
                    'WeCom consumer lease renewal failed; disconnecting WSClient immediately',
                  );
                  disconnectSync();
                }
              })
              .catch(() => {
                logger.warn(
                  { botId },
                  'WeCom consumer lease renewal threw; disconnecting WSClient immediately',
                );
                disconnectSync();
              });
          }, config.leaseRenewIntervalMs);
          leaseRenewTimer.unref?.();
        }

        if (sdkAdapter.ready()) {
          fireReady();
        }

        return true;
      } catch (err) {
        logger.error({ err, botId }, 'WeCom initial connection failed');
        disconnectSync();
        return false;
      }
    },

    async disconnect(): Promise<void> {
      disconnectSync();
    },

    async sendMessage(
      chatId: string,
      text: string,
      _localImagePaths?: string[],
    ): Promise<void> {
      if (!ensureLeaseHeld()) {
        return;
      }
      if (stopping || closed || !sender || !sdk?.ready()) {
        logger.warn(
          { botId, chatId },
          'WeCom channel not connected, skip sending message',
        );
        return;
      }

      const memberId = parseWeComMemberId(chatId);
      if (!memberId) {
        logger.warn(
          { botId, chatId },
          'Invalid WeCom chatId format, skip sending message',
        );
        return;
      }
      await sendProactiveText(chatId, memberId, text);
    },

    async notify(
      memberId: string,
      content: string,
      scope: BotReadScope,
      beforeSend: () => Promise<void>,
    ): Promise<BotSendOutcome> {
      if (!ensureLeaseHeld() || stopping || closed || !sender || !sdk?.ready()) {
        return {
          state: 'blocked',
          apiErrorCode: null,
          msgid: null,
          detail: 'wecom_channel_not_connected',
        };
      }

      const outcome = await sender.notify(memberId, content, scope, async () => {
        if (!ensureLeaseHeld() || stopping || closed || !sdk?.ready()) {
          throw new Error('channel_closed');
        }
        await beforeSend();
      });

      if (outcome.state === 'unknown') {
        logger.warn(
          {
            botId,
            memberId,
            detail: outcome.detail,
          },
          'WeCom proactive notify ACK timed out (state=unknown); not retrying',
        );
      }

      return outcome;
    },

    isConnected(): boolean {
      if (stopping || closed) return false;
      if (!ensureLeaseHeld()) return false;
      return sdk?.ready() ?? false;
    },
  };
}
