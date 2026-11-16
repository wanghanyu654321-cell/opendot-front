import { vi } from 'vitest';
import { createPostgresPerformanceStore, migratePerformance } from '../../src/role-eval/performance-postgres.js';
import type { PerformanceStore } from '../../src/role-eval/performance-store.js';
import { createPostgresBindingStore, type WecomBotBindingStore } from '../../src/role-eval/directory-store.js';
import type { OpenedPerformanceStore } from '../../src/role-eval/performance-open.js';
import { APPOINTMENT_RECIPIENTS_KEY } from '../../src/role-eval/appointments.js';
import { createWecomLongConnectionChannel, type FrontClawChannel } from '../../src/opendot/wecom-channel.js';
import { seed } from '../role-eval/access-fixture-m03.js';
import { peopleM04 } from '../role-eval/ledger-fixture-m04.js';
import { policyM05, RECIPIENTS } from '../role-eval/appointment-fixture-m05.js';
import { MemorySql } from '../role-eval/sql-fixture.js';
import { offlineBotSdk } from '../fixtures/offline-bot-sdk.js';

/**
 * M07 合成世界（全部合成数据）：M05 的人员/策略（B 店苏晓禾=店长、小赵/小王=员工；A 店老周等），
 * 机器人 fc-bot、企业 corp-b；B 店三人 + 老周有绑定。OpenDot 宿主为假宿主（只有 logger + env）。
 */
export const BOT = 'fc-bot';
export const CORP = 'corp-b';
export const BOUND = ['m-wang-yj', 'm-zhao', 'm-xw', 'm-zhou'] as const;
export async function seedBindings(store: PerformanceStore, bindings: WecomBotBindingStore, members: readonly string[] = BOUND) {
  for (const memberId of members) {
    const person = await store.getPersonByMember(memberId);
    if (!person) throw Error(`no person ${memberId}`);
    await bindings.saveBinding({ botId: BOT, corpId: CORP, memberId, accountId: person.accountId, version: 1, active: true });
  }
}
export async function seedWorld(store: PerformanceStore, bindings: WecomBotBindingStore) {
  await seed(store, { people: peopleM04, policy: policyM05(1) });
  await store.setConfig(APPOINTMENT_RECIPIENTS_KEY, RECIPIENTS);
  await seedBindings(store, bindings);
}

/** 内存 SQL 替身 + 内存绑定表；open() 每次返回同一份（模拟同一个库），close 计数。 */
export async function memoryWorld(sqlFactory: () => MemorySql = () => new MemorySql()) {
  const sql = sqlFactory();
  await migratePerformance(sql);
  const store = createPostgresPerformanceStore(sql);
  const bindings = createPostgresBindingStore(sql);
  await seedWorld(store, bindings);
  const closes = vi.fn(async () => {});
  const open = vi.fn(async (): Promise<OpenedPerformanceStore> => ({ store, bindings, driver: 'postgres', close: closes }));
  return { sql, store, bindings, open, closes };
}

/** 假 OpenDot 宿主：只有 pino 子集 logger + env。 */
export function fakeHost(env: Record<string, string | undefined> = {}) {
  const logs: { level: 'info' | 'warn'; fields: Record<string, unknown>; message?: string }[] = [];
  return {
    logs,
    host: {
      env: { FRONT_CLAW_OPENDOT_ADAPTER: '1', ...env },
      logger: {
        info: (fields: Record<string, unknown>, message?: string) => { logs.push({ level: 'info', fields, ...(message ? { message } : {}) }); },
        warn: (fields: Record<string, unknown>, message?: string) => { logs.push({ level: 'warn', fields, ...(message ? { message } : {}) }); },
      },
    },
  };
}

/** 离线企微通道工厂：真实 SDK WSClient（网络被替换）+ 现有 sdk 适配/发送器；每次拿租约新建一个。 */
export function offlineChannels(options: { authenticate?: boolean } = {}) {
  const made: (ReturnType<typeof offlineBotSdk> & { channel: FrontClawChannel; connects: number; disconnects: number })[] = [];
  const factory = () => {
    const sdk = offlineBotSdk(BOT);
    const entry = Object.assign(sdk, { channel: undefined as unknown as FrontClawChannel, connects: 0, disconnects: 0 });
    entry.channel = createWecomLongConnectionChannel({ client: sdk.client, botId: BOT,
      connect: () => { entry.connects++; if (options.authenticate !== false) sdk.authenticate(); },
      disconnect: () => { entry.disconnects++; } });
    made.push(entry);
    return entry.channel;
  };
  const current = () => made[made.length - 1]!;
  let seq = 0;
  /** 企微单聊文本帧（与 SDK aibot_msg_callback 同形）。 */
  const frame = (memberId: string, content: string, msgid = `wx-${++seq}`, extra: { chattype?: string; corpid?: string; aibotid?: string } = {}) => ({
    cmd: 'aibot_msg_callback', headers: { req_id: `req-${msgid}` },
    body: { msgid, aibotid: extra.aibotid ?? BOT, msgtype: 'text', chattype: extra.chattype ?? 'single', create_time: 1794448800, from: { userid: memberId, corpid: extra.corpid ?? CORP }, text: { content } },
  });
  const send = (memberId: string, content: string, msgid?: string, extra?: Parameters<typeof frame>[3]) => {
    const f = frame(memberId, content, msgid, extra);
    current().frame(f);
    return f.body.msgid;
  };
  /** 所有通道已发出的回复正文（aibot_respond_msg）。 */
  const replies = () => made.flatMap(m => m.sent.filter(s => s.cmd === 'aibot_respond_msg').map(s => String((s.body as { stream?: { content?: string } }).stream?.content ?? '')));
  const notices = () => made.flatMap(m => m.sent.filter(s => s.cmd === 'aibot_send_msg').map(s => s.body));
  return { factory, made, current, frame, send, replies, notices };
}
export function manualClock(start = new Date('2026-11-12T02:00:00Z').getTime()) {
  let t = start;
  return { now: () => new Date(t), advance(ms: number) { t += ms; }, get ms() { return t; } };
}
export const opIdOf = (memberId: string, msgid: string) => ({ botId: BOT, corpId: CORP, memberId, messageId: msgid });
