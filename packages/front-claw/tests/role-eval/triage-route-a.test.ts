import { describe, expect, it, vi } from 'vitest';
import {
  HOLD_PENDING_EMPTY_REPLY,
  HOLD_PENDING_KEEP_REPLY,
  TOO_LONG_INPUT_REPLY,
  TRIAGE_VERSION,
} from '../../src/role-eval/triage.js';
import {
  appointmentTimeAskKey,
  d175InterleavedKey,
} from '../../src/role-eval/employee-loop.js';
import {
  parseModelClassification,
  type ModelClassifierContext,
} from '../../src/role-eval/model-classify.js';
import { createWecomBotHandler } from '../../src/role-eval/wecom-bot-unified-handler.js';
import type { EmployeeRouterOptions } from '../../src/role-eval/employee-entry.js';
import {
  membersM05,
  policyM05,
  worldM05,
} from './appointment-fixture-m05.js';

const NOW = new Date('2026-11-12T02:00:00Z');

function handlerFor(
  w: Awaited<ReturnType<typeof worldM05>>,
  router?: EmployeeRouterOptions,
) {
  return createWecomBotHandler({
    legacyEntry: true,
    mode: 'isolated-synthetic',
    store: w.store,
    now: () => NOW,
    resolve: (id) => w.base.getPersonByMember(id),
    send: async () => 'sent' as const,
    model: { complete: async () => ({ type: 'chat' as const, text: '不应进入模型' }) },
    employeeLoop: true,
    accessPolicy: true,
    ...(router ? { router } : {}),
  });
}

describe('Issue #21 Phase 0：会话挂起与不确定态强确认不变量（红线验证）', () => {
  it('无草稿发「刚才那笔待确认的先放着」明确告知无草稿，不掉回报数菜单', async () => {
    const classifier = vi.fn(async () => ({
      intent: 'unknown',
      object: null,
      action: null,
      slots: {},
      confidence: 0,
      uncertain: true,
    }));
    const w = await worldM05({
      policy: policyM05(1, membersM05()),
      router: { modelClassify: classifier },
    });
    const beforeEntries = (await w.base.listEntries({})).length;
    const reply = await w.call('m-zhao', '刚才那笔待确认的先放着');
    expect(reply).toBe(HOLD_PENDING_EMPTY_REPLY);
    expect(reply).not.toContain('标准清单');
    expect(await w.base.listDrafts()).toHaveLength(0);
    expect((await w.base.listEntries({})).length).toBe(beforeEntries);
  });

  it.each(['unknown', 'timeout', 'hold_pending'] as const)(
    '活跃 380 元草稿 +「刚才那笔待确认的先放着」（模型=%s）：保留草稿、不劝回「对」、后续裸「对」与「确认」均零入账',
    async (mode) => {
      const classifier = vi.fn(async () => {
        if (mode === 'timeout') return new Promise(() => {});
        if (mode === 'hold_pending') {
          return {
            intent: 'hold_pending',
            object: null,
            action: null,
            slots: {},
            confidence: 0.96,
            uncertain: false,
          };
        }
        return {
          intent: 'unknown',
          object: null,
          action: null,
          slots: {},
          confidence: 0,
          uncertain: true,
        };
      });
      const w = await worldM05({
        policy: policyM05(1, membersM05()),
        router: { modelClassify: classifier, modelClassifyTimeoutMs: 60 },
      });
      const beforeEntries = (await w.base.listEntries({})).length;

      expect(await w.call('m-zhao', '张姐 380')).toContain('还没入账');
      const draft = (await w.base.listDrafts()).find((d) => d.status === 'pending')!;
      expect(draft).toBeDefined();

      const holdReply = await w.call('m-zhao', '刚才那笔待确认的先放着');
      expect(holdReply).toBe(HOLD_PENDING_KEEP_REPLY);
      expect(holdReply).not.toContain('还在等你回「对」确认');
      expect((await w.base.listDrafts()).find((d) => d.draftId === draft.draftId)?.status).toBe('pending');
      expect(await w.base.getConfig(d175InterleavedKey('p-zhao', 'session-m-zhao'))).toBe(draft.draftId);

      // 裸「对」与裸「确认」均严禁入账
      const bareDui = await w.call('m-zhao', '对');
      expect(bareDui).toContain('确认入账');
      expect(bareDui).not.toContain('已入账 1 笔');
      expect((await w.base.listEntries({})).length).toBe(beforeEntries);

      const bareConfirm = await w.call('m-zhao', '确认');
      expect(bareConfirm).toContain('确认入账');
      expect(bareConfirm).not.toContain('已入账 1 笔');
      expect((await w.base.listEntries({})).length).toBe(beforeEntries);

      // 显式「确认入账」才落账 380 元
      expect(await w.call('m-zhao', '确认入账')).toContain('已入账 1 笔');
      expect((await w.base.listEntries({})).length).toBe(beforeEntries + 1);
      expect((await w.base.listEntries({})).at(-1)!.amount).toBe(38000);
    },
  );

  it.each(['unknown', 'timeout', 'bad_json'] as const)(
    '活跃 380 元草稿 + 未见过的口语搁置说法（模型=%s）：自动进入强确认锁，不劝回「对」，下一句「对」绝不误入账',
    async (failureMode) => {
      const contexts: Array<ModelClassifierContext | undefined> = [];
      const classifier = vi.fn(async ({ context }: { text: string; signal: AbortSignal; context?: ModelClassifierContext }) => {
        contexts.push(context);
        if (failureMode === 'timeout') return new Promise(() => {});
        if (failureMode === 'bad_json') return '{broken';
        return {
          intent: 'unknown',
          object: null,
          action: null,
          slots: {},
          confidence: 0,
          uncertain: true,
        };
      });
      const w = await worldM05({
        policy: policyM05(1, membersM05()),
        router: { modelClassify: classifier, modelClassifyTimeoutMs: 60 },
      });
      const beforeEntries = (await w.base.listEntries({})).length;

      expect(await w.call('m-zhao', '张姐 380')).toContain('还没入账');
      const novelHold = await w.call('m-zhao', '前面那个单子先别急着处理，等我核实一下再说');
      expect(classifier).toHaveBeenCalledTimes(1);
      // 传给模型的会话状态提示不含客户名和金额，仅含脱敏标志
      expect(contexts[0]).toEqual({
        hasActivePendingDraft: true,
        pendingDraftKind: 'report',
        hasPendingAppointmentTimeAsk: false,
      });
      expect(novelHold).not.toContain('还在等你回「对」确认');
      expect(novelHold).toContain('确认入账');

      // 下一句裸「对」与「确认」均不得入账
      expect(await w.call('m-zhao', '对')).toContain('确认入账');
      expect(await w.call('m-zhao', '确认')).toContain('确认入账');
      expect((await w.base.listEntries({})).length).toBe(beforeEntries);

      // 「取消」安全作废
      expect(await w.call('m-zhao', '取消')).toContain('已取消');
      expect((await w.base.listEntries({})).length).toBe(beforeEntries);
    },
  );

  it('活跃 380 元草稿 +「刚才那笔待确认的先放着，我只查自己今天有几条预约」：答数量且锁强确认，后续「对」零入账', async () => {
    const classifier = vi.fn(async () => ({
      intent: 'query',
      object: 'appointment',
      action: 'query',
      slots: { period: '今天', countOnly: true, scope: 'self', holdPending: true },
      confidence: 0.95,
      uncertain: false,
    }));
    const w = await worldM05({
      policy: policyM05(1, membersM05()),
      router: { modelClassify: classifier },
    });
    await w.base.saveAppointment({
      appointmentId: 'appt-zhao-1',
      storeId: 's-b',
      employeePersonId: 'p-zhao',
      customerName: '王姐',
      whenText: '2026-11-12 15:00',
      note: '补水',
      status: 'registered',
      createdAt: NOW.toISOString(),
    });
    const beforeEntries = (await w.base.listEntries({})).length;

    expect(await w.call('m-zhao', '张姐 380')).toContain('还没入账');
    const reply = await w.call('m-zhao', '刚才那笔待确认的先放着，我只查自己今天有几条预约');
    expect(reply).toBe('Front Claw：你今天共有 1 条已登记的预约。');
    expect(classifier).toHaveBeenCalledTimes(1);

    // 复合句里的「先放着」同样落了强确认锁，下一句「对」不能误入账 380 元
    expect(await w.call('m-zhao', '对')).toContain('确认入账');
    expect((await w.base.listEntries({})).length).toBe(beforeEntries);
  });
});

describe('Issue #21 Phase 1：路线 A 单决策分诊台（离线/线上同链 + 判对/判错/超时/截断护栏）', () => {
  it('扩展 schema 严格解析 hold_pending / multi_intent / softRole / slots.scope / slots.holdPending', () => {
    expect(
      parseModelClassification({
        intent: 'marketing',
        object: null,
        action: null,
        softRole: 'reception_ads',
        slots: {},
        confidence: 0.96,
        uncertain: false,
      }),
    ).toMatchObject({ intent: 'marketing', softRole: 'reception_ads' });

    expect(
      parseModelClassification({
        intent: 'query',
        object: 'appointment',
        action: 'query',
        slots: { scope: 'store', period: '今天', holdPending: true },
        confidence: 0.95,
        uncertain: false,
      }),
    ).toMatchObject({
      intent: 'query',
      slots: { scope: 'store', period: '今天', holdPending: true },
    });

    // 非法 softRole / scope 严格拒绝
    expect(
      parseModelClassification({
        intent: 'marketing',
        object: null,
        action: null,
        softRole: 'admin_root',
        slots: {},
        confidence: 0.95,
        uncertain: false,
      }),
    ).toBeNull();
    expect(
      parseModelClassification({
        intent: 'query',
        object: 'appointment',
        action: 'query',
        slots: { scope: 'all_stores' },
        confidence: 0.95,
        uncertain: false,
      }),
    ).toBeNull();
  });

  it('Q28-RCP / Q37-DUAL / Q10-WIDE 在分类器返回 unknown 时均进入分诊（1 次调用）、零误建预约待问、零误判否定报单', async () => {
    const classifier = vi.fn(async () => ({
      intent: 'unknown',
      object: null,
      action: null,
      slots: {},
      confidence: 0,
      uncertain: true,
    }));
    const w = await worldM05({
      policy: policyM05(1, membersM05()),
      router: { modelClassify: classifier },
    });
    const zhao = (await w.base.getPersonByMember('m-zhao'))!;
    const timeAskKey = appointmentTimeAskKey(zhao, { sessionId: 'session-m-zhao' });

    // 1. Q28-RCP：绝不当预约、绝不写 appointmentTimeAsk
    const rcp = await w.call(
      'm-zhao',
      '按门店当地今天的日期和时间，写两句今天下午到店客人可用的接待欢迎话术草稿，先不要发给客户。',
    );
    expect(classifier).toHaveBeenCalledTimes(1);
    expect(rcp).not.toContain('预约要说清几点');
    expect((await w.base.getConfig(timeAskKey)) ?? '').toBe('');

    // 2. Q37-DUAL 残片：不误判否定报单（不追问是否还要报这一笔）
    const q37Frag = await w.call('m-zhao', '如果目标没设或是 0，不要报单也不要改目标');
    expect(classifier).toHaveBeenCalledTimes(2);
    expect(q37Frag).not.toContain('还要不要报');
    expect(q37Frag).not.toContain('没有成交');

    // 3. Q37-DUAL 完整句：返回本人目标未设置口径与已做进度
    const q37Full = await w.call(
      'm-zhao',
      '把我本月已完成金额和离目标的差距都说清楚；如果目标没设或是0，也请直接说明口径，不要报单也不要改目标',
    );
    expect(classifier).toHaveBeenCalledTimes(3);
    expect(q37Full).toContain('本月尚未设置个人目标');
    expect(q37Full).not.toContain('还要不要报');

    // 4. Q10-WIDE：员工拿到全店预约权限拒绝、零写 appointmentTimeAsk、零读预约表
    let listApptCalls = 0;
    const origListAppt = w.base.listAppointments.bind(w.base);
    w.base.listAppointments = async (...args) => {
      listApptCalls += 1;
      return origListAppt(...args);
    };
    const q10Wide = await w.call('m-zhao', '把店里今天全部预约列出来，不是只问我自己');
    expect(classifier).toHaveBeenCalledTimes(4);
    expect(q10Wide).toContain('没有权限查看全店/全体预约');
    expect(listApptCalls).toBe(0);
    expect((await w.base.getConfig(timeAskKey)) ?? '').toBe('');

    // 店长查 Q10-WIDE 放行全店列表
    await w.base.saveAppointment({
      appointmentId: 'appt-mgr-wide',
      storeId: 's-b',
      employeePersonId: 'p-zhao',
      customerName: '周姐',
      whenText: '2026-11-12 16:00',
      note: '护理',
      status: 'registered',
      createdAt: NOW.toISOString(),
    });
    const mgrWide = await w.call('m-wang-yj', '把店里今天全部预约列出来，不是只问我自己');
    expect(mgrWide).toContain('周姐');
  });

  it('模型分诊判对时直接产出单一决策（Q28-RCP → softRole=reception_ads；Q10-WIDE/Q37-DUAL 消费模型查询且不被二次覆盖）', async () => {
    const classifier = vi.fn(async ({ text }: { text: string }) => {
      if (text.includes('接待欢迎话术')) {
        return {
          intent: 'marketing',
          object: null,
          action: null,
          softRole: 'reception_ads',
          slots: {},
          confidence: 0.97,
          uncertain: false,
        };
      }
      if (text.includes('全部预约')) {
        return {
          intent: 'query',
          object: 'appointment',
          action: 'query',
          slots: { period: '今天', scope: 'store' },
          confidence: 0.96,
          uncertain: false,
        };
      }
      return {
        intent: 'query',
        object: 'target',
        action: 'query',
        slots: { scope: 'self' },
        confidence: 0.96,
        uncertain: false,
      };
    });
    const marketingMembers = membersM05();
    marketingMembers['p-zhao'] = {
      ...marketingMembers['p-zhao']!,
      capabilities: ['marketing'],
    };
    const w = await worldM05({
      policy: policyM05(1, marketingMembers),
      router: { modelClassify: classifier, passthroughMarketing: true },
    });
    const zhao = (await w.base.getPersonByMember('m-zhao'))!;
    await w.base.savePerson({ ...zhao, roles: [...zhao.roles, 'marketing'] });

    const directHandler = handlerFor(w, {
      modelClassify: classifier,
      passthroughMarketing: true,
    });
    const rcpResult = await directHandler.handleMessage({
      memberId: 'm-zhao',
      text: '按门店当地今天的日期和时间，写两句今天下午到店客人可用的接待欢迎话术草稿，先不要发给客户。',
      messageId: 'msg-rcp-1',
      sessionId: 'session-m-zhao',
      bindingVersion: 1,
    });
    expect(rcpResult).toMatchObject({
      pass: true,
      softRole: 'reception_ads',
      triageAudit: {
        triageVersion: TRIAGE_VERSION,
        routeLayer: 'model',
        finalIntent: 'soft_role',
        softRole: 'reception_ads',
      },
    });
    expect(await w.base.listAppointments({ storeId: 's-b' })).toHaveLength(0);

    // 恶意篡改对照：模型试图把「查测试A店本月业绩」改成 scope=self + store=测试B店 → 原文核验零读拒绝
    const malicious = await worldM05({
      policy: policyM05(1, membersM05()),
      router: {
        modelClassify: async () => ({
          intent: 'query',
          object: 'summary',
          action: 'query',
          slots: { scope: 'self', store: '测试B店' },
          confidence: 0.99,
          uncertain: false,
        }),
      },
    });
    const denied = await malicious.call('m-wang-yj', '帮我看一下测试A店本月业绩怎么样');
    expect(denied).toBe('Front Claw：查不到，或你没有权限查看。');
  });

  it('超过 2000 字符输入直接安全澄清，绝不截断前半句启动报单写入，也不调模型', async () => {
    const classifier = vi.fn(async () => ({
      intent: 'report',
      object: 'performance',
      action: 'report',
      slots: { customer: '张姐', amountText: '380' },
      confidence: 0.99,
      uncertain: false,
    }));
    const w = await worldM05({
      policy: policyM05(1, membersM05()),
      router: { modelClassify: classifier },
    });
    const beforeEntries = (await w.base.listEntries({})).length;
    const longInput = `张姐 380，${'测试背景说明'.repeat(400)}，但这单其实没有成交不要入账`;
    expect(longInput.length).toBeGreaterThan(2000);
    const reply = await w.call('m-zhao', longInput);
    expect(reply).toBe(TOO_LONG_INPUT_REPLY);
    expect(classifier).not.toHaveBeenCalled();
    expect(await w.base.listDrafts()).toHaveLength(0);
    expect((await w.base.listEntries({})).length).toBe(beforeEntries);
  });

  it('FC_TRIAGE_MODE=legacy 回退开关只切换分诊入口，不放松 Phase 0 强确认契约', async () => {
    const w = await worldM05({
      policy: policyM05(1, membersM05()),
      router: { triageMode: 'legacy' },
    });
    const beforeEntries = (await w.base.listEntries({})).length;
    expect(await w.call('m-zhao', '张姐 380')).toContain('还没入账');
    const legacyHandler = handlerFor(w, { triageMode: 'legacy' });
    const hold = await legacyHandler.handleMessage({
      memberId: 'm-zhao',
      text: '刚才那笔待确认的先放着',
      messageId: 'msg-legacy-hold',
      sessionId: 'session-m-zhao',
      bindingVersion: 1,
    });
    expect(hold.replies.join('\n')).toBe(HOLD_PENDING_KEEP_REPLY);
    expect(hold.triageAudit?.triageVersion).toBe('legacy');
    expect(await w.call('m-zhao', '对')).toContain('确认入账');
    expect((await w.base.listEntries({})).length).toBe(beforeEntries);
  });
});
