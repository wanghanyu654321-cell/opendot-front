# M06 持久通知、草稿提醒与故障恢复 — 报告（2026-11-11，北京时间 UTC+8）

基线：树 f834911d（M05，repo-m05）。新工作树 repo-m06（detached，f2a8105 + m05-cumulative；开工前 `unset GIT_INDEX_FILE`，index 是 worktree 自己的 `.git/worktrees/repo-m06/index`）。M06 树 **5839f3038051bbb07f974c1096324d7f4b35123c**。未 commit/push/PR；未连服务器、未发企微、未碰 env/凭据、未用 sudo/docker；只删了自己的临时文件。**没有改 schema**（见 D29 和决定 1）。

## 0. 新默认（D29–D41，均待拍板）

| # | 默认 | 位置 |
|---|---|---|
| D29 | 不加列：派发信息编码进现有 status 文本列，基本词在前（`pending|到期时间|阶段|a=次数|r=补发|tok=令牌|by=worker|err=原因`）。旧代码按基本词读，不受影响 | notification-status.ts |
| D30 | 四种状态：pending（排队/已领取/发送中）、sent=企微通道已接受（不代表已读）、not_sent=明确失败/不再发送、unknown=结果未知 | 同上 |
| D31 | 租约 60 秒，每轮 20 条，最多 5 次，退避 1/5/15/60 分钟；未上线的 blocked（未连接等）也计一次 | notification-dispatch.ts |
| D32 | unknown 不自动重发：发告警事件；人工补发写审计（config 键 `front-claw-notification:audit:<id>:<n>`），每条最多补发 1 次 | `requeueUnknownNotification` |
| D33 | 领取后、发送前崩溃 → 租约到期重领（不计次数）；进入发送后崩溃 → 判 unknown，不重发 | `claimTransition` |
| D34 | 发送前同一事务重判（策略行、指定店长配置 FOR SHARE）：预约提醒要求预约仍 registered、时间未过、仍是该店指定店长、有 appointment_receive；改账通知要求草稿已确认、72 小时内、progress_self；草稿提醒要求草稿仍待确认未过期、report_self；作废通知 12 小时内 | `precheck`/`decide` |
| D35 | 只派发确定性 64 位十六进制 ID 的行（M04/M05/M06 写的）；旧入口 UUID 行派发器不碰，旧入口维护也不再把出站箱行改成 unknown | performance-*、unified-handler |
| D36 | 改账通知发给归属人和报数人（不含操作人），不抄送老板；只在开关打开时发 | M04 D16 + 开关 |
| D37 | 员工入口草稿维护：报数草稿满 30 分钟提醒一次；过期（闭店）的待确认草稿作废（标记 finalReply）；只有维护作废的报数草稿发一次作废通知，用户「取消」的不发；确认中/已确认/已登记预约都不动 | `maintainDrafts` |
| D38 | 不补发“配置店长前登记”的预约提醒；`backfillAppointmentReminders` 开关默认关，打开也只补未来、无任何提醒行、收件人合格且不是本人的预约 | `backfill` |
| D39 | 真实发送默认关：仅当 `FRONT_CLAW_NOTIFY_DISPATCH=1` 且员工入口 + 访问策略时，boot 才启动派发（30 秒一轮）；PG 配置 `front-claw-notification-dispatch` = {"paused":true} 可暂停领取和草稿维护（行保留），配置损坏按暂停处理 | front-claw-boot.ts、pilot |
| D40 | 积压告警：待发 ≥50 条或最老 ≥30 分钟 → 事件（生产走 wecomDebug 日志），不呼叫 | `tick` |
| D41 | 租约和到期按应用时钟（不是数据库时钟） | dispatcher |

## 1. 改动（相对 M05 树，12 文件 +1284/−5）

- **notification-status.ts**（新）：状态编解码、SQL 同义的到期判定、出站箱 ID 识别。
- **performance-store.ts / performance-postgres.ts**：读出时把编码拆成基本词 + `delivery`（纯基本词的行不加字段，旧断言不变）。新增：
  - `enqueueNotification`：ON CONFLICT DO NOTHING。
  - `claimDueNotifications`：单事务 `FOR UPDATE SKIP LOCKED`，到期条件在 SQL 里（`split_part(status,'|',2) <= now`）。
  - `beginNotificationSend`：配置 FOR SHARE → 行 FOR UPDATE → 核对原文 → 判定。
  - `transitionNotification`：以原文为条件。
  - 内存实现同语义。
- **notification-dispatch.ts**（新）：
  - 派发器 `tick`：暂停检查 → 草稿维护 →（可选补排）→ 领取 → 逐条发送 → 积压统计。
  - 发送接口 `NotificationSender.send(input, beforeSend)`。
  - `createBotNotificationSender` 适配现有 `wecom-bot-sender.notify`（有界超时、beforeSend 预检、accepted/rejected/blocked/unknown），不重写发送代码。
  - 人工补发 `requeueUnknownNotification`。
- **front-claw-boot.ts / wecom-bot-pilot.ts**：`startNotificationDispatch(sender)`，默认 disabled；pilot 拿到长连接 sender 后调用，事件只记类型/种类/次数/错误码，不记正文。
- **employee-loop.ts**：「我的预约」按派发信息如实显示：正在发送 / 上次未成功稍后重试（已试 N 次）/ 未发送原因 / 结果未知（已人工补发 N 次）。
- **wecom-bot-unified-handler.ts**（旧入口）：维护时跳过出站箱行。
- **测试**：notify-m06 20 项（内存 + 可控时钟 + 假发送器 + 真实 createBotSender 超时）、notify-pg-m06 8 项（PG17 + 真实 node 子进程 kill -9）、notify-fixture-m06、notify-worker-m06（子进程入口）。

## 2. 测试

| 项 | 结果 |
|---|---|
| tsc / typecheck / build | exit 0 / 0 / 0 |
| M01 / M02 / M03 / M04 / M05 / M06 定向 | 15/15、18/18、21/21、25/25、20/20、20/20 |
| 回归（15 个文件） | 200/200 |
| 全量 vitest | 898 中 896 过；2 失败仅已知 live-model-smoke |
| test:pg（PG17 17.11 临时集群，**非线上版本**） | 6 文件 39/39；整套另跑 10 次全过 |
| notify-pg-m06 重复 | repeat5 5/5；另单文件 10 次全过 |
| 默认路径（不设 FRONT_CLAW_PG_BIN） | PG16 initdb ENOENT，39 跳过，exit 1，与基线一致 |
| 变异 | 17/17 被抓到（首轮漏 2 项，已补用例） |

PG 证据（PG17，非线上版本；**不声称**达到任何延迟目标）：
- 4 个派发者 / 4 个连接池 × 3 轮，30 条：每条恰好上线一次，全部 sent；四个 worker 都分到活（如 8/8/8/6）。
- 先后：撤权方先持策略行 FOR UPDATE，派发在 beginNotificationSend 等锁 → 停用店长提交后不上线，not_sent。
- 派发 × 停用指定店长竞态 20 轮：每次 8–9 上线 / 11–12 拒绝，状态与发送器记录逐轮一致。
- 现有 wecom-bot-sender + SDK 不回执（超时）→ unknown；之后 1/10/120 分钟多轮都不自动重发。
- 租约内别人领不到；停在发送前的过期领取者之后不能上线。
- 停在“发送中”的派发者：另一连接池在租约到期后判 unknown，迟到的“已接受”写不进去。
- boot：只有开关 + 员工入口 + 访问策略才 started，否则 disabled。
- **真实进程崩溃点矩阵**（node 子进程自 SIGKILL，随后租约内重启一次、租约到期后再重启一次）：

| 崩溃点 | 崩溃后 | 租约内重启 | 租约到期后 | 上线者 |
|---|---|---|---|---|
| 领取前 | pending | 发送成功 | sent a=1 | 租约内那次（只 1 次） |
| 领取后 | claimed | 不动 | sent a=1 | 重启者（1 次） |
| begin 事务内（未提交） | claimed（已回滚） | 不动 | sent a=1 | 重启者（1 次） |
| 已上线、未回执 | sending | 不动 | unknown（lease_expired_during_send） | 崩溃者（1 次），不重发 |
| 已回执、写状态前 | sending | 不动 | unknown | 崩溃者（1 次），不重发 |

单元（可控时钟）另覆盖：退避节奏和上限、blocked 恢复、unknown 告警、人工补发审计和上限、发送中抛错、四种收件人失效原因、领取后才撤权、预约时间已过、默认不补发 / 开关补一次、草稿提醒一次 / 已确认不提醒 / 闭店作废通知一次 / 取消不通知 / 预约不作废、暂停与损坏配置、积压告警、旧入口互不干扰。

## 3. 过程中发现并修掉的

- 旧入口维护会把所有 pending 行改成 unknown（会误伤 M04/M05 的待发行）→ 改为跳过出站箱行；派发器也只领出站箱行。
- 员工入口下没有任何草稿维护 → 补了提醒 / 作废。
- 变异首轮漏 2 项：PG 结果写回不带条件（补了跨连接池迟到回执用例）；取消草稿的作废通知（原用例时间点超出 12 小时窗口，没真正覆盖，已修正）。
- 加了“领取者自己停住超过租约、无人接手”用例（覆盖发送前租约检查）。

## 4. 核对与未验证

- 其他写入者：开工（20:02）和收尾（20:26）都查过。repo 15 行、repo-m02 29、repo-m03 36、repo-m04 43、repo-m05 49，HEAD 均 f2a8105；各目录最新文件分别是 17:46 / 18:23 / 18:51 / 19:31 / 19:57，都早于 M06 开工；无其他 vitest/tsc/codex/postgres 进程。GIT_INDEX_FILE 全程未导出，临时索引只在子 shell 里用，用完即删。
- 补丁重放：临时索引上 f834911d + m06.patch、f2a8105 + m06-cumulative.patch 都得到 5839f303。
- **未验证**：
  - 真实企微推送（pilot 接线只做了类型检查，没对真实 SDK 跑过；开关保持关闭）。
  - 店长手机是否可见。
  - 线上 PG 版本与延迟。
  - 多主机时钟偏差。
  - 大数据量下的扫描性能。

## 5. 已知限制

1. 不加列的代价：到期过滤用 `split_part`，没有索引；积压统计和预约查找是全表读，适合当前小规模。
2. 已写入“发送中”之后撤权，拦不住已经上线的那一条（发送前最后一次判定之后的撤权只影响下一条）。
3. 过期领取者若其实拿到了“已接受”，结果只进事件日志，行仍是 unknown；此时人工补发可能造成重复提醒。
4. 不承诺企微端到端恰好一次；unknown 本身就意味着可能已送达。
5. 告警只是日志事件，没有接呼叫或群通知。
6. 人员档案（在职、门店）在锁外预读；锁内以策略为准。
7. 人工补发先写审计再改状态，状态写失败会留下一条“请求过”的审计。
8. 子进程用例的打包产物写在 repo-m06/node_modules/.m06-worker（被 git 忽略）。
9. 旧入口自己的通知流程未改（M08）。
10. PG17 不是线上版本；没有声称达到任何延迟目标。

## 6. 需要拍板

1. **schema**：继续用 status 文本编码（D29），还是加正式列（migration 008：attempts、next_attempt_at、lease_until、claim_token、last_error + 到期索引）？我推荐上线前加列，代码已把编码集中在一个模块，改动面小。
2. 退避参数（5 次，1/5/15/60 分钟）、租约 60 秒是否合适？
3. unknown 人工补发：上限 1 次可以吗？谁有权执行？
4. 何时打开 `FRONT_CLAW_NOTIFY_DISPATCH`（建议等真实手机验证，M09）？
5. 草稿提醒 30 分钟、作废通知、改账通知 72 小时过期是否合适？
6. 补排开关保持关闭吗？
7. unknown / 积压告警发到哪里（日志、管理员企微、其他）？
8. 暂停开关由谁维护？
