# M06 计划

0. **工作树**：先 `unset GIT_INDEX_FILE`；`git worktree add --detach repo-m06 f2a8105`，`git apply --index M05/m05-cumulative.patch`，write-tree = f834911d ✅；index 在 `.git/worktrees/repo-m06/index`（自己的）。开工前其他工作树 status：repo 15、m02 29、m03 36、m04 43、m05 49 行；无 vitest/tsc/codex/postgres 进程。node_modules 从 repo-m05 复制。
1. **状态编码（不改 schema）**：`notification-status.ts`。status 列仍以基本词开头（pending/sent/not_sent/unknown），后接 `|下次或租约时间|阶段|a=次数|r=补发次数|tok=令牌|by=worker|err=原因`。旧的纯 `pending` 照常可读。读出时拆成 `status`（基本词，旧代码不受影响）+ `delivery`。到期判定可在 SQL 里用 `split_part(status,'|',2) <= now` 完成。若用户希望正式加列，列为决定项（migration 008）。
2. **store**：新增 `enqueueNotification`（ON CONFLICT DO NOTHING）、`claimDueNotifications`（单事务 SKIP LOCKED 领取；过期的“发送中”判 unknown）、`beginNotificationSend`（策略行+指定店长配置 FOR SHARE → 行 FOR UPDATE → 核对令牌和租约 → 重判资格 → 写“发送中”或 not_sent）、`transitionNotification`（条件更新）。PG 与内存同语义。
3. **派发器** `notification-dispatch.ts`：tick = 暂停检查 → 草稿维护 → （可选补发）→ 领取 → 逐条发送 → 积压统计/告警事件。发送接口 `NotificationSender.send(input, beforeSend)`；`createBotNotificationSender(botSender)` 适配现有 `notify`。结果映射与有限退避；unknown 告警；`requeueUnknownNotification` 人工补发（审计记录写 config 前缀键，上限）。
4. **接线**：boot 增 `startNotificationDispatch(sender)`，仅当 `FRONT_CLAW_NOTIFY_DISPATCH=1` 且 employeeLoop+accessPolicy 时启动；pilot 在拿到 sender 后调用。默认关闭。旧入口 settle 跳过出站箱行。
5. **「我的预约」**：按 delivery 显示（发送中/重试中/未发送原因）。
6. **测试**：单元（内存 + 受控时钟 + 假发送器）、PG（多派发者、租约、撤权锁、超时 unknown、触发器失败）、真实子进程 kill -9（rolldown 打包 worker，隔离 PG17）、变异。
