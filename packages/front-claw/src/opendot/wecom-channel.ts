import { createHash } from 'node:crypto';
import { WSClient } from '@wecom/aibot-node-sdk';
import type { BotReadScope } from '../role-eval/wecom-bot-context.js';
import { createBotSdkAdapter } from '../role-eval/wecom-bot-sdk.js';
import { createBotSender, type BotSendOutcome } from '../role-eval/wecom-bot-sender.js';
import { normalizeBotFrame } from '../role-eval/wecom-bot-transport.js';
import { maskWecomValue, wecomDebug, wecomSdkLogger } from '../role-eval/wecom-bot-preparation.js';
import { WECOM_BOT_ID_ENV, WECOM_BOT_SECRET_ENV } from './host-contract.js';

/** 已认证 SDK 事件里的单聊文本（帧解析复用 normalizeBotFrame：群聊、缺字段一律丢弃）。 */
export interface InboundText {
  epoch?: number; reqId: string; botId: string; corpId?: string; memberId: string; messageId: string; text: string; createTime?: number;
}
export type ChannelSendState = BotSendOutcome['state'];
type OwnedClient = Pick<WSClient, 'on' | 'off' | 'isConnected' | 'reply' | 'sendMessage'>;

/** 企微长连接通道端口。生产实现见 createWecomLongConnectionChannel；测试用同一实现 + 离线 SDK。 */
export interface FrontClawChannel {
  open(onText: (event: InboundText) => void): void;
  /** 已认证且已连接（不是 WebSocket.OPEN）。 */
  ready(): boolean;
  current?(event: InboundText): boolean;
  reply(event: InboundText, text: string, scope: BotReadScope): Promise<ChannelSendState>;
  notify(memberId: string, content: string, scope: BotReadScope, beforeSend: (scope: BotReadScope) => Promise<void>): Promise<BotSendOutcome>;
  /** 被丢弃的帧数（非本机器人、非单聊、非文本、格式不对）。 */
  rejected(): number;
  close(): Promise<void>;
}

/**
 * 复用现有长连接代码：createBotSdkAdapter（请求号不复用、认证周期失效、迟到 ACK 不串号）、
 * createBotSender（有界超时、beforeSend 预检、accepted/rejected/blocked/unknown）、normalizeBotFrame。
 * 本函数不新增发送协议；客户端连接/断开由调用方传入（测试为空操作，离线 SDK）。
 */
export function createWecomLongConnectionChannel(options: { client: OwnedClient; botId: string; connect(client: OwnedClient): void; disconnect(client: OwnedClient): void }): FrontClawChannel {
  const { client, botId, connect, disconnect } = options;
  if (!botId.trim()) throw Error('invalid_wecom_channel');
  const sdk = createBotSdkAdapter({ mode: 'isolated-synthetic', client: client as WSClient });
  const sender = createBotSender({ sdk });
  let listener: ((frame: unknown) => void) | undefined;
  let closed = false;
  let dropped = 0, epoch = 0;
  const invalidate = () => { epoch++; };
  const epochEvents = ['connected', 'authenticated', 'disconnected', 'reconnecting', 'error', 'event.disconnected_event'] as const;
  for (const event of epochEvents) client.on(event, invalidate);
  return {
    open(onText) {
      if (listener || closed) throw Error('wecom_channel_reopened');
      listener = frame => {
        if (closed || !sdk.ready()) { dropped++; return; }
        try {
          const event = normalizeBotFrame(structuredClone(frame));
          if (event.botId !== botId || event.action.kind !== 'text') { dropped++; return; }
          onText({ epoch, reqId: event.reqId, botId: event.botId, ...(event.corpId !== undefined ? { corpId: event.corpId } : {}), memberId: event.memberId, messageId: event.messageId, text: event.action.text, ...(event.createTime !== undefined ? { createTime: event.createTime } : {}) });
        } catch { dropped++; }
      };
      client.on('message.text', listener as never);
      connect(client);
      wecomDebug('opendot_channel_open', { botId: maskWecomValue(botId) });
    },
    ready: () => !closed && sdk.ready(),
    current: event => !closed && sdk.ready() && event.epoch === epoch,
    async reply(event, text, scope) {
      try {
        const outcome = await sender.reply({ reqId: event.reqId, body: { msgtype: 'stream', stream: { id: createHash('sha256').update('front-claw-opendot-reply|' + event.reqId).digest('hex').slice(0, 32), finish: true, content: text } } },
          scope, async () => { if (closed || event.epoch !== epoch || !sdk.ready()) throw Error('channel_changed'); });
        return outcome.state;
      } catch { return 'rejected'; }
    },
    notify: (memberId, content, scope, beforeSend) => sender.notify(memberId, content, scope, async child => { if (closed) throw Error('channel_closed'); await beforeSend(child); }),
    rejected: () => dropped,
    async close() {
      if (closed) return;
      closed = true;
      if (listener) client.off('message.text', listener as never);
      for (const event of epochEvents) client.off(event, invalidate);
      sender.close(); sdk.close();
      try { disconnect(client); } catch { /* 断开失败不影响关停 */ }
    },
  };
}

/** 生产工厂（假设 A2：凭据来自 env）。参数同 wecom-bot-preparation.ts 现有真实客户端：不自动重连，由适配器按租约重建通道。 */
export function wecomChannelFromEnv(env: Readonly<Record<string, string | undefined>>): FrontClawChannel {
  const botId = env[WECOM_BOT_ID_ENV]?.trim() ?? '';
  const secret = env[WECOM_BOT_SECRET_ENV]?.trim() ?? '';
  if (!botId || !secret) throw Error('wecom_credential_unavailable');
  const client = new WSClient({ botId, secret, maxReconnectAttempts: 0, maxAuthFailureAttempts: 0, requestTimeout: 4000, logger: wecomSdkLogger() });
  return createWecomLongConnectionChannel({ client, botId, connect: c => { (c as WSClient).connect(); }, disconnect: c => { (c as WSClient).disconnect(); } });
}
