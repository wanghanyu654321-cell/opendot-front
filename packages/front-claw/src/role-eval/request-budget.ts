/**
 * M02 请求预算：每个请求一个统一截止时间和唯一终态。
 * - 终态：completed / failed / timeout / cancelled，只结算一次；迟到结果只记录，不再投递。
 * - 同请求号同内容：进行中则共享同一个结果；已 completed 的直接返回原终态并标记 duplicate，
 *   调用方据此不再投递。timeout/failed/cancelled 不缓存，原消息重发会重新进入业务（业务侧自己幂等），
 *   这样“结果未知”可以靠重发原确认或按原操作号查回。
 * 仅进程内；跨重启的去重仍由 PG 草稿/操作号与全局消息指纹负责。
 */
export type TerminalState = 'completed' | 'failed' | 'timeout' | 'cancelled';
export interface WorkResult {
  reply: string; operationId?: string; ledgerSettled?: boolean;
  /** R1：结果来自哪个入口及其依赖的能力（缓存命中时复核用）。 */
  target?: 'store' | 'marketing';
  /** A composite reply may require one more capability on the same store scope. */
  access?: { capability: import('./access-policy.js').Capability | null; additionalCapability?: import('./access-policy.js').Capability; storeIds: string[]; identity?: { personId: string; policyVersion: number } };
}
export interface Terminal extends WorkResult { requestId: string; state: TerminalState; elapsedMs: number; }
export interface BudgetRun { terminal: Terminal; duplicate: boolean; }
export const DEFAULT_REQUEST_BUDGET_MS = 15_000;

export function createRequestBudget(options: {
  budgetMs?: number | undefined; now?: () => number; maxEntries?: number;
  onLate?: (requestId: string, outcome: { ok: true; result: WorkResult } | { ok: false }) => void;
} = {}) {
  const budgetMs = options.budgetMs ?? DEFAULT_REQUEST_BUDGET_MS;
  const now = options.now ?? (() => performance.now());
  const maxEntries = options.maxEntries ?? 2000;
  const completed = new Map<string, { fingerprint: string; terminal: Terminal }>();
  const inflight = new Map<string, { fingerprint: string; promise: Promise<Terminal> }>();
  const delivered = new Set<string>();
  const remember = (key: string, value: { fingerprint: string; terminal: Terminal }) => {
    completed.set(key, value);
    while (completed.size > maxEntries) completed.delete(completed.keys().next().value!);
  };

  async function execute(requestId: string, parent: { signal?: AbortSignal | undefined; deadline?: number | undefined },
    work: (child: { signal: AbortSignal; deadline: number }) => Promise<WorkResult>,
    onUnsettled: (state: Exclude<TerminalState, 'completed'>) => WorkResult): Promise<Terminal> {
    const started = now();
    const deadline = Math.min(parent.deadline ?? Infinity, started + budgetMs);
    const child = new AbortController();
    let settled = false;
    return await new Promise<Terminal>(resolve => {
      const finish = (state: TerminalState, result: WorkResult) => {
        if (settled) return false;
        settled = true; clearTimeout(timer); parent.signal?.removeEventListener('abort', onAbort);
        if (state !== 'completed') child.abort();
        resolve(Object.freeze({ ...result, requestId, state, elapsedMs: now() - started }));
        return true;
      };
      const onAbort = () => finish('cancelled', onUnsettled('cancelled'));
      const timer = setTimeout(() => finish('timeout', onUnsettled('timeout')), Math.max(0, deadline - now()));
      if (parent.signal?.aborted) { onAbort(); return; }
      if (now() >= deadline) { finish('timeout', onUnsettled('timeout')); return; }
      parent.signal?.addEventListener('abort', onAbort, { once: true });
      let promise: Promise<WorkResult>;
      try { promise = Promise.resolve(work({ signal: child.signal, deadline })); }
      catch (error) { promise = Promise.reject(error); }
      promise.then(
        result => { if (!finish('completed', result)) try { options.onLate?.(requestId, { ok: true, result }); } catch { /* 观测 */ } },
        () => { if (!finish('failed', onUnsettled('failed'))) try { options.onLate?.(requestId, { ok: false }); } catch { /* 观测 */ } },
      );
    });
  }

  return {
    budgetMs,
    async run(requestId: string, fingerprint: string, parent: { signal?: AbortSignal | undefined; deadline?: number | undefined },
      work: (child: { signal: AbortSignal; deadline: number }) => Promise<WorkResult>,
      onUnsettled: (state: Exclude<TerminalState, 'completed'>) => WorkResult): Promise<BudgetRun> {
      const done = completed.get(requestId);
      if (done && done.fingerprint === fingerprint) return { terminal: done.terminal, duplicate: true };
      const running = inflight.get(requestId);
      if (running && running.fingerprint === fingerprint) return { terminal: await running.promise, duplicate: true };
      // 同号不同内容不复用任何结果，交业务侧判冲突；不覆盖原请求的登记。
      const key = done || running ? `${requestId}#${fingerprint}` : requestId;
      const promise = execute(requestId, parent, work, onUnsettled);
      inflight.set(key, { fingerprint, promise });
      try {
        const terminal = await promise;
        if (terminal.state === 'completed') remember(key, { fingerprint, terminal });
        return { terminal, duplicate: false };
      } finally { inflight.delete(key); }
    },
    /** 同一请求号的同一最终回复只投递一次；重发后得到的新终态（如结果未知→已入账）仍可投递。 */
    claimDelivery(terminal: Terminal): boolean {
      const key = JSON.stringify([terminal.requestId, terminal.state, terminal.reply]);
      if (delivered.has(key)) return false;
      delivered.add(key);
      while (delivered.size > maxEntries * 2) delivered.delete(delivered.values().next().value!);
      return true;
    },
  };
}
export type RequestBudget = ReturnType<typeof createRequestBudget>;
