# Front Claw ⇄ OpenDot 薄适配（M07）

## 边界
- OpenDot 侧只多一个文件 `src/front-claw-hook.ts`（只 import `node:path`/`node:url`）和 `src/index.ts` 三处改动（`opendot-hook.patch`）：
  import、在 `startBotHandoffService` 之后 `await startFrontClawHook(logger)`、shutdown Phase 1 `Promise.allSettled` 里 `frontClaw.close()`。
  不改 IMChannel/channel_accounts、不进 task-scheduler/goal-run、不碰 Mem0、不加 OpenDot 依赖。补丁**未应用到任何 OpenDot 目录**，只在临时副本上验证。
- Front Claw 侧入口 `dist/opendot/index.js` 导出 `startFrontClawOpenDotService({logger, env})`，自己持有：企微长连接（现有 SDK 适配/发送器）、
  PG 账本（`FRONT_CLAW_DATABASE_URL`，表结构不变）、M03 每步重判、M06 通知派发。
- 操作 ID：`front-claw:` + 40 位十六进制（与 OpenDot `goal-run:${id}` 不相交）。

## 开启（默认关）
| env | 含义 |
|---|---|
| `FRONT_CLAW_OPENDOT_ADAPTER=1` | 总开关；其它值一律关，关时不读任何其它变量、不开库、不连企微 |
| `FRONT_CLAW_OPENDOT_MODULE` | 适配器构建产物的**绝对路径** |
| `FRONT_CLAW_OPENDOT_START_TIMEOUT_MS` | 可选（R1），启动截止时间，默认 15000，范围 1..120000；超时记 warn、OpenDot 照常启动，迟到的成功结果立即 close()（释放租约、关库） |
| `FRONT_CLAW_DATABASE_URL` | Front Claw 自己的 PG |
| `FRONT_CLAW_WECOM_BOT_ID` / `FRONT_CLAW_WECOM_BOT_SECRET` | 假设 A2：企微机器人凭据走 env（不复用 OpenDot channel_accounts） |
| `FRONT_CLAW_OPENDOT_CAPABILITIES` | 可选，逗号分隔 M03 能力名；只能在 M03 结果上**再收窄**，未知名拒绝启动 |
| `FRONT_CLAW_MEM0` | 只能不设或 `0`；否则拒绝启动 |

启动失败只记 warn，OpenDot 照常运行。

## 单消费者
`performance_config` 一行 `front-claw-opendot-consumer` 作租约（30s，10s 续约）。参考 kubernetes/client-go
`tools/leaderelection`（LeaseDuration > RenewDeadline > RetryPeriod×1.2）。
R1 起租约行带单调 `epoch`（每次换主 +1）：每条消息处理前、回复前按 PG 行核对 owner/epoch/到期，入账在提交事务内 FOR SHARE 核对（与 M06 通知领取同一 `fenceHolds`），旧持有者既不写也不回；M01–M06 的确定性 ID 幂等仍作兜底。
操作记录写在 `performance_config` 的 `front-claw-op:<操作号>`（跨重启可查；进程中途退出 → 报 `interrupted`）。
适配器形状参考 microsoft/botbuilder-js `BotAdapter`/`CloudAdapterBase.processActivity`（通道活动 → 一轮业务逻辑）；契约测试写法参考 pact-foundation/pact-js（消费者侧契约 + 假提供方）。

## 验证到哪
- 已验证：假宿主契约、临时副本打补丁后真实导入钩子、离线企微 SDK、临时 PG17（**非线上版本**）。
- 未验证：真实 OpenDot 进程（本机无其依赖，不能跑其 typecheck/测试/容器）、真实企微、线上 PG 版本、OpenDot 的 git SHA（只有 zip）。
