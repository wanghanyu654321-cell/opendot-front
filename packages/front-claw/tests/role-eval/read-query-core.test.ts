import { describe, expect, it } from 'vitest';
import {
  fromModelReadQuery,
  parseRuleReadQuery,
} from '../../src/role-eval/read-query.js';
import {
  extractScopeConstraints,
  otherStoreShortNames,
} from '../../src/role-eval/scope-refusal.js';
import type { ModelClassification } from '../../src/role-eval/model-classify.js';

const DAY = '2026-11-25';

function modelQuery(
  object: NonNullable<ModelClassification['object']>,
  slots: ModelClassification['slots'] = {},
): ModelClassification {
  return {
    intent: 'query',
    object,
    action: 'query',
    slots,
    confidence: 0.96,
    uncertain: false,
  };
}

describe('Pure Core ReadQuerySpec: 规则与模型产出统一结构且保留范围约束', () => {
  it('范围约束抽取保留「别的店不要」「只查本店」「已授权」语义，同时保留正向跨店检测', () => {
    const c1 = extractScopeConstraints(
      '把已授权的试点测试B店门店排名给我看看，别的店不要',
    );
    expect(c1.excludedOtherStores).toEqual(['别的店']);
    expect(c1.onlyAuthorized).toBe(true);
    expect(otherStoreShortNames('把已授权的试点测试B店门店排名给我看看，别的店不要', '试点测试B店')).toEqual([]);

    const c2 = extractScopeConstraints(
      '看一下试点测试B店今天还没报的人有哪些，只查本店',
    );
    expect(c2.ownStoreOnly).toBe(true);
    expect(c2.positiveText).toBe('看一下试点测试B店今天还没报的人有哪些');

    expect(otherStoreShortNames('看看别的店这个月业绩汇总', '试点测试B店')).toEqual(['别的店']);
    expect(otherStoreShortNames('查测试A店今天业绩', '试点测试B店')).toEqual(['测试A店']);
  });

  it('相同业务问题经规则或模型解析产出一致的核心业务参数', () => {
    const ruleUnreported = parseRuleReadQuery(
      '看一下试点测试B店今天还没报的人有哪些，只查本店',
      DAY,
    );
    const modelUnreported = fromModelReadQuery(
      modelQuery('unreported', { store: '试点测试B店' }),
      '看一下试点测试B店今天还没报的人有哪些，只查本店',
      DAY,
    );
    expect(ruleUnreported).toMatchObject({
      kind: 'unreported',
      store: '试点测试B店',
      ownStoreOnly: true,
    });
    expect(modelUnreported).toMatchObject({
      kind: 'unreported',
      store: '试点测试B店',
      ownStoreOnly: true,
    });

    const ruleAppt = parseRuleReadQuery('今天我名下预约总共几条？只问数量', DAY);
    const modelAppt = fromModelReadQuery(
      modelQuery('appointment', { period: '今天', countOnly: true }),
      '今天我名下预约总共几条？只问数量',
      DAY,
    );
    expect(ruleAppt).toMatchObject({
      kind: 'appointment',
      scope: 'own',
      day: 'today',
      detailMode: 'count',
    });
    expect(modelAppt).toMatchObject({
      kind: 'appointment',
      scope: 'own',
      day: 'today',
      detailMode: 'count',
    });

    const ruleDayAfter = parseRuleReadQuery('查我后天已经登记的预约', DAY);
    const modelDayAfter = fromModelReadQuery(
      modelQuery('appointment', { period: '后天' }),
      '帮我看下后天有没有预约',
      DAY,
    );
    expect(ruleDayAfter).toMatchObject({
      kind: 'appointment',
      scope: 'own',
      day: 'day_after_tomorrow',
      detailMode: 'list',
    });
    expect(modelDayAfter).toMatchObject({
      kind: 'appointment',
      scope: 'own',
      day: 'day_after_tomorrow',
    });

    const ruleRef = parseRuleReadQuery(
      '入账结果里有没有 test-nonexistent-id 这一笔，查不到就直接说',
      DAY,
    );
    const modelRef = fromModelReadQuery(
      modelQuery('entry', { ref: 'test-nonexistent-id', entryMode: 'by_ref' }),
      '入账结果里有没有 test-nonexistent-id 这一笔，查不到就直接说',
      DAY,
    );
    expect(ruleRef).toMatchObject({
      kind: 'entry_result',
      mode: 'by_ref',
      ref: 'test-nonexistent-id',
    });
    expect(modelRef).toMatchObject({
      kind: 'entry_result',
      mode: 'by_ref',
      ref: 'test-nonexistent-id',
    });

    const ruleRank = parseRuleReadQuery(
      '把已授权的试点测试B店门店排名给我看看，别的店不要',
      DAY,
    );
    const modelRank = fromModelReadQuery(
      modelQuery('ranking', { store: '试点测试B店' }),
      '把已授权的试点测试B店门店排名给我看看，别的店不要',
      DAY,
    );
    expect(ruleRank).toMatchObject({
      kind: 'ranking',
      store: '试点测试B店',
      onlyAuthorized: true,
      excludedOtherStores: ['别的店'],
    });
    expect(modelRank).toMatchObject({
      kind: 'ranking',
      store: '试点测试B店',
      onlyAuthorized: true,
      excludedOtherStores: ['别的店'],
    });
  });

  it('区分预约纠错澄清与入账结果双口径，保留合成口语变体覆盖', () => {
    expect(
      parseRuleReadQuery('我刚才问的是预约查询，不是要报业绩', DAY),
    ).toMatchObject({
      kind: 'clarify_query',
      reason: 'appointment_missing_scope',
    });

    // 合成口语对照：区分最近一次操作结果 vs 最近一笔已入账
    expect(parseRuleReadQuery('查一下我最近一次操作结果', DAY)).toMatchObject({
      kind: 'entry_result',
      mode: 'latest_operation',
    });
    expect(parseRuleReadQuery('查一下我最近一笔已入账', DAY)).toMatchObject({
      kind: 'entry_result',
      mode: 'latest_confirmed',
    });

    // 合成口语对照：老客消费 + 全店小计
    expect(
      parseRuleReadQuery('查一下本店老客消费和全店业绩小计', DAY),
    ).toMatchObject({
      kind: 'store_summary',
      mentionsReturningCustomer: true,
    });

    // 合成口语对照：本人 + 本店口语组合
    expect(
      parseRuleReadQuery('把我自己和试点测试B店本月的业绩都给我看看', DAY),
    ).toMatchObject({
      kind: 'self_and_summary',
      store: '试点测试B店',
    });
  });
});
