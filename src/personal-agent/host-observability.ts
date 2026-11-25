import { createHash } from 'node:crypto';
import { LangfuseClient } from '@langfuse/client';
import { recordObservedInputTrace } from './message-feedback.js';
import type { FeedbackScoreDispatch } from './message-feedback.js';
import type { McpApproval } from './mcp-approval-store.js';
import { context as otelContext, ROOT_CONTEXT } from '@opentelemetry/api';
import {
  BasicTracerProvider,
  type ReadableSpan,
  type SpanExporter,
} from '@opentelemetry/sdk-trace-base';
import { ExportResultCode, type ExportResult } from '@opentelemetry/core';
import { JsonTraceSerializer } from '@opentelemetry/otlp-transformer';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { LangfuseSpanProcessor } from '@langfuse/otel';
import { setLangfuseTracerProvider, startObservation } from '@langfuse/tracing';
import type {
  ModelRequestObservation,
  ModelRequestResult,
} from './metered-model-api.js';

export type NativeModelIdentity = {
  sessionId: string;
  ownerId: string;
  conversationId: number;
  generationTaskId: number;
  attempt: number;
  inputRequestIds: readonly string[];
  modelId: string;
  runtime: 'node-durable';
};

export interface WeComPrecheckTelemetry {
  readonly correlationId: string;
  readonly botId: string;
  readonly memberId: string;
  readonly storeId?: string;
  readonly route: string;
  readonly gateReason: string;
  readonly modelMs: number;
  readonly errorCategory: string;
  readonly outcomeKind: 'handled' | 'pass' | 'failed';
  readonly targetRole?:
    | 'marketing'
    | 'training'
    | 'manager_ops'
    | 'reception_ads';
  readonly tier?: 'employee' | 'manager' | 'owner';
  readonly readonlyContextInjected?: boolean;
}

export interface WeComAgentTurnTelemetry {
  readonly correlationId: string;
  readonly coveredCorrelationIds?: readonly string[];
  readonly workspaceFolder: string;
  readonly profileId?: string;
  readonly skillIds?: readonly string[];
  /** Manifest-selected skills for this workspace run (not per-message tool invocation proof). */
  readonly selectedSkillIds?: readonly string[];
  /** Backward-compatible alias for selectedSkillIds. */
  readonly loadedSkillIds?: readonly string[];
  /** Batch-level marker indicating at least one queued message in this turn carried readonlyContext. */
  readonly batchReadonlyContextMarked?: boolean;
  /** Backward-compatible alias for batchReadonlyContextMarked. */
  readonly readonlyContextInjected?: boolean;
  readonly durationMs: number;
  readonly status: 'success' | 'error' | 'aborted';
  readonly inputTokens?: number;
  readonly outputTokens?: number;
}

export interface WeComOutboundAuthTelemetry {
  readonly correlationId: string;
  readonly botId: string;
  readonly memberId: string;
  readonly allowed: boolean;
  readonly reason: string;
  readonly policyVersion?: number;
}

export interface WeComDeliveryTelemetry {
  readonly correlationId: string;
  readonly botId: string;
  readonly outboxStatus:
    | 'delivered'
    | 'uncertain'
    | 'failed'
    | 'retry_wait'
    | 'busy'
    | 'cancelled'
    | 'lease_lost';
  readonly wecomState: 'accepted' | 'blocked' | 'rejected' | 'unknown';
  readonly chunkCount: number;
  readonly durationMs?: number;
}

type Pending = {
  spans: ReadableSpan[];
  bytes: number;
  callback: (result: ExportResult) => void;
};
const success: ExportResult = { code: ExportResultCode.SUCCESS };
const hash = (value: string) =>
  createHash('sha256').update(value).digest('hex');
const hashRef = (value: string) => hash(value).slice(0, 24);
export const hashWeComAuditRef = (value: string): string => hashRef(value);
const SAFE_CODE_PATTERN = /^[a-zA-Z0-9._:-]{1,64}$/;
const SAFE_SKILL_ID_PATTERN = /^[\w.:-]{1,64}$/;
const WECOM_OUTCOME_KINDS = new Set<WeComPrecheckTelemetry['outcomeKind']>([
  'handled',
  'pass',
  'failed',
]);
const WECOM_TARGET_ROLES = new Set<
  NonNullable<WeComPrecheckTelemetry['targetRole']>
>(['marketing', 'training', 'manager_ops', 'reception_ads']);
const WECOM_TIERS = new Set<NonNullable<WeComPrecheckTelemetry['tier']>>([
  'employee',
  'manager',
  'owner',
]);
const WECOM_AGENT_STATUSES = new Set<WeComAgentTurnTelemetry['status']>([
  'success',
  'error',
  'aborted',
]);
const WECOM_OUTBOX_STATUSES = new Set<WeComDeliveryTelemetry['outboxStatus']>([
  'delivered',
  'uncertain',
  'failed',
  'retry_wait',
  'busy',
  'cancelled',
  'lease_lost',
]);
const WECOM_STATES = new Set<WeComDeliveryTelemetry['wecomState']>([
  'accepted',
  'blocked',
  'rejected',
  'unknown',
]);

function sanitizeCode(value: unknown, fallback = 'redacted'): string {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  if (!trimmed) return 'none';
  return SAFE_CODE_PATTERN.test(trimmed) ? trimmed : fallback;
}

function sanitizeSkillIds(ids: unknown): string[] | undefined {
  if (!Array.isArray(ids)) return undefined;
  const sanitized = ids
    .slice(0, 16)
    .map((id) =>
      typeof id === 'string' && SAFE_SKILL_ID_PATTERN.test(id.trim())
        ? id.trim()
        : 'invalid_skill_id',
    );
  return sanitized.length > 0 ? sanitized : undefined;
}

function normalizeDurationMs(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.round(value));
}

function normalizeNonNegativeInt(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.trunc(value));
}

function normalizeOptionalInt(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.max(0, Math.trunc(value));
}

/** Bounded in bytes, not just span count. Official OTLP serialization is used
 * to measure the exact uncompressed request before placing it in memory. */
export class BoundedLangfuseExporter implements SpanExporter {
  readonly metrics = { exported: 0, dropped: 0, failed: 0 };
  private queue: Pending[] = [];
  private queuedBytes = 0;
  private sending = false;
  private closed = false;
  private circuitOpen = false;
  private waiters: (() => void)[] = [];
  constructor(
    private readonly delegate: SpanExporter,
    private readonly maxBytes = 65_536,
    private readonly maxBatches = 64,
    private readonly maxInFlightMs = 3_000,
  ) {}
  export(spans: ReadableSpan[], callback: (result: ExportResult) => void) {
    if (this.closed || this.circuitOpen) {
      this.metrics.dropped += spans.length;
      callback(success);
      return;
    }
    let bytes: number;
    try {
      bytes =
        JsonTraceSerializer.serializeRequest(spans)?.byteLength ?? Infinity;
    } catch {
      this.metrics.dropped += spans.length;
      callback(success);
      return;
    }
    if (
      bytes > this.maxBytes ||
      this.queuedBytes + bytes > this.maxBytes ||
      this.queue.length >= this.maxBatches
    ) {
      this.metrics.dropped += spans.length;
      callback(success);
      return;
    }
    this.queue.push({ spans, bytes, callback });
    this.queuedBytes += bytes;
    queueMicrotask(() => this.pump());
  }
  /** A timed-out delegate is not a healthy outlet. Stop sending it new
   * batches and release everything already queued. The official transport has
   * no abort handle, so keeping the hung request outstanding is the only
   * cancellation available; never stack more requests behind it. */
  private trip() {
    if (this.circuitOpen) return;
    this.circuitOpen = true;
    for (const item of this.queue.splice(0)) {
      this.metrics.dropped += item.spans.length;
      this.queuedBytes -= item.bytes;
      item.callback(success);
    }
    for (const resolve of this.waiters.splice(0)) resolve();
  }
  private pump() {
    if (this.sending) return;
    const item = this.queue.shift();
    if (!item) {
      for (const resolve of this.waiters.splice(0)) resolve();
      return;
    }
    this.sending = true;
    let completed = false;
    const complete = (result: ExportResult, timedOut = false) => {
      if (completed) return;
      completed = true;
      clearTimeout(watchdog);
      if (result.code === ExportResultCode.SUCCESS)
        this.metrics.exported += item.spans.length;
      else this.metrics.failed += item.spans.length;
      this.queuedBytes -= item.bytes;
      this.sending = false;
      item.callback(success); // An observability outage is never a task failure.
      if (timedOut) this.trip();
      this.pump();
    };
    const watchdog = setTimeout(
      () => complete({ code: ExportResultCode.FAILED }, true),
      this.maxInFlightMs,
    );
    watchdog.unref?.();
    try {
      this.delegate.export(item.spans, complete);
    } catch {
      complete({ code: ExportResultCode.FAILED });
    }
  }
  async forceFlush(): Promise<void> {
    if (this.sending || this.queue.length)
      await new Promise<void>((resolve) => this.waiters.push(resolve));
  }
  async shutdown(): Promise<void> {
    this.closed = true;
    for (const item of this.queue.splice(0)) {
      this.metrics.dropped += item.spans.length;
      this.queuedBytes -= item.bytes;
      item.callback(success);
    }
    for (const resolve of this.waiters.splice(0)) resolve();
    // The official delegate flushes its own queue, which would wait forever
    // behind an export that already exhausted the watchdog budget. Shutdown is
    // best-effort once the circuit is open; do not add another blocking flush.
    if (this.circuitOpen) return;
    // The official transport has its own short request timeout. Do not block
    // application shutdown on an unavailable collector.
    await Promise.race([
      this.delegate.shutdown().catch(() => {}),
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 3_000);
        timer.unref?.();
      }),
    ]);
  }
}

export type HostObservabilityOptions = {
  publicKey: string;
  secretKey: string;
  baseUrl: string;
  installationId: string;
  sampleRate: number;
  exporter?: SpanExporter; // isolated tests only; production constructs OTLP.
};
let active: HostObservability | undefined;
export function getHostObservability() {
  return active;
}

export class HostObservability {
  readonly exporter: BoundedLangfuseExporter;
  readonly projectRef: string;
  private readonly scores: LangfuseClient;
  private readonly stoppingScores = new AbortController();
  private provider: BasicTracerProvider;
  private stopped = false;
  constructor(private readonly options: HostObservabilityOptions) {
    if (
      !Number.isFinite(options.sampleRate) ||
      options.sampleRate < 0 ||
      options.sampleRate > 1
    )
      throw new Error('Invalid observability sample rate');
    const parsed = new URL(options.baseUrl);
    if (
      parsed.protocol !== 'https:' ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash ||
      parsed.pathname !== '/'
    )
      throw new Error('Observability requires an HTTPS project origin');
    if (!options.publicKey || !options.secretKey || !options.installationId)
      throw new Error('Observability project credentials unavailable');
    this.projectRef = hash(JSON.stringify([parsed.origin, options.publicKey]));
    this.scores = new LangfuseClient({
      publicKey: options.publicKey,
      secretKey: options.secretKey,
      baseUrl: parsed.origin,
      timeout: 2,
    });
    const auth = Buffer.from(
      `${options.publicKey}:${options.secretKey}`,
    ).toString('base64');
    this.exporter = new BoundedLangfuseExporter(
      options.exporter ??
        new OTLPTraceExporter({
          url: `${parsed.origin}/api/public/otel/v1/traces`,
          headers: {
            Authorization: `Basic ${auth}`,
            'x-langfuse-ingestion-version': '4',
            'x-langfuse-sdk-name': 'javascript',
            'x-langfuse-sdk-version': '6.0.2',
            'x-langfuse-public-key': options.publicKey,
          },
          timeoutMillis: 2_000,
        }),
    );
    this.provider = new BasicTracerProvider({
      spanProcessors: [
        new LangfuseSpanProcessor({
          exporter: this.exporter,
          publicKey: options.publicKey,
          secretKey: options.secretKey,
          baseUrl: parsed.origin,
          mediaUploadEnabled: false,
          exportMode: 'immediate',
          shouldExportSpan: ({ otelSpan }) => otelSpan.name.startsWith('dot.'),
        }),
      ],
    });
    setLangfuseTracerProvider(this.provider);
    active = this;
  }
  async sendFeedbackScore(
    input: FeedbackScoreDispatch,
  ): Promise<'accepted' | 'uncertain' | 'rejected'> {
    if (this.stopped || input.project_ref !== this.projectRef)
      return 'uncertain';
    try {
      const response = await this.scores.api.scores.create(
        [
          {
            id: input.feedback_id,
            traceId: input.trace_id,
            name: 'user_helpful',
            value: input.score === 1 ? 1 : 0,
            dataType: 'BOOLEAN',
            timestamp: input.timestamp,
          },
        ],
        {
          timeoutInSeconds: 2,
          maxRetries: 0,
          abortSignal: this.stoppingScores.signal,
        },
      );
      if ('message' in response && response.message === 'Accepted')
        return 'accepted';
      if (
        'accepted' in response &&
        response.accepted === 1 &&
        response.rejected === 0
      )
        return 'accepted';
      if ('rejected' in response && response.rejected > 0) return 'rejected';
      return 'uncertain';
    } catch {
      return 'uncertain';
    }
  }
  sampled(
    identity: Pick<
      NativeModelIdentity,
      'ownerId' | 'sessionId' | 'inputRequestIds'
    >,
  ): boolean {
    if (
      this.stopped ||
      this.options.sampleRate === 0 ||
      !identity.inputRequestIds.length
    )
      return false;
    const key = [
      this.options.installationId,
      identity.ownerId,
      identity.sessionId,
      ...identity.inputRequestIds,
    ].join(':');
    return (
      parseInt(hash(key).slice(0, 13), 16) / 0x10000000000000 <
      this.options.sampleRate
    );
  }
  memoryOperation(input: {
    ownerId: string;
    sessionId: string;
    inputId: string;
    profileId: string;
    runtime: 'node-durable' | 'coding';
    operation: 'search';
    startedAt: number;
    endedAt: number;
    state: 'completed' | 'failed';
    cache: 'hit' | 'shared' | 'miss';
    resultCount?: number;
    policyVersion: number;
  }) {
    if (
      !this.sampled({
        ownerId: input.ownerId,
        sessionId: input.sessionId,
        inputRequestIds: [input.inputId],
      })
    )
      return;
    if (input.endedAt < input.startedAt) return;
    const span = otelContext.with(ROOT_CONTEXT, () =>
      startObservation(
        'dot.memory.search',
        {
          metadata: {
            owner_ref: hash(
              `${this.options.installationId}:${input.ownerId}`,
            ).slice(0, 24),
            session_id: input.sessionId,
            input_ref: hash(input.inputId).slice(0, 24),
            dot_ref: hash(input.profileId).slice(0, 24),
            runtime: input.runtime,
            operation: input.operation,
            state: input.state,
            cache: input.cache,
            policy_version: input.policyVersion,
            ...(input.resultCount === undefined
              ? {}
              : { result_count: input.resultCount }),
            scope: 'owner_dot_private',
            coverage: 'host_recall',
          },
        },
        { startTime: new Date(input.startedAt) },
      ),
    );
    span.end(new Date(input.endedAt));
  }
  /** Async capture is an independent operation, not a live child of a turn. */
  memoryCapture(input: {
    ownerId: string;
    sessionId: string;
    inputId: string;
    profileId: string;
    runtime: 'node-durable' | 'coding';
    captureId: string;
    attempt: number;
    policyVersion: number;
    startedAt: number;
    endedAt: number;
    state: 'accepted' | 'uncertain' | 'failed' | 'rate_limited';
    eventId: string | null;
  }) {
    if (
      !this.sampled({
        ownerId: input.ownerId,
        sessionId: input.sessionId,
        inputRequestIds: [input.inputId],
      })
    )
      return;
    if (input.endedAt < input.startedAt) return;
    const span = otelContext.with(ROOT_CONTEXT, () =>
      startObservation(
        'dot.memory.add',
        {
          metadata: {
            owner_ref: hash(
              `${this.options.installationId}:${input.ownerId}`,
            ).slice(0, 24),
            session_id: input.sessionId,
            input_ref: hash(input.inputId).slice(0, 24),
            dot_ref: hash(input.profileId).slice(0, 24),
            capture_ref: hash(input.captureId).slice(0, 24),
            runtime: input.runtime,
            attempt: input.attempt,
            policy_version: input.policyVersion,
            state: input.state,
            scope: 'owner_dot_private',
            coverage: 'committed_capture_receipt',
            ...(input.eventId
              ? {
                  event_ref: hash(input.eventId).slice(0, 24),
                  extraction: 'unconfirmed',
                }
              : {}),
          },
        },
        { startTime: new Date(input.startedAt) },
      ),
    );
    span.end(new Date(input.endedAt));
  }
  /** Metadata comes from the committed approval ledger, never model text or
   * a tool result. Independent spans do not claim a live parent across waits. */
  mcpReceipt(approval: McpApproval, phase: 'decision' | 'execution') {
    const source = approval.intent.source;
    const inputIds =
      source.runtime === 'pi-durable'
        ? source.inputs.map((item) => item.request_id)
        : [source.business_turn_id];
    if (
      !this.sampled({
        ownerId: approval.owner_user_id,
        sessionId: approval.session_id,
        inputRequestIds: inputIds,
      })
    )
      return;
    const started =
      phase === 'decision' ? approval.created_at : approval.dispatched_at;
    const ended =
      phase === 'decision' ? approval.decided_at : approval.settled_at;
    if (started === null || ended === null || ended < started) return;
    const span = otelContext.with(ROOT_CONTEXT, () =>
      startObservation(
        phase === 'decision' ? 'dot.mcp.approval' : 'dot.mcp.execution',
        {
          metadata: {
            owner_ref: hash(
              `${this.options.installationId}:${approval.owner_user_id}`,
            ).slice(0, 24),
            session_id: approval.session_id,
            input_refs: inputIds
              .slice(0, 64)
              .map((id) => hash(id).slice(0, 24)),
            call_ref: hash(approval.id).slice(0, 24),
            server_ref: hash(approval.intent.server_id).slice(0, 24),
            tool_ref: hash(approval.intent.original_name).slice(0, 24),
            ...(source.runtime === 'pi-durable'
              ? {
                  generation_task_id: source.generation_task_id,
                  tool_task_id: source.tool_task_id,
                }
              : {
                  coding_tool_call_ref: hash(source.tool_call_id).slice(0, 24),
                }),
            runtime:
              source.runtime === 'pi-durable' ? 'node-durable' : 'coding',
            location: approval.intent.location.kind,
            state: approval.state,
            coverage: 'committed_mcp_ledger',
          },
        },
        { startTime: new Date(started) },
      ),
    );
    span.end(new Date(ended));
  }
  /** Host-received Coding execution events; timestamps are observed latency. */
  codingTool(input: import('./coding-tool-observation.js').CodingToolReceipt) {
    if (
      !this.sampled({
        ownerId: input.ownerId,
        sessionId: input.sessionId,
        inputRequestIds: [input.inputId],
      })
    )
      return;
    const span = otelContext.with(ROOT_CONTEXT, () =>
      startObservation(
        'dot.tool.execution',
        {
          metadata: {
            owner_ref: hash(
              `${this.options.installationId}:${input.ownerId}`,
            ).slice(0, 24),
            session_id: input.sessionId,
            input_ref: hash(input.inputId).slice(0, 24),
            coding_tool_call_ref: hash(input.callId).slice(0, 24),
            runtime: 'coding',
            state: input.state,
            coverage: 'host_observed_stream',
          },
        },
        { startTime: new Date(input.startedAt) },
      ),
    );
    span.end(new Date(input.endedAt));
  }
  /** An SDK stream invocation observed by the host, not an HTTP-attempt count. */
  codingModel(input: import('./coding-tool-observation.js').CodingToolReceipt) {
    if (
      !this.sampled({
        ownerId: input.ownerId,
        sessionId: input.sessionId,
        inputRequestIds: [input.inputId],
      })
    )
      return;
    const span = otelContext.with(ROOT_CONTEXT, () =>
      startObservation(
        'dot.model.sdk_invocation',
        {
          metadata: {
            owner_ref: hash(
              `${this.options.installationId}:${input.ownerId}`,
            ).slice(0, 24),
            session_id: input.sessionId,
            input_ref: hash(input.inputId).slice(0, 24),
            call_ref: hash(input.callId).slice(0, 24),
            runtime: 'coding',
            state: input.state,
            coverage: 'host_observed_sdk_invocation',
            usage_status: 'unknown',
            cost_status: 'unpriced',
          },
        },
        { startTime: new Date(input.startedAt) },
      ),
    );
    span.end(new Date(input.endedAt));
  }
  /** Completed native tool attempts only. Arguments, results, diagnostics and
   * arbitrary MCP names never cross the observability boundary. */
  tool(
    identity: NativeModelIdentity,
    input: {
      taskId: number;
      name: string;
      startedAt: number;
      endedAt: number;
      isError: boolean;
      nested: boolean;
    },
  ) {
    if (!this.sampled(identity)) return;
    const known = new Set([
      'read_workspace_file',
      'read_personal_memory',
      'list_personal_devices',
      'read_device_file',
      'ask_group_dot',
      'read_group_context',
      'create_approved_artifact',
    ]);
    const span = otelContext.with(ROOT_CONTEXT, () =>
      startObservation(
        'dot.tool.execution',
        {
          metadata: {
            session_id: identity.sessionId,
            owner_ref: hash(
              `${this.options.installationId}:${identity.ownerId}`,
            ).slice(0, 24),
            input_refs: identity.inputRequestIds
              .slice(0, 64)
              .map((id) => hash(id).slice(0, 24)),
            conversation_id: identity.conversationId,
            generation_task_id: identity.generationTaskId,
            tool_task_id: input.taskId,
            tool: known.has(input.name) ? input.name : 'other',
            nested: input.nested,
            state: input.isError ? 'error' : 'completed',
            runtime: identity.runtime,
            coverage: 'tool_result_before_commit',
          },
        },
        { startTime: new Date(input.startedAt) },
      ),
    );
    span.end(new Date(input.endedAt));
  }
  model(identity: NativeModelIdentity): ModelRequestObservation | undefined {
    if (!this.sampled(identity)) return undefined;
    const metadata = {
      session_id: identity.sessionId,
      owner_ref: hash(
        `${this.options.installationId}:${identity.ownerId}`,
      ).slice(0, 24),
      input_refs: identity.inputRequestIds
        .slice(0, 64)
        .map((id) => hash(id).slice(0, 24)),
      conversation_id: identity.conversationId,
      generation_task_id: identity.generationTaskId,
      attempt: identity.attempt,
      runtime: identity.runtime,
      coverage: 'node_model',
    };
    let wait: ReturnType<typeof startObservation> | undefined;
    let generation: ReturnType<typeof startObservation> | undefined;
    let waitEnded = false;
    let firstVisible = false;
    let requestAt: number | undefined;
    let sdkInvoked = false;
    const endWait = (state: string, at: number) => {
      if (!wait || waitEnded) return;
      waitEnded = true;
      wait.update({ metadata: { state } });
      wait.end(new Date(at));
    };
    return {
      admitted: (at) => {
        wait = otelContext.with(ROOT_CONTEXT, () =>
          startObservation(
            'dot.model.admission_wait',
            { metadata: { ...metadata, state: 'waiting' } },
            { startTime: new Date(at) },
          ),
        );
      },
      dispatched: (at) => {
        sdkInvoked = true;
        endWait('admitted', at);
      },
      providerRequestStarted: (at) => {
        endWait('admitted', at);
        requestAt = at;
        try {
          const traceId = wait?.otelSpan.spanContext().traceId;
          if (traceId)
            recordObservedInputTrace({
              owner: identity.ownerId,
              session: identity.sessionId,
              requests: identity.inputRequestIds,
              task: identity.generationTaskId,
              attempt: identity.attempt,
              traceId,
              projectRef: this.projectRef,
            });
        } catch {
          /* Optional observability metadata never blocks inference. */
        }
        generation = startObservation(
          'dot.model.generation',
          {
            // Provider-qualified model IDs (for example `provider/model`)
            // are common. Keep the allowlist tight so URLs and query strings
            // cannot accidentally export credentials as a model name.
            model: /^(?=.{1,80}$)[\w.-]+(?:\/[\w.-]+)?$/.test(identity.modelId)
              ? identity.modelId
              : 'custom-model',
            metadata: {
              ...metadata,
              usage_status: 'unknown',
              cost_status: 'unpriced',
            },
          },
          {
            asType: 'generation',
            startTime: new Date(at),
            parentSpanContext: wait?.otelSpan.spanContext(),
          },
        );
      },
      completedTraceId: () =>
        requestAt === undefined
          ? undefined
          : wait?.otelSpan.spanContext().traceId,
      firstVisibleOutput: (at) => {
        if (!generation || firstVisible) return;
        firstVisible = true;
        generation.update({
          metadata: {
            first_visible_output_observed_ms: at - (requestAt ?? at),
            timing_source: 'sdk_visible_event',
          },
        });
      },
      finished: (result: ModelRequestResult, at, requestStarted) => {
        if (!requestStarted) {
          endWait(result.kind, at);
          if (sdkInvoked) {
            const noTransport = startObservation(
              'dot.model.no_transport',
              {
                metadata: {
                  ...metadata,
                  state: result.kind,
                  coverage: 'sdk_without_http',
                },
              },
              { parentSpanContext: wait?.otelSpan.spanContext() },
            );
            noTransport.end();
          }
          return;
        }
        generation?.update({ metadata: { state: result.kind } });
        generation?.end(new Date(at));
      },
    };
  }
  private sampledWeCom(correlationId: string): boolean {
    if (
      this.stopped ||
      this.options.sampleRate === 0 ||
      typeof correlationId !== 'string' ||
      !correlationId.trim()
    )
      return false;
    if (this.options.sampleRate >= 1) return true;
    const key = `${this.options.installationId}:wecom:${correlationId}`;
    return (
      parseInt(hash(key).slice(0, 13), 16) / 0x10000000000000 <
      this.options.sampleRate
    );
  }
  private emitWeComSpan(
    name:
      | 'dot.wecom.precheck'
      | 'dot.wecom.agent_turn'
      | 'dot.wecom.outbound_auth'
      | 'dot.wecom.delivery',
    correlationId: string,
    buildMetadata: () => Record<string, unknown>,
    durationMs?: number,
  ): void {
    try {
      if (!this.sampledWeCom(correlationId)) return;
      const endedAt = Date.now();
      const normalizedDurationMs =
        durationMs === undefined ? 0 : normalizeDurationMs(durationMs);
      const startedAt = endedAt - normalizedDurationMs;
      const metadata = buildMetadata();
      const span = otelContext.with(ROOT_CONTEXT, () =>
        startObservation(
          name,
          { metadata },
          { startTime: new Date(startedAt) },
        ),
      );
      span.end(new Date(endedAt));
    } catch {
      /* Observability degradation must never block WeCom message handling. */
    }
  }
  /** Redacted WeCom precheck decision span correlated by hashed correlationId. */
  wecomPrecheck(input: WeComPrecheckTelemetry): void {
    this.emitWeComSpan(
      'dot.wecom.precheck',
      input.correlationId,
      () => {
        const storeRef =
          typeof input.storeId === 'string' && input.storeId.trim()
            ? hashRef(input.storeId.trim())
            : undefined;
        return {
          channel: 'wecom',
          correlation_ref: hashRef(input.correlationId),
          bot_ref: hashRef(input.botId),
          member_ref: hashRef(input.memberId),
          ...(storeRef ? { store_ref: storeRef } : {}),
          route: sanitizeCode(input.route),
          gate_reason: sanitizeCode(input.gateReason),
          model_ms: normalizeDurationMs(input.modelMs),
          error_category: sanitizeCode(input.errorCategory),
          outcome_kind: WECOM_OUTCOME_KINDS.has(input.outcomeKind)
            ? input.outcomeKind
            : 'failed',
          ...(input.targetRole && WECOM_TARGET_ROLES.has(input.targetRole)
            ? { target_role: input.targetRole }
            : {}),
          ...(input.tier && WECOM_TIERS.has(input.tier)
            ? { tier: input.tier }
            : {}),
          ...(input.readonlyContextInjected === undefined
            ? {}
            : {
                readonly_context_injected: Boolean(
                  input.readonlyContextInjected,
                ),
              }),
        };
      },
      input.modelMs,
    );
  }
  /** Redacted WeCom OpenDot Agent turn telemetry span. */
  wecomAgentTurn(input: WeComAgentTurnTelemetry): void {
    this.emitWeComSpan(
      'dot.wecom.agent_turn',
      input.correlationId,
      () => {
        const profileRef =
          typeof input.profileId === 'string' && input.profileId.trim()
            ? hashRef(input.profileId.trim())
            : undefined;
        const skillIds = sanitizeSkillIds(input.skillIds);
        const selectedSkillIds = sanitizeSkillIds(
          input.selectedSkillIds ?? input.loadedSkillIds,
        );
        const batchReadonlyMarked =
          input.batchReadonlyContextMarked ?? input.readonlyContextInjected;
        const coveredRefs = Array.isArray(input.coveredCorrelationIds)
          ? [
              ...new Set(
                input.coveredCorrelationIds
                  .filter(
                    (id): id is string =>
                      typeof id === 'string' && id.trim().length > 0,
                  )
                  .slice(0, 20)
                  .map((id) => hashRef(id.trim())),
              ),
            ]
          : undefined;
        const inputTokens = normalizeOptionalInt(input.inputTokens);
        const outputTokens = normalizeOptionalInt(input.outputTokens);
        return {
          channel: 'wecom',
          correlation_ref: hashRef(input.correlationId),
          ...(coveredRefs && coveredRefs.length > 0
            ? { covered_correlation_refs: coveredRefs }
            : {}),
          workspace_ref: hashRef(input.workspaceFolder),
          ...(profileRef ? { profile_ref: profileRef } : {}),
          ...(skillIds ? { skill_ids: skillIds } : {}),
          ...(selectedSkillIds
            ? {
                selected_skill_ids: selectedSkillIds,
                loaded_skill_ids: selectedSkillIds,
                skill_evidence_level: 'workspace_manifest_selection',
              }
            : {}),
          ...(batchReadonlyMarked === undefined
            ? {}
            : {
                batch_readonly_context_marked: Boolean(batchReadonlyMarked),
                readonly_context_injected: Boolean(batchReadonlyMarked),
              }),
          duration_ms: normalizeDurationMs(input.durationMs),
          status: WECOM_AGENT_STATUSES.has(input.status)
            ? input.status
            : 'error',
          ...(inputTokens === undefined ? {} : { input_tokens: inputTokens }),
          ...(outputTokens === undefined
            ? {}
            : { output_tokens: outputTokens }),
        };
      },
      input.durationMs,
    );
  }
  /** Redacted WeCom outbound send authorization telemetry span. */
  wecomOutboundAuth(input: WeComOutboundAuthTelemetry): void {
    this.emitWeComSpan('dot.wecom.outbound_auth', input.correlationId, () => {
      const policyVersion = normalizeOptionalInt(input.policyVersion);
      return {
        channel: 'wecom',
        correlation_ref: hashRef(input.correlationId),
        bot_ref: hashRef(input.botId),
        member_ref: hashRef(input.memberId),
        allowed: Boolean(input.allowed),
        reason: sanitizeCode(input.reason),
        ...(policyVersion === undefined
          ? {}
          : { policy_version: policyVersion }),
      };
    });
  }
  /** Redacted WeCom delivery & outbox settlement telemetry span. */
  wecomDelivery(input: WeComDeliveryTelemetry): void {
    const durationMs = normalizeOptionalInt(input.durationMs);
    this.emitWeComSpan(
      'dot.wecom.delivery',
      input.correlationId,
      () => ({
        channel: 'wecom',
        correlation_ref: hashRef(input.correlationId),
        bot_ref: hashRef(input.botId),
        outbox_status: WECOM_OUTBOX_STATUSES.has(input.outboxStatus)
          ? input.outboxStatus
          : 'failed',
        wecom_state: WECOM_STATES.has(input.wecomState)
          ? input.wecomState
          : 'unknown',
        chunk_count: normalizeNonNegativeInt(input.chunkCount),
        ...(durationMs === undefined ? {} : { duration_ms: durationMs }),
      }),
      durationMs,
    );
  }
  async flush() {
    await this.provider.forceFlush();
  }
  async close() {
    if (this.stopped) return;
    this.stopped = true;
    this.stoppingScores.abort();
    if (active === this) active = undefined;
    setLangfuseTracerProvider(null);
    await Promise.race([
      this.provider.forceFlush().catch(() => {}),
      new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 3_000);
        t.unref?.();
      }),
    ]);
    await this.provider.shutdown().catch(() => {});
  }
}

export function observeWeComPrecheck(input: WeComPrecheckTelemetry): void {
  try {
    active?.wecomPrecheck(input);
  } catch {
    /* Silent no-op when observability is unconfigured or degraded. */
  }
}

export function observeWeComAgentTurn(input: WeComAgentTurnTelemetry): void {
  try {
    active?.wecomAgentTurn(input);
  } catch {
    /* Silent no-op when observability is unconfigured or degraded. */
  }
}

export function observeWeComOutboundAuth(
  input: WeComOutboundAuthTelemetry,
): void {
  try {
    active?.wecomOutboundAuth(input);
  } catch {
    /* Silent no-op when observability is unconfigured or degraded. */
  }
}

export function observeWeComDelivery(input: WeComDeliveryTelemetry): void {
  try {
    active?.wecomDelivery(input);
  } catch {
    /* Silent no-op when observability is unconfigured or degraded. */
  }
}
