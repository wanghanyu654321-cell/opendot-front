import { afterEach, expect, it } from 'vitest';
import { startFrontClawOpenDotService, operationIdFor } from '../../src/opendot/adapter.js';
import { createWecomLongConnectionChannel } from '../../src/opendot/wecom-channel.js';
import { CONSUMER_LEASE_KEY } from '../../src/opendot/consumer-lease.js';
import { wecomDebug, wecomSdkLogger, maskWecomValue } from '../../src/role-eval/wecom-bot-preparation.js';
import { vi } from 'vitest';
import { UNBOUND } from '../../src/role-eval/wecom-bot-unified-handler.js';
import { normalizeBotFrame } from '../../src/role-eval/wecom-bot-transport.js';
import { isSelfProgressQuery } from '../../src/role-eval/scope-refusal.js';
import { gate, installPausePoints } from '../../src/role-eval/pause-points.js';
import { BOT, CORP, fakeHost, manualClock, memoryWorld, offlineChannels } from '../../tests/opendot/fixture-m07.js';
import { offlineBotSdk } from '../../tests/fixtures/offline-bot-sdk.js';

// Synthetic regressions for the SDK channel and adapter in one request path.
// Every value and database in this file is synthetic. No network client connects.
const SHEET = '12号测试B店\n560（小赵）';
const MEMBER = 'm-zhao';
const closers: (() => Promise<void>)[] = [];
afterEach(async () => { while (closers.length) await closers.pop()!(); });

async function boot(authenticate = true, requestTimeoutMs = 15000) {
  const world = await memoryWorld();
  const clock = manualClock();
  const channels = offlineChannels({ authenticate });
  const host = fakeHost();
  const service = await startFrontClawOpenDotService(host.host, {
    open: world.open, channel: channels.factory, now: clock.now, timers: false, requestTimeoutMs,
  });
  closers.push(() => service.close());
  const say = async (text: string, messageId: string) => {
    channels.send(MEMBER, text, messageId); await service.idle();
    return channels.replies().at(-1) ?? '';
  };
  return { world, clock, channels, service, say, logs: host.logs };
}

it('OBS-CORP-ABSENT: unique trusted binding supplies the missing enterprise', async () => {
  const t = await boot();
  const frame = t.channels.frame(MEMBER, '我的进度', 'synthetic-no-corp');
  delete (frame.body.from as { corpid?: string }).corpid;
  expect(normalizeBotFrame(frame).corpId).toBeUndefined();
  t.channels.current().frame(frame); await t.service.idle();
  expect(t.channels.replies().at(-1)).toContain('今天 已做 900');
  expect(t.service.stats().unbound).toBe(0);
  expect(await t.world.store.listDrafts()).toHaveLength(0);
  expect(await t.world.store.listEntries({ storeId: 's-b' })).toHaveLength(2);
});

it('OBS-CHAIN: one SDK channel path creates draft confirms once and reads the same personal progress', async () => {
  const t = await boot();
  const initial = await t.world.store.listEntries({ storeId: 's-b' });
  const before = initial.length;
  expect(initial.filter(e => e.ownerPersonId === 'p-zhao').reduce((n,e) => n + e.amount, 0)).toBe(90000);
  expect(await t.say(SHEET, 'synthetic-report')).toContain('还没入账');
  expect(await t.world.store.listEntries({ storeId: 's-b' })).toHaveLength(before);
  expect(await t.say('对', 'synthetic-confirm')).toContain('已入账');
  expect(await t.world.store.listEntries({ storeId: 's-b' })).toHaveLength(before + 1);
  const reply = await t.say('我的进度', 'synthetic-progress');
  expect(reply).toContain('今天'); expect(reply).toContain('1460');
  await t.say('对', 'synthetic-confirm');
  expect(await t.world.store.listEntries({ storeId: 's-b' })).toHaveLength(before + 1);
  expect(await t.service.result(operationIdFor({ botId: BOT, corpId: CORP, memberId: MEMBER, messageId: 'synthetic-confirm' })))
    .toMatchObject({ ledgerSettled: true, draftStatus: 'confirmed', replyState: 'accepted' });
});

it.each(['corp', 'body-forgery', 'bot', 'group', 'inactive-binding', 'inactive-person', 'ambiguous-member'] as const)
('NEG-ISOLATION: %s does not create a business draft', async kind => {
  const t = await boot();
  const frame = t.channels.frame(MEMBER, SHEET, 'synthetic-negative');
  if (kind === 'corp') frame.body.from.corpid = 'synthetic-foreign-corp';
  if (kind === 'body-forgery') {
    t.world.bindings.listBindings = async () => [];
    delete (frame.body.from as { corpid?: string }).corpid;
    Object.assign(frame.body, { corpid: CORP, corpId: CORP, accountId: 'synthetic-forgery', roles: ['owner'] });
  }
  if (kind === 'bot') frame.body.aibotid = 'synthetic-foreign-bot';
  if (kind === 'group') frame.body.chattype = 'group';
  if (kind === 'inactive-binding') await t.world.bindings.saveBinding({ botId: BOT, corpId: CORP, memberId: MEMBER, accountId: 'a-zhao', active: false, version: 2 });
  if (kind === 'inactive-person' || kind === 'ambiguous-member') {
    const p = (await t.world.store.getPersonByMember(MEMBER))!;
    await t.world.store.savePerson(kind === 'inactive-person' ? { ...p, active: false } : { ...p, personId: 'synthetic-duplicate', accountId: 'synthetic-duplicate-account' });
  }
  t.channels.current().frame(frame); await t.service.idle();
  expect(await t.world.store.listDrafts()).toHaveLength(0);
  expect(await t.world.store.listEntries({ storeId: 's-b' })).toHaveLength(2);
  if (kind === 'bot' || kind === 'group') expect(t.channels.replies()).toHaveLength(0);
  else expect(t.channels.replies()).toHaveLength(1);
});

it('GAP-AUTH: a callback before SDK authentication must not create a draft', async () => {
  const t = await boot(false);
  expect(t.channels.current().channel.ready()).toBe(false);
  await t.say(SHEET, 'synthetic-preauth');
  // Unauthenticated callbacks cannot start business work.
  expect((await t.world.store.listDrafts()).length).toBe(0);
});

it('GAP-BINDING: revocation before commit must stop the in-flight confirmation', async () => {
  const t = await boot(); await t.say(SHEET, 'synthetic-revoke-draft');
  const pause = gate();
  const uninstall = installPausePoints({ 'commit-gate:before-commit': pause.hook });
  try {
    t.channels.send(MEMBER, '对', 'synthetic-revoke-confirm');
    await pause.reached;
    const binding = (await t.world.bindings.listBindings()).find(b => b.memberId === MEMBER)!;
    await t.world.bindings.saveBinding({ ...binding, version: binding.version + 1, active: false });
    pause.release(); await t.service.idle();
    expect((await t.world.store.listEntries({ storeId: 's-b' })).length).toBe(2);
  } finally { pause.release(); uninstall(); }
});

it('GAP-AMBIGUITY: multiple binding candidates must be refused by the adapter', async () => {
  const t = await boot();
  const list = t.world.bindings.listBindings.bind(t.world.bindings);
  t.world.bindings.listBindings = async () => {
    const rows = await list(); const row = rows.find(b => b.memberId === MEMBER)!;
    return [...rows, { ...row, corpId: 'synthetic-foreign-corp' }];
  };
  await t.say(SHEET, 'synthetic-ambiguous-binding');
  expect((await t.world.store.listDrafts()).length).toBe(0);
});

it('GAP-SNAPSHOT: delayed mutation of a binding result must not change the admitted identity', async () => {
  const t = await boot();
  const rows = await t.world.bindings.listBindings();
  const row = rows.find(b => b.memberId === MEMBER)!;
  t.world.bindings.listBindings = async () => rows;
  const original = t.world.store.getPersonByMember.bind(t.world.store);
  t.world.store.getPersonByMember = async id => {
    const person = await original(id);
    row.corpId = 'synthetic-mutated-corp'; row.active = false; row.version = 42;
    return person;
  };
  await t.say(SHEET, 'synthetic-retained-binding');
  // All downstream calls must use the validated private binding snapshot.
  const draft = (await t.world.store.listDrafts())[0];
  expect(draft?.payload.type === 'report' ? draft.payload.employeeContext?.bindingVersion : undefined).toBe(1);
});

it('GAP-LIFECYCLE: channel must capture executable callbacks during assembly', async () => {
  const sdk = offlineBotSdk(BOT); let originalCalls = 0, replacementCalls = 0;
  const options = { client: sdk.client, botId: BOT,
    connect: () => { originalCalls++; sdk.authenticate(); }, disconnect: () => {} };
  const channel = createWecomLongConnectionChannel(options);
  try {
    options.connect = () => { replacementCalls++; };
    channel.open(() => {});
    expect(originalCalls).toBe(1); expect(replacementCalls).toBe(0);
  } finally { await channel.close(); }
});

it('GAP-QUERY: the synthetic query form must reach personal progress without a model', () => {
  expect(isSelfProgressQuery('查询我的业绩')).toBe(true);
});

it('GAP-QUERY-CHANNEL: a fully bound synthetic SDK query must return personal progress', async () => {
  const t = await boot();
  const reply = await t.say('查询我的业绩', 'synthetic-natural-query');
  expect(reply).toContain('今天 已做 900');
  expect(t.logs.at(-1)?.fields.route).toBe('快通道');
});

it('GAP-REPLY-BUDGET: cancelling before the reply starts must abort the same reply scope', async () => {
  const t = await boot();
  const channel = t.channels.current().channel;
  const original = channel.reply.bind(channel);
  let reached!: () => void, release!: () => void;
  const hit = new Promise<void>(r => { reached = r; });
  const held = new Promise<void>(r => { release = r; });
  let replySignal: AbortSignal | undefined;
  channel.reply = async (event, text, scope) => {
    replySignal = scope.signal; reached(); await held;
    return original(event, text, scope);
  };
  let cancelling: ReturnType<typeof t.service.cancel> | undefined;
  try {
    t.channels.send(MEMBER, '我的进度', 'synthetic-cancel-reply');
    await hit;
    cancelling = t.service.cancel(operationIdFor({ botId: BOT, corpId: CORP, memberId: MEMBER, messageId: 'synthetic-cancel-reply' }));
    expect(replySignal?.aborted).toBe(true);
  } finally { release(); await cancelling; await t.service.idle(); }
});

it.each(['no-anchor', 'empty-domain', 'invalid-version', 'account', 'member', 'bot', 'person-domain'] as const)
('IDENTITY: missing corp fails closed for %s', async kind => {
  const t = await boot();
  const rows = await t.world.bindings.listBindings();
  const row = rows.find(b => b.memberId === MEMBER)!;
  if (kind === 'no-anchor') t.world.bindings.listBindings = async () => [];
  else if (kind === 'person-domain') {
    const get = t.world.store.getPersonByMember.bind(t.world.store);
    t.world.store.getPersonByMember = async id => { const p = await get(id); return p ? Object.assign(p, {corpId: 'synthetic-other-domain'}) : p; };
  } else {
    if (kind === 'empty-domain') row.corpId = '';
    if (kind === 'invalid-version') row.version = 0;
    if (kind === 'account') row.accountId = 'synthetic-other-account';
    if (kind === 'member') row.memberId = 'synthetic-other-member';
    if (kind === 'bot') row.botId = 'synthetic-other-bot';
    t.world.bindings.listBindings = async () => rows;
  }
  const frame = t.channels.frame(MEMBER, SHEET, 'synthetic-no-domain-' + kind);
  delete (frame.body.from as {corpid?: string}).corpid;
  t.channels.current().frame(frame); await t.service.idle();
  expect(await t.world.store.listDrafts()).toHaveLength(0);
  expect(t.channels.replies()).toEqual([UNBOUND]);
  const logs = JSON.stringify(t.logs);
  expect(logs).not.toContain(MEMBER); expect(logs).not.toContain('synthetic-');
  expect(t.logs.some(l => typeof l.fields.identityReason === 'string')).toBe(true);
});

it('IDENTITY: body fields cannot replace or change the trusted enterprise', async () => {
  const t = await boot();
  const frame = t.channels.frame(MEMBER, SHEET, 'synthetic-ignore-body');
  delete (frame.body.from as {corpid?: string}).corpid;
  Object.assign(frame.body, {corpid: 'synthetic-forged', accountId: 'synthetic-forged'});
  t.channels.current().frame(frame); await t.service.idle();
  expect(await t.world.store.listDrafts()).toHaveLength(1);
});

it('LIFECYCLE: reconnect invalidates queued messages from the old authenticated epoch', async () => {
  const t = await boot();
  const get = t.world.store.getConfig.bind(t.world.store);
  let release!: () => void, hit!: () => void;
  const held = new Promise<void>(r => {release = r;});
  const reached = new Promise<void>(r => {hit = r;});
  let first = true;
  t.world.store.getConfig = async key => {if (first && key === CONSUMER_LEASE_KEY) {first = false; hit(); await held;} return get(key);};
  try {
    t.channels.send(MEMBER, SHEET, 'synthetic-old-epoch'); await reached;
    t.channels.current().client.emit('reconnecting', 1);
    t.channels.current().authenticate(); release(); await t.service.idle();
    expect(await t.world.store.listDrafts()).toHaveLength(0);
  } finally {release();}
});

it('LIFECYCLE: disconnect callback is fixed at assembly', async () => {
  const sdk = offlineBotSdk(BOT); const first = vi.fn(), replacement = vi.fn();
  const options = {client: sdk.client, botId: BOT, connect: () => sdk.authenticate(), disconnect: first};
  const channel = createWecomLongConnectionChannel(options); options.disconnect = replacement;
  channel.open(() => {}); await channel.close(); await channel.close();
  expect(first).toHaveBeenCalledOnce(); expect(replacement).not.toHaveBeenCalled();
});

it.each(['version', 'account', 'inactive-person'] as const)('BINDING: %s changed before commit cannot settle', async kind => {
  const t = await boot(); await t.say(SHEET, 'synthetic-live-draft');
  const pause = gate(); const uninstall = installPausePoints({'commit-gate:before-commit': pause.hook});
  try {
    t.channels.send(MEMBER, '对', 'synthetic-live-confirm'); await pause.reached;
    const binding = (await t.world.bindings.listBindings()).find(b => b.memberId === MEMBER)!;
    if (kind === 'inactive-person') await t.world.store.savePerson({... (await t.world.store.getPersonByMember(MEMBER))!, active: false});
    else await t.world.bindings.saveBinding({...binding, version: binding.version + 1, ...(kind === 'account' ? {accountId: 'synthetic-replacement'} : {})});
    pause.release(); await t.service.idle();
    expect(await t.world.store.listEntries({storeId: 's-b'})).toHaveLength(2);
  } finally {pause.release(); uninstall();}
});

it('BUDGET: a hung final fence read terminates without a send', async () => {
  const t = await boot(true, 80); const get = t.world.store.getConfig.bind(t.world.store);
  let reads = 0;
  t.world.store.getConfig = async key => { if (key === CONSUMER_LEASE_KEY && ++reads === 2) return new Promise(() => {}); return get(key); };
  await t.say('我的进度', 'synthetic-hung-fence');
  expect(t.channels.replies()).toHaveLength(0);
  expect(await t.service.result(operationIdFor({botId: BOT, corpId: CORP, memberId: MEMBER, messageId: 'synthetic-hung-fence'}))).toMatchObject({state: 'timeout'});
});

it('BUDGET: a hung reply leaves durable unknown and is never retried after restart', async () => {
  const t = await boot(true, 80); const channel = t.channels.current().channel;
  const original = channel.reply.bind(channel); let release!: () => void;
  const held = new Promise<void>(r => {release = r;});
  channel.reply = async (event, text, scope) => {await held; return original(event, text, scope);};
  try {
    await t.say('我的进度', 'synthetic-hung-reply');
    const id = operationIdFor({botId: BOT, corpId: CORP, memberId: MEMBER, messageId: 'synthetic-hung-reply'});
    expect(await t.service.result(id)).toMatchObject({state: 'timeout', replyState: 'unknown'});
    release(); await t.service.close();
    const channels = offlineChannels(); const service = await startFrontClawOpenDotService(fakeHost().host, {open: t.world.open, channel: channels.factory, now: t.clock.now, timers: false});
    closers.push(() => service.close());
    channels.send(MEMBER, '我的进度', 'synthetic-hung-reply'); await service.idle();
    expect(channels.replies()).toHaveLength(0);
    expect(await service.result(id)).toMatchObject({replyState: 'unknown'});
  } finally {release();}
});

it.each(['查询小王的业绩', '查询本店汇总', '查询所有人的业绩', '查询我的业绩和全店排名'])('QUERY: %s is never a personal fast path', text => {
  expect(isSelfProgressQuery(text)).toBe(false);
});

it('LOG: normal and debug logging contain no synthetic input or derived identifiers', async () => {
  vi.stubEnv('WECOM_DEBUG', '1'); const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    const marker = 'synthetic-secret-marker';
    wecomDebug(marker, {id: marker, length: marker.length, suffix: marker.slice(-4)});
    wecomSdkLogger().error(marker, Error(marker));
    expect(maskWecomValue(marker)).toBe('<omitted>');
    const t = await boot(); await t.say(marker, marker);
    const output = JSON.stringify([t.logs, log.mock.calls]);
    expect(output).not.toContain(marker); expect(output).not.toContain('len=');
    expect(output).not.toMatch(/[a-f0-9]{40}/);
  } finally {log.mockRestore(); vi.unstubAllEnvs();}
});

it('HISTORY: a new binding version cannot confirm an old draft; progress remains readable', async () => {
  const t = await boot(); await t.say(SHEET, 'synthetic-old-draft');
  const binding = (await t.world.bindings.listBindings()).find(b => b.memberId === MEMBER)!;
  await t.world.bindings.saveBinding({...binding, version: binding.version + 1});
  await t.say('对', 'synthetic-after-rebind');
  expect(await t.world.store.listEntries({storeId: 's-b'})).toHaveLength(2);
  expect(await t.say('查询我的业绩', 'synthetic-after-rebind-progress')).toContain('900');
  // Current contract also hides historical operation text after a version change. This is a documented boundary.
  expect(await t.say('入账结果', 'synthetic-after-rebind-history')).toContain('没有可查');
});

it('COUNT: two SDK confirmations after both preflights report only their own inserted rows', async () => {
  const t = await boot();
  await t.say(SHEET, 'synthetic-count-employee');
  t.channels.send('m-wang-yj', SHEET, 'synthetic-count-manager'); await t.service.idle();
  const waiting: (() => void)[] = []; let both!: () => void;
  const reached = new Promise<void>(r => {both = r;});
  const uninstall = installPausePoints({'commit-gate:before-commit': async () => {
    await new Promise<void>(resolve => { waiting.push(resolve); if (waiting.length === 2) both(); });
  }});
  try {
    t.channels.send(MEMBER, '对', 'synthetic-count-first');
    t.channels.send('m-wang-yj', '对', 'synthetic-count-second'); await reached;
    waiting[0]!();
    await t.service.idle(operationIdFor({botId: BOT, corpId: CORP, memberId: MEMBER, messageId: 'synthetic-count-first'}));
    waiting[1]!(); await t.service.idle();
    expect(await t.world.store.listEntries({storeId: 's-b'})).toHaveLength(3);
    const replies = t.channels.replies().slice(-2);
    expect(replies[0]).toContain('已入账 1 笔');
    expect(replies[1]).toContain('已入账 0 笔');
  } finally {for (const release of waiting) release(); uninstall();}
});

it('CHAIN: missing-corp SDK shape drafts, confirms once, and queries the same personal ledger', async () => {
  const t = await boot();
  const say = async (text: string, message: string) => {
    const f = t.channels.frame(MEMBER, text, message); delete (f.body.from as {corpid?: string}).corpid;
    t.channels.current().frame(f); await t.service.idle(); return t.channels.replies().at(-1) ?? '';
  };
  expect(await say(SHEET, 'synthetic-public-report')).toContain('还没入账');
  expect(await say('对', 'synthetic-public-confirm')).toContain('已入账 1 笔');
  expect(await say('查询我的业绩', 'synthetic-public-query')).toContain('1460');
  await say('对', 'synthetic-public-confirm');
  expect(await t.world.store.listEntries({storeId: 's-b'})).toHaveLength(3);
});
