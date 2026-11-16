/**
 * R2：测试专用暂停点（确定性竞态测试用）。
 * - 生产：没有安装钩子，`pausePoint()` 同步返回 undefined，调用方 `const p = pausePoint(...); if (p) await p;`
 *   不产生 await、不读 env、不改变任何时序（有测试）。
 * - 测试：只有在 vitest 进程里（process.env.VITEST 非空）且 NODE_ENV !== 'production' 时才允许安装，否则抛错。
 * 位置（均在“读完数据之后、提交之前”）：
 *   commit-gate:before-commit —— 员工入口读完草稿/人员/策略预检后、调用 commitConfirming* 之前；
 *   send-gate:before-begin    —— 派发器锁外预检读完后、beginNotificationSend 之前；
 *   notify:before-mark        —— 通道返回后、带 fence 的结果写回（标记已发送）之前。
 */
export type PausePointName = 'commit-gate:before-commit' | 'send-gate:before-begin' | 'notify:before-mark';
export interface PauseContext { name: PausePointName; id: string }
type Hook = (context: PauseContext) => Promise<void> | void;

let hooks: Partial<Record<PausePointName, Hook>> | null = null;

export function pausePoint(name: PausePointName, id: string): Promise<void> | undefined {
  if (hooks === null) return undefined;
  const hook = hooks[name];
  if (!hook) return undefined;
  return Promise.resolve(hook({ name, id }));
}

/** 只在测试进程可用；返回卸载函数。 */
export function installPausePoints(next: Partial<Record<PausePointName, Hook>>): () => void {
  if (!process.env.VITEST || process.env.NODE_ENV === 'production') throw Error('pause_points_test_only');
  hooks = { ...next };
  return () => { hooks = null; };
}
export const pausePointsInstalled = (): boolean => hooks !== null;

/** 测试工具：一个可从外部放行的闸门。 */
export function gate(): { reached: Promise<PauseContext>; release(): void; hook: Hook } {
  let arrive!: (context: PauseContext) => void, open!: () => void;
  const reached = new Promise<PauseContext>(resolve => { arrive = resolve; });
  const released = new Promise<void>(resolve => { open = resolve; });
  let used = false;
  return { reached, release: () => open(), hook: async context => { if (used) return; used = true; arrive(context); await released; } };
}
