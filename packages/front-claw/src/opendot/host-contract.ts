/**
 * M07：Front Claw 需要 OpenDot 宿主提供的最小契约。每一项都注明 OpenDot 源码出处
 * （本地 OpenDot 源码副本，来自 OpenDot.zip sha256 6ad0c734…ce49，无 git SHA）。
 * 没有出处的写成「假设」，不能当作 OpenDot 已有接口。
 *
 * 出处：
 * - 日志：src/logger.ts:233 `export const logger = pino({...})`；index.ts 全程 `logger.warn({ err }, '...')` 形式。
 * - 生命周期：index.ts:20621 `const botHandoffs = startBotHandoffService(productRuntime)`，
 *   shutdown() Phase 1（index.ts:20711–20720）`Promise.allSettled([botHandoffs.close()…, queue.shutdown(15_000)])`，
 *   早于 Phase 3 `imManager.disconnectAll()`；强制退出 30 秒（index.ts forceExitTimer）。
 * - 配置：src/load-env.ts `process.loadEnvFile()` 把 .env 读进 process.env；src/config.ts 全部从 process.env 取值。
 * - goal-run 命名空间：src/personal-agent/goal-runtime.ts:36 `const requestId = \`goal-run:${claim.id}\``，
 *   只处理 task-scheduler 从 SQLite scheduled_tasks 领取的 personal_goal 快照。
 * - Mem0：src/mem0-private-config.ts 主人/Dot 开关默认 0；docs/mem0-owner-private.md「excludes … channel … origins」。
 *
 * 假设（OpenDot 里没有，需要评审）：
 * - A1 OpenDot 没有宿主服务扩展点 → 需要最小挂点（integrations/opendot-front-claw/opendot-hook.patch）。
 * - A2 OpenDot channel_accounts 没有企微 provider（src/im-channel.ts 只有飞书/Telegram/QQ/微信/钉钉/Discord/WhatsApp）→ 企微凭据走 env。
 * - A3 OpenDot permissions.ts 是 Web 用户权限，没有门店业务能力 → 平台层能力由部署配置（env）给出，不映射 OpenDot 用户权限。
 */

/** pino Logger 的最小子集（OpenDot logger 满足）。 */
export interface OpenDotHostLogger {
  info(fields: Record<string, unknown>, message?: string): void;
  warn(fields: Record<string, unknown>, message?: string): void;
}

/** 宿主传给适配器的全部东西：日志 + 环境。适配器不 import 任何 OpenDot 模块。 */
export interface OpenDotHost {
  logger: OpenDotHostLogger;
  env: Readonly<Record<string, string | undefined>>;
}

/** 宿主侧服务形状：同 startBotHandoffService 的返回值，在 shutdown Phase 1 里 close()。 */
export interface OpenDotHostService {
  close(): Promise<void>;
}

export const OPENDOT_GOAL_RUN_PREFIX = 'goal-run:';
export const FRONT_CLAW_OPERATION_PREFIX = 'front-claw:';
/** 适配器总开关（默认关）。 */
export const OPENDOT_ADAPTER_FLAG = 'FRONT_CLAW_OPENDOT_ADAPTER';
/** OpenDot 钩子用：适配器模块（构建产物）绝对路径。 */
export const OPENDOT_ADAPTER_MODULE = 'FRONT_CLAW_OPENDOT_MODULE';
/** 平台层能力（逗号分隔 M03 能力名）；未设 = 不收窄。 */
export const OPENDOT_PLATFORM_CAPABILITIES = 'FRONT_CLAW_OPENDOT_CAPABILITIES';
/** 假设 A2：企微机器人凭据。只在适配器开启且未注入通道时读取。 */
export const WECOM_BOT_ID_ENV = 'FRONT_CLAW_WECOM_BOT_ID';
export const WECOM_BOT_SECRET_ENV = 'FRONT_CLAW_WECOM_BOT_SECRET';
