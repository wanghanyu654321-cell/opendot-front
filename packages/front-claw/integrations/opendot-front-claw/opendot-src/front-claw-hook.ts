/**
 * Front Claw 薄挂点（M07，新增到 OpenDot src/）。默认关闭：只有 FRONT_CLAW_OPENDOT_ADAPTER=1 且
 * FRONT_CLAW_OPENDOT_MODULE 是绝对路径时，才动态加载外部 Front Claw 模块（qiwe-agent 构建产物 dist/opendot/index.js）。
 * 失败只记日志，OpenDot 照常启动。不改 IMChannel、不进 task-scheduler、不碰 Mem0；只 import node 内置模块。
 * R3（A-P1-2）：本函数立即返回句柄（Promise 立即兑现），不等待 Front Claw——OpenDot 先完成自己的启动；Front Claw 模块在下一轮事件循环才开始加载。
 * 动态 import、模块顶层初始化、入口 start 三段共用一个启动预算（FRONT_CLAW_OPENDOT_START_TIMEOUT_MS，默认 15000，1..120000）；
 * 超时 → 标记 unavailable 并以 alert 字段告警，迟到的成功结果立即 close()（释放租约、关 DB）。
 * 限制：模块初始化若是同步死循环，会占住同一进程的事件循环，计时器和 OpenDot 都无法运行——这只能靠 worker 线程或子进程隔离（未做，见 R3 REPORT）。
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

interface HookLogger {
  info(fields: Record<string, unknown>, message?: string): void;
  warn(fields: Record<string, unknown>, message?: string): void;
}
export interface FrontClawHostService {
  close(): Promise<void>;
}
export type FrontClawHookState = 'off' | 'loading' | 'active' | 'unavailable' | 'closed';
export interface FrontClawHostHandle extends FrontClawHostService {
  /** 当前状态：off（未开启）/ loading / active / unavailable（失败或超时）/ closed。 */
  state(): FrontClawHookState;
  /** 加载结果：active 时为适配器服务，否则 null。永不 reject。 */
  ready(): Promise<FrontClawHostService | null>;
}
const DEFAULT_START_TIMEOUT_MS = 15_000;
const ALERT = 'front_claw_unavailable';
function startTimeout(raw: string | undefined): number {
  const value = Number(raw?.trim());
  return raw !== undefined && Number.isInteger(value) && value >= 1 && value <= 120_000 ? value : DEFAULT_START_TIMEOUT_MS;
}
function settled(state: FrontClawHookState): FrontClawHostHandle {
  return { state: () => state, ready: async () => null, close: async () => {} };
}

/** 立即兑现（不等待 Front Claw 加载）；OpenDot 里的 `await startFrontClawHook(logger)` 只让出一个微任务。 */
export async function startFrontClawHook(
  logger: HookLogger,
  env: NodeJS.ProcessEnv = process.env,
): Promise<FrontClawHostHandle> {
  return startFrontClawHookNow(logger, env);
}
function startFrontClawHookNow(logger: HookLogger, env: NodeJS.ProcessEnv): FrontClawHostHandle {
  if (env.FRONT_CLAW_OPENDOT_ADAPTER?.trim() !== '1') return settled('off');
  const modulePath = env.FRONT_CLAW_OPENDOT_MODULE?.trim() ?? '';
  if (!path.isAbsolute(modulePath)) {
    logger.warn({ alert: ALERT }, 'Front Claw adapter enabled without an absolute module path; staying off');
    return settled('unavailable');
  }
  const budgetMs = startTimeout(env.FRONT_CLAW_OPENDOT_START_TIMEOUT_MS);
  let state: FrontClawHookState = 'loading';
  let stage: 'deferred' | 'import' | 'start' = 'deferred';
  let service: FrontClawHostService | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = Symbol('timeout');
  const deadline = new Promise<typeof timedOut>(resolve => { timer = setTimeout(() => resolve(timedOut), budgetMs); });
  // 延后到下一轮事件循环再加载：OpenDot 当前的启动步骤先跑完。
  const loading = new Promise<void>(resolve => setImmediate(resolve)).then(async () => {
    stage = 'import';
    const mod = (await import(pathToFileURL(modulePath).href)) as {
      startFrontClawOpenDotService?: (host: { logger: HookLogger; env: NodeJS.ProcessEnv }) => Promise<FrontClawHostService>;
    };
    if (typeof mod.startFrontClawOpenDotService !== 'function') throw new Error('front_claw_entry_missing');
    stage = 'start';
    return mod.startFrontClawOpenDotService({ logger, env });
  });
  const lateClose = (late: FrontClawHostService) => late.close().catch(err => logger.warn({ err }, 'Front Claw adapter late close failed'));
  const ready = Promise.race([loading, deadline]).then(first => {
    if (timer) clearTimeout(timer);
    if (first === timedOut) {
      if (state === 'loading') state = 'unavailable';
      logger.warn({ alert: ALERT, stage, budgetMs }, 'Front Claw adapter start timed out; marked unavailable, OpenDot continues without it');
      loading.then(lateClose, () => {});
      return null;
    }
    if (state !== 'loading') { void lateClose(first); return null; } // 加载期间已 close
    service = first; state = 'active';
    return first;
  }, (err: unknown) => {
    if (timer) clearTimeout(timer);
    if (state === 'loading') state = 'unavailable';
    logger.warn({ err, alert: ALERT, stage }, 'Front Claw adapter failed to start; OpenDot continues without it');
    return null;
  });
  return {
    state: () => state,
    ready: () => ready,
    async close() {
      const current = service;
      state = 'closed'; service = null;
      if (current) await current.close();
    },
  };
}
