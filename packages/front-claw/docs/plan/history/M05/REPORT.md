# M05 预约 + 店长提醒 — 报告（2026-11-11，北京时间 UTC+8）

基线：树 1aca630d（M04，repo-m04）。工作树 repo-m05（detached，f2a8105 + m04-cumulative）。M05 树 **f834911d0801cecfc61dcfea04929f0b1e4b1854**。未 commit/push/PR；未连服务器、未发企微、未碰 env/凭据、未用 sudo/docker；只删了自己的临时文件。**不改 schema**（status、kind 本来就是 text 列）。

## 0. 新默认（D17–D28，均待拍板）

| # | 默认 | 位置 |
|---|---|---|
| D17 | 新能力 appointment_submit（登记）/ appointment_receive（收提醒、看本店预约）。测试夹具：员工 submit；店长 submit+receive；老板 receive。真实策略表本片未写 | access-policy、appointment-fixture-m05 |
| D18 | 指定店长来自 PG 配置 `front-claw-appointment-recipients` = {"version":1,"stores":{门店:人}}，每店一人 | appointments `designatedRecipient` |
| D19 | 登记即成立（status=registered），店长无需回复、不催、跨闭店不作废 | finishAppointment |
| D20 | 未配置 / 不合格（不在本店、无 receive、停用）→ 不写提醒行，预约照样成立，回复说明“提醒待配置” | recipientFor |
| D21 | 登记人本人就是指定店长 → 不给自己发 | recipientFor |
| D22 | 收件人在「对」时重新判定，并在提交事务内按锁住的策略再判一次；不合格只丢提醒、不回滚预约 | noticeAllowed |
| D23 | 没写上午/下午的 1–7 点按下午；中午 1–5 点按下午；“半/一刻/三刻/N分”支持 | resolveTime |
| D24 | 日期按日历日（不是营业日）；没日期词=今天；N号早于今天=下月；12 月说 1–2 月=明年；周X 已过=下周 | resolveDate |
| D25 | 没留名的顾客记“未留名”；内容（门店+登记人+时间+顾客+项目）相同 = 同一预约，后来的作废（duplicate） | appointmentContentId |
| D26 | 员工入口里「确认预约 N」只解释新规则（登记即成立），不写 | appointmentQuery |
| D27 | 预约只在 accessPolicy 模式开放；否则回“未开放” | appointmentDraft |
| D28 | 回显后到确认时预约时间已过 → 不登记，草稿保留，可「取消」 | 确认分支 |

## 1. 改动（相对 M04 树，15 文件 +1283/−27）

- **appointments.ts**：原有函数一行没改（复用 parseAppointmentUtterance 等），在后面追加：口语预约解析 `parseAppointmentRequest`（今天/明天/后天/周X/下周X/N月N日/N号 + 中文数字时间）、`looksLikeAppointment`、`describeWhen`（11月13日（周五）15:00）、内容确定的预约号/提醒号、`designatedRecipient`、`reminderBody`（含「仅提醒，无需回复」）、`buildReminderPayload`（形如 SDK 1.0.7 `sendMessage(chatid,{msgtype:'markdown',markdown:{content}})`，**只构造，不发送**）。
- **performance-store.ts / performance-postgres.ts**：`commitConfirmingAppointments(draft, rows, options?)`。不带 options 走旧路径不变；带 options 时一个事务：策略行 FOR SHARE（guard，拒绝则草稿退回待确认）→ 草稿 confirming→confirmed → 预约 `INSERT … ON CONFLICT DO NOTHING RETURNING`（没插进去=同内容已登记→整体回滚、草稿作废 duplicate）→ 按锁住的策略过滤提醒 → 提醒 INSERT（kind=appointment，status=pending）。内存实现同语义。
- **employee-loop.ts**：预约草稿（回显门店/日期/星期/时间/顾客/项目/提醒对象）→「对」/「取消」；确认前重判授权、时间是否已过；提醒写失败整体回滚、回“结果未知”；「我的预约」「预约列表」「今天的预约」查询，提醒状态如实显示（pending=已排队尚未发送；sent=企微已接受不代表已读；not_sent=未送达；unknown=结果未知）。
- **intent-router.ts**：口语预约（有客人/称呼信号 + 时间/日期、无营销词）→ appointment，并压过报数；「我的预约」等查询词。
- **wecom-bot-unified-handler.ts**（旧入口）：员工入口的预约草稿也让回本人入口，旧路径不会确认/取消它；旧入口自己的 pending_manager 流程未动。
- **测试**：appointment-m05 17 项、intent-m05 3 项、appointment-pg-m05 8 项；fixture appointment-fixture-m05；sql-fixture 支持 `INSERT … RETURNING`（冲突返回空）；access-fixture-m03 的 spy 遇到不可克隆参数（带函数的提交选项）记 '[uncloneable]'（之前直接抛错，导致 12 项假失败）。
- **语料**：M05 盲测 27 条在改分类器前冻结，首跑 13/27（留出测试集产物）；调参集按文本追加 13 条（共 84）。盲测与调参、与 M02/M04 盲测都不重叠。

PM 要求对照：
- 「明天三点有个客人要来」→ 预约流程（单元 + 入口端到端，不回澄清，营销端口零调用）。
- 店长提醒只落 pending 行 + 构造载荷，全程 send 零调用；真实派发留给 M06。
- 店长不回复也有效（跨闭店用例）。
- 草稿→「对」；每步过 M03（入口、建草稿前、确认前、提交事务内）。
- 幂等：同一「对」重放、两池并发、两张同内容草稿并发，都只一条预约、一条提醒。
- 遗留① 序号/重试确认到下一笔：A 登记后起 B 草稿，A 的「对」被重试 → 只回 A 的结果，B 仍待确认；「确认预约 1」零写。
- 遗留② 通知失败被吞：提醒写失败 → 预约同事务回滚、回“结果未知”；故障消除后原确认续跑只登记一次；not_sent/unknown 如实显示。

## 2. 测试

| 项 | 结果 |
|---|---|
| tsc / typecheck / build | exit 0 / 0 / 0 |
| M01 / M02 / M03 / M04 / M05 定向 | 15/15、18/18、21/21、25/25、20/20 |
| 回归（15 个文件） | 200/200 |
| 全量 vitest | 878 中 876 过；2 失败仅已知 live-model-smoke |
| test:pg（PG17 17.11 临时集群，**非线上版本**） | 5 文件 31/31；整套另跑 10 次全过 |
| appointment-pg-m05 重复 | repeat5 5/5；另单文件 10 次全过 |
| 默认路径（不设 FRONT_CLAW_PG_BIN） | PG16 initdb ENOENT，31 跳过，exit 1，与基线一致 |
| 变异 | 11/11 被抓到（首轮漏 3 项，已补用例） |

PG 证据（PG17，非线上版本；**不声称**达到任何延迟目标）：
- 同一「对」两池并发 10 轮：每轮预约 1、提醒 1。
- 两会话同内容草稿两池并发 10 轮：每轮恰一份登记、一份 duplicate，两边都赢过（如 3/7、6/4）。
- 先后：撤权方先持策略行 FOR UPDATE → 拒绝、零写、草稿待确认。
- 先后：锁住期间停用指定店长 → 预约成立、提醒 0、回复不说“已排队”。
- 登记×撤权竞态 20 轮：每次约 6–8 登记 / 12–14 拒绝，两种结果都出现，计数一致。
- 登记×指定店长停用竞态 20 轮：预约每轮都成立；提醒 0 或 1 与最终回复一致（约 7–8 / 12–13）。
- 测试库触发器让提醒 INSERT 失败 → 整体回滚、“结果未知”；去掉后新进程原确认续跑只登记一次。
- 重启/确认中崩溃 → 原确认续跑只登记一次。

语料（规则分类器离线评测，同一作者，不是独立盲测）：调参 84 宏F1 1.0；M02 盲测 52 宏F1 1.0；M04 盲测 27 准确率 0.963（「谢谢啦」→澄清，同 M04）；M05 盲测 27 准确率 1.0（改分类器前 13/27）。店务/闲聊误入营销四套都是 0。

## 3. 过程中发现并修掉的

- **索引事故**：shell 里残留导出的 GIT_INDEX_FILE（/tmp/m05-chk-idx），建工作树时 worktree add/apply --index 写进了临时索引。已在 repo-m05 内 read-tree + apply --cached 修复（树 1aca630d、status 43 行与 repo-m04 一致），删了自己的临时文件；repo/repo-m04 未受影响。之后每次用临时索引都在子 shell 里，结束确认未导出。
- 「周四三点」被判无效（数字正则贪婪）、「周姐」被当成非姓氏 → 已修。
- 12 项单元假失败：测试 spy 用 structuredClone 记录参数，遇到带函数的提交选项抛错 → spy 改为可降级记录（只改测试夹具）。
- 变异首轮漏 3 项 → 补了 PG“锁后停用店长”、回显不排提醒断言、“回显后时间已过”用例。

## 4. 核对与未验证

- 其他写入者：开工和收尾都查过。repo 15 行、repo-m02 29 行、repo-m03 36 行、repo-m04 43 行，HEAD 均 f2a8105；repo-m04 最新文件 19:31（M04 自己的收尾），repo-m03 18:51、repo-m02 18:23，M05 开工后无变化；无其他 vitest/tsc/codex 进程。
- 补丁重放：临时索引上 1aca630d + m05.patch、f2a8105 + m05-cumulative.patch 都得到 f834911d；GIT_INDEX_FILE 已确认未导出。
- **未验证**：真实企微推送（SDK sendMessage 在真实账号、店长手机上的表现）；线上 PG 版本与延迟；真实策略/指定店长配置（本片没写）；语义分类器（没装）。

## 5. 已知限制

1. 提交事务内收件人被判不合格时，“改写最终回复”是事务后的第二次写；若这一步失败，最终回复可能仍说“已排队”，但提醒表是准的（「我的预约」以表为准）。
2. 旧入口（非 employeeLoop）的 pending_manager 预约流程原样保留（迁移归 M08）。
3. `buildReminderPayload` 只在测试里构造校验，生产代码不调用；派发、回写 sent/not_sent/unknown 都是 M06。
4. 同一进程同一 messageId 重发，原样回第一次的回复（M02 语义）。
5. 同一顾客同一时间同一项目由同一人登记两次，会被当作重复；真要两条需在项目/顾客上区分。
6. 时间解析是规则式的（D23/D24），不认识的说法会问“几点”或判写法不对，不会猜。
7. PG17 不是线上版本；没有声称达到任何延迟目标。

## 6. 需要拍板

1. 指定店长配置：用 `front-claw-appointment-recipients` 每店一人可以吗？谁来维护，B 店是否就配测试员工A？
2. 老板要不要抄送（目前不抄送，老板只有 receive 可查本店列表）？
3. 默认上下午规则（1–7 点按下午）是否可以？
4. 同内容匿名客人（“未留名”）算重复是否可以，还是要每次都新开？
5. 未配置店长时登记的预约，配置后要不要补发提醒（建议放 M06）？
6. 旧入口的 pending_manager 预约流程保留到 M08 再迁，还是现在就关？
7. 能力表（D17）：员工能登记、店长能登记+接收、老板只接收，是否同意？
