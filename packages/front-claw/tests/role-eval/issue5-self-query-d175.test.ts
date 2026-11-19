import { describe, expect, it } from 'vitest';
import {
  ACCESS_POLICY_HIGH_WATER_KEY,
  CAPABILITIES,
  updateAccessPolicy,
} from '../../src/role-eval/access-policy.js';
import {
  ALREADY_CONFIRMED_TEXT,
  D175_INTERLEAVED_GUIDANCE,
  DRAFT_EXPIRED_REREPORT,
  STALE_CONSUMER,
  d175InterleavedKey,
} from '../../src/role-eval/employee-loop.js';
import { createConsumerLease } from '../../src/opendot/consumer-lease.js';
import type { RoutedHandleResult } from '../../src/role-eval/employee-entry.js';
import { isSelfProgressQuery } from '../../src/role-eval/scope-refusal.js';
import { createWecomBotHandler } from '../../src/role-eval/wecom-bot-unified-handler.js';
import { membersM05, policyM05, worldM05 } from './appointment-fixture-m05.js';
import { MemorySql } from './sql-fixture.js';
import {
  createPostgresPerformanceStore,
  migratePerformance,
} from '../../src/role-eval/performance-postgres.js';

describe('Issue #5 省略第二人称自查边界（isSelfProgressQuery）', () => {
  it('命中省略第二个「我/本人」的本人进度自然问法', () => {
    const positives = [
      '帮我查看今天做了多少业绩',
      '帮我查今天做了多少业绩',
      '帮我查今天业绩',
      '帮我看今天进度',
      '帮我看看今天业绩',
      '帮我查一下今天业绩',
      '请帮我查看今天做了多少业绩？',
      '帮我查本月业绩',
      '帮我查看我今天做了多少业绩',
      '给我查今天进度',
    ];
    for (const phrase of positives) {
      expect(isSelfProgressQuery(phrase), phrase).toBe(true);
    }
  });

  it('绝不误伤查同事/查他店/查本店汇总或带金额/改账/预约/历史日期语句', () => {
    const negatives = [
      '帮我查小林今天业绩',
      '帮我查本店今天业绩',
      '帮我查测试A店今天业绩',
      '帮我查张姐 680',
      '帮我查今天全店汇总',
      '帮我查今天排名',
      '帮我把今天张姐改成680',
      '帮我约明天下午3点张姐',
      '帮我查昨天业绩',
      '帮我查上个月业绩',
      '查今天业绩',
      '帮我记一笔今天680',
    ];
    for (const phrase of negatives) {
      expect(isSelfProgressQuery(phrase), phrase).toBe(false);
    }
  });
});

describe('Issue #5 D175 穿插软对话后的确认歧义门禁', () => {
  async function setupWorld(now?: () => Date) {
    const members = membersM05();
    members['p-wang-yj']!.capabilities = ['marketing'];
    const w = await worldM05({
      ...(now ? { now } : {}),
      policy: policyM05(1, members),
      router: { passthroughMarketing: true },
    });
    const sessionId = 'session-m-wang-yj';
    const interleavedKey = d175InterleavedKey('p-wang-yj', sessionId);
    let seq = 0;
    const sendFull = async (text: string): Promise<RoutedHandleResult> => {
      const handler = createWecomBotHandler({
        legacyEntry: true,
        mode: 'isolated-synthetic',
        store: w.store,
        now: now ?? (() => new Date('2026-11-12T02:00:00Z')),
        resolve: (id) => w.base.getPersonByMember(id),
        send: async () => 'sent',
        model: { complete: async () => ({ type: 'chat', text: '离线桩' }) },
        employeeLoop: true,
        accessPolicy: true,
        router: { passthroughMarketing: true },
      });
      return (await handler.handleMessage({
        memberId: 'm-wang-yj',
        text,
        messageId: `i5-${++seq}`,
        sessionId,
        bindingVersion: 1,
      })) as RoutedHandleResult;
    };
    return { w, interleavedKey, sendFull };
  }

  it('未穿插软对话：「对」「确认入账」「全部确认」均可直接入账，「取消」直接作废', async () => {
    for (const cmd of ['对', '确认入账', '全部确认'] as const) {
      const { w, interleavedKey, sendFull } = await setupWorld();
      const before = (await w.base.listEntries()).length;
      const staged = await sendFull('郗姨：520（苏晓禾）');
      expect(staged.replies.join('\n')).toContain('还没入账');
      expect((await w.base.getConfig(interleavedKey)) ?? '').toBe('');

      const confirmed = await sendFull(cmd);
      expect(confirmed.replies.join('\n'), cmd).toContain('已入账 1 笔');
      expect(await w.base.listEntries()).toHaveLength(before + 1);
      expect((await w.base.getConfig(interleavedKey)) ?? '').toBe('');
    }

    const { w, sendFull } = await setupWorld();
    const beforeCancel = (await w.base.listEntries()).length;
    await sendFull('郗姨：520（苏晓禾）');
    const cancelled = await sendFull('取消');
    expect(cancelled.replies.join('\n')).toContain('已取消');
    expect(await w.base.listDrafts({ status: 'pending' })).toHaveLength(0);
    expect(await w.base.listEntries()).toHaveLength(beforeCancel);
  });

  it('穿插 passthroughMarketing 后：写入 d175InterleavedKey，单字「对」严禁入账并保留草稿，「确认入账」或「全部确认」精准入账 1 笔', async () => {
    for (const explicitCmd of ['确认入账', '全部确认'] as const) {
      const { w, interleavedKey, sendFull } = await setupWorld();
      const before = (await w.base.listEntries()).length;

      await sendFull('郗姨：680（苏晓禾）');
      const draft = (await w.base.listDrafts({ status: 'pending' }))[0]!;
      expect(draft).toBeTruthy();

      const mk = await sendFull('帮我写一条周末补水活动的朋友圈文案');
      expect(mk.pass).toBe(true);
      expect(await w.base.getConfig(interleavedKey)).toBe(draft.draftId);
      expect(await w.base.listDrafts({ status: 'pending' })).toHaveLength(1);

      // 连续两次发单字「对」都严禁入账，并保留待确认草稿
      for (let attempt = 0; attempt < 2; attempt++) {
        const blocked = await sendFull('对');
        const reply = blocked.replies.join('\n');
        expect(reply).toContain(D175_INTERLEAVED_GUIDANCE);
        expect(reply).toContain('郗姨');
        expect(reply).toContain('680');
        expect(reply).toContain(draft.draftId);
        expect(reply).not.toContain('已入账');
        expect(reply).not.toContain('还在等你回「对」确认');
        expect(await w.base.listEntries()).toHaveLength(before);
        expect((await w.base.listDrafts({ status: 'pending' }))[0]?.draftId).toBe(
          draft.draftId,
        );
        expect(await w.base.getConfig(interleavedKey)).toBe(draft.draftId);
      }

      // 回复明确指令后准确入账 1 笔，并清掉 d175InterleavedKey，再回「对」走 D160
      const committed = await sendFull(explicitCmd);
      expect(committed.replies.join('\n')).toContain('已入账 1 笔');
      expect(await w.base.listEntries()).toHaveLength(before + 1);
      expect(await w.base.getConfig(interleavedKey)).toBe('');

      const repeatSingle = await sendFull('对');
      expect(repeatSingle.replies.join('\n')).toBe(ALREADY_CONFIRMED_TEXT);
      expect(await w.base.listEntries()).toHaveLength(before + 1);
    }
  });

  it('穿插后回复「取消」或新建草稿或草稿过期结算均清理 d175InterleavedKey', async () => {
    // 1. 取消清标记
    {
      const { w, interleavedKey, sendFull } = await setupWorld();
      await sendFull('郗姨：680（苏晓禾）');
      expect((await sendFull('写一条护肤推广文案')).pass).toBe(true);
      expect(await w.base.getConfig(interleavedKey)).toBeTruthy();

      const cancelled = await sendFull('取消');
      expect(cancelled.replies.join('\n')).toContain('已取消');
      expect(await w.base.getConfig(interleavedKey)).toBe('');
      expect(await w.base.listDrafts({ status: 'pending' })).toHaveLength(0);
    }

    // 2. 新建草稿替换清标记，新草稿可直接「对」入账
    {
      const { w, interleavedKey, sendFull } = await setupWorld();
      const before = (await w.base.listEntries()).length;
      await sendFull('郗姨：680（苏晓禾）');
      expect((await sendFull('写一条护肤推广文案')).pass).toBe(true);
      expect(await w.base.getConfig(interleavedKey)).toBeTruthy();

      const replaced = await sendFull('逯姨：790（苏晓禾）');
      expect(replaced.replies.join('\n')).toContain('客户：逯姨');
      expect(await w.base.getConfig(interleavedKey)).toBe('');

      const confirmed = await sendFull('对');
      expect(confirmed.replies.join('\n')).toContain('已入账 1 笔');
      expect(confirmed.replies.join('\n')).toContain('790');
      expect(await w.base.listEntries()).toHaveLength(before + 1);
    }

    // 3. 过期结算清标记
    {
      let at = Date.parse('2026-11-12T02:00:00Z');
      const { w, interleavedKey, sendFull } = await setupWorld(() => new Date(at));
      const before = (await w.base.listEntries()).length;
      await sendFull('郗姨：680（苏晓禾）');
      const draft = (await w.base.listDrafts({ status: 'pending' }))[0]!;
      expect((await sendFull('写一条护肤推广文案')).pass).toBe(true);
      expect(await w.base.getConfig(interleavedKey)).toBe(draft.draftId);

      at = Date.parse(draft.expiresAt);
      const expiredReply = await sendFull('对');
      expect(expiredReply.replies.join('\n')).toBe(DRAFT_EXPIRED_REREPORT);
      expect(await w.base.getConfig(interleavedKey)).toBe('');
      expect(await w.base.listEntries()).toHaveLength(before);
    }
  });

  it('消费租约失效时，passthroughMarketing 写 d175InterleavedKey 被 fencing 拦下且拒绝放行', async () => {
    const sql = new MemorySql();
    await migratePerformance(sql);
    const store = createPostgresPerformanceStore(sql);
    const members = membersM05();
    members['p-wang-yj']!.capabilities = ['marketing'];
    const baseTime = new Date('2026-11-12T02:00:00Z');
    const now = () => baseTime;

    const w = await worldM05({
      store,
      now,
      policy: policyM05(1, members),
      router: { passthroughMarketing: true },
    });
    expect(await w.base.getConfig(ACCESS_POLICY_HIGH_WATER_KEY)).toBe('1');
    const policyCheck = await updateAccessPolicy(w.base, {
      expectedVersion: 1,
      next: policyM05(2, members, {
        stores: { 's-a': [...CAPABILITIES], 's-b': [...CAPABILITIES] },
      }),
      actor: 'admin',
      reason: 'ensure-policy',
      at: baseTime.toISOString(),
    });
    expect(policyCheck.ok).toBe(true);

    const lease = createConsumerLease({
      store,
      owner: 'owner-1',
      ttlMs: 30_000,
      now,
    });
    expect(await lease.acquire()).toBe(true);
    const fence = lease.fence()!;

    const handler = createWecomBotHandler({
      legacyEntry: true,
      mode: 'isolated-synthetic',
      store,
      now,
      resolve: (id) => store.getPersonByMember(id),
      send: async () => 'sent',
      model: { complete: async () => ({ type: 'chat', text: '离线桩' }) },
      employeeLoop: true,
      accessPolicy: true,
      router: { passthroughMarketing: true },
    });

    const staged = await handler.handleMessage({
      memberId: 'm-wang-yj',
      text: '郗姨：680（苏晓禾）',
      messageId: 'lease-1',
      sessionId: 'session-lease',
      bindingVersion: 1,
      fence,
    });
    expect(staged.replies.join('\n')).toContain('还没入账');

    // 另一实例抢占租约，原 fence 失效
    const rival = createConsumerLease({
      store,
      owner: 'owner-2',
      ttlMs: 30_000,
      now: () => new Date(baseTime.getTime() + 60_000),
    });
    expect(await rival.acquire()).toBe(true);

    const blocked = (await handler.handleMessage({
      memberId: 'm-wang-yj',
      text: '帮我写一条周末补水活动文案',
      messageId: 'lease-2',
      sessionId: 'session-lease',
      bindingVersion: 1,
      fence,
    })) as RoutedHandleResult;
    expect(blocked.pass).toBeUndefined();
    expect(blocked.replies.join('\n')).toBe(STALE_CONSUMER);
    expect(
      (await store.getConfig(d175InterleavedKey('p-wang-yj', 'session-lease'))) ??
        '',
    ).toBe('');
  });
});
