# M07 计划（2026-11-11 20:45 UTC+8）

0. **工作树**：`unset GIT_INDEX_FILE`；`git worktree add --detach repo-m07 f2a8105`；`git apply --index M06/m06-cumulative.patch`；write-tree = 5839f303 ✅；index = `.git/worktrees/repo-m07/index`（自己的）。开工 20:28 查其他写入者：repo 15 / m02 29 / m03 36 / m04 43 / m05 49 / m06 55 行，HEAD 均 f2a8105，最新文件均早于开工；无 vitest/tsc/codex/postgres 进程。node_modules 从 repo 复制（git 忽略）。
1. **契约（只写有出处的）** `src/opendot/host-contract.ts`：
   - 日志：OpenDot `src/logger.ts:233` `export const logger = pino(...)`，调用形如 `logger.warn({ err }, '...')` → 契约只要 `info/warn(obj, msg)`。
   - 生命周期：仿 `startBotHandoffService`（index.ts 20621）返回带 `close()` 的服务，在 `shutdown()` Phase 1（20713 行 `Promise.allSettled([...])`）里关闭，早于 `imManager.disconnectAll()`。
   - 配置：OpenDot `src/load-env.ts` 把 `.env` 读进 `process.env`；`config.ts` 全部按 env 取值 → 适配器只读 env 开关。
   - goal-run 命名空间：`goal-runtime.ts:36` `goal-run:${claim.id}`。Front Claw 用 `front-claw:` 前缀，互不相交。
   - **假设（未在 OpenDot 中找到，标明）**：A1 宿主愿意加最小挂点（无扩展点）；A2 企微凭据来自 env（OpenDot 的 channel_accounts 没有企微 provider）；A3 平台层能力清单由部署配置给出（OpenDot 的 `permissions.ts` 是 Web 用户权限，没有门店业务能力，不映射）；A4 OpenDot 进程里 Node ≥22（package.json engines 未核）。
2. **OpenDot 最小差异**（不应用到任何 OpenDot 目录，只在临时副本上 `git apply --check` + 跑钩子文件）：新增 `src/front-claw-hook.ts`（只 import node:path/node:url；开关关→空服务；开→动态 import 外部模块绝对路径；失败只记日志，OpenDot 照常启动），`index.ts` 3 处（import、`botHandoffs` 后 `await startFrontClawHook(logger)`、Phase 1 加 `frontClaw.close()`）。产物 `integrations/opendot-front-claw/opendot-hook.patch` + 钩子源文件。
3. **适配器** `src/opendot/adapter.ts` `startFrontClawOpenDotService(host, deps)`：
   - `FRONT_CLAW_OPENDOT_ADAPTER!=='1'` → `disabled`：不开 PG、不连企微、不注册任何东西。
   - 开启：Mem0 检查 → 解析平台能力 `FRONT_CLAW_OPENDOT_CAPABILITIES`（未知名拒绝启动；未设=不收窄）→ `bootFrontClaw({employeeLoop:true, accessPolicy:true, platformCapabilities})`（复用 M01–M06）→ PG 单消费者租约 → 拿到才建通道并消费，拿不到 `standby` 定时重试。
   - 入站：帧解析复用 `normalizeBotFrame`（群聊照旧拒绝）→ PG 绑定（bot/corp/member、active、与人员 accountId 一致）→ `handler.handleMessage`（M03 每步重判）→ 回复。租约本地已过期则不处理（旧消费者不再写）。
   - 操作 ID：`front-claw:` + sha256(bot,corp,member,msgid)；登记 msgid、业务 operationId（草稿号，取自 `onEmployeeTrace`）、结果。`cancel(id)`：未知/不属于本命名空间/进行中（中止，等收尾后如实报告是否已入账）/已结束（只报告，不撤销）。`result(id)`：本进程记录 + PG 草稿状态。
   - 关停：停收 → 等在途（默认 10 秒，OpenDot 强退是 30 秒）→ 超时中止 → 关通道 → 释放租约 → 关 PG/维护/派发。
4. **企微通道** `src/opendot/wecom-channel.ts`：复用 `createBotSdkAdapter`、`createBotSender`（reply/notify，有界超时、beforeSend）、`normalizeBotFrame`、`createBotNotificationSender`（M06 派发器）。客户端由注入工厂创建；生产工厂按 `wecom-bot-preparation.ts:94` 现有参数 `new WSClient({botId, secret, ...})`。测试只用假客户端。
5. **单消费者租约** `src/opendot/consumer-lease.ts`：PG config 键 `front-claw-opendot-consumer`，值 {owner, token, until}；先 `insertConfigIfAbsent`（新增 store 方法，INSERT … ON CONFLICT DO NOTHING，不改 schema），再 `updateConfigLocked`（行 FOR UPDATE）判断/续约/释放。参考 client-go leaderelection（租期 > 续约期限 > 重试间隔）。
6. **授权交集**：平台能力只作为 M03 `decideAccess` 的 `platform` 层（已有）；适配器不碰账本写接口，所有业务都经 handler。
7. **删除冗余（列证据后删，只删本工作树）**：
   - `appointments.ts` 的 `buildReminderPayload` + `ReminderPayload`：M05 写来“只构造不发送”的载荷；M06 起真实发送走 `wecom-bot-sender.notify`（自己组帧）。证据：`rg buildReminderPayload` 只有定义和 `tests/role-eval/appointment-m05.test.ts:46` 一处测试引用，src/integrations/examples 无引用。删后把该测试改为断言提醒正文。
   - **不删**：`integrations/native/**`、`native-bot-*`、`wecom-bot-pilot.ts`——它们是旧 Native 宿主的现行入口/回滚制品（MERGED：“停消费后才切回兼容制品”），`native-bot-execution.ts` 被 `integrations/native/scheduler-targeted.test.mts` 使用。早期方案 骨架的 `admission-shim`（布尔准入）和 `task-dedup`（进程内 Map）不在仓库里，不拷入，由 M03 策略和 PG 租约替代。
8. **测试**：单元（MemorySql + 假宿主 + 假企微客户端）：契约、默认关、钩子文件（临时副本打补丁后真实导入）、会话隔离、权限交集/撤权、双实例同帧、取消三态、关停、Mem0/goal-run 静态检查。PG（PG17 临时，非线上）：入口→适配器→handler→隔离 PG→回复记录器；两个进程级实例抢租约、到期接管、旧持有者停消费；双调度一笔；消费中崩溃（不释放租约）→ 新实例到期接管 → 同 msgid 重放不重复入账；撤权与消息并发。变异检查。

## 新默认（REPORT §0 列全）
D42 适配器默认关；D43 平台能力未设=不收窄，设了只能收窄，未知名拒绝启动；D44 单消费者租约 30 秒、续约 10 秒、standby 重试 10 秒；D45 关停等在途 10 秒；D46 企微凭据 env（假设 A2）；D47 适配器失败不阻止 OpenDot 启动；D48 操作 ID 规则；D49 取消不撤销账目；D50 丢租约只停入站，派发器靠 M06 自身并发保护继续。
