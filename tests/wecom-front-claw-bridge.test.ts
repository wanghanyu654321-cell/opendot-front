import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  BRIDGE_AGENT_GUARDRAIL_DENIED_REPLY,
  BRIDGE_INCOMPLETE_PROFILE_REPLY,
  classifyWeComSoftRole,
  createModelClassifierFromOpenDotConfig,
  createWeComFrontClawBridge,
  formatWeComStoreClockPromptBlock,
  resolveOpenDotClassifierConfig,
  SAFE_MARKETING_DISALLOWED_TOOLS,
  validateTargetAgentProfile,
  type WeComInboundTextEvent,
  type WeComOutboundAuthRequest,
  type WeComOutboundAuthResult,
  type WeComPrecheckPort,
  type WeComStoreClockContext,
} from '../src/wecom-front-claw-bridge.js';
import { prependWeComStoreClockToPrompt } from '../src/wecom-front-claw-runtime.js';
import { WECOM_READONLY_CONTEXT_MARKER } from '../src/wecom.js';
import {
  CLARIFY_REPLY,
  MARKETING_UNAVAILABLE,
} from '../packages/front-claw/src/role-eval/employee-entry.js';
import {
  ACCESS_DENIED,
  ALREADY_CONFIRMED_TEXT,
  D175_INTERLEAVED_GUIDANCE,
} from '../packages/front-claw/src/role-eval/employee-loop.js';
import {
  ACCESS_POLICY_HIGH_WATER_KEY,
  ACCESS_POLICY_KEY,
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
        ? [
            'report_self',
            'report_proxy',
            'progress_self',
            'marketing',
            'appointment_submit',
          ]
        : [
            'report_self',
            'report_proxy',
            'progress_self',
            'appointment_submit',
          ],
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
        capabilities:
          options.wangCapabilities ?? (wangMarketing ? ['marketing'] : []),
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
  driver?: 'memory' | 'postgres';
  bridgeOptions?: Parameters<typeof createWeComFrontClawBridge>[0];
  people?: Person[];
  initialPolicy?: AccessPolicy | null;
  autoRoleGrant?: '0' | '1';
  wangTier?: Person['tier'];
  now?: () => Date;
  wrapStore?: (
    store: ReturnType<typeof createPostgresPerformanceStore>,
  ) => ReturnType<typeof createPostgresPerformanceStore>;
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
      tier: opts.wangTier ?? 'employee',
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

  const policy =
    opts.initialPolicy === undefined ? cleanPolicy(1) : opts.initialPolicy;
  if (policy) {
    const policyRes = await updateAccessPolicy(store, {
      expectedVersion: null,
      next: policy,
      actor: 'admin',
      reason: 'init',
      at: '2026-11-12T00:00:00Z',
    });
    expect(policyRes.ok).toBe(true);
  }

  let currentTime = new Date('2026-11-12T02:00:00Z');
  const nowFn = opts.now ?? (() => currentTime);

  const bridge = await createWeComFrontClawBridge({
    now: nowFn,
    env: {
      FRONT_CLAW_MEM0: '0',
      FRONT_CLAW_DATABASE_URL:
        'postgres://secret-user:secret-pass@127.0.0.1:5432/front_claw_secret',
      FRONT_CLAW_WECOM_AUTO_ROLE_GRANT: opts.autoRoleGrant,
    },
    open: async () => ({
      driver: opts.driver ?? 'memory',
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
    resolveWorkspaceJid: ({ memberId }) =>
      `wecom:c2c:${memberId}#account:default`,
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
    currentPolicyVersion: policy?.version,
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

  it('② D175：有 pending 草稿时穿插营销返回 pass 且保留草稿；随后单字「对」拒入账并提示，回复「确认入账」精准入账 1 笔', async () => {
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
      principal: { personId: 'p-wang', tier: 'employee', bindingVersion: 1 },
      corpId: CORP_A,
      accountId: 'a-wang',
      storeId: 's-a',
      displayName: '王姐',
      targetRole: 'marketing',
      workspaceJid: 'wecom:c2c:m-wang#account:default',
    });

    // D175/D179：放行营销时不得清空或破坏原有未过期报单草稿
    const draftAfter = await fx.store.getOpenDraft('p-wang');
    expect(draftAfter?.draftId).toBe(draftBefore?.draftId);
    expect(await fx.store.listEntries()).toHaveLength(0);

    // 确认桥接器输出与句柄绝不泄漏 PG store 或连接串
    expect(JSON.stringify(passed)).not.toContain('postgres://');
    expect('store' in (fx.bridge as unknown as Record<string, unknown>)).toBe(
      false,
    );

    // D175 确认歧义门禁：穿插软对话后发单字「对」严禁入账，保留草稿并给出明确二次提示
    const blockedSingleChar = await fx.send('m-wang', '对');
    expect(blockedSingleChar.kind).toBe('handled');
    if (blockedSingleChar.kind !== 'handled')
      throw new Error('expected handled');
    const guardReply = blockedSingleChar.replies.join('\n');
    expect(guardReply).toContain(D175_INTERLEAVED_GUIDANCE);
    expect(guardReply).toContain('王姐');
    expect(guardReply).toContain('560');
    expect(guardReply).toContain(draftBefore!.draftId);
    expect(guardReply).not.toContain('已入账');
    expect((await fx.store.getOpenDraft('p-wang'))?.draftId).toBe(
      draftBefore?.draftId,
    );
    expect(await fx.store.listEntries()).toHaveLength(0);

    // 明确回复「确认入账」精准入账 1 笔，且只入账 1 次
    const confirmed = await fx.send('m-wang', '确认入账');
    expect(confirmed.kind).toBe('handled');
    if (confirmed.kind !== 'handled') throw new Error('expected handled');
    expect(confirmed.replies.join('\n')).toContain('已入账 1 笔');
    expect(confirmed.replies.join('\n')).toContain('560');

    const entries = await fx.store.listEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.amount).toBe(56000);

    // 再次重复发「对」提示已经入账，不重复写账
    const duplicateConfirm = await fx.send('m-wang', '对');
    expect(duplicateConfirm.kind).toBe('handled');
    if (duplicateConfirm.kind !== 'handled')
      throw new Error('expected handled');
    expect(duplicateConfirm.replies).toEqual([ALREADY_CONFIRMED_TEXT]);
    expect(await fx.store.listEntries()).toHaveLength(1);
  });

  it('②-b 有已过期 pending 草稿时发营销请求：结算过期项并携带 expiredReminder 放行', async () => {
    const fx = await createBridgeFixture();
    cleanups.push(() => fx.bridge.close());

    const staged = await fx.send('m-wang', '12号测试A店\n200（王姐）');
    expect(staged.kind).toBe('handled');
    expect(await fx.store.getOpenDraft('p-wang')).not.toBeNull();

    // 推进时钟使草稿过期（跨过营业日截止时刻）
    fx.setNow(new Date('2026-11-14T00:00:00Z'));

    const passed = await fx.send('m-wang', '帮我写一条周末活动的朋友圈文案');
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
    const plainTimedOut = await fx.send(
      'm-wang',
      '帮我处理下刚才那段不太确定的事',
    );
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
    const ambiguous = await fx.send('m-dup', '帮我写一条周末活动的朋友圈文案', {
      corpId: undefined,
    });
    expect(ambiguous.kind).toBe('failed');
  });

  it('⑤ 撤权后拒绝放行（含新消息与重放原 messageId）', async () => {
    const fx = await createBridgeFixture({ autoRoleGrant: '0' });
    cleanups.push(() => fx.bridge.close());

    // 撤权前同文可放行
    const ok = await fx.send('m-wang', '帮我写一条周末活动的朋友圈文案', {
      messageId: 'mk-replay-1',
    });
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
    expect(executionOrder).toEqual([
      'classify:1:帮我构思一段优雅的客户到店邀约开场白',
    ]);
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
      validateTargetAgentProfile({
        executionMode: 'host',
        allowedTools: ['Read'],
      }).ok,
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

    const blocked = await fx.send('m-wang', '帮我写一条周末活动的朋友圈文案');
    expect(blocked.kind).toBe('failed');
    if (blocked.kind !== 'failed') throw new Error('expected failed');
    expect(blocked.replies[0]).toBe(BRIDGE_AGENT_GUARDRAIL_DENIED_REPLY);

    profileAllowsBash = false;
    const allowed = await fx.send('m-wang', '帮我写一条周末活动的朋友圈文案');
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
    const afterClose = await fx.send(
      'm-wang',
      '帮我写一条周末活动的朋友圈文案',
    );
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
    const fetchSpy = vi.fn(
      async () =>
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

  it('live 分类请求携带足够 max_tokens 与完整枚举约束，并支持自然句报数出草稿（含 fenced JSON）', async () => {
    const cfg = resolveOpenDotClassifierConfig({
      env: {
        FC_MODEL_MODE: 'live',
        ANTHROPIC_BASE_URL: 'https://model.example.test',
        ANTHROPIC_MODEL: 'deepseek-flash',
        ANTHROPIC_AUTH_TOKEN: 'sk-ant-test-token',
      },
    });

    let capturedBody: Record<string, unknown> | undefined;
    const originalFetch = globalThis.fetch;
    const fetchSpy = vi.fn(async (_url: unknown, init?: RequestInit) => {
      capturedBody = JSON.parse(String(init?.body ?? '{}')) as Record<
        string,
        unknown
      >;
      return new Response(
        JSON.stringify({
          content: [
            { type: 'thinking', thinking: 'reasoning...' },
            {
              type: 'text',
              text: '```json\n{"intent":"report","object":"performance","action":"report","slots":{"customer":"张姐","amountText":"六百八十块"},"confidence":0.95,"uncertain":false}\n```',
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    cleanups.push(async () => {
      globalThis.fetch = originalFetch;
    });

    const classifier = createModelClassifierFromOpenDotConfig(cfg);
    const fx = await createBridgeFixture({
      bridgeOptions: {
        modelClassify: classifier,
      },
    });
    cleanups.push(() => fx.bridge.close());

    const outcome = await fx.send(
      'm-wang',
      '张姐刚刚做了一个补水项目六百八十块',
    );
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(Number(capturedBody?.max_tokens)).toBeGreaterThanOrEqual(1024);
    expect(String(capturedBody?.system)).toContain(
      'object="performance", action="report"',
    );
    expect(String(capturedBody?.system)).toContain(
      'amountText, customer, employee, index, period, store',
    );

    expect(outcome.kind).toBe('handled');
    if (outcome.kind !== 'handled') throw new Error('expected handled');
    expect(outcome.replies[0]).toContain('张姐');
    expect(outcome.replies[0]).toContain('680');
    const draft = await fx.store.getOpenDraft('p-wang');
    expect(draft).not.toBeNull();
    expect(await fx.store.listEntries()).toHaveLength(0);
  });

  it('D175 补充：穿插后「全部确认」入账 1 笔、「取消」作废清标记、新报单替代清标记、未穿插直接「确认入账」', async () => {
    const fx = await createBridgeFixture();
    cleanups.push(() => fx.bridge.close());

    // 1. 穿插后回复「全部确认」精准入账 1 笔并清理标记
    await fx.send('m-wang', '12号测试A店\n420（王姐）');
    expect((await fx.send('m-wang', '帮我写一条春日促销文案')).kind).toBe(
      'pass',
    );
    const singleBlocked = await fx.send('m-wang', '对');
    expect(singleBlocked.kind).toBe('handled');
    expect(await fx.store.listEntries()).toHaveLength(0);

    const confirmedAll = await fx.send('m-wang', '全部确认');
    expect(confirmedAll.kind).toBe('handled');
    if (confirmedAll.kind !== 'handled') throw new Error('expected handled');
    expect(confirmedAll.replies.join('\n')).toContain('已入账 1 笔');
    expect(await fx.store.listEntries()).toHaveLength(1);

    // 2. 穿插后回复「取消」作废草稿并清标记
    await fx.send('m-wang', '12号测试A店\n310（王姐）');
    expect((await fx.send('m-wang', '再帮我写一条七夕促销文案')).kind).toBe(
      'pass',
    );
    const cancelled = await fx.send('m-wang', '取消');
    expect(cancelled.kind).toBe('handled');
    if (cancelled.kind !== 'handled') throw new Error('expected handled');
    expect(cancelled.replies.join('\n')).toContain('已取消');
    expect(await fx.store.getOpenDraft('p-wang')).toBeNull();
    expect(await fx.store.listEntries()).toHaveLength(1);

    // 3. 穿插后发新报单替代旧草稿，旧标记失效，新草稿允许直接回「对」入账
    await fx.send('m-wang', '12号测试A店\n250（王姐）');
    expect((await fx.send('m-wang', '帮我写一条客户回访文案')).kind).toBe(
      'pass',
    );
    const replaced = await fx.send('m-wang', '12号测试A店\n720（王姐）');
    expect(replaced.kind).toBe('handled');
    fx.setNow(new Date('2026-11-12T02:00:05Z'));
    const directConfirmAfterReplace = await fx.send('m-wang', '对');
    expect(directConfirmAfterReplace.kind).toBe('handled');
    if (directConfirmAfterReplace.kind !== 'handled') {
      throw new Error('expected handled');
    }
    expect(directConfirmAfterReplace.replies.join('\n')).toContain(
      '已入账 1 笔',
    );
    expect(directConfirmAfterReplace.replies.join('\n')).toContain('720');
    expect(await fx.store.listEntries()).toHaveLength(2);

    // 4. 未穿插时「确认入账」也可直接入账
    await fx.send('m-lin', '12号测试A店\n180（小林）');
    const directExplicit = await fx.send('m-lin', '确认入账');
    expect(directExplicit.kind).toBe('handled');
    if (directExplicit.kind !== 'handled') throw new Error('expected handled');
    expect(directExplicit.replies.join('\n')).toContain('已入账 1 笔');
    expect(await fx.store.listEntries()).toHaveLength(3);
  });

  it('分类模型配置分离：FC_MODEL_CLASSIFIER_MODEL 与 FC_MODEL_CLASSIFIER_MAX_TOKENS 校验与 stub 保守默认', async () => {
    // 默认 FC_MODEL_MODE 必须保持 stub，未显式设为 live 时不创建分类器
    const defaultCfg = resolveOpenDotClassifierConfig({ env: {} });
    expect(defaultCfg.mode).toBe('stub');
    expect(defaultCfg.maxTokens).toBe(1024);
    expect(createModelClassifierFromOpenDotConfig(defaultCfg)).toBeUndefined();

    // FC_MODEL_CLASSIFIER_MODEL 优先覆盖 modelConfig.model 与 ANTHROPIC_MODEL
    const overridden = resolveOpenDotClassifierConfig({
      env: {
        FC_MODEL_MODE: 'live',
        ANTHROPIC_BASE_URL: 'https://model.example.test',
        ANTHROPIC_MODEL: 'claude-sonnet-default',
        ANTHROPIC_AUTH_TOKEN: 'sk-ant-test-token',
        FC_MODEL_CLASSIFIER_MODEL: 'deepseek-classifier-fast',
        FC_MODEL_CLASSIFIER_MAX_TOKENS: '2048',
      },
      modelConfig: { model: 'ignored-model' },
    });
    expect(overridden.model).toBe('deepseek-classifier-fast');
    expect(overridden.maxTokens).toBe(2048);

    // 边界合法值 256 / 4096 生效，非法值一律回退 1024
    expect(
      resolveOpenDotClassifierConfig({
        env: { FC_MODEL_CLASSIFIER_MAX_TOKENS: '256' },
      }).maxTokens,
    ).toBe(256);
    expect(
      resolveOpenDotClassifierConfig({
        env: { FC_MODEL_CLASSIFIER_MAX_TOKENS: '4096' },
      }).maxTokens,
    ).toBe(4096);
    for (const bad of ['', '100', '4097', '-5', '0', '512.5', 'abc']) {
      expect(
        resolveOpenDotClassifierConfig({
          env: { FC_MODEL_CLASSIFIER_MAX_TOKENS: bad },
        }).maxTokens,
      ).toBe(1024);
    }

    // live 请求实际使用覆盖后的 model 与 max_tokens
    let capturedBody: Record<string, unknown> | undefined;
    const originalFetch = globalThis.fetch;
    const fetchSpy = vi.fn(async (_url: unknown, init?: RequestInit) => {
      capturedBody = JSON.parse(String(init?.body ?? '{}')) as Record<
        string,
        unknown
      >;
      return new Response(
        JSON.stringify({
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                intent: 'unknown',
                object: null,
                action: null,
                slots: {},
                confidence: 0,
                uncertain: true,
              }),
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    cleanups.push(async () => {
      globalThis.fetch = originalFetch;
    });

    const classifier = createModelClassifierFromOpenDotConfig(overridden);
    expect(classifier).toBeTypeOf('function');
    await classifier!({
      text: '今天有点不明白的情况',
      signal: new AbortController().signal,
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(capturedBody?.model).toBe('deepseek-classifier-fast');
    expect(capturedBody?.max_tokens).toBe(2048);
  });

  it('省略第二人称自查边界：自然问法命中本人进度，查同事/本店/带金额不误伤', async () => {
    const modelClassify = vi.fn(async () => ({
      intent: 'unknown',
      object: null,
      action: null,
      slots: {},
      confidence: 0,
      uncertain: true,
    }));
    const fx = await createBridgeFixture({
      bridgeOptions: { modelClassify },
    });
    cleanups.push(() => fx.bridge.close());

    // 先入账一笔作为本人进度数据源
    await fx.send('m-lin', '12号测试A店\n380（小林）');
    await fx.send('m-lin', '对');

    for (const phrase of [
      '帮我查看今天做了多少业绩',
      '帮我查今天业绩',
      '帮我看今天进度',
    ]) {
      const res = await fx.send('m-lin', phrase);
      expect(res.kind, phrase).toBe('handled');
      if (res.kind !== 'handled') throw new Error('expected handled');
      expect(res.replies.join('\n'), phrase).toContain('380');
    }
    expect(modelClassify).not.toHaveBeenCalled();

    // 查同事业绩：必须被 M03/R3 拒绝（failed / 不能做）
    const peer = await fx.send('m-wang', '帮我查小林今天业绩');
    expect(peer.kind).toBe('failed');
    if (peer.kind !== 'failed') throw new Error('expected failed');
    expect(peer.replies.join('\n')).toContain('不能做');

    // 查本店汇总：普通员工无权，拒绝并返回 failed，绝不当本人进度
    const storePerf = await fx.send('m-lin', '帮我查本店今天业绩');
    expect(storePerf.kind).toBe('failed');

    // 带客户与金额语句：不误判为本人进度查询
    const withAmount = await fx.send('m-lin', '帮我查张姐 680');
    expect(withAmount.kind).toBe('handled');
    if (withAmount.kind !== 'handled') throw new Error('expected handled');
    expect(withAmount.replies.join('\n')).not.toContain('今天 已做');
    expect(await fx.store.listEntries()).toHaveLength(1);
  });

  it('SAFE_MARKETING_DISALLOWED_TOOLS 收紧列表与 authorizeOutbound() 实时 M03 出站复核（无缓存、不泄密）', async () => {
    expect([...SAFE_MARKETING_DISALLOWED_TOOLS]).toEqual([
      'Bash',
      'Write',
      'Edit',
      'NotebookEdit',
      'Task',
      'TaskOutput',
      'TaskStop',
      'WebFetch',
      'WebSearch',
      'mcp__miniclaw__*',
    ]);

    const fx = await createBridgeFixture({ autoRoleGrant: '0' });
    cleanups.push(() => fx.bridge.close());

    const authCheck: (
      req: WeComOutboundAuthRequest,
    ) => Promise<WeComOutboundAuthResult> = fx.bridge.authorizeOutbound;
    expect(typeof authCheck).toBe('function');

    // 1. 正常放行（默认 capability = 'marketing'）
    const ok1 = await fx.bridge.authorizeOutbound({
      corpId: CORP_A,
      memberId: 'm-wang',
    });
    expect(ok1).toEqual({
      allowed: true,
      policyVersion: 1,
      personId: 'p-wang',
      storeId: 's-a',
    });

    // 2. 跨店不匹配直接拒绝
    const crossStore = await fx.bridge.authorizeOutbound({
      corpId: CORP_A,
      memberId: 'm-wang',
      storeId: 's-b',
      capability: 'marketing',
    });
    expect(crossStore).toEqual({
      allowed: false,
      reason: 'store_out_of_scope',
    });

    // 3. corpId 不匹配直接拒绝
    const wrongCorp = await fx.bridge.authorizeOutbound({
      corpId: CORP_B,
      memberId: 'm-wang',
    });
    expect(wrongCorp).toEqual({
      allowed: false,
      reason: 'corp_mismatch',
    });

    // 4. 实时重读策略：撤权 marketing 后立即拒绝（绝不缓存）
    const revoked = await updateAccessPolicy(fx.store, {
      expectedVersion: 1,
      next: cleanPolicy(2, {
        wangCapabilities: ['report_self', 'progress_self'],
      }),
      actor: 'admin',
      reason: 'revoke-outbound-marketing',
      at: '2026-11-12T02:10:00Z',
    });
    expect(revoked.ok).toBe(true);
    expect(
      await fx.bridge.authorizeOutbound({ corpId: CORP_A, memberId: 'm-wang' }),
    ).toEqual({
      allowed: false,
      reason: 'capability_denied',
    });

    // 5. 高水位回滚（旧策略原文写回）必须拒绝
    await fx.store.updateConfigLocked(ACCESS_POLICY_KEY, [], () => ({
      [ACCESS_POLICY_KEY]: JSON.stringify(cleanPolicy(1)),
    }));
    expect(await fx.store.getConfig(ACCESS_POLICY_HIGH_WATER_KEY)).toBe('2');
    expect(
      await fx.bridge.authorizeOutbound({ corpId: CORP_A, memberId: 'm-wang' }),
    ).toEqual({
      allowed: false,
      reason: 'stale_policy',
    });

    // 6. 策略损坏（无效 JSON）必须拒绝
    await fx.store.updateConfigLocked(ACCESS_POLICY_KEY, [], () => ({
      [ACCESS_POLICY_KEY]: '{broken-json',
    }));
    expect(
      await fx.bridge.authorizeOutbound({ corpId: CORP_A, memberId: 'm-wang' }),
    ).toEqual({
      allowed: false,
      reason: 'broken_policy',
    });

    // 恢复高版本有效策略，继续测绑定失效与人员停用
    const restored = await updateAccessPolicy(fx.store, {
      expectedVersion: null,
      next: cleanPolicy(3),
      actor: 'admin',
      reason: 'restore-for-binding-test',
      at: '2026-11-12T02:11:00Z',
    });
    expect(restored.ok).toBe(true);
    expect(
      await fx.bridge.authorizeOutbound({ corpId: CORP_A, memberId: 'm-wang' }),
    ).toEqual({
      allowed: true,
      policyVersion: 3,
      personId: 'p-wang',
      storeId: 's-a',
    });

    // 7. 成员停用拒绝
    const origWang = (await fx.store.getPersonByMember('m-wang'))!;
    await fx.store.savePerson({ ...origWang, active: false });
    expect(
      await fx.bridge.authorizeOutbound({ corpId: CORP_A, memberId: 'm-wang' }),
    ).toEqual({
      allowed: false,
      reason: 'person_inactive',
    });
    await fx.store.savePerson(origWang);

    // 8. 绑定失效拒绝
    await fx.bindings.saveBinding({
      botId: BOT_ID,
      corpId: CORP_A,
      memberId: 'm-wang',
      accountId: 'a-wang',
      version: 2,
      active: false,
    });
    expect(
      await fx.bridge.authorizeOutbound({ corpId: CORP_A, memberId: 'm-wang' }),
    ).toEqual({
      allowed: false,
      reason: 'binding_inactive',
    });
    await fx.bindings.saveBinding({
      botId: BOT_ID,
      corpId: CORP_A,
      memberId: 'm-wang',
      accountId: 'a-wang',
      version: 3,
      active: true,
    });

    // 9. 存储抛出含连接串异常时，安全返回 denied 且不泄露 PG 连接串或 store
    const origGetConfig = fx.store.getConfig.bind(fx.store);
    fx.store.getConfig = async () => {
      throw new Error(
        'pg failure postgres://secret-user:secret-pass@127.0.0.1:5432/front_claw_secret',
      );
    };
    const errResult = await fx.bridge.authorizeOutbound({
      corpId: CORP_A,
      memberId: 'm-wang',
    });
    fx.store.getConfig = origGetConfig;
    expect(errResult.allowed).toBe(false);
    expect(JSON.stringify(errResult)).not.toContain('postgres://');
    expect(JSON.stringify(errResult)).not.toContain('secret-pass');
    expect('store' in (fx.bridge as unknown as Record<string, unknown>)).toBe(
      false,
    );
  });
});

describe('Issue #11 企微按档位授权与软岗位路由', () => {
  const marketingQuery = '帮我写一条朋友圈文案';
  const reviewQuery = '请给我一些门店经营复盘建议';
  const reviewDenied = {
    kind: 'failed',
    replies: [
      'Front Claw：店长经营复盘仅对本店店长或老板开放，你当前没有这项权限。没有读取或写入任何账目。',
    ],
  };
  const modelClassify = async () => ({
    intent: 'marketing',
    object: null,
    action: null,
    slots: {},
    confidence: 0.99,
    uncertain: false,
  });

  it('注入的 PG 存储缺少可锁定身份的事务时，仅按已有策略鉴权', async () => {
    const fx = await createBridgeFixture({ driver: 'postgres' });
    cleanups.push(() => fx.bridge.close());
    expect((await fx.send('m-lin', marketingQuery)).kind).toBe('failed');
    expect(
      await fx.bridge.authorizeOutbound({ corpId: CORP_A, memberId: 'm-wang' }),
    ).toMatchObject({ allowed: true, policyVersion: 1 });
    expect(await fx.store.getPersonByMember('m-lin')).toMatchObject({
      roles: [],
    });
    expect(await fx.store.getConfig(ACCESS_POLICY_HIGH_WATER_KEY)).toBe('1');
  });

  it('默认开通遇到暂时写入故障时，已授权的本人进度仍由店务处理', async () => {
    const fx = await createBridgeFixture();
    cleanups.push(() => fx.bridge.close());
    vi.spyOn(fx.store, 'updateConfigLocked').mockRejectedValueOnce(
      new Error('grant-lock-unavailable'),
    );
    expect(await fx.send('m-lin', '我的进度')).toMatchObject({
      kind: 'handled',
      replies: [expect.stringContaining('已做')],
    });
    expect(await fx.store.getConfig(ACCESS_POLICY_HIGH_WATER_KEY)).toBe('1');
  });

  it.each([
    [
      'employee',
      ['report_self', 'progress_self', 'correct_own', 'appointment_submit'],
    ],
    [
      'manager',
      [
        'report_self',
        'report_proxy',
        'progress_self',
        'progress_other',
        'store_summary',
        'unreported',
        'target_set',
        'correct_own',
        'correct_store',
        'appointment_submit',
        'appointment_receive',
      ],
    ],
  ] as const)(
    '默认补齐 %s 四层策略和员工角色，仅推进一次版本',
    async (tier, regular) => {
      const policy = cleanPolicy(1);
      policy.enterprise = ['report_self'];
      policy.stores['s-a'] = ['report_self'];
      policy.roles[tier] = ['report_self'];
      policy.members['p-wang'] = {
        role: tier,
        storeIds: ['s-a'],
        status: 'active',
      };
      const fx = await createBridgeFixture({
        initialPolicy: policy,
        wangTier: tier,
      });
      cleanups.push(() => fx.bridge.close());
      const person = (await fx.store.getPersonByMember('m-wang'))!;
      await fx.store.savePerson({ ...person, roles: [] });
      const outbound = {
        corpId: CORP_A,
        memberId: 'm-wang',
        capability: 'training',
      } as const;

      const inboundResult = await fx.send('m-wang', marketingQuery);
      const outboundResult = await fx.bridge.authorizeOutbound(outbound);
      expect(inboundResult).toMatchObject({
        kind: 'pass',
        targetRole: 'marketing',
      });
      expect(outboundResult).toMatchObject({ allowed: true, policyVersion: 2 });
      expect((await fx.store.getPersonByMember('m-wang'))?.roles).toEqual([
        'marketing',
      ]);
      const saved = JSON.parse(
        (await fx.store.getConfig(ACCESS_POLICY_KEY))!,
      ) as AccessPolicy;
      for (const layer of [
        saved.enterprise,
        saved.stores['s-a'],
        saved.roles[tier],
        saved.members['p-wang'].capabilities,
      ]) {
        expect(layer).toEqual(
          expect.arrayContaining(['marketing', ...regular]),
        );
      }
      expect(await fx.store.getConfig(ACCESS_POLICY_HIGH_WATER_KEY)).toBe('2');
      expect(await fx.send('m-wang', marketingQuery)).toMatchObject({
        kind: 'pass',
      });
      expect(await fx.store.getConfig(ACCESS_POLICY_KEY)).toBe(
        JSON.stringify(saved),
      );
    },
  );

  it('仅出站也为合法 owner 补齐营销授权，并保留既有本店能力', async () => {
    const policy = cleanPolicy(1);
    policy.roles.owner = ['store_summary'];
    policy.members['p-wang'] = {
      role: 'owner',
      storeIds: ['s-a'],
      status: 'active',
    };
    const fx = await createBridgeFixture({
      initialPolicy: policy,
      wangTier: 'owner',
      autoRoleGrant: '1',
    });
    cleanups.push(() => fx.bridge.close());
    const person = (await fx.store.getPersonByMember('m-wang'))!;
    await fx.store.savePerson({ ...person, roles: [] });
    const request = {
      corpId: CORP_A,
      memberId: 'm-wang',
      targetRole: 'manager_ops',
    } as const;
    expect(await fx.bridge.authorizeOutbound(request)).toMatchObject({
      allowed: true,
      policyVersion: 2,
    });
    expect((await fx.store.getPersonByMember('m-wang'))?.roles).toEqual([
      'marketing',
    ]);
    expect(
      await fx.bridge.authorizeOutbound({ ...request, storeId: 's-b' }),
    ).toMatchObject({
      allowed: false,
      reason: 'store_out_of_scope',
    });
  });

  it.each([
    { label: 'revoked', status: 'revoked', caps: ['report_self'] },
    { label: 'suspended', status: 'suspended', caps: ['report_self'] },
    { label: '空能力列表', status: 'active', caps: [] },
    {
      label: '关闭自动开通',
      status: 'active',
      caps: ['report_self'],
      enabled: '0',
    },
  ] as const)('$label 时不恢复员工角色或策略', async (testCase) => {
    const fx = await createBridgeFixture({
      autoRoleGrant: 'enabled' in testCase ? testCase.enabled : undefined,
      initialPolicy: cleanPolicy(1, {
        wangStatus: testCase.status,
        wangCapabilities: [...testCase.caps],
      }),
    });
    cleanups.push(() => fx.bridge.close());
    const person = (await fx.store.getPersonByMember('m-wang'))!;
    await fx.store.savePerson({ ...person, roles: [] });
    const before = await fx.store.getConfig(ACCESS_POLICY_KEY);

    expect(await fx.send('m-wang', marketingQuery)).toMatchObject({
      kind: 'failed',
    });
    expect(
      await fx.bridge.authorizeOutbound({ corpId: CORP_A, memberId: 'm-wang' }),
    ).toMatchObject({ allowed: false });
    expect(await fx.store.getPersonByMember('m-wang')).toMatchObject({
      roles: [],
    });
    expect(await fx.store.getConfig(ACCESS_POLICY_KEY)).toBe(before);
    expect(await fx.store.getConfig(ACCESS_POLICY_HIGH_WATER_KEY)).toBe('1');
  });

  it.each([
    [null, null],
    ['{bad-json', '2'],
    [JSON.stringify(cleanPolicy(1)), '2'],
    [JSON.stringify(cleanPolicy(1)), 'invalid'],
  ])('策略或高水位无效时拒绝且保留原数据 %#', async (raw, highWater) => {
    const fx = await createBridgeFixture({ initialPolicy: null });
    cleanups.push(() => fx.bridge.close());
    if (raw !== null)
      await fx.store.insertConfigIfAbsent(ACCESS_POLICY_KEY, raw);
    if (highWater !== null) {
      await fx.store.insertConfigIfAbsent(
        ACCESS_POLICY_HIGH_WATER_KEY,
        highWater,
      );
    }

    expect(await fx.send('m-lin', marketingQuery)).toMatchObject({
      kind: 'failed',
    });
    expect(
      await fx.bridge.authorizeOutbound({ corpId: CORP_A, memberId: 'm-lin' }),
    ).toMatchObject({ allowed: false });
    expect(await fx.store.getPersonByMember('m-lin')).toMatchObject({
      roles: [],
    });
    expect(await fx.store.getConfig(ACCESS_POLICY_KEY)).toBe(raw);
    expect(await fx.store.getConfig(ACCESS_POLICY_HIGH_WATER_KEY)).toBe(
      highWater,
    );
  });

  it('策略提交前管理员并发撤权时，保留撤销版本与原员工角色', async () => {
    const policy = cleanPolicy(1);
    policy.members['p-lin'].capabilities = ['report_self'];
    const fx = await createBridgeFixture({ initialPolicy: policy });
    cleanups.push(() => fx.bridge.close());
    const update = fx.store.updateConfigLocked.bind(fx.store);
    const revoked = cleanPolicy(2);
    revoked.members['p-lin'].status = 'revoked';
    vi.spyOn(fx.store, 'updateConfigLocked').mockImplementationOnce(
      async (key, extraKeys, mutate) => {
        const result = await updateAccessPolicy(fx.store, {
          expectedVersion: 1,
          next: revoked,
          actor: 'admin',
          reason: 'concurrent-revoke',
          at: '2026-11-12T02:00:00Z',
        });
        expect(result.ok).toBe(true);
        return update(key, extraKeys, mutate);
      },
    );

    expect(
      await fx.bridge.authorizeOutbound({ corpId: CORP_A, memberId: 'm-lin' }),
    ).toEqual({ allowed: false, reason: 'inactive' });
    expect(await fx.store.getConfig(ACCESS_POLICY_KEY)).toBe(
      JSON.stringify(revoked),
    );
    expect(await fx.store.getPersonByMember('m-lin')).toMatchObject({
      roles: [],
    });
  });

  it('区分培训、店长复盘、接待投流及默认营销', () => {
    expect(classifyWeComSoftRole('家访五步法怎么带教')).toBe('training');
    expect(classifyWeComSoftRole('请给我日报建议和经营诊断')).toBe(
      'manager_ops',
    );
    expect(classifyWeComSoftRole('怎么处理客诉和嫌贵')).toBe('reception_ads');
    expect(classifyWeComSoftRole('分析美团投流 roi')).toBe('reception_ads');
    expect(classifyWeComSoftRole(marketingQuery)).toBe('marketing');
  });

  it('Issue #18: 软岗位按主意图分级路由，美团投流复盘不误判店长经营，且带教/店长显式词仍优先', async () => {
    // NR-V-E25a 原句/常见变体：主意图是美团投流复盘 -> reception_ads
    expect(classifyWeComSoftRole('帮我做美团投流复盘和团单优化建议')).toBe(
      'reception_ads',
    );
    expect(classifyWeComSoftRole('美团投流怎么复盘')).toBe('reception_ads');
    // 显式店长经营语境即使带“美团”仍归 manager_ops
    expect(classifyWeComSoftRole('店长复盘中提到美团活动怎么看')).toBe(
      'manager_ops',
    );
    // 培训带教优先于投流与复盘
    expect(classifyWeComSoftRole('培训新人如何做美团投流复盘')).toBe(
      'training',
    );
    // 裸“复盘”保持 manager_ops 兼容
    expect(classifyWeComSoftRole('帮我复盘一下')).toBe('manager_ops');

    // 端到端验证：普通员工发美团投流复盘放行 reception_ads；发显式店长复盘仍被拒
    const fx = await createBridgeFixture({
      bridgeOptions: { modelClassify },
    });
    cleanups.push(() => fx.bridge.close());
    expect(
      await fx.send('m-wang', '帮我做美团投流复盘和团单优化建议'),
    ).toMatchObject({
      kind: 'pass',
      targetRole: 'reception_ads',
    });
    expect(
      await fx.send('m-wang', '店长复盘中提到美团活动怎么看'),
    ).toMatchObject({
      kind: 'failed',
    });
  });

  it('Issue #18: 店长只读快照注入门店当地时间（Asia/Shanghai）且 onPrecheckAudit 覆盖 handled/failed/pass', async () => {
    const audits: Array<{
      messageId: string;
      storeId?: string;
      tier?: string;
      targetRole?: string;
    }> = [];
    const policy = cleanPolicy(1);
    policy.members['p-wang'].role = 'manager';
    const fx = await createBridgeFixture({
      initialPolicy: policy,
      wangTier: 'manager',
      now: () => new Date('2026-11-12T02:00:00.000Z'), // 10:00 Asia/Shanghai
      bridgeOptions: {
        modelClassify,
        onPrecheckAudit: (record) => audits.push(record),
      },
    });
    cleanups.push(() => fx.bridge.close());

    // 1. pass (manager_ops) -> snapshot 应含门店当地时间 10:00 (+08:00, Asia/Shanghai) 与 业务日
    const passRes = await fx.send('m-wang', reviewQuery);
    expect(passRes).toMatchObject({ kind: 'pass', targetRole: 'manager_ops' });
    if (passRes.kind !== 'pass') throw new Error('expected pass');
    expect(passRes.readonlyContext).toContain(
      '当前当地时间：2026-11-12 10:00 (+08:00, Asia/Shanghai)',
    );
    expect(passRes.readonlyContext).toContain('业务日：2026-11-12');

    // 2. handled (快通道只读查询) -> 旁路回调应收到可信 tier & storeId
    const handledRes = await fx.send('m-wang', '我的进度');
    expect(handledRes).toMatchObject({ kind: 'handled' });

    // 3. failed (普通员工越权店长复盘) -> 旁路回调同样收到可信 tier & storeId，且不污染 outcome 结构
    const empAudits: typeof audits = [];
    const empFx = await createBridgeFixture({
      bridgeOptions: {
        modelClassify,
        onPrecheckAudit: (record) => empAudits.push(record),
      },
    });
    cleanups.push(() => empFx.bridge.close());
    const deniedRes = await empFx.send('m-wang', reviewQuery);
    expect(deniedRes).toEqual(reviewDenied);

    expect(
      audits.some(
        (a) =>
          a.tier === 'manager' &&
          a.storeId === 's-a' &&
          a.targetRole === 'manager_ops',
      ),
    ).toBe(true);
    expect(
      audits.filter((a) => a.tier === 'manager' && a.storeId === 's-a').length,
    ).toBeGreaterThanOrEqual(2);
    expect(
      empAudits.some(
        (a) =>
          a.tier === 'employee' &&
          a.storeId === 's-a' &&
          a.targetRole === 'manager_ops',
      ),
    ).toBe(true);
  });

  it('Issue #20 (Q28): 四个企微软岗统一获得门店当地时钟与独立业务日，且不污染 marketing/reception_ads 只读块契约', async () => {
    const audits: Array<{
      messageId: string;
      storeId?: string;
      tier?: string;
      targetRole?: string;
      workspaceJid?: string;
      storeClock?: WeComStoreClockContext;
    }> = [];
    const policy = cleanPolicy(1);
    policy.members['p-wang'].role = 'manager';
    // 2026-11-25T16:03:00.000Z = 2026-11-26 00:03 (+08:00, Asia/Shanghai)，与 UTC 日期跨天
    const midnightUtc = new Date('2026-11-25T16:03:00.000Z');
    const fx = await createBridgeFixture({
      initialPolicy: policy,
      wangTier: 'manager',
      now: () => midnightUtc,
      bridgeOptions: {
        modelClassify,
        resolveWorkspaceJid: (ctx) =>
          `web:wecom-front-claw:${ctx.targetRole ?? 'marketing'}:test`,
        onPrecheckAudit: (record) => audits.push(record),
      },
    });
    cleanups.push(() => fx.bridge.close());

    const cases = [
      {
        role: 'marketing' as const,
        text: '给我排一个明天早晚小红书文案发布时间表',
        expectReadonlyContext: false,
      },
      {
        role: 'reception_ads' as const,
        text: '美团团购投流效果不好，给我一个明天的投放复盘排期',
        expectReadonlyContext: false,
      },
      {
        role: 'training' as const,
        text: '帮我安排家访五步法带教新人的明天早会练习节奏',
        expectReadonlyContext: false,
      },
      {
        role: 'manager_ops' as const,
        text: reviewQuery,
        expectReadonlyContext: true,
      },
    ];

    for (const item of cases) {
      const res = await fx.send('m-wang', item.text);
      expect(res, item.role).toMatchObject({
        kind: 'pass',
        targetRole: item.role,
      });
      if (item.expectReadonlyContext) {
        expect(res, item.role).toHaveProperty('readonlyContext');
      } else {
        expect(res, item.role).not.toHaveProperty('readonlyContext');
      }
      const matched = audits.find(
        (a) => a.targetRole === item.role && a.storeClock !== undefined,
      );
      expect(matched?.workspaceJid, item.role).toBe(
        `web:wecom-front-claw:${item.role}:test`,
      );
      expect(matched?.storeClock, item.role).toEqual({
        localDate: '2026-11-26',
        localTime: '00:03',
        utcOffset: '+08:00',
        timeZone: 'Asia/Shanghai',
        businessDay: '2026-11-26',
        localDateTimeLabel: '2026-11-26 00:03 (+08:00, Asia/Shanghai)',
      });
    }

    // 校验 23:30 营业日切换边界：自然日历 2026-11-25 与业务日 2026-11-26 清晰分离
    const cutoffPrompt = prependWeComStoreClockToPrompt(
      '<messages><message time="2026-11-25T15:30:00.000Z">明天排期</message></messages>',
      undefined,
      new Date('2026-11-25T15:30:00.000Z'),
    );
    expect(cutoffPrompt).toContain(
      '门店当前当地日期与时间：2026-11-25 23:30 (+08:00, Asia/Shanghai)',
    );
    expect(cutoffPrompt).toContain('门店当前业务日：2026-11-26');
    expect(cutoffPrompt).toContain('不得早于当前当地时间');
    expect(cutoffPrompt).not.toContain(WECOM_READONLY_CONTEXT_MARKER);
    // 幂等保护：重复包装不双写
    expect(
      prependWeComStoreClockToPrompt(
        cutoffPrompt,
        undefined,
        new Date('2026-11-25T15:30:00.000Z'),
      ),
    ).toBe(cutoffPrompt);

    // 显式时钟块格式也保持无账本/无只读上下文标记
    const midnightBlock = formatWeComStoreClockPromptBlock(
      audits.find((a) => a.targetRole === 'marketing' && a.storeClock)!
        .storeClock!,
    );
    expect(midnightBlock).toContain('2026-11-26 00:03 (+08:00, Asia/Shanghai)');
    expect(midnightBlock).not.toContain(WECOM_READONLY_CONTEXT_MARKER);

    // 员工在午夜依然无权访问 manager_ops 经营复盘
    const empFx = await createBridgeFixture({
      now: () => midnightUtc,
      bridgeOptions: { modelClassify },
    });
    cleanups.push(() => empFx.bridge.close());
    expect(await empFx.send('m-wang', reviewQuery)).toEqual(reviewDenied);
  });

  it('把软岗位传给两个解析器，且仅培训传入培训只读块', async () => {
    const workspace = 'wecom:training-workspace';
    const resolveWorkspaceJid = vi.fn(() => workspace);
    const resolveTargetProfile = vi.fn(() => ({
      status: 'active',
      executionMode: 'container',
      contextSource: 'managed',
      hostSkillsMode: 'disabled',
      disallowedTools: [...SAFE_MARKETING_DISALLOWED_TOOLS],
    }));
    const resolveTrainingContext = vi.fn(
      async () => '【培训参考】先明确本次家访的学习目标。',
    );
    const fx = await createBridgeFixture({
      bridgeOptions: {
        modelClassify,
        resolveWorkspaceJid,
        resolveTargetProfile,
        resolveTrainingContext,
      },
    });
    cleanups.push(() => fx.bridge.close());
    const query = '新人怎么用家访五步法？';

    expect(await fx.send('m-wang', query)).toMatchObject({
      kind: 'pass',
      targetRole: 'training',
      workspaceJid: workspace,
      readonlyContext: '【培训参考】先明确本次家访的学习目标。',
    });
    expect(resolveWorkspaceJid).toHaveBeenLastCalledWith(
      expect.objectContaining({
        targetRole: 'training',
      }),
    );
    expect(resolveTargetProfile).toHaveBeenLastCalledWith(
      expect.objectContaining({
        targetRole: 'training',
        workspaceJid: workspace,
      }),
    );
    expect(resolveTrainingContext).toHaveBeenCalledWith({
      query,
      corpId: CORP_A,
      accountId: 'a-wang',
      storeId: 's-a',
      workspaceJid: workspace,
    });
    for (const [text, role] of [
      [marketingQuery, 'marketing'],
      ['怎么回复客户的嫌贵异议？', 'reception_ads'],
    ]) {
      const reply = await fx.send('m-wang', text);
      expect(reply).toMatchObject({ kind: 'pass', targetRole: role });
      expect(reply).not.toHaveProperty('readonlyContext');
    }
    expect(resolveTrainingContext).toHaveBeenCalledTimes(1);
  });

  it.each(['manager', 'owner'] as const)(
    '给 %s 的复盘只返回本店已确认业绩汇总',
    async (tier) => {
      const policy = cleanPolicy(1);
      policy.members['p-wang'].role = tier;
      const fx = await createBridgeFixture({
        initialPolicy: policy,
        wangTier: tier,
        bridgeOptions: { modelClassify },
      });
      cleanups.push(() => fx.bridge.close());
      const otherStore = {
        ...(await fx.store.getPersonByMember('m-wang'))!,
        personId: 'p-other',
        accountId: 'a-other',
        memberId: 'm-other',
        storeId: 's-b',
      };
      await fx.store.savePerson(otherStore);
      await fx.store.insertEntries(
        [
          {
            storeId: 's-a',
            businessDay: '2026-11-12',
            amount: 12345,
            status: 'confirmed',
          },
          {
            storeId: 's-a',
            businessDay: '2026-11-03',
            amount: 1055,
            status: 'confirmed',
          },
          {
            storeId: 's-a',
            businessDay: '2026-11-13',
            amount: 95000,
            status: 'confirmed',
          },
          {
            storeId: 's-a',
            businessDay: '2026-10-31',
            amount: 90000,
            status: 'confirmed',
          },
          {
            storeId: 's-a',
            businessDay: '2026-11-12',
            amount: 80000,
            status: 'pending',
          },
          {
            storeId: 's-a',
            businessDay: '2026-11-12',
            amount: 70000,
            status: 'voided',
          },
          {
            storeId: 's-b',
            businessDay: '2026-11-12',
            amount: 60000,
            status: 'confirmed',
          },
        ].map((row, index) => ({
          ...row,
          status: row.status as 'confirmed' | 'pending' | 'voided',
          entryId: `internal-entry-${index}`,
          amountType: 'consultant',
          customerName: '客户秘密',
          ownerPersonId: row.storeId === 's-a' ? 'p-wang' : 'p-other',
          ownerName: '个人业绩人名',
          reporterPersonId: row.storeId === 's-a' ? 'p-wang' : 'p-other',
          note: 'postgres://secret-user:secret-pass@localhost/db',
          disputed: false,
          createdAt: '2026-11-12T02:00:00Z',
        })),
      );
      const listEntries = vi.spyOn(fx.store, 'listEntries');

      const result = await fx.send('m-wang', reviewQuery);
      expect(result).toMatchObject({ kind: 'pass', targetRole: 'manager_ops' });
      if (result.kind !== 'pass') throw new Error('expected pass');
      expect(result.readonlyContext).toContain('业务日：2026-11-12');
      expect(result.readonlyContext).toContain(
        '今日已确认业绩：123.45元（1笔）',
      );
      expect(result.readonlyContext).toContain(
        '本月累计已确认业绩：134元（2笔）',
      );
      expect(result.readonlyContext).not.toMatch(
        /postgres:\/\/|secret-pass|p-wang|s-a|internal-entry|客户秘密|个人业绩人名/,
      );
      expect(listEntries).toHaveBeenCalledExactlyOnceWith({ storeId: 's-a' });
    },
  );

  it.each(['employee', 'manager'] as const)(
    '拒绝 %s 无本店复盘权限的入站与出站，且不查账',
    async (tier) => {
      const policy = cleanPolicy(1);
      policy.members['p-wang'].role = tier;
      policy.members['p-wang'].capabilities = ['marketing', 'report_self'];
      const fx = await createBridgeFixture({
        initialPolicy: policy,
        wangTier: tier,
        autoRoleGrant: tier === 'manager' ? '0' : undefined,
        bridgeOptions: { modelClassify },
      });
      cleanups.push(() => fx.bridge.close());
      const listEntries = vi.spyOn(fx.store, 'listEntries');

      expect(await fx.send('m-wang', reviewQuery)).toEqual(reviewDenied);
      expect(
        await fx.bridge.authorizeOutbound({
          corpId: CORP_A,
          memberId: 'm-wang',
          capability: 'manager_ops',
        }),
      ).toMatchObject({ allowed: false });
      expect(listEntries).not.toHaveBeenCalled();
    },
  );

  it('在汇总读取期间撤掉店长权限时，不放行已读取的上下文', async () => {
    const policy = cleanPolicy(1);
    policy.members['p-wang'].role = 'manager';
    const fx = await createBridgeFixture({
      initialPolicy: policy,
      wangTier: 'manager',
      autoRoleGrant: '0',
      bridgeOptions: { modelClassify },
    });
    cleanups.push(() => fx.bridge.close());
    vi.spyOn(fx.store, 'listEntries').mockImplementationOnce(async () => {
      const revoked = { ...policy, version: 2 };
      revoked.members['p-wang'].capabilities = ['marketing', 'report_self'];
      expect(
        (
          await updateAccessPolicy(fx.store, {
            expectedVersion: 1,
            next: revoked,
            actor: 'admin',
            reason: 'revoke-summary',
            at: '2026-11-12T02:00:00Z',
          })
        ).ok,
      ).toBe(true);
      return [];
    });

    expect(await fx.send('m-wang', reviewQuery)).toMatchObject({
      kind: 'failed',
    });
    expect(
      await fx.bridge.authorizeOutbound({
        corpId: CORP_A,
        memberId: 'm-wang',
        targetRole: 'manager_ops',
      }),
    ).toMatchObject({ allowed: false, reason: 'capability_denied' });
  });

  it('目标岗位解析期间撤回营销能力时不读取经营汇总', async () => {
    const policy = cleanPolicy(1);
    policy.members['p-wang'].role = 'manager';
    const fx = await createBridgeFixture({
      initialPolicy: policy,
      wangTier: 'manager',
      autoRoleGrant: '0',
      bridgeOptions: {
        modelClassify,
        resolveTargetProfile: async () => {
          const next = { ...policy, version: 2 };
          next.members['p-wang'].capabilities = ['store_summary'];
          expect(
            (
              await updateAccessPolicy(fx.store, {
                expectedVersion: 1,
                next,
                actor: 'admin',
                reason: 'revoke-marketing',
                at: '2026-11-12T02:00:00Z',
              })
            ).ok,
          ).toBe(true);
          return {
            status: 'active',
            executionMode: 'container',
            contextSource: 'managed',
            hostSkillsMode: 'disabled',
            disallowedTools: [...SAFE_MARKETING_DISALLOWED_TOOLS],
          };
        },
      },
    });
    cleanups.push(() => fx.bridge.close());
    const listEntries = vi.spyOn(fx.store, 'listEntries');
    expect(await fx.send('m-wang', reviewQuery)).toMatchObject({
      kind: 'failed',
    });
    expect(listEntries).not.toHaveBeenCalled();
  });
});
