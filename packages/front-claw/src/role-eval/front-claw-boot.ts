import { capturePendingArrival } from './pending-order.js';
import { statSync } from 'node:fs';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createNotificationDispatcher, DISPATCH_FLAG, type DispatchEvent, type NotificationSender } from './notification-dispatch.js';
import path from 'node:path';
import { applyDirectoryMigration, readSqliteDirectory } from './directory-store.js';
import { FRONT_CLAW_DATABASE_URL, openPerformanceStore, type OpenedPerformanceStore } from './performance-open.js';
import type { PerformanceStore } from './performance-store.js';
import { createWecomBotHandler, LegacyEntryDisabled, legacyEntryAllowed, type WecomBotHandlerOptions } from './wecom-bot-unified-handler.js';
import type { StoreBusinessActor, StoreBusinessPort } from './wecom-bot-handler.js';

/** Base SQLite file holding employee bindings and people aliases. Optional. */
export const FRONT_CLAW_SQLITE_PATH = 'FRONT_CLAW_SQLITE_PATH';
export const MAINTENANCE_INTERVAL_MS = 90_000;

export interface FrontClawBoot {
  driver: OpenedPerformanceStore['driver'];
  /** present when this checkout has integrations/native; absent on the current live base. */
  native: 'present' | 'absent';
  store: OpenedPerformanceStore['store'];
  bindings: OpenedPerformanceStore['bindings'];
  handler: ReturnType<typeof createWecomBotHandler>;
  migrated: { bindings: number; aliases: number };
  startMaintenance(): void;
  /**
   * M06：启动持久通知派发（出站箱）。只有 env FRONT_CLAW_NOTIFY_DISPATCH=1 且员工入口 + 访问策略模式时才启动，
   * 否则返回 'disabled' 且不发送任何消息（默认关闭）。发送器由调用方注入（生产为现有长连接 notify 的适配）。
   */
  startNotificationDispatch(sender: NotificationSender, options?: { intervalMs?: number; onEvent?: (event: DispatchEvent) => void }): 'started' | 'disabled' | 'already';
  /** M07：停止派发定时器（适配器丢失单消费者租约时调用；已领取的行按 M06 租约到期恢复）。 */
  stopNotificationDispatch(): void;
  close(): Promise<void>;
}
export const NOTIFY_DISPATCH_INTERVAL_MS = 30_000;

/** Feature-detect the optional native overlay. A missing directory does not throw. */
export function nativeIntegrationStatus(root = process.cwd()): 'present' | 'absent' {
  try {
    return statSync(path.join(root, 'integrations', 'native', 'conversation-overlay.mjs')).isFile() ? 'present' : 'absent';
  } catch {
    return 'absent';
  }
}

/**
 * Open the performance store and the unified assistant.
 * Postgres is used only when FRONT_CLAW_DATABASE_URL is set. Otherwise the memory store is the fallback.
 * Existing SQLite bindings and aliases are copied once; a second call does not insert them again.
 */
export async function bootFrontClaw(options: {
  env?: Record<string, string | undefined>;
  now?: () => Date;
  send: WecomBotHandlerOptions['send'];
  model: WecomBotHandlerOptions['model'];
  root?: string;
  maintenanceIntervalMs?: number;
  employeeLoop?: boolean;
  /** M03：访问策略模式，必须与 employeeLoop 同开；开启后人员 tier 只来自目录，SDK 角色不再写回人员档案。 */
  accessPolicy?: boolean;
  onEmployeeTrace?: WecomBotHandlerOptions['onEmployeeTrace'];
  router?: WecomBotHandlerOptions['router'];
  /** R3a（D99）：旧入口开关，默认关闭；仅 employeeLoop 未开时有意义。 */
  legacyEntry?: WecomBotHandlerOptions['legacyEntry'];
  onLegacyWarn?: WecomBotHandlerOptions['onLegacyWarn'];
  /** M07：平台层（OpenDot 部署配置）能力，作为 M03 decideAccess 的最后一层，只能收窄。 */
  platformCapabilities?: WecomBotHandlerOptions['platformCapabilities'];
  /** M07：已打开的存储（测试注入内存 SQL 替身）；缺省按 env 打开。 */
  open?: () => Promise<OpenedPerformanceStore>;
}): Promise<FrontClawBoot> {
  const env = options.env ?? process.env;
  const employeeLoop = options.employeeLoop === true;
  const accessPolicy = options.accessPolicy === true;
  if (accessPolicy && !employeeLoop) throw Error('invalid_access_policy_assembly');
  // R4（D99）：旧入口开关在打开存储和目录迁移之前判定。关闭时启动前零 DB 副作用。
  if (!employeeLoop && !legacyEntryAllowed({ ...(options.legacyEntry !== undefined ? { legacyEntry: options.legacyEntry } : {}), env })) {
    throw new LegacyEntryDisabled();
  }
  const opened = options.open ? await options.open() : await openPerformanceStore(env, { requirePostgres: employeeLoop });
  try {
    const sqlitePath = env[FRONT_CLAW_SQLITE_PATH]?.trim() ?? '';
    const migrated = sqlitePath
      ? await applyDirectoryMigration({ store: opened.store, bindings: opened.bindings }, readSqliteDirectory(sqlitePath))
      : { bindings: 0, aliases: 0 };
    const handler = createWecomBotHandler({
      mode: 'isolated-synthetic',
      employeeLoop,
      ...(accessPolicy ? { accessPolicy: true } : {}),
      ...(options.onEmployeeTrace ? { onEmployeeTrace: options.onEmployeeTrace } : {}),
      ...(options.router ? { router: options.router } : {}),
      ...(options.platformCapabilities ? { platformCapabilities: options.platformCapabilities } : {}),
      ...(options.legacyEntry !== undefined ? { legacyEntry: options.legacyEntry } : {}),
      env,
      store: opened.store,
      now: options.now ?? (() => new Date()),
      resolve: memberId => opened.store.getPersonByMember(memberId),
      send: options.send,
      model: options.model,
      ...(options.onLegacyWarn ? { onLegacyWarn: options.onLegacyWarn } : {}),
    });
    let timer: ReturnType<typeof setInterval> | undefined;
    let closing: Promise<void> | undefined;
    let dispatchTimer: ReturnType<typeof setInterval> | undefined;
    const dispatchEnabled = env[DISPATCH_FLAG]?.trim() === '1' && employeeLoop && accessPolicy;
    return {
      driver: opened.driver,
      native: nativeIntegrationStatus(options.root),
      store: opened.store,
      bindings: opened.bindings,
      handler,
      migrated,
      startMaintenance() {
        if (timer) return;
        const interval = options.maintenanceIntervalMs ?? MAINTENANCE_INTERVAL_MS;
        if (!Number.isInteger(interval) || interval < 1 || interval > 600_000) throw Error('invalid_front_claw_maintenance');
        timer = setInterval(() => { void handler.runMaintenance().catch(() => {}); }, interval);
        timer.unref?.();
      },
      startNotificationDispatch(sender, dispatchOptions = {}) {
        if (!dispatchEnabled) return 'disabled';
        if (dispatchTimer) return 'already';
        const interval = dispatchOptions.intervalMs ?? NOTIFY_DISPATCH_INTERVAL_MS;
        if (!Number.isInteger(interval) || interval < 1_000 || interval > 600_000) throw Error('invalid_front_claw_dispatch');
        const dispatcher = createNotificationDispatcher({ store: opened.store, sender, now: options.now ?? (() => new Date()),
          worker: `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`, ...(dispatchOptions.onEvent ? { onEvent: dispatchOptions.onEvent } : {}),
          ...(options.platformCapabilities ? { platform: options.platformCapabilities } : {}) });
        let running = false;
        dispatchTimer = setInterval(() => {
          if (running) return;
          running = true;
          void dispatcher.tick().catch(() => {}).finally(() => { running = false; });
        }, interval);
        dispatchTimer.unref?.();
        return 'started';
      },
      stopNotificationDispatch() {
        if (dispatchTimer) clearInterval(dispatchTimer);
        dispatchTimer = undefined;
      },
      async close() {
        if (dispatchTimer) clearInterval(dispatchTimer);
        dispatchTimer = undefined;
        if (timer) clearInterval(timer);
        timer = undefined;
        await (closing ??= opened.close());
      },
    };
  } catch (error) { await opened.close().catch(() => {}); throw error; }
}

/** Bind sheet/confirm calls to one already opened store. prepare() passes the store from openPerformanceStore. */
export function createStoreBusinessPort(store: PerformanceStore, handler: ReturnType<typeof createWecomBotHandler>): StoreBusinessPort {
  const employeeLoop = handler.employeeLoop;
  return {
    employeeLoop,
    captureArrival: () => capturePendingArrival(store),
    async remember(actor: StoreBusinessActor) {
      if (employeeLoop) {
        // 已认证上下文只核对既有绑定，不能在消息处理时补造人员档案。
        const person = await store.getPersonByMember(actor.memberId);
        if (!person?.active || !person.displayName.trim() || !person.storeName.trim() ||
          person.personId !== actor.personId || person.accountId !== actor.accountId || person.storeId !== actor.storeId) throw Error('access_denied');
        return;
      }
      await store.savePerson({
        personId: actor.personId, accountId: actor.accountId, memberId: actor.memberId, displayName: actor.displayName,
        storeId: actor.storeId, storeName: actor.storeName, tier: actor.tier, roles: [...actor.roles], active: true,
      });
    },
    async hasOpenDraft(memberId) {
      const person = await store.getPersonByMember(memberId);
      if (!person) return false;
      return !!(await store.getOpenDraft(person.personId));
    },
    handleMessage: input => handler.handleMessage(input),
  };
}

export { FRONT_CLAW_DATABASE_URL };
