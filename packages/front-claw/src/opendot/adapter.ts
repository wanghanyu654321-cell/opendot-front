import { snapshotBinding, sameBinding, type WecomBotBinding } from '../role-eval/wecom-bot-bindings.js';
import { capturePendingArrival } from '../role-eval/pending-order.js';
import { createHash, randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { CAPABILITIES, type Capability } from '../role-eval/access-policy.js';
import { bootFrontClaw, type FrontClawBoot } from '../role-eval/front-claw-boot.js';
import { createBotNotificationSender } from '../role-eval/notification-dispatch.js';
import type { OpenedPerformanceStore } from '../role-eval/performance-open.js';
import { UNBOUND, type SendResult } from '../role-eval/wecom-bot-unified-handler.js';
import { createConsumerLease, type ConsumerLease } from './consumer-lease.js';
import { fenceHolds, parseLeaseRecord, type Fence } from '../role-eval/fencing.js';
import { loadOperationRecord, parseOperationRecord, OPERATION_RECORD_PREFIX, saveOperationRecord, type OperationRecord } from '../role-eval/operation-records.js';
import { consumerWrites } from '../role-eval/consumer-writes.js';
import type { ModelClassifier } from '../role-eval/model-classify.js';
import { stubModelClassifier } from '../role-eval/model-classify.js';
import type { MessageObservation } from '../role-eval/employee-entry.js';
import {
  FRONT_CLAW_OPERATION_PREFIX, OPENDOT_ADAPTER_FLAG, OPENDOT_PLATFORM_CAPABILITIES,
  type OpenDotHost, type OpenDotHostService,
} from './host-contract.js';
import { assertMem0Off } from './mem0-off.js';
import { wecomChannelFromEnv, type ChannelSendState, type FrontClawChannel, type InboundText } from './wecom-channel.js';

export type AdapterState = 'disabled' | 'standby' | 'active' | 'closed';
export type OperationState = 'not_ours' | 'not_found' | 'running' | 'completed' | 'failed' | 'timeout' | 'cancelled' | 'interrupted';
/** 一次企微消息的操作报告。取消只报告真实状态，不撤销已入账的账目。 */
export interface OperationReport {
  operationId: string; state: OperationState;
  messageId?: string; businessOperationId?: string; ledgerSettled?: boolean; draftStatus?: string; replyState?: ChannelSendState;
}
export interface AdapterStats { handled: number; duplicate: number; droppedStale: number; droppedClosing: number; unbound: number; rejectedFrames: number; channelRebuilds: number }
export interface FrontClawOpenDotService extends OpenDotHostService {
  state(): AdapterState;
  result(operationId: string): Promise<OperationReport>;
  cancel(operationId: string): Promise<OperationReport>;
  /** 一轮：抢/续租约，按结果开/停入站，通道掉线超时重建。生产由定时器驱动。 */
  tick(): Promise<void>;
  idle(operationId?: string): Promise<void>;
  stats(): AdapterStats;
  readonly owner: string;
}
export interface AdapterDeps {
  /** Optional extraction port; captured at startup, never given a store or write tools. */
  modelClassify?: ModelClassifier;
  modelClassifyTimeoutMs?: number;
  /** 通道工厂；缺省为生产企微长连接（假设 A2，凭据 env）。每次拿到租约新建一个。 */
  channel?: () => FrontClawChannel;
  /** 测试：注入已打开的存储（内存 SQL 替身）；缺省按 env 打开 PG。 */
  open?: () => Promise<OpenedPerformanceStore>;
  now?: () => Date;
  owner?: string;
  leaseMs?: number; renewMs?: number; requestTimeoutMs?: number; graceMs?: number; channelDownMs?: number;
  dispatchIntervalMs?: number; maintenanceIntervalMs?: number;
  /** false：不启动定时器，由调用方手动 tick()（测试）。 */
  timers?: boolean;
}

const sha = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
/** 同一条企微消息 → 同一个操作 ID（跨进程一致）；与 OpenDot goal-run:<claimId> 不相交。 */
export function operationIdFor(event: Pick<InboundText, 'botId' | 'corpId' | 'memberId' | 'messageId'>): string {
  return FRONT_CLAW_OPERATION_PREFIX + sha([event.botId, event.corpId ?? '', event.memberId, event.messageId]).slice(0, 40);
}
export function isFrontClawOperation(id: string): boolean {
  return typeof id === 'string' && /^front-claw:[0-9a-f]{40}$/.test(id);
}
/** 平台层能力：未设 = 不收窄（undefined）；设了必须全是已知 M03 能力名，否则拒绝启动。空串 = 全部收掉。 */
export function parsePlatformCapabilities(raw: string | undefined): readonly Capability[] | undefined {
  if (raw === undefined) return undefined;
  const names = raw.split(',').map(name => name.trim()).filter(Boolean);
  const known = new Set<string>(CAPABILITIES);
  if (names.some(name => !known.has(name))) throw Error('invalid_platform_capabilities');
  return Object.freeze([...new Set(names)] as Capability[]);
}

const emptyStats = (): AdapterStats => ({ handled: 0, duplicate: 0, droppedStale: 0, droppedClosing: 0, unbound: 0, rejectedFrames: 0, channelRebuilds: 0 });
function disabledService(): FrontClawOpenDotService {
  let closed = false;
  const report = async (operationId: string): Promise<OperationReport> => ({ operationId, state: isFrontClawOperation(operationId) ? 'not_found' : 'not_ours' });
  return {
    owner: 'disabled', state: () => closed ? 'closed' : 'disabled', result: report, cancel: report,
    tick: async () => {}, idle: async () => {}, stats: emptyStats, async close() { closed = true; },
  };
}

interface Op { id: string; messageId: string; state: OperationState; controller: AbortController; ledgerSettled?: boolean; replyState?: ChannelSendState; fence?: Fence; persisted?: boolean }

/**
 * OpenDot 宿主服务入口（形状同 startBotHandoffService：返回带 close() 的对象，宿主在 shutdown Phase 1 关闭）。
 * 默认关：FRONT_CLAW_OPENDOT_ADAPTER 不是 "1" 时不开 PG、不连企微、不读凭据。
 * 开启后：Mem0 检查 → 平台能力 → bootFrontClaw（员工入口 + M03 访问策略，复用 M01–M06）→ 单消费者租约 → 企微通道。
 * 适配器不直接写账本：每条消息都经 handler.handleMessage，由 M03 在每一步按最新策略重判（平台层只能收窄）。
 */
export async function startFrontClawOpenDotService(host: OpenDotHost, deps: AdapterDeps = {}): Promise<FrontClawOpenDotService> {
  deps = { ...deps };
  const env = host.env;
  if (env[OPENDOT_ADAPTER_FLAG]?.trim() !== '1') {
    host.logger.info({ state: 'disabled' }, 'Front Claw adapter disabled');
    return disabledService();
  }
  assertMem0Off(env);
  const platform = parsePlatformCapabilities(env[OPENDOT_PLATFORM_CAPABILITIES]);
  const now = deps.now ?? (() => new Date());
  const leaseMs = deps.leaseMs ?? 30_000, renewMs = deps.renewMs ?? 10_000;
  const requestTimeoutMs = deps.requestTimeoutMs ?? 15_000, graceMs = deps.graceMs ?? 10_000, channelDownMs = deps.channelDownMs ?? 30_000;
  if (!(leaseMs > renewMs * 1.2) || renewMs < 1) throw Error('invalid_adapter_timing');
  const owner = deps.owner ?? `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
  const createChannel = deps.channel ?? (() => wecomChannelFromEnv(env));

  let channel: FrontClawChannel | undefined;
  let channelOpenedAt = 0;
  let closing = false, closed = false;
  const stats = emptyStats();
  const traces = new Map<string, { operationId?: string; ledgerSettled: boolean }>();
  const ops = new Map<string, Op>();
  const inflight = new Map<string, Promise<void>>();
  const employeeQueues = new Map<string, Promise<void>>();
  const observations = new Map<string, MessageObservation>();
  const remember = (op: Op) => { ops.set(op.id, op); while (ops.size > 5000) { const first = ops.keys().next().value!; if (inflight.has(first)) break; ops.delete(first); } };
  let lease: ConsumerLease | undefined;
  const leaseHeld = () => lease?.held() === true;
  /** R1：回复前核对这条消息领取时的 fencing 仍成立（PG 行 owner/epoch 未变、未到期）；否则不回复。 */
  async function fenceStillHolds(fence: Fence | undefined): Promise<boolean> {
    if (!fence || !leaseHeld() || lease?.fence()?.epoch !== fence.epoch) return false;
    const record = parseLeaseRecord(await boot.store.getConfig(fence.key).catch(() => null));
    return fenceHolds(record, fence, now().getTime());
  }
  const saveOp = async (op: Op) => {
    const trace = traces.get(op.messageId);
    const record: OperationRecord = { state: op.state as OperationRecord['state'], messageId: op.messageId, ledgerSettled: op.ledgerSettled === true || trace?.ledgerSettled === true,
      ...(trace?.operationId ? { businessOperationId: trace.operationId } : {}), ...(op.replyState ? { replyState: op.replyState } : {}) };
    // R3（A-P1-1）：操作记录也带 epoch 写；被接管后的旧持有者写不进（拒绝即放弃，不重试）。
    await saveOperationRecord(consumerWrites(boot.store, op.fence, () => now().getTime()), op.id, record);
  };

  const send = async ({ toPersonId, text }: { toPersonId: string; text: string }): Promise<SendResult> => {
    const current = channel;
    if (!current || !leaseHeld()) return 'not_sent';
    const person = await boot.store.getPerson(toPersonId);
    if (!person) return 'not_sent';
    try {
      const outcome = await current.notify(person.memberId, text, { signal: AbortSignal.timeout(10_000), deadline: performance.now() + 10_000 }, async () => { if (!leaseHeld()) throw Error('lease_lost'); });
      return outcome.state === 'accepted' ? 'sent' : outcome.state === 'blocked' ? 'not_sent' : 'unknown';
    } catch { return 'unknown'; }
  };
  const boot: FrontClawBoot = await bootFrontClaw({
    env, now, employeeLoop: true, accessPolicy: true, send,
    ...(platform ? { platformCapabilities: platform } : {}),
    ...(deps.open ? { open: deps.open } : {}),
    ...(deps.maintenanceIntervalMs ? { maintenanceIntervalMs: deps.maintenanceIntervalMs } : {}),
    // 与现有 pilot 相同：模型端口只回固定闲聊（OpenDot 模型配置复用未做，见报告）。
    model: { complete: async () => ({ type: 'chat', text: 'Front Claw 在。' }) },
    router: { modelClassify: deps.modelClassify ?? stubModelClassifier, modelClassifyTimeoutMs: deps.modelClassifyTimeoutMs ?? 8000,
      onObservation: ({ requestId, ...record }) => { observations.set(requestId, record); } },
    onEmployeeTrace: trace => {
      traces.set(trace.messageId, { ...(trace.operationId ? { operationId: trace.operationId } : {}), ledgerSettled: trace.ledgerSettled });
      while (traces.size > 5000) traces.delete(traces.keys().next().value!);
    },
  });
  lease = createConsumerLease({ store: boot.store, owner, ttlMs: leaseMs, now });
  const notifier = createBotNotificationSender({
    notify: (member, content, scope, beforeSend) => {
      const current = channel;
      if (!current) throw Error('dispatch_not_active');
      return current.notify(member, content, scope, beforeSend);
    },
  }, { active: () => !closing && !!channel && leaseHeld() });

  type Denial = 'missing_domain' | 'no_binding' | 'ambiguous' | 'inactive' | 'mismatch' | 'invalid_directory' | 'permission';
  type Identity = { binding: Readonly<WecomBotBinding>; personId: string };
  async function bindingFor(event: Readonly<InboundText>): Promise<{ identity: Identity } | { reason: Denial }> {
    // Copy before any subsequent await: trusted readers may retain their return references.
    let rows: WecomBotBinding[];
    try { rows = structuredClone(await boot.bindings.listBindings()); } catch { return { reason: 'invalid_directory' }; }
    if (!Array.isArray(rows) || rows.some(row => !row || typeof row !== 'object')) return { reason: 'invalid_directory' };
    const candidates = rows.filter(row => row.botId === event.botId && row.memberId === event.memberId);
    if (!candidates.length) return { reason: 'no_binding' };
    if (candidates.length !== 1) return { reason: 'ambiguous' };
    if (typeof candidates[0]?.corpId !== 'string' || !candidates[0].corpId.trim()) return { reason: 'missing_domain' };
    let binding: Readonly<WecomBotBinding>;
    try { binding = Object.freeze(snapshotBinding(candidates[0])); } catch { return { reason: 'invalid_directory' }; }
    if (!binding.active) return { reason: 'inactive' };
    if (event.corpId !== undefined && event.corpId !== binding.corpId) return { reason: 'mismatch' };
    const person = structuredClone(await boot.store.getPersonByMember(event.memberId));
    if (!person) return { reason: 'mismatch' };
    if (!person.active) return { reason: 'inactive' };
    if (person.memberId !== binding.memberId || person.accountId !== binding.accountId) return { reason: 'mismatch' };
    // Person's public contract has no corpId. If a trusted reader supplies that domain, it must agree.
    if ('corpId' in person && person.corpId !== binding.corpId) return { reason: 'mismatch' };
    const people = structuredClone(await boot.store.listPeople());
    if (people.filter(p => p.memberId === binding.memberId).length !== 1 || people.filter(p => p.accountId === binding.accountId).length !== 1) return { reason: 'ambiguous' };
    const current = people.find(p => p.personId === person.personId);
    if (!current?.active || current.memberId !== binding.memberId || current.accountId !== binding.accountId ||
        'corpId' in current && current.corpId !== binding.corpId) return { reason: 'mismatch' };
    return { identity: { binding, personId: person.personId } };
  }

  function receive(event: InboundText): void {
    event = Object.freeze(structuredClone(event));
    const pendingArrival = boot.handler.employeeLoop ? capturePendingArrival(boot.store) : undefined;
    void pendingArrival?.catch(() => {});
    let denial: Denial | undefined;
    const arrivedAt = event.createTime === undefined ? undefined : new Date(event.createTime * 1000).toISOString();
    const id = operationIdFor(event);
    const deadline = performance.now() + requestTimeoutMs;
    const logInbound = async (reason?: string) => {
      const observation = reason ? undefined : observations.get(event.messageId);
      if (!reason || reason === 'timeout' || reason === 'cancelled' || reason === 'failed') {
        observations.delete(event.messageId);
      }
      const seq = observation?.pendingSequence ?? (await pendingArrival?.catch(() => undefined))?.sequence ?? null;
      try { host.logger.info({ event: 'inbound_message',
        route: observation?.route ?? '追问',
        gateReason: reason ?? observation?.gateReason ?? 'not_applicable',
        pendingSequence: seq,
        modelMs: observation?.modelMs ?? 0,
        ...(denial ? { identityReason: denial } : {}),
        errorCategory: reason === 'failed' ? 'processing_error' : reason === 'timeout' || reason === 'cancelled' ? reason : (observation?.errorCategory ?? 'none') }); } catch { /* Logs cannot change business results. */ }
    };
    if (closing) { stats.droppedClosing++; void logInbound('closing'); return; }
    // 旧消费者（租约本地已过期）不做任何业务写入，也不回复。
    if (!leaseHeld()) { stats.droppedStale++; void logInbound('stale_consumer'); return; }
    if (inflight.has(id)) { stats.duplicate++; void logInbound('duplicate'); return; }
    const fence = lease?.fence() ?? undefined;
    const op: Op = { id, messageId: event.messageId, state: 'running', controller: new AbortController(), ...(fence ? { fence } : {}) };
    const admittedChannel = channel;
    const active = () => !op.controller.signal.aborted && performance.now() < deadline &&
      admittedChannel === channel && (admittedChannel?.current?.(event) ?? admittedChannel?.ready() ?? false);
    const read = <T>(reading: () => Promise<T>): Promise<T> => new Promise((resolve, reject) => {
      let settled = false, timedOut = false;
      const done = () => { settled = true; clearTimeout(timer); op.controller.signal.removeEventListener('abort', stop); };
      const stop = () => {
        if (settled) return;
        op.state = timedOut || performance.now() >= deadline ? 'timeout' : 'cancelled';
        done(); op.controller.abort(); reject(Error('request_budget_exhausted'));
      };
      const timer = setTimeout(() => { timedOut = true; stop(); }, Math.ceil(Math.max(0, deadline - performance.now())));
      if (!active()) { stop(); return; }
      op.controller.signal.addEventListener('abort', stop, { once: true });
      void Promise.resolve().then(() => { if (!active()) throw Error('request_not_active'); return reading(); }).then(value => {
        if (settled) return;
        if (!active()) { stop(); return; }
        done(); resolve(value);
      }, error => { if (!settled) { done(); reject(error); } });
    });
    remember(op);
    const queueKey = sha([event.botId, event.memberId]);
    const previous = employeeQueues.get(queueKey) ?? Promise.resolve();
    let duplicate = false;
    const run = previous.catch(() => {}).then(async () => {
      // R1（M07-01）：处理前按 PG 租约行核对 fencing（本地时钟偏差时 leaseHeld 可能误判）；不成立 → 不做任何业务处理、不回复。
      if (!await read(() => fenceStillHolds(op.fence))) { stats.droppedStale++; op.state = 'cancelled'; return; }
      const raw = await read(() => boot.store.getConfig(OPERATION_RECORD_PREFIX + id));
      const saved = parseOperationRecord(raw);
      if (raw !== null && !saved) throw Error('invalid_operation_record');
      // A fenced consumer may finish a known claimed confirmation; never rerun extraction or an unknown send.
      const actor = saved?.state === 'running' && !saved.replyState && event.text.trim() === '对' ? await read(() => boot.store.getPersonByMember(event.memberId)) : null;
      const resumable = actor && (await read(() => boot.store.listDrafts({ reporterPersonId: actor.personId, storeId: actor.storeId, status: 'confirming' })))
        .some(draft => draft.kind === 'report' && draft.payload.type === 'report' && draft.payload.employeeContext?.memberId === event.memberId && draft.payload.employeeContext.actionMessageId === event.messageId);
      if (saved && !resumable) {
        duplicate = true; stats.duplicate++;
        op.state = saved.state === 'running' ? 'interrupted' : saved.state;
        op.ledgerSettled = saved.ledgerSettled;
        if (saved.replyState) op.replyState = saved.replyState;
        return;
      }
      op.persisted = true; await read(() => saveOp(op));
      let replies: readonly string[];
      const resolved = await read(() => bindingFor(Object.freeze(structuredClone(event))));
      const identity = 'identity' in resolved ? resolved.identity : undefined;
      const binding = identity?.binding;
      const validateBinding = async () => {
        const latest = await read(() => bindingFor(Object.freeze(structuredClone(event))));
        return !!identity && 'identity' in latest && latest.identity.personId === identity.personId && sameBinding(identity.binding, latest.identity.binding);
      };
      if (!binding) { denial = 'reason' in resolved ? resolved.reason : 'invalid_directory'; stats.unbound++; replies = [UNBOUND]; op.state = 'completed'; }
      else {
        const result = await read(() => boot.handler.handleMessage({
          memberId: event.memberId, text: event.text, messageId: event.messageId, arrivedAt, pendingArrival,
          sessionId: sha(['opendot', binding.corpId, event.botId, event.memberId, binding.accountId]),
          binding: Object.freeze(structuredClone(binding)), validateBinding, channelActive: active,
          bindingVersion: binding.version, signal: op.controller.signal, deadline,
          ...(op.fence ? { fence: { ...op.fence } } : {}),
        }));
        op.state = result.state ?? 'completed';
        op.ledgerSettled = result.ledgerSettled === true;
        replies = result.replies;
        stats.handled++;
      }
      const target = channel;
      // R1（M07-01）：被接管/租约过期的旧持有者不回复（结果按 fencing 已被拒绝或由新持有者负责）。
      if (replies.length && target && await read(() => fenceStillHolds(op.fence)) && (!binding || await validateBinding())) {
        // Durable uncertainty is written BEFORE invoking an outbound side effect. Never replay it after a crash.
        op.replyState = 'unknown';
        await read(() => saveOp(op));
        if (!await read(() => fenceStillHolds(op.fence)) || binding && !await validateBinding()) return;
        op.replyState = await read(() => target.reply(Object.freeze(structuredClone(event)), replies.join('\n\n'), { signal: op.controller.signal, deadline }));
      } else if (replies.length) stats.droppedStale++;
    }).catch(() => { if (op.state === 'running') op.state = 'failed'; }).finally(async () => {
      if (op.persisted) await read(() => saveOp(op)).catch(() => {});
      await logInbound(duplicate ? 'duplicate' : op.state === 'failed' || op.state === 'timeout' || op.state === 'cancelled' ? op.state : undefined);
      inflight.delete(id);
      if (employeeQueues.get(queueKey) === run) employeeQueues.delete(queueKey);
    });
    inflight.set(id, run);
    employeeQueues.set(queueKey, run);
  }

  async function report(id: string): Promise<OperationReport> {
    if (!isFrontClawOperation(id)) return { operationId: id, state: 'not_ours' };
    const op = ops.get(id);
    if (!op) {
      // 本进程没见过：查持久记录（重启/另一实例处理过）。
      const saved = await loadOperationRecord(boot.store, id).catch(() => null);
      if (!saved) return { operationId: id, state: 'not_found' };
      const out: OperationReport = { operationId: id, state: saved.state === 'running' ? 'interrupted' : saved.state, messageId: saved.messageId };
      if (saved.replyState) out.replyState = saved.replyState;
      let settled = saved.ledgerSettled;
      if (saved.businessOperationId) {
        out.businessOperationId = saved.businessOperationId;
        const draft = await boot.store.getDraft(saved.businessOperationId).catch(() => null);
        if (draft) { out.draftStatus = draft.status; settled = settled || draft.status === 'confirmed'; }
      }
      out.ledgerSettled = settled;
      return out;
    }
    const trace = traces.get(op.messageId);
    const out: OperationReport = { operationId: id, state: op.state, messageId: op.messageId };
    if (op.replyState) out.replyState = op.replyState;
    let settled = op.ledgerSettled === true || trace?.ledgerSettled === true;
    if (trace?.operationId) {
      out.businessOperationId = trace.operationId;
      const draft = await boot.store.getDraft(trace.operationId).catch(() => null);
      if (draft) { out.draftStatus = draft.status; settled = settled || draft.status === 'confirmed'; }
    }
    out.ledgerSettled = settled;
    return out;
  }

  async function activate() {
    const next = createChannel();
    channel = next; channelOpenedAt = now().getTime();
    try {
      next.open(receive);
    } catch (error) {
      // R1（M07-P2-1）：部分激活失败 → 关通道、释放租约，由调用方决定是否关 DB。
      channel = undefined;
      await next.close().catch(() => {});
      await lease?.release().catch(() => {});
      throw error;
    }
    boot.startNotificationDispatch(notifier, { ...(deps.dispatchIntervalMs ? { intervalMs: deps.dispatchIntervalMs } : {}),
      onEvent: event => { if (event.type === 'unknown_alert' || event.type === 'backlog_alert' || event.type === 'recovered_unknown') host.logger.warn({ type: event.type, kind: event.kind ?? null }, 'Front Claw notification alert'); } });
    host.logger.info({ state: 'active' }, 'Front Claw adapter consuming');
  }
  async function deactivate(reason: string) {
    const current = channel;
    channel = undefined;
    boot.stopNotificationDispatch();
    if (current) { stats.rejectedFrames += current.rejected(); await current.close().catch(() => {}); }
    host.logger[reason === 'closing' ? 'info' : 'warn']({ reason }, 'Front Claw adapter stopped consuming');
  }
  let ticking: Promise<void> | undefined;
  async function tickOnce() {
    if (closing || !lease) return;
    let held = false;
    try { held = await lease.acquire(); } catch { held = false; }
    if (closing) return;
    if (held && !channel) await activate();
    else if (!held && channel) await deactivate('lease_lost');
    else if (held && channel && !channel.ready() && now().getTime() - channelOpenedAt > channelDownMs) {
      stats.channelRebuilds++;
      await deactivate('channel_down');
      await activate();
    }
  }
  const tick = () => (ticking ??= tickOnce().finally(() => { ticking = undefined; }));

  try {
    boot.startMaintenance();
    await tick();
  } catch (error) {
    await deactivate('start_failed').catch(() => {});
    await lease?.release().catch(() => {});
    await boot.close().catch(() => {});
    throw error;
  }
  const timer = deps.timers === false ? undefined : setInterval(() => { void tick().catch(() => {}); }, renewMs);
  timer?.unref?.();

  let closingPromise: Promise<void> | undefined;
  return {
    owner,
    state: () => closed ? 'closed' : channel ? 'active' : 'standby',
    result: report,
    async cancel(id) {
      if (!isFrontClawOperation(id)) return { operationId: id, state: 'not_ours' };
      const op = ops.get(id);
      const running = inflight.get(id);
      if (op && running) { op.controller.abort(); await running; }
      return report(id);
    },
    tick,
    async idle(operationId) {
      if (operationId) { await inflight.get(operationId); return; }
      while (inflight.size) await Promise.allSettled([...inflight.values()]);
    },
    stats: () => ({ ...stats, rejectedFrames: stats.rejectedFrames + (channel?.rejected() ?? 0) }),
    close() {
      return closingPromise ??= (async () => {
        closing = true;
        if (timer) clearInterval(timer);
        await ticking?.catch(() => {});
        // 先等在途（宿主强退 30 秒），超时再中止；中止后按 handler 原规则如实收尾（可能已入账）。
        let graceTimer: ReturnType<typeof setTimeout> | undefined;
        const expired = await Promise.race([
          Promise.allSettled([...inflight.values()]).then(() => false),
          new Promise<boolean>(resolve => { graceTimer = setTimeout(() => resolve(true), graceMs); }),
        ]);
        if (graceTimer) clearTimeout(graceTimer);
        if (expired) for (const op of ops.values()) if (inflight.has(op.id)) op.controller.abort();
        await Promise.allSettled([...inflight.values()]);
        await deactivate('closing').catch(() => {});
        await lease?.release().catch(() => {});
        await boot.close();
        closed = true;
        host.logger.info({ state: 'closed' }, 'Front Claw adapter closed');
      })();
    },
  };
}
