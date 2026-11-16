import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { startFrontClawOpenDotService, operationIdFor, isFrontClawOperation, parsePlatformCapabilities } from '../../src/opendot/adapter.js';
import { CONSUMER_LEASE_KEY, createConsumerLease } from '../../src/opendot/consumer-lease.js';
import { OPENDOT_GOAL_RUN_PREFIX } from '../../src/opendot/host-contract.js';
import { ACCESS_DENIED } from '../../src/role-eval/employee-loop.js';
import { UNBOUND } from '../../src/role-eval/wecom-bot-unified-handler.js';
import { ACCESS_POLICY_KEY, updateAccessPolicy } from '../../src/role-eval/access-policy.js';
import { membersM05, policyM05 } from '../role-eval/appointment-fixture-m05.js';
import { MemorySql } from '../role-eval/sql-fixture.js';
import { BOT, CORP, fakeHost, manualClock, memoryWorld, offlineChannels, opIdOf } from './fixture-m07.js';

const SHEET_ZHAO = '12号测试B店\n560（小赵）';
const at = '2026-11-12T02:00:00.000Z';
async function boot(options: { env?: Record<string, string | undefined>; world?: Awaited<ReturnType<typeof memoryWorld>>; clock?: ReturnType<typeof manualClock>; channels?: ReturnType<typeof offlineChannels>; owner?: string; graceMs?: number } = {}) {
  const world = options.world ?? await memoryWorld();
  const clock = options.clock ?? manualClock();
  const channels = options.channels ?? offlineChannels();
  const { host, logs } = fakeHost(options.env);
  const service = await startFrontClawOpenDotService(host, { open: world.open, channel: channels.factory, now: clock.now, timers: false,
    leaseMs: 30_000, renewMs: 10_000, ...(options.owner ? { owner: options.owner } : {}), ...(options.graceMs !== undefined ? { graceMs: options.graceMs } : {}) });
  const say = async (memberId: string, text: string, msgid?: string) => { const id = channels.send(memberId, text, msgid); await service.idle(); return id; };
  const last = () => channels.replies().at(-1) ?? '';
  return { world, clock, channels, service, logs, say, last };
}
async function suspend(store: Awaited<ReturnType<typeof memoryWorld>>['store'], personId: string, version = 2) {
  const members = membersM05(); members[personId] = { ...members[personId]!, status: 'suspended' };
  const result = await updateAccessPolicy(store, { expectedVersion: version - 1, next: policyM05(version, members), actor: 'test-admin', reason: 'm07-revoke', at });
  if (!result.ok) throw Error(result.reason);
}

describe('M07 契约：默认关与启动校验', () => {
  it('未开开关：不开存储、不建通道、不读凭据，只记一条 disabled 日志', async () => {
    for (const flag of [undefined, '0', 'true', ' 1x']) {
      const world = await memoryWorld();
      const channel = vi.fn();
      const { host, logs } = fakeHost({ FRONT_CLAW_OPENDOT_ADAPTER: flag, FRONT_CLAW_WECOM_BOT_SECRET: 'must-not-be-read' });
      const service = await startFrontClawOpenDotService(host, { open: world.open, channel, timers: false });
      expect(service.state()).toBe('disabled');
      expect(world.open).not.toHaveBeenCalled(); expect(channel).not.toHaveBeenCalled();
      expect(logs).toEqual([{ level: 'info', fields: { state: 'disabled' }, message: 'Front Claw adapter disabled' }]);
      expect(await service.result('goal-run:1')).toEqual({ operationId: 'goal-run:1', state: 'not_ours' });
      await service.close(); expect(service.state()).toBe('closed');
    }
  });
  it('Mem0 被要求打开、平台能力有未知名、时序非法：在打开存储之前拒绝启动', async () => {
    const world = await memoryWorld();
    for (const env of [{ FRONT_CLAW_MEM0: '1' }, { FRONT_CLAW_MEM0: 'on' }, { FRONT_CLAW_OPENDOT_CAPABILITIES: 'report_self,admin_all' }]) {
      await expect(startFrontClawOpenDotService(fakeHost(env).host, { open: world.open, channel: offlineChannels().factory, timers: false })).rejects.toThrow();
    }
    await expect(startFrontClawOpenDotService(fakeHost().host, { open: world.open, channel: offlineChannels().factory, timers: false, leaseMs: 10_000, renewMs: 10_000 })).rejects.toThrow('invalid_adapter_timing');
    expect(world.open).not.toHaveBeenCalled();
    expect(parsePlatformCapabilities(undefined)).toBeUndefined();
    expect(parsePlatformCapabilities('')).toEqual([]);
    expect(parsePlatformCapabilities(' report_self , report_self,progress_self')).toEqual(['report_self', 'progress_self']);
  });
});

describe('M07 契约：入口 → 适配器 → handler → 存储 → 回复记录器', () => {
  it('报数回显、「对」入账、操作 ID 贯通（msgid → 请求 → 草稿号），结果如实', async () => {
    const t = await boot();
    expect(t.service.state()).toBe('active');
    expect(t.channels.current().connects).toBe(1);
    await t.say('m-zhao', SHEET_ZHAO, 'wx-report');
    expect(t.last()).toContain('560');
    expect(await t.world.store.listEntries({ storeId: 's-b' })).toHaveLength(2); // 种子里的两笔
    await t.say('m-zhao', '对', 'wx-confirm');
    expect(t.last()).toContain('已入账');
    const amounts = (await t.world.store.listEntries({ storeId: 's-b' })).map(e => e.amount).sort((a, b) => a - b);
    expect(amounts).toEqual([10000, 56000, 90000]);
    const op = operationIdFor(opIdOf('m-zhao', 'wx-confirm'));
    expect(op.startsWith('front-claw:')).toBe(true);
    const report = await t.service.result(op);
    expect(report).toMatchObject({ operationId: op, state: 'completed', messageId: 'wx-confirm', ledgerSettled: true, draftStatus: 'confirmed', replyState: 'accepted' });
    expect(report.businessOperationId).toMatch(/^[0-9a-f]{64}$/);
    // 同一 msgid 重投（企微重试）：不再入账，回复同一结果。
    await t.say('m-zhao', '对', 'wx-confirm');
    expect((await t.world.store.listEntries({ storeId: 's-b' })).length).toBe(3);
    await t.service.close();
    expect(t.world.closes).toHaveBeenCalledTimes(1);
    expect(t.channels.current().disconnects).toBe(1);
    expect(t.channels.current().connect).not.toHaveBeenCalled(); // 真实 SDK connect 从未被调用（离线）
  });
  it('群聊、别的机器人、非文本、坏帧都被丢弃：不进 handler，不回复', async () => {
    const t = await boot();
    t.channels.send('m-zhao', SHEET_ZHAO, 'g-1', { chattype: 'group' });
    t.channels.send('m-zhao', SHEET_ZHAO, 'o-1', { aibotid: 'other-bot' });
    t.channels.current().frame({ cmd: 'aibot_msg_callback', headers: { req_id: 'x' }, body: { msgtype: 'text' } });
    await t.service.idle();
    expect(t.channels.replies()).toEqual([]);
    expect(await t.world.store.listDrafts()).toEqual([]);
    expect(t.service.stats().handled).toBe(0);
    await t.service.close();
  });
  it('没绑定、绑定停用、企业不符、绑定账号与人员不符拒绝；缺企业号复用可信锚', async () => {
    const t = await boot();
    await t.say('m-lin', '我的进度', 'u-1'); // 小林未绑定
    await t.world.bindings.saveBinding({ botId: BOT, corpId: CORP, memberId: 'm-xw', accountId: 'a-xw', version: 2, active: false });
    await t.say('m-xw', SHEET_ZHAO, 'u-2');
    t.channels.send('m-zhao', SHEET_ZHAO, 'u-3', { corpid: 'corp-other' }); await t.service.idle();
    await t.world.bindings.saveBinding({ botId: BOT, corpId: CORP, memberId: 'm-zhou', accountId: 'a-someone-else', version: 2, active: true });
    await t.say('m-zhou', '经营汇总', 'u-4');
    const noCorp = t.channels.frame('m-zhao', SHEET_ZHAO, 'u-5');
    delete (noCorp.body.from as { corpid?: string }).corpid;
    t.channels.current().frame(noCorp); await t.service.idle();
    expect(t.channels.replies().slice(0, 4)).toEqual([UNBOUND, UNBOUND, UNBOUND, UNBOUND]);
    expect(t.channels.replies().at(-1)).toContain('还没入账');
    expect(await t.world.store.listDrafts()).toHaveLength(1);
    expect(t.service.stats().unbound).toBe(4);
    await t.service.close();
  });
  it('会话隔离：别人的「对」确认不了小赵的草稿', async () => {
    const t = await boot();
    await t.say('m-zhao', SHEET_ZHAO, 's-1');
    await t.say('m-wang-yj', '对', 's-2'); // 同店店长，但没有自己的草稿
    expect(t.last()).toContain('没有待确认');
    expect((await t.world.store.listEntries({ storeId: 's-b' })).length).toBe(2);
    await t.say('m-zhao', '对', 's-3');
    expect((await t.world.store.listEntries({ storeId: 's-b' })).length).toBe(3);
    await t.service.close();
  });
});

describe('M07 授权取交集，适配器绕不过 M03 每步重判', () => {
  it('平台层收窄：去掉 report_proxy 后店长代报被拒，本人报数照常', async () => {
    const t = await boot({ env: { FRONT_CLAW_OPENDOT_CAPABILITIES: 'report_self,progress_self,progress_other,store_summary,unreported' } });
    await t.say('m-wang-yj', SHEET_ZHAO, 'p-1');
    expect(t.last()).toBe(ACCESS_DENIED);
    await t.say('m-zhao', SHEET_ZHAO, 'p-2');
    expect(t.last()).toContain('560');
    await t.service.close();
  });
  it('平台层放不宽：平台给了 stores_ranking，员工按 M03 仍无此能力', async () => {
    const t = await boot({ env: { FRONT_CLAW_OPENDOT_CAPABILITIES: 'report_self,progress_self,stores_ranking,store_summary' } });
    await t.say('m-zhao', '门店排名', 'r-1');
    expect(t.last()).not.toMatch(/第\s*1/);
    expect(t.last()).toMatch(/权限|不支持|没有/);
    await t.service.close();
  });
  it('平台层收掉全部（空串）：任何业务都拒绝', async () => {
    const t = await boot({ env: { FRONT_CLAW_OPENDOT_CAPABILITIES: '' } });
    await t.say('m-zhao', SHEET_ZHAO, 'z-1');
    expect(t.last()).toBe(ACCESS_DENIED);
    expect(await t.world.store.listDrafts()).toEqual([]);
    await t.service.close();
  });
  it('回显后撤权：同一会话的「对」被拒，零写入（适配器没有直写路径）', async () => {
    const t = await boot();
    await t.say('m-zhao', SHEET_ZHAO, 'v-1');
    await suspend(t.world.store, 'p-zhao');
    await t.say('m-zhao', '对', 'v-2');
    expect(t.last()).toBe(ACCESS_DENIED);
    expect((await t.world.store.listEntries({ storeId: 's-b' })).length).toBe(2);
    await t.service.close();
  });
  it('策略行缺失：拒绝（不退回“无策略”）', async () => {
    const t = await boot();
    // R1：策略键受保护，setConfig 拒写；用锁内写模拟“行被写坏”。
    await t.world.store.updateConfigLocked(ACCESS_POLICY_KEY, [], () => ({ [ACCESS_POLICY_KEY]: 'not-json' }));
    await t.say('m-zhao', SHEET_ZHAO, 'b-1');
    expect(t.last()).toBe(ACCESS_DENIED);
    await t.service.close();
  });
  it('静态：适配器源码不调用任何账本/草稿/通知写接口，也不 import OpenDot、Mem0、调度器', () => {
    const dir = path.resolve('src/opendot');
    const sources = readdirSync(dir).filter(f => f.endsWith('.ts')).map(f => [f, readFileSync(path.join(dir, f), 'utf8')] as const);
    expect(sources.length).toBeGreaterThanOrEqual(6);
    for (const [file, text] of sources) {
      expect(text, file).not.toMatch(/\.(insertEntries|commit\w+|saveDraft|savePerson|setConfig|updateEntr\w*|enqueueNotification|transitionNotification|claimDueNotifications|beginNotificationSend|saveBinding|saveAlias|createDraft\w*)\(/);
      for (const m of text.matchAll(/from '([^']+)'/g)) expect(m[1], file).toMatch(/^(node:|@wecom\/aibot-node-sdk$|\.\/|\.\.\/role-eval\/)/);
      expect(text, file).not.toMatch(/\bimport\(|require\(/); // 没有动态加载（OpenDot/Mem0/调度器都进不来）
    }
    const hook = readFileSync('integrations/opendot-front-claw/opendot-src/front-claw-hook.ts', 'utf8');
    expect([...hook.matchAll(/from '([^']+)'/g)].map(m => m[1])).toEqual(['node:path', 'node:url']);
    // 租约只写自己的一个 config 键。
    expect(readFileSync(path.join(dir, 'consumer-lease.ts'), 'utf8')).toMatch(/CONSUMER_LEASE_KEY = 'front-claw-opendot-consumer'/);
  });
});

describe('M07 唯一归属：命名空间、单消费者租约、双调度', () => {
  it('front-claw: 与 goal-run: 不相交；操作 ID 跨实例一致', () => {
    const a = operationIdFor(opIdOf('m-zhao', 'same')), b = operationIdFor(opIdOf('m-zhao', 'same'));
    expect(a).toBe(b); expect(isFrontClawOperation(a)).toBe(true);
    expect(a.startsWith(OPENDOT_GOAL_RUN_PREFIX)).toBe(false);
    expect(isFrontClawOperation('goal-run:' + a.slice(11))).toBe(false);
    expect(operationIdFor(opIdOf('m-xw', 'same'))).not.toBe(a);
    expect(operationIdFor({ ...opIdOf('m-zhao', 'same'), corpId: 'other' })).not.toBe(a);
  });
  it('第二个实例 standby；第一个关停释放后接管；standby 收到的帧不处理', async () => {
    const world = await memoryWorld();
    const clock = manualClock();
    const a = await boot({ world, clock, owner: 'A' });
    const bChannels = offlineChannels();
    const b = await boot({ world, clock, owner: 'B', channels: bChannels });
    expect(a.service.state()).toBe('active'); expect(b.service.state()).toBe('standby');
    expect(bChannels.made).toHaveLength(0); // standby 不建企微连接
    await a.service.close();
    expect(JSON.parse((await world.store.getConfig(CONSUMER_LEASE_KEY))!)).toEqual({ owner: null, token: null, until: 0, epoch: expect.any(Number) });
    await b.service.tick();
    expect(b.service.state()).toBe('active');
    await b.say('m-zhao', SHEET_ZHAO, 'h-1');
    expect(b.last()).toContain('560');
    await b.service.close();
  });
  it('持有者停住（不续约）：到期后另一实例接管；旧实例本地也判过期，迟到的帧不写不回', async () => {
    const world = await memoryWorld();
    const clock = manualClock();
    const a = await boot({ world, clock, owner: 'A' });
    const b = await boot({ world, clock, owner: 'B' });
    clock.advance(30_001);
    await b.service.tick();
    expect(b.service.state()).toBe('active');
    a.channels.send('m-zhao', SHEET_ZHAO, 'late-1'); await a.service.idle();
    expect(a.channels.replies()).toEqual([]);
    expect(a.service.stats().droppedStale).toBe(1);
    expect(await world.store.listDrafts()).toEqual([]);
    await a.service.tick(); // A 回来后发现租约被占：停入站
    expect(a.service.state()).toBe('standby');
    expect(a.channels.current().disconnects).toBe(1);
    await a.service.close(); await b.service.close();
  });
  it('R1 fencing 下的重叠（时钟偏差让两边都以为自己持有）：旧 epoch 的 A 写不进也不回复，账本至多一笔；重发给 B 恰好一笔', async () => {
    const world = await memoryWorld();
    const ca = manualClock(), cb = manualClock();
    const a = await boot({ world, clock: ca, owner: 'A' });
    await a.say('m-zhao', SHEET_ZHAO, 'd-1');
    cb.advance(30_001);
    const b = await boot({ world, clock: cb, owner: 'B' });
    expect(b.service.state()).toBe('active'); expect(a.service.state()).toBe('active');
    const f = a.channels.frame('m-zhao', '对', 'd-2');
    a.channels.current().frame(f); b.channels.current().frame(f);
    const aBefore = a.channels.replies().length;
    await Promise.all([a.service.idle(), b.service.idle()]);
    expect(a.channels.replies().length).toBe(aBefore);
    expect((await world.store.listEntries({ storeId: 's-b' })).filter(e => e.amount === 56000).length).toBeLessThanOrEqual(1);
    b.channels.current().frame(a.channels.frame('m-zhao', '对', 'd-3')); await b.service.idle();
    expect((await world.store.listEntries({ storeId: 's-b' })).filter(e => e.amount === 56000)).toHaveLength(1);
    await a.service.close(); await b.service.close();
  });
  it('同一实例并发收到同一帧两次：只处理一次', async () => {
    const t = await boot();
    const f = t.channels.frame('m-zhao', SHEET_ZHAO, 'dup-1');
    t.channels.current().frame(f); t.channels.current().frame(f);
    await t.service.idle();
    expect(t.service.stats().duplicate).toBe(1);
    expect(await t.world.store.listDrafts()).toHaveLength(1);
    await t.service.close();
  });
  it('租约行损坏：谁都不消费（不当作空闲）', async () => {
    const world = await memoryWorld();
    await world.store.setConfig(CONSUMER_LEASE_KEY, '{broken');
    const t = await boot({ world });
    expect(t.service.state()).toBe('standby');
    await t.service.close();
  });
  it('租约：并发首次抢占只有一个赢（insertConfigIfAbsent 不覆盖）', async () => {
    // MemorySql 没有行锁，这里用串行事务替身验证判定逻辑；真实 FOR UPDATE 竞争在 PG17 集成测试里。
    const world = await memoryWorld(() => new SerialSql());
    const clock = manualClock();
    const leases = ['L1', 'L2', 'L3'].map(owner => createConsumerLease({ store: world.store, owner, ttlMs: 30_000, now: clock.now }));
    const won = await Promise.all(leases.map(l => l.acquire()));
    expect(won.filter(Boolean)).toHaveLength(1);
    const holder = leases[won.indexOf(true)]!;
    expect(await holder.acquire()).toBe(true); // 续约
    const other = leases.find(l => l !== holder)!;
    expect(await other.acquire()).toBe(false);
    await other.release(); // 非持有者释放无效
    expect(JSON.parse((await world.store.getConfig(CONSUMER_LEASE_KEY))!).owner).toBe(holder.owner);
  });
});

/** 事务串行执行（模拟行锁互斥）。 */
class SerialSql extends MemorySql {
  private chain: Promise<unknown> = Promise.resolve();
  override transaction<T>(work: Parameters<MemorySql['transaction']>[0]): Promise<T> {
    const run = this.chain.then(() => super.transaction<T>(work as never));
    this.chain = run.catch(() => undefined);
    return run;
  }
}

/** 让确认写账本时停住，模拟慢库。 */
class GatedSql extends MemorySql {
  gate: Promise<void> | null = null;
  hit: (() => void) | null = null;
  override async query<T = Record<string, unknown>>(sql: string, params: readonly unknown[] = []): Promise<{ rows: T[] }> {
    if (this.gate && /INSERT INTO \S*performance_entries/i.test(sql.replace(/\s+/g, ' '))) { this.hit?.(); await this.gate; }
    return super.query<T>(sql, params);
  }
}

describe('M07 取消与关停：只报告真实状态，不撤销账目', () => {
  it('不属于本命名空间 / 未知 / 已完成：如实报告，已入账的不撤销', async () => {
    const t = await boot();
    expect(await t.service.cancel('goal-run:abc')).toEqual({ operationId: 'goal-run:abc', state: 'not_ours' });
    const unknown = operationIdFor(opIdOf('m-zhao', 'never'));
    expect(await t.service.cancel(unknown)).toEqual({ operationId: unknown, state: 'not_found' });
    await t.say('m-zhao', SHEET_ZHAO, 'c-1'); await t.say('m-zhao', '对', 'c-2');
    const done = await t.service.cancel(operationIdFor(opIdOf('m-zhao', 'c-2')));
    expect(done).toMatchObject({ state: 'completed', ledgerSettled: true, draftStatus: 'confirmed' });
    expect((await t.world.store.listEntries({ storeId: 's-b' })).length).toBe(3);
    await t.service.close();
  });
  it('进行中取消：不开始新回复；迟到的提交照实反映在结果里', async () => {
    let sql!: GatedSql;
    const world = await memoryWorld(() => (sql = new GatedSql()));
    const t = await boot({ world });
    await t.say('m-zhao', SHEET_ZHAO, 'k-1');
    let release!: () => void; let reached!: () => void;
    const hit = new Promise<void>(r => { reached = r; });
    sql.gate = new Promise<void>(r => { release = r; }); sql.hit = reached;
    t.channels.send('m-zhao', '对', 'k-2');
    await hit;
    const op = operationIdFor(opIdOf('m-zhao', 'k-2'));
    expect((await t.service.result(op)).state).toBe('running');
    const cancelling = t.service.cancel(op);
    await new Promise(r => setTimeout(r, 20));
    const report = await Promise.race([cancelling, new Promise<'pending'>(r => setTimeout(() => r('pending'), 200))]);
    // 请求预算在中止时立即收尾为 cancelled（handler 原规则），账本写入仍在途。
    expect(report === 'pending' ? 'pending' : report.state).toBe('cancelled');
    expect(t.channels.replies()).toHaveLength(1); // 仅原草稿回显；取消后不开始新发送。
    sql.gate = null; release();
    await new Promise(r => setTimeout(r, 50));
    const after = await t.service.result(op);
    expect(after.state).toBe('cancelled');
    expect(after.ledgerSettled).toBe((await t.world.store.listEntries({ storeId: 's-b' })).some(e => e.amount === 56000));
    await t.service.close();
  });
  it('关停：等在途超时后中止 → 关通道 → 释放租约 → 关存储；之后的帧不处理', async () => {
    let sql!: GatedSql;
    const world = await memoryWorld(() => (sql = new GatedSql()));
    const t = await boot({ world, graceMs: 50 });
    await t.say('m-zhao', SHEET_ZHAO, 'q-1');
    let reached!: () => void; const hit = new Promise<void>(r => { reached = r; });
    let release!: () => void; sql.gate = new Promise<void>(r => { release = r; }); sql.hit = reached;
    t.channels.send('m-zhao', '对', 'q-2');
    await hit;
    const closing = t.service.close();
    // 宽限期内通道还开着：新帧不再受理（已停入站）。
    t.channels.send('m-zhao', '我的进度', 'q-2b');
    expect(t.service.stats().droppedClosing).toBe(1);
    await new Promise(r => setTimeout(r, 120));
    sql.gate = null; release();
    await closing;
    expect(t.service.state()).toBe('closed');
    expect(t.world.closes).toHaveBeenCalledTimes(1);
    expect(JSON.parse((await world.store.getConfig(CONSUMER_LEASE_KEY))!).owner).toBeNull();
    expect((await t.service.result(operationIdFor(opIdOf('m-zhao', 'q-2')))).state).toBe('cancelled');
    expect((await t.service.result(operationIdFor(opIdOf('m-zhao', 'q-2b')))).state).toBe('not_found');
    t.channels.send('m-zhao', SHEET_ZHAO, 'q-3'); await t.service.idle();
    expect((await t.service.result(operationIdFor(opIdOf('m-zhao', 'q-3')))).state).toBe('not_found');
    await t.service.close(); // 幂等
    expect(t.world.closes).toHaveBeenCalledTimes(1);
  });
  it('通道掉线超过 30 秒：重建通道（新连接），旧连接断开', async () => {
    const clock = manualClock();
    const channels = offlineChannels({ authenticate: false });
    const t = await boot({ clock, channels });
    expect(t.service.state()).toBe('active');
    clock.advance(10_000); await t.service.tick();
    expect(channels.made).toHaveLength(1);
    clock.advance(25_000); await t.service.tick();
    expect(channels.made).toHaveLength(2);
    expect(channels.made[0]!.disconnects).toBe(1);
    expect(t.service.stats().channelRebuilds).toBe(1);
    await t.service.close();
  });
});
