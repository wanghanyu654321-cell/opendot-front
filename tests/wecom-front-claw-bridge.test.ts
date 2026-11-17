import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  BRIDGE_AGENT_GUARDRAIL_DENIED_REPLY,
  BRIDGE_INCOMPLETE_PROFILE_REPLY,
  createModelClassifierFromOpenDotConfig,
  createWeComFrontClawBridge,
  resolveOpenDotClassifierConfig,
  SAFE_MARKETING_DISALLOWED_TOOLS,
  validateTargetAgentProfile,
  type WeComInboundTextEvent,
  type WeComPrecheckPort,
} from '../src/wecom-front-claw-bridge.js';
import {
  CLARIFY_REPLY,
  MARKETING_UNAVAILABLE,
} from '../packages/front-claw/src/role-eval/employee-entry.js';
import { ACCESS_DENIED } from '../packages/front-claw/src/role-eval/employee-loop.js';
import {
  CAPABILITIES,
  updateAccessPolicy,
  type AccessPolicy,
} from '../packages/front-claw/src/role-eval/access-policy.js';
import { createPostgresBindingStore } from '../packages/front-claw/src/role-eval/directory-store.js';
import {
  createPostgresPerformanceStore,
  migratePerformance,
} from '../packages/front-claw/src/role-eval/performance-postgres.js';
import type { Person } from '../packages/front-claw/src/role-eval/performance-store.js';
import { UNBOUND } from '../packages/front-claw/src/role-eval/wecom-bot-unified-handler.js';
import { MemorySql } from '../packages/front-claw/tests/role-eval/sql-fixture.js';

const BOT_ID = 'bot-wecom-1';
const CORP_A = 'ww-corp-a';
const CORP_B = 'ww-corp-b';

function cleanPolicy(
  version: number,
  options: {
    wangMarketing?: boolean;
    wangStatus?: 'active' | 'suspended' | 'revoked';
    wangCapabilities?: AccessPolicy['enterprise'];
  } = {},
): AccessPolicy {
  const wangMarketing = options.wangMarketing ?? true;
  const allCaps = [...CAPABILITIES];
  return {
    version,
    enterprise: allCaps,
    stores: {
      's-a': allCaps,
    },
    roles: {
      employee: wangMarketing
        ? ['report_self', 'report_proxy', 'progress_self', 'marketing', 'appointment_submit']
        : ['report_self', 'report_proxy', 'progress_self', 'appointment_submit'],
      manager: allCaps,
      owner: allCaps,
    },
    members: {
      'p-lin': {
        role: 'employee',
        storeIds: ['s-a'],
        status: 'active',
      },
      'p-zhao': {
        role: 'employee',
        storeIds: ['s-a'],
        status: 'active',
      },
      'p-wang': {
        role: 'employee',
        storeIds: ['s-a'],
        status: options.wangStatus ?? 'active',
        capabilities: options.wangCapabilities ?? (wangMarketing ? ['marketing'] : []),
      },
      'p-empty-name': {
        role: 'employee',
        storeIds: ['s-a'],
        status: 'active',
        capabilities: ['marketing'],
      },
      'p-empty-store': {
        role: 'employee',
        storeIds: ['s-a'],
        status: 'active',
        capabilities: ['marketing'],
      },
      'p-dup': {
        role: 'employee',
        storeIds: ['s-a'],
        status: 'active',
        capabilities: ['marketing'],
      },
    },
  };
}

interface FixtureOptions {
  bridgeOptions?: Parameters<typeof createWeComFrontClawBridge>[0];
  people?: Person[];
  initialPolicy?: AccessPolicy;
  now?: () => Date;
  wrapStore?: (store: ReturnType<typeof createPostgresPerformanceStore>) => ReturnType<typeof createPostgresPerformanceStore>;
}

async function createBridgeFixture(opts: FixtureOptions = {}) {
  const sql = new MemorySql();
  await migratePerformance(sql);
  const rawStore = createPostgresPerformanceStore(sql);
  const store = opts.wrapStore ? opts.wrapStore(rawStore) : rawStore;
  const bindings = createPostgresBindingStore(sql);

  const defaultPeople: Person[] = opts.people ?? [
    {
      personId: 'p-lin',
      accountId: 'a-lin',
      memberId: 'm-lin',
      displayName: '小林',
      storeId: 's-a',
      storeName: '测试A店',
      tier: 'employee',
      roles: [],
      active: true,
    },
    {
      personId: 'p-zhao',
      accountId: 'a-zhao',
      memberId: 'm-zhao',
      displayName: '小赵',
      storeId: 's-a',
      storeName: '测试A店',
      tier: 'employee',
      roles: ['marketing'],
      active: true,
    },
    {
      personId: 'p-wang',
      accountId: 'a-wang',
      memberId: 'm-wang',
      displayName: '王姐',
      storeId: 's-a',
      storeName: '测试A店',
      tier: 'employee',
      roles: ['marketing'],
      active: true,
    },
  ];
  for (const person of defaultPeople) {
    await store.savePerson(person);
  }
  await store.setConfig(
    'employee-loop:m01',
    JSON.stringify({
      enabled: true,
      storeId: 's-a',
      memberIds: defaultPeople.map((person) => person.memberId),
    }),
  );
  await bindings.saveBinding({
    botId: BOT_ID,
    corpId: CORP_A,
    memberId: 'm-lin',
    accountId: 'a-lin',
    version: 1,
    active: true,
  });
  await bindings.saveBinding({
    botId: BOT_ID,
    corpId: CORP_A,
    memberId: 'm-zhao',
    accountId: 'a-zhao',
    version: 1,
    active: true,
  });
  await bindings.saveBinding({
    botId: BOT_ID,
    corpId: CORP_A,
    memberId: 'm-wang',
    accountId: 'a-wang',
    version: 1,
    active: true,
  });

  const policy = opts.initialPolicy ?? cleanPolicy(1);
  const policyRes = await updateAccessPolicy(store, {
    expectedVersion: null,
    next: policy,
    actor: 'admin',
    reason: 'init',
    at: '2026-11-12T00:00:00Z',
  });
  expect(policyRes.ok).toBe(true);

  let currentTime = new Date('2026-11-12T02:00:00Z');
  const nowFn = opts.now ?? (() => currentTime);

  const bridge = await createWeComFrontClawBridge({
    now: nowFn,
    env: {
      FRONT_CLAW_MEM0: '0',
      FRONT_CLAW_DATABASE_URL: 'postgres://secret-user:secret-pass@127.0.0.1:5432/front_claw_secret',
    },
    open: async () => ({
      driver: 'memory',
      store,
      bindings,
      close: async () => {},
    }),
    targetProfile: {
      profileId: 'marketing-safe',
      status: 'active',
      executionMode: 'container',
      contextSource: 'managed',
      hostSkillsMode: 'disabled',
      disallowedTools: [...SAFE_MARKETING_DISALLOWED_TOOLS],
    },
    resolveWorkspaceJid: ({ memberId }) => `wecom:c2c:${memberId}#account:default`,
    ...opts.bridgeOptions,
  });

  let seq = 0;
  const send = (
    memberId: string,
    text: string,
    overrides: Partial<WeComInboundTextEvent> = {},
  ) =>
    bridge.precheck({
      reqId: `req-${++seq}`,
      botId: BOT_ID,
      corpId: CORP_A,
      memberId,
      messageId: `msg-${seq}`,
      text,
      createTime: Math.floor(nowFn().getTime() / 1000),
      ...overrides,
    });

  return {
    sql,
    store,
    bindings,
    bridge,
    send,
    setNow(next: Date) {
      currentTime = next;
    },
    currentPolicyVersion: policy.version,
  };
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop()!;
    await fn();
  }
});

describe('WeCom ⇄ Front Claw ⇄ OpenDot 前置三态桥接器', () => {
  it('① 标准行报数返回 handled，且支持缺 corpId 唯一启用绑定识别与确认入账', async () => {
    const fx = await createBridgeFixture();
    cleanups.push(() => fx.bridge.close());

    // Satisfy WeComPrecheckPort type structurally
    const port: WeComPrecheckPort = fx.bridge.precheck;
    expect(typeof port).toBe('function');

    // 省略 corpId，依赖唯一启用可信绑定识别
    const staged = await fx.send('m-lin', '12号测试A店\n380（小林）', {
      corpId: undefined,
    });
    expect(staged.kind).toBe('handled');
    if (staged.kind !== 'handled') throw new Error('expected handled');
    expect(staged.replies.join('\n')).toContain('380');
    expect(await fx.store.listEntries()).toHaveLength(0);

    const confirmed = await fx.send('m-lin', '对', { corpId: undefined });
    expect(confirmed.kind).toBe('handled');
    if (confirmed.kind !== 'handled') throw new Error('expected handled');
    expect(confirmed.replies.join('\n')).toContain('已入账');

    const entries = await fx.store.listEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.amount).toBe(38000);
    expect(entries[0]?.ownerPersonId).toBe('p-lin');
  });

  it('② 有 pending 草稿时发营销请求返回 pass 且保留 pending 草稿，随后发「对」成功入账 1 笔', async () => {
    const fx = await createBridgeFixture();
    cleanups.push(() => fx.bridge.close());

    const staged = await fx.send('m-wang', '12号测试A店\n560（王姐）');
    expect(staged.kind).toBe('handled');
    const draftBefore = await fx.store.getOpenDraft('p-wang');
    expect(draftBefore).not.toBeNull();
    expect(await fx.store.listEntries()).toHaveLength(0);

    const passed = await fx.send(
      'm-wang',
      '帮我写一条周末到店护理的朋友圈文案',
    );
    expect(passed).toEqual({
      kind: 'pass',
      corpId: CORP_A,
      accountId: 'a-wang',
      storeId: 's-a',
      displayName: '王姐',
      workspaceJid: 'wecom:c2c:m-wang#account:default',
    });

    // D175/D179：放行营销时不得清空或破坏原有未过期报单草稿
    const draftAfter = await fx.store.getOpenDraft('p-wang');
    expect(draftAfter?.draftId).toBe(draftBefore?.draftId);
    expect(await fx.store.listEntries()).toHaveLength(0);

    // 确认桥接器输出与句柄绝不泄漏 PG store 或连接串
    expect(JSON.stringify(passed)).not.toContain('postgres://');
    expect('store' in (fx.bridge as unknown as Record<string, unknown>)).toBe(false);

    // 随后发送「对」，原草稿准确入账 1 笔
    const confirmed = await fx.send('m-wang', '对');
    expect(confirmed.kind).toBe('handled');
    if (confirmed.kind !== 'handled') throw new Error('expected handled');
    expect(confirmed.replies.join('\n')).toContain('已入账 1 笔');
    expect(confirmed.replies.join('\n')).toContain('560');

    const entries = await fx.store.listEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.amount).toBe(56000);
  });

  it('②-b 有已过期 pending 草稿时发营销请求：结算过期项并携带 expiredReminder 放行', async () => {
    const fx = await createBridgeFixture();
    cleanups.push(() => fx.bridge.close());

    const staged = await fx.send('m-wang', '12号测试A店\n200（王姐）');
    expect(staged.kind).toBe('handled');
    expect(await fx.store.getOpenDraft('p-wang')).not.toBeNull();

    // 推进时钟使草稿过期（跨过营业日截止时刻）
    fx.setNow(new Date('2026-11-14T00:00:00Z'));

    const passed = await fx.send(
      'm-wang',
      '帮我写一条周末活动的朋友圈文案',
    );
    expect(passed.kind).toBe('pass');
    if (passed.kind !== 'pass') throw new Error('expected pass');
    expect(passed.expiredReminder).toBeTruthy();
    expect(await fx.store.getOpenDraft('p-wang')).toBeNull();
  });

  it('③ 分类超时或模糊报数返回 handled 澄清而非 pass（且不泄露给通用 Agent）', async () => {
    const fx = await createBridgeFixture({
      bridgeOptions: {
        budgetMs: 800,
        modelClassifyTimeoutMs: 60,
        modelClassify: ({ signal }) =>
          new Promise((resolve) => {
            const timer = setTimeout(() => {
              resolve({
                intent: 'marketing',
                object: null,
                action: null,
                slots: {},
                confidence: 0.99,
                uncertain: false,
              });
            }, 500);
            signal.addEventListener(
              'abort',
              () => {
                clearTimeout(timer);
              },
              { once: true },
            );
          }),
      },
    });
    cleanups.push(() => fx.bridge.close());

    // 无挂起项时，分类超时纯粹返回 CLARIFY_REPLY（handled），绝不放行 pass
    const plainTimedOut = await fx.send('m-wang', '帮我处理下刚才那段不太确定的事');
    expect(plainTimedOut.kind).toBe('handled');
    if (plainTimedOut.kind !== 'handled') throw new Error('expected handled');
    expect(plainTimedOut.replies).toEqual([CLARIFY_REPLY]);

    // 先挂起一笔正常草稿，确保超时的模糊消息既不误确认也不漏成 pass，且保留原草稿提醒
    const staged = await fx.send('m-wang', '12号测试A店\n320（王姐）');
    expect(staged.kind).toBe('handled');

    const timedOut = await fx.send('m-wang', '帮我处理下刚才那段不太确定的事');
    expect(timedOut.kind).toBe('handled');
    if (timedOut.kind !== 'handled') throw new Error('expected handled');
    expect(timedOut.replies.join('\n')).toContain(CLARIFY_REPLY);
    expect(timedOut.replies.join('\n')).toContain('还在等你回「对」确认');

    // 模糊报数金额同样走澄清，不放行
    const vagueReport = await fx.send('m-wang', '12号测试A店 几百块（王姐）');
    expect(vagueReport.kind).toBe('handled');
    if (vagueReport.kind !== 'handled') throw new Error('expected handled');
    expect(vagueReport.replies.join('\n')).toContain('没有写入');

    // 原草稿依然完整保留，随后可确认入账
    const confirmed = await fx.send('m-wang', '对');
    expect(confirmed.kind).toBe('handled');
    expect(await fx.store.listEntries()).toHaveLength(1);
  });

  it('④ 未绑定 / corpId 不匹配 / 缺 corpId 多绑定不唯一 / 空 displayName（防 PR-03）一律返回 failed', async () => {
    const fx = await createBridgeFixture({
      people: [
        {
          personId: 'p-wang',
          accountId: 'a-wang',
          memberId: 'm-wang',
          displayName: '王姐',
          storeId: 's-a',
          storeName: '测试A店',
          tier: 'employee',
          roles: ['marketing'],
          active: true,
        },
        {
          personId: 'p-empty-name',
          accountId: 'a-empty-name',
          memberId: 'm-empty-name',
          displayName: '   ',
          storeId: 's-a',
          storeName: '测试A店',
          tier: 'employee',
          roles: ['marketing'],
          active: true,
        },
        {
          personId: 'p-empty-store',
          accountId: 'a-empty-store',
          memberId: 'm-empty-store',
          displayName: '小陈',
          storeId: 's-a',
          storeName: '',
          tier: 'employee',
          roles: ['marketing'],
          active: true,
        },
        {
          personId: 'p-dup',
          accountId: 'a-dup',
          memberId: 'm-dup',
          displayName: '阿敏',
          storeId: 's-a',
          storeName: '测试A店',
          tier: 'employee',
          roles: ['marketing'],
          active: true,
        },
      ],
    });
    cleanups.push(() => fx.bridge.close());

    await fx.bindings.saveBinding({
      botId: BOT_ID,
      corpId: CORP_A,
      memberId: 'm-empty-name',
      accountId: 'a-empty-name',
      version: 1,
      active: true,
    });
    await fx.bindings.saveBinding({
      botId: BOT_ID,
      corpId: CORP_A,
      memberId: 'm-empty-store',
      accountId: 'a-empty-store',
      version: 1,
      active: true,
    });

    // 1. 完全未绑定成员（即便是明确营销话术也绝不放行 pass）
    const unbound = await fx.send(
      'm-stranger',
      '帮我写一条周末活动的朋友圈文案',
    );
    expect(unbound.kind).toBe('failed');
    if (unbound.kind !== 'failed') throw new Error('expected failed');
    expect(unbound.replies[0]).toBe(UNBOUND);

    // 2. corpId 不匹配
    const wrongCorp = await fx.send(
      'm-wang',
      '帮我写一条周末活动的朋友圈文案',
      { corpId: CORP_B },
    );
    expect(wrongCorp.kind).toBe('failed');

    // 3. 空 displayName / 空 storeName（PR-03）
    const emptyName = await fx.send(
      'm-empty-name',
      '帮我写一条周末活动的朋友圈文案',
    );
    expect(emptyName.kind).toBe('failed');
    if (emptyName.kind !== 'failed') throw new Error('expected failed');
    expect(emptyName.replies[0]).toBe(BRIDGE_INCOMPLETE_PROFILE_REPLY);

    const emptyStore = await fx.send(
      'm-empty-store',
      '帮我写一条周末活动的朋友圈文案',
    );
    expect(emptyStore.kind).toBe('failed');

    // 4. 缺失 corpId 且绑定不唯一（模拟双启用绑定），拒绝识别
    const multiBindings = [
      {
        botId: BOT_ID,
        corpId: CORP_A,
        memberId: 'm-dup',
        accountId: 'a-dup',
        version: 1,
        active: true,
      },
      {
        botId: BOT_ID,
        corpId: CORP_B,
        memberId: 'm-dup',
        accountId: 'a-dup',
        version: 2,
        active: true,
      },
    ];
    const origListBindings = fx.bindings.listBindings.bind(fx.bindings);
    fx.bindings.listBindings = async () => [
      ...(await origListBindings()),
      ...multiBindings,
    ];
    const ambiguous = await fx.send(
      'm-dup',
      '帮我写一条周末活动的朋友圈文案',
      { corpId: undefined },
    );
    expect(ambiguous.kind).toBe('failed');
  });

  it('⑤ 撤权后拒绝放行（含新消息与重放原 messageId）', async () => {
    const fx = await createBridgeFixture();
    cleanups.push(() => fx.bridge.close());

    // 撤权前同文可放行
    const ok = await fx.send(
      'm-wang',
      '帮我写一条周末活动的朋友圈文案',
      { messageId: 'mk-replay-1' },
    );
    expect(ok.kind).toBe('pass');

    // 管理员通过 M03 更新策略：收掉 p-wang 的 marketing 能力
    const revoked = await updateAccessPolicy(fx.store, {
      expectedVersion: 1,
      next: cleanPolicy(2, {
        wangCapabilities: ['report_self', 'progress_self'],
      }),
      actor: 'admin',
      reason: 'revoke-marketing',
      at: '2026-11-12T02:05:00Z',
    });
    expect(revoked.ok).toBe(true);

    // 1. 新营销消息必须返回 failed（拒绝放行）
    const deniedNew = await fx.send(
      'm-wang',
      '帮我写一条周末活动的朋友圈文案',
      { messageId: 'mk-after-revoke' },
    );
    expect(deniedNew.kind).toBe('failed');
    if (deniedNew.kind !== 'failed') throw new Error('expected failed');
    expect(deniedNew.replies.join('\n')).toBe(MARKETING_UNAVAILABLE);

    // 2. 重放撤权前的 messageId，同样不能靠去重缓存偷跑 pass
    const deniedReplay = await fx.send(
      'm-wang',
      '帮我写一条周末活动的朋友圈文案',
      { messageId: 'mk-replay-1' },
    );
    expect(deniedReplay.kind).toBe('failed');
    if (deniedReplay.kind !== 'failed') throw new Error('expected failed');
    expect(deniedReplay.replies.join('\n')).toBe(MARKETING_UNAVAILABLE);

    // 3. 进一步挂起成员状态后，连普通店务也被 M03 拦下返回 failed
    const suspended = await updateAccessPolicy(fx.store, {
      expectedVersion: 2,
      next: cleanPolicy(3, { wangStatus: 'suspended' }),
      actor: 'admin',
      reason: 'suspend-member',
      at: '2026-11-12T02:06:00Z',
    });
    expect(suspended.ok).toBe(true);

    const deniedStore = await fx.send('m-wang', '我的进度');
    expect(deniedStore.kind).toBe('failed');
    if (deniedStore.kind !== 'failed') throw new Error('expected failed');
    expect(deniedStore.replies.join('\n')).toBe(ACCESS_DENIED);
  });

  it('D183 收包瞬间同步锁定到达序号 + 同员工队列严格串行 + 结合 OpenDot runtime-config 模型分类', async () => {
    const captureOrder: string[] = [];
    const syncInvokeOrder: number[] = [];
    const executionOrder: string[] = [];
    let captureSeq = 0;

    let releaseFirstClassify!: () => void;
    const firstClassifyGate = new Promise<void>((resolve) => {
      releaseFirstClassify = resolve;
    });

    const openDotCfg = resolveOpenDotClassifierConfig({
      env: { FC_MODEL_MODE: 'live', FC_MODEL_TIMEOUT_MS: '2000' },
    });
    expect(openDotCfg.mode).toBe('live');

    let calls = 0;
    const fx = await createBridgeFixture({
      wrapStore(base) {
        return new Proxy(base, {
          get(target, prop, receiver) {
            if (prop === 'capturePendingArrival') {
              return () => {
                syncInvokeOrder.push(++captureSeq);
                const promise = target.capturePendingArrival();
                void promise.then((res) => {
                  captureOrder.push(res.sequence);
                });
                return promise;
              };
            }
            return Reflect.get(target, prop, receiver);
          },
        });
      },
      bridgeOptions: {
        env: {
          FRONT_CLAW_MEM0: '0',
          FC_MODEL_MODE: 'live',
          FC_MODEL_TIMEOUT_MS: '2000',
        },
        openDotModelComplete: async ({ user }) => {
          calls++;
          executionOrder.push(`classify:${calls}:${user}`);
          if (calls === 1) {
            await firstClassifyGate;
          }
          return JSON.stringify({
            intent: 'marketing',
            object: null,
            action: null,
            slots: {},
            confidence: 0.95,
            uncertain: false,
          });
        },
      },
    });
    cleanups.push(() => fx.bridge.close());

    // 同时发起两个请求：第一个走 OpenDot 模型分类且阻塞；第二个为标准报数清单
    const p1 = fx.send('m-wang', '帮我构思一段优雅的客户到店邀约开场白');
    const p2 = fx.send('m-wang', '12号测试A店\n480（王姐）');

    // 未让出异步等待前，两个 precheck 调用在收包瞬间均已同步触发 capturePendingArrival
    expect(syncInvokeOrder).toEqual([1, 2]);
    await vi.waitFor(() => {
      expect(captureOrder.length).toBeGreaterThanOrEqual(2);
    });
    expect(BigInt(captureOrder[0]!)).toBeLessThan(BigInt(captureOrder[1]!));
    // 第二个请求因同员工串行队列等待，不得在第一个模型调用结束前提前落草稿
    expect(executionOrder).toEqual(['classify:1:帮我构思一段优雅的客户到店邀约开场白']);
    expect(await fx.store.getOpenDraft('p-wang')).toBeNull();

    releaseFirstClassify();
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.kind).toBe('pass');
    expect(r2.kind).toBe('handled');
    expect(await fx.store.getOpenDraft('p-wang')).not.toBeNull();
  });

  it('同进程 Agent 权限护栏：禁止任意 Shell/文件写/host 执行模式/host_claude/PG 环境变量泄漏', async () => {
    expect(
      validateTargetAgentProfile({ allowedTools: ['Bash', 'Read'] }).ok,
    ).toBe(false);
    expect(
      validateTargetAgentProfile({ allowedTools: ['Read', 'Write'] }).ok,
    ).toBe(false);
    expect(
      validateTargetAgentProfile({ executionMode: 'host', allowedTools: ['Read'] }).ok,
    ).toBe(false);
    expect(
      validateTargetAgentProfile({
        contextSource: 'host_claude',
        allowedTools: ['Read'],
      }).ok,
    ).toBe(false);
    expect(
      validateTargetAgentProfile({
        allowedTools: ['Read'],
        injectedEnvKeys: ['FRONT_CLAW_DATABASE_URL'],
      }).ok,
    ).toBe(false);
    expect(
      validateTargetAgentProfile({
        status: 'active',
        executionMode: 'container',
        contextSource: 'managed',
        hostSkillsMode: 'disabled',
        allowedTools: ['Read', 'WebSearch'],
      }).ok,
    ).toBe(true);

    let profileAllowsBash = true;
    const fx = await createBridgeFixture({
      bridgeOptions: {
        resolveTargetProfile: () =>
          profileAllowsBash
            ? {
                profileId: 'unsafe-marketing',
                status: 'active',
                executionMode: 'container',
                contextSource: 'managed',
                allowedTools: ['Bash', 'Read'],
              }
            : {
                profileId: 'safe-marketing',
                status: 'active',
                executionMode: 'container',
                contextSource: 'managed',
                hostSkillsMode: 'disabled',
                allowedTools: ['Read', 'WebSearch'],
              },
      },
    });
    cleanups.push(() => fx.bridge.close());

    const blocked = await fx.send(
      'm-wang',
      '帮我写一条周末活动的朋友圈文案',
    );
    expect(blocked.kind).toBe('failed');
    if (blocked.kind !== 'failed') throw new Error('expected failed');
    expect(blocked.replies[0]).toBe(BRIDGE_AGENT_GUARDRAIL_DENIED_REPLY);

    profileAllowsBash = false;
    const allowed = await fx.send(
      'm-wang',
      '帮我写一条周末活动的朋友圈文案',
    );
    expect(allowed.kind).toBe('pass');
  });

  it('单消费者 PG 租约模式：获租正常处理，释放/失租后拒绝放行与处理', async () => {
    const fx = await createBridgeFixture({
      bridgeOptions: {
        lease: {
          enabled: true,
          owner: 'bridge-instance-1',
          ttlMs: 10_000,
          renewMs: 3_000,
        },
      },
    });
    cleanups.push(() => fx.bridge.close());

    expect(fx.bridge.leaseHeld()).toBe(true);
    const ok = await fx.send('m-wang', '帮我写一条周末活动的朋友圈文案');
    expect(ok.kind).toBe('pass');

    await fx.bridge.close();
    expect(fx.bridge.leaseHeld()).toBe(false);
    const afterClose = await fx.send('m-wang', '帮我写一条周末活动的朋友圈文案');
    expect(afterClose.kind).toBe('failed');
  });

  it('OpenDot runtime-config 模型分类失败/非JSON输出一律兜底为 handled 澄清，绝不泄漏 pass', async () => {
    const cfg = resolveOpenDotClassifierConfig({
      env: {
        FC_MODEL_MODE: 'live',
        ANTHROPIC_BASE_URL: 'https://model.example.test',
        ANTHROPIC_MODEL: 'claude-test-haiku',
        ANTHROPIC_AUTH_TOKEN: 'sk-ant-test-token',
      },
    });
    expect(cfg.mode).toBe('live');
    expect(cfg.model).toBe('claude-test-haiku');
    expect(cfg.authToken).toBe('sk-ant-test-token');

    const originalFetch = globalThis.fetch;
    const fetchSpy = vi.fn(async () =>
      new Response('not-json-garbage', {
        status: 502,
        headers: { 'content-type': 'text/plain' },
      }),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    cleanups.push(async () => {
      globalThis.fetch = originalFetch;
    });

    const classifier = createModelClassifierFromOpenDotConfig(cfg);
    expect(classifier).toBeTypeOf('function');

    const fx = await createBridgeFixture({
      bridgeOptions: {
        modelClassify: classifier,
      },
    });
    cleanups.push(() => fx.bridge.close());

    const outcome = await fx.send('m-wang', '昨天那件事我还没想好怎么处理');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(outcome.kind).toBe('handled');
    if (outcome.kind !== 'handled') throw new Error('expected handled');
    expect(outcome.replies).toEqual([CLARIFY_REPLY]);
  });
});
