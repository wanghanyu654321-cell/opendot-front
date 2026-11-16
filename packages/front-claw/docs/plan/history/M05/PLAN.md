# M05 实施计划（写于代码改动前，19:45 UTC+8）

1. **工作树**：`git worktree add --detach repo-m05 f2a8105` + `git apply --index M04/m04-cumulative.patch`，临时索引 write-tree = 1aca630d ✅。开工前核对：无 vitest/tsc/codex 进程；repo-m02/repo-m04 在 45 秒内没有文件变化。node_modules 从 repo-m04 复制（不联网）。
   - 插曲：创建工作树时，shell 里残留了上一步导出的 GIT_INDEX_FILE（/tmp/m05-chk-idx），导致 worktree add 和 apply --index 写到了那个临时索引，repo-m05 自己的 index 没生成。
   - 修复：`git read-tree HEAD && git apply --cached m04-cumulative.patch`，得到 1aca630d，status 43 行与 repo-m04 一致；随后删除自己的临时文件 /tmp/m05-chk-idx。
   - repo 和 repo-m04 的 index 未受影响：status 行数分别为 15 和 43，与之前一致。
2. **盲测集**：先冻结私有评测语料，改分类器前跑一次，结果写到留出测试集产物。
3. **access-policy.ts**：增加 `appointment_submit` 和 `appointment_receive`。
4. **appointments.ts**：保留原函数，新增以下内容。
   - `parseAppointmentRequest(text, now, tz)`：解析日期（今天/明天/后天/大后天/周X/下周X/N月N日/N号）和时间（HH:MM、H点、H点半、H点MM分、中文数字、上午/中午/下午/晚上）；不带上下午时 1–7 点按下午算。顾客和项目尽量抽取，抽不到时顾客记为“未留名”。返回 request、'needs_time'、'past' 或 null。
   - `appointmentContentId`：按内容生成预约号。
   - `buildManagerReminder`：生成通知行和发送载荷（chatid=memberId, markdown），只构造，不发送。
5. **performance-store / postgres**：
   - Appointment.status 增加 `registered`；AppointmentPayload 增加可选的 employeeContext、outcome、recipient 和 item 字段。
   - 扩展 `commitConfirmingAppointments(draft, appts, options?)`。不带 options 时走旧路径，行为不变。带 options（guard、notices、noticeAllowed）时，在同一事务里依次：策略行 FOR SHARE → 草稿条件转换 → 预约 `INSERT … ON CONFLICT DO NOTHING RETURNING`（没插进去就判为重复，回滚并作废草稿，outcome=duplicate）→ 用锁住的策略过滤提醒 → 提醒 INSERT。内存实现语义相同。
   - sql-fixture 支持 INSERT…RETURNING：冲突时 DO NOTHING 返回空，与 PG 一致。
6. **employee-loop.ts**：
   - appointment 加入 LOOP_KINDS，归属摘要也覆盖它。
   - 建草稿：先查 `appointment_submit` 能力，再看是否已有相同预约，然后回显。
   - 确认：重判授权、时间是否已过、收件人是否合格，然后提交。
   - 回复文案：“已登记，预约号 X；已排队提醒店长 Y（仅提醒，无需回复；尚未发送）”或“提醒待配置”。
   - 新增查询：「预约结果 / 我的预约」（本人）、「预约列表 / 今天的预约」（appointment_receive）。
   - 「确认预约 N」只解释规则，不写。非策略模式回“未开放”。
7. **wecom-bot-unified-handler.ts**（旧入口）：凡是带 employeeContext 的草稿（含预约），旧入口都不确认、不取消、不追加；settleConfirming 跳过这类草稿。
8. **intent-router.ts**：用 parseAppointmentRequest 或来店词规则识别预约，优先级高于报数和澄清；「预约结果」「我的预约」「预约列表」都进 appointment。
9. **测试**：
   - `appointment-m05.test.ts`（MemorySql）
   - `intent-m05.test.ts`
   - `appointment-pg-m05.integration.test.ts`（PG17）：并发确认、同确认重放、撤权×确认 20 轮、收件人撤权×确认、锁序、重启续跑、重复内容并发
10. **验证**：tsc、M01–M05、回归、全量、test:pg、typecheck、build，再跑变异测试。
11. **产物**：m05.patch、m05-cumulative.patch、m05-tree.txt、REPORT.md、SHA256SUMS。
