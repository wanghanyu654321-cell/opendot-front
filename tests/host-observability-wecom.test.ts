import { createHash, randomUUID } from 'node:crypto';
import { ExportResultCode } from '@opentelemetry/core';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type SpanExporter,
} from '@opentelemetry/sdk-trace-base';
import { afterEach, describe, expect, test } from 'vitest';

import {
  BoundedLangfuseExporter,
  HostObservability,
  getHostObservability,
  observeWeComAgentTurn,
  observeWeComDelivery,
  observeWeComOutboundAuth,
  observeWeComPrecheck,
  type WeComAgentTurnTelemetry,
  type WeComDeliveryTelemetry,
  type WeComOutboundAuthTelemetry,
  type WeComPrecheckTelemetry,
} from '../src/personal-agent/host-observability.js';

function sha256Ref(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 24);
}

const activeObservers: HostObservability[] = [];

function createObserver(
  sampleRate = 1,
  exporter: SpanExporter = new InMemorySpanExporter(),
): HostObservability {
  const observer = new HostObservability({
    publicKey: 'pk-wecom-fixture',
    secretKey: 'sk-wecom-secret-never-export',
    baseUrl: 'https://langfuse.example.test/',
    installationId: randomUUID(),
    sampleRate,
    exporter,
  });
  activeObservers.push(observer);
  return observer;
}

afterEach(async () => {
  while (activeObservers.length > 0) {
    const observer = activeObservers.pop();
    if (observer) {
      await observer.close();
    }
  }
});

describe('HostObservability WeCom four-stage telemetry', () => {
  test('emits four correlated dot.wecom.* spans sharing the same hashed correlation_ref', async () => {
    const memory = new InMemorySpanExporter();
    const observer = createObserver(1, memory);

    const correlationId = 'corr-bot01-member09-msg777';
    const expectedCorrelationRef = sha256Ref(correlationId);

    const precheck: WeComPrecheckTelemetry = {
      correlationId,
      botId: 'bot-raw-01',
      memberId: 'member-raw-09',
      storeId: 'store-raw-88',
      route: 'marketing_pass',
      gateReason: 'non_ledger_marketing_intent',
      modelMs: 42,
      errorCategory: 'none',
      outcomeKind: 'pass',
    };
    const agentTurn: WeComAgentTurnTelemetry = {
      correlationId,
      workspaceFolder: 'wecom-front-claw-abc123',
      profileId: 'profile-safe-marketing',
      skillIds: ['beauty-local-content'],
      durationMs: 315,
      status: 'success',
      inputTokens: 1200,
      outputTokens: 320,
    };
    const outboundAuth: WeComOutboundAuthTelemetry = {
      correlationId,
      botId: 'bot-raw-01',
      memberId: 'member-raw-09',
      allowed: true,
      reason: 'member_bound_active',
      policyVersion: 3,
    };
    const delivery: WeComDeliveryTelemetry = {
      correlationId,
      botId: 'bot-raw-01',
      outboxStatus: 'delivered',
      wecomState: 'accepted',
      chunkCount: 2,
      durationMs: 18,
    };

    observer.wecomPrecheck(precheck);
    observer.wecomAgentTurn(agentTurn);
    observer.wecomOutboundAuth(outboundAuth);
    observer.wecomDelivery(delivery);
    await observer.flush();

    const spans = memory.getFinishedSpans();
    expect(spans.map((span) => span.name)).toEqual([
      'dot.wecom.precheck',
      'dot.wecom.agent_turn',
      'dot.wecom.outbound_auth',
      'dot.wecom.delivery',
    ]);

    for (const span of spans) {
      expect(span.name.startsWith('dot.')).toBe(true);
      expect(JSON.stringify(span.attributes)).toContain(expectedCorrelationRef);
    }
  });

  test('redacts plaintext identifiers, rejects extra business payloads, and hashes refs with SHA256(24)', async () => {
    const memory = new InMemorySpanExporter();
    const observer = createObserver(1, memory);

    const rawCorrelation = 'ww_raw_bot:zhangsan_member:msg_999';
    const rawBot = 'ww_raw_bot_991';
    const rawMember = 'zhangsan_vip_member_007';
    const rawStore = 'flagship_beijing_chaoyang_store';
    const rawWorkspace = 'wecom-front-claw-beijing-01';
    const rawProfile = 'safe-marketing-profile-01';

    observer.wecomPrecheck({
      correlationId: rawCorrelation,
      botId: rawBot,
      memberId: rawMember,
      storeId: rawStore,
      route: '包含中文门店名或顾客姓名李四',
      gateReason: 'forbidden_env_leak:PGPASSWORD',
      modelMs: 15,
      errorCategory: 'postgres://user:pass@pg:5432/front_dot',
      outcomeKind: 'handled',
      ...({
        text: '客户李四充值5800元皮肤管理卡',
        customerName: '李四',
        amount: 5800,
        prompt: 'SECRET_PROMPT_BODY',
      } as Record<string, unknown>),
    } as WeComPrecheckTelemetry);

    observer.wecomAgentTurn({
      correlationId: rawCorrelation,
      workspaceFolder: rawWorkspace,
      profileId: rawProfile,
      skillIds: ['beauty-local-content', '不合法技能 张三 5800元'],
      durationMs: 250,
      status: 'success',
      inputTokens: 100,
      outputTokens: 50,
      ...({
        reply: 'SECRET_REPLY_TEXT',
        messages: ['hello customer'],
      } as Record<string, unknown>),
    } as WeComAgentTurnTelemetry);

    observer.wecomOutboundAuth({
      correlationId: rawCorrelation,
      botId: rawBot,
      memberId: rawMember,
      allowed: false,
      reason: 'reject https://internal.host/token=abc',
      policyVersion: 2,
    });

    observer.wecomDelivery({
      correlationId: rawCorrelation,
      botId: rawBot,
      outboxStatus: 'uncertain',
      wecomState: 'unknown',
      chunkCount: 1,
      durationMs: 2000,
    });

    await observer.flush();

    const spans = memory.getFinishedSpans();
    expect(spans).toHaveLength(4);

    const serialized = JSON.stringify(spans.map((span) => span.attributes));
    for (const secret of [
      rawCorrelation,
      rawBot,
      rawMember,
      rawStore,
      rawWorkspace,
      rawProfile,
      'sk-wecom-secret-never-export',
      '客户李四充值5800元皮肤管理卡',
      '李四',
      '5800',
      'SECRET_PROMPT_BODY',
      'SECRET_REPLY_TEXT',
      'hello customer',
      'postgres://user:pass@pg:5432/front_dot',
      'https://internal.host/token=abc',
      '包含中文门店名或顾客姓名李四',
      '不合法技能 张三 5800元',
    ]) {
      expect(serialized).not.toContain(secret);
    }

    expect(serialized).toContain(sha256Ref(rawCorrelation));
    expect(serialized).toContain(sha256Ref(rawBot));
    expect(serialized).toContain(sha256Ref(rawMember));
    expect(serialized).toContain(sha256Ref(rawStore));
    expect(serialized).toContain(sha256Ref(rawWorkspace));
    expect(serialized).toContain(sha256Ref(rawProfile));
    expect(serialized).toContain('forbidden_env_leak:PGPASSWORD');
    expect(serialized).toContain('beauty-local-content');
    expect(serialized).toContain('invalid_skill_id');
    expect(serialized).toContain('redacted');
  });

  test('global convenience accessors work when active and silently no-op when unconfigured or closed', async () => {
    expect(getHostObservability()).toBeUndefined();

    const precheck: WeComPrecheckTelemetry = {
      correlationId: 'corr-noop-check',
      botId: 'bot-1',
      memberId: 'member-1',
      route: 'store_ops',
      gateReason: 'ok',
      modelMs: 10,
      errorCategory: 'none',
      outcomeKind: 'handled',
    };
    const agentTurn: WeComAgentTurnTelemetry = {
      correlationId: 'corr-noop-check',
      workspaceFolder: 'wecom-front-claw',
      durationMs: 50,
      status: 'success',
    };
    const outboundAuth: WeComOutboundAuthTelemetry = {
      correlationId: 'corr-noop-check',
      botId: 'bot-1',
      memberId: 'member-1',
      allowed: true,
      reason: 'ok',
    };
    const delivery: WeComDeliveryTelemetry = {
      correlationId: 'corr-noop-check',
      botId: 'bot-1',
      outboxStatus: 'delivered',
      wecomState: 'accepted',
      chunkCount: 1,
    };

    expect(() => {
      observeWeComPrecheck(precheck);
      observeWeComAgentTurn(agentTurn);
      observeWeComOutboundAuth(outboundAuth);
      observeWeComDelivery(delivery);
    }).not.toThrow();

    const memory = new InMemorySpanExporter();
    const observer = createObserver(1, memory);
    expect(getHostObservability()).toBe(observer);

    observeWeComPrecheck(precheck);
    observeWeComAgentTurn(agentTurn);
    observeWeComOutboundAuth(outboundAuth);
    observeWeComDelivery(delivery);
    await observer.flush();

    expect(memory.getFinishedSpans().map((span) => span.name)).toEqual([
      'dot.wecom.precheck',
      'dot.wecom.agent_turn',
      'dot.wecom.outbound_auth',
      'dot.wecom.delivery',
    ]);

    await observer.close();
    expect(getHostObservability()).toBeUndefined();
    const exportedBeforePostCloseCalls = observer.exporter.metrics.exported;
    const spanCountAfterClose = memory.getFinishedSpans().length;

    observer.wecomPrecheck(precheck);
    observeWeComDelivery(delivery);
    await observer.flush();
    expect(observer.exporter.metrics.exported).toBe(
      exportedBeforePostCloseCalls,
    );
    expect(memory.getFinishedSpans()).toHaveLength(spanCountAfterClose);
  });

  test('sampleRate 0 suppresses all four spans and exporter errors/timeouts never throw or block', async () => {
    const suppressedMemory = new InMemorySpanExporter();
    const zeroSampler = createObserver(0, suppressedMemory);

    zeroSampler.wecomPrecheck({
      correlationId: 'corr-zero',
      botId: 'bot-z',
      memberId: 'mem-z',
      route: 'marketing',
      gateReason: 'pass',
      modelMs: 5,
      errorCategory: 'none',
      outcomeKind: 'pass',
    });
    zeroSampler.wecomAgentTurn({
      correlationId: 'corr-zero',
      workspaceFolder: 'ws-z',
      durationMs: 12,
      status: 'success',
    });
    zeroSampler.wecomOutboundAuth({
      correlationId: 'corr-zero',
      botId: 'bot-z',
      memberId: 'mem-z',
      allowed: true,
      reason: 'ok',
    });
    zeroSampler.wecomDelivery({
      correlationId: 'corr-zero',
      botId: 'bot-z',
      outboxStatus: 'delivered',
      wecomState: 'accepted',
      chunkCount: 1,
    });
    await zeroSampler.flush();
    expect(suppressedMemory.getFinishedSpans()).toHaveLength(0);

    const throwingExporter: SpanExporter = {
      export: () => {
        throw new Error('langfuse unreachable');
      },
      shutdown: async () => {
        throw new Error('shutdown failed');
      },
    };
    const faultyObserver = createObserver(1, throwingExporter);
    expect(() => {
      faultyObserver.wecomPrecheck({
        correlationId: 'corr-fault',
        botId: 'bot-f',
        memberId: 'mem-f',
        route: 'marketing',
        gateReason: 'pass',
        modelMs: 5,
        errorCategory: 'none',
        outcomeKind: 'pass',
      });
      faultyObserver.wecomAgentTurn({
        correlationId: 'corr-fault',
        workspaceFolder: 'ws-f',
        durationMs: 10,
        status: 'error',
      });
      faultyObserver.wecomOutboundAuth({
        correlationId: 'corr-fault',
        botId: 'bot-f',
        memberId: 'mem-f',
        allowed: false,
        reason: 'denied',
      });
      faultyObserver.wecomDelivery({
        correlationId: 'corr-fault',
        botId: 'bot-f',
        outboxStatus: 'failed',
        wecomState: 'rejected',
        chunkCount: 1,
      });
    }).not.toThrow();
    await expect(faultyObserver.flush()).resolves.toBeUndefined();
    await expect(faultyObserver.close()).resolves.toBeUndefined();

    // Verify BoundedLangfuseExporter handles hung exports for dot.wecom.* spans without throwing
    const capture = new InMemorySpanExporter();
    const helperProvider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(capture)],
    });
    helperProvider.getTracer('fixture').startSpan('dot.wecom.delivery').end();
    const wecomSpan = capture.getFinishedSpans()[0]!;
    const hungDelegate: SpanExporter = {
      export: () => {
        // intentionally never invoke callback to trigger timeout watchdog
      },
      shutdown: async () => {},
    };
    const bounded = new BoundedLangfuseExporter(hungDelegate, 65_536, 16, 15);
    const results: number[] = [];
    bounded.export([wecomSpan], (res) => results.push(res.code));
    await bounded.forceFlush();
    expect(results).toEqual([ExportResultCode.SUCCESS]);
    expect(bounded.metrics.failed).toBe(1);
    await bounded.shutdown();
    await helperProvider.shutdown();
  });

  test('fractional sampling applies consistently across all four stages per correlationId', async () => {
    const memory = new InMemorySpanExporter();
    const observer = createObserver(0.5, memory);

    const correlationIds = Array.from(
      { length: 12 },
      (_, idx) => `corr-sample-${idx}`,
    );

    for (const correlationId of correlationIds) {
      observer.wecomPrecheck({
        correlationId,
        botId: 'bot-s',
        memberId: 'mem-s',
        route: 'marketing',
        gateReason: 'pass',
        modelMs: 10,
        errorCategory: 'none',
        outcomeKind: 'pass',
      });
      observer.wecomAgentTurn({
        correlationId,
        workspaceFolder: 'ws-s',
        durationMs: 25,
        status: 'success',
      });
      observer.wecomOutboundAuth({
        correlationId,
        botId: 'bot-s',
        memberId: 'mem-s',
        allowed: true,
        reason: 'ok',
      });
      observer.wecomDelivery({
        correlationId,
        botId: 'bot-s',
        outboxStatus: 'delivered',
        wecomState: 'accepted',
        chunkCount: 1,
      });
      await observer.flush();
    }

    expect(observer.exporter.metrics.dropped).toBe(0);
    const spans = memory.getFinishedSpans();
    for (const correlationId of correlationIds) {
      const ref = sha256Ref(correlationId);
      const matching = spans.filter((span) =>
        JSON.stringify(span.attributes).includes(ref),
      );
      expect([0, 4]).toContain(matching.length);
    }
  });
});
