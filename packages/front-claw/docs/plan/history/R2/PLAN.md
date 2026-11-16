# R2 PLAN

1. **暂停点**（R2-6）：`src/role-eval/pause-points.ts`。未安装钩子时 `pausePoint()` 同步返回 `undefined`（生产无操作，不 await、不读 env）；`installPausePoints()` 只在 vitest 进程（`process.env.VITEST`）且非 production 时可用，否则抛错。位置：
   - 入账门：员工入口读完草稿/人员/策略预检之后、调用 `commitConfirming*` 之前（`commit-gate:before-commit`）；
   - 发送门：派发器锁外预检读完之后、`beginNotificationSend` 之前（`send-gate:before-begin`）；
   - 标记已发送：通道返回之后、带 fence 的结果写回之前（`notify:before-mark`）。
   PG 测试用两个独立连接池：A 停在暂停点，B 撤权/停用/调店/提升策略版本/重领，A 继续 → 被门拒绝，入账恰一次（B 侧或后续重试）。
2. **条件更新 fencing**（R2-7）：
   - 通知结果写回、claimed→sending：单条 `UPDATE … WHERE status=$expected AND substring(status from '\|f=([0-9]+)')::bigint = $f AND split_part(status,'|',2) > $now AND phase∈(claimed,sending)`，0 行 = 被挡；去掉先 SELECT 再判。
   - M07 租约 fence 的业务提交：关闭草稿的那条 UPDATE 加 `AND EXISTS (SELECT 1 FROM config WHERE key=$k AND owner/epoch/until 匹配)`（正则抽取，坏 JSON 判不匹配，不抛错），0 行 = 被挡（草稿退回、零入账）。
3. **金额**（R2-3）：金额文法区分「整数元」与「带小数分」；`amountOfTerm` 返回 `{ok}|{reason: 'fraction'|'zero'|'negative'|'too_large'|'bad'}`；带角分、零、负数、超上限（默认单笔 ≤ 1,000,000 元）→ 澄清，不取整、不入草稿；负号写在客户名后（「张姐-680」）不再被吞掉。
4. **泛化报单解析**（R2-2）：`src/role-eval/report-extract.ts`：分句 → 抽金额（阿拉伯数字+单位、￥前缀、中文数字带量级或货币单位）→ 抽客人（称谓形名词「X姐/X姨/X阿姨/X哥/X叔/X先生/X女士/X老师/X总」）或项目（与预约共用的服务项目词表）→ 每个金额配对同一分句内的客人/项目；可选括号员工；合计（一共/总共/合计 且等于前面之和）不算一笔；引号内的金额是素材不算。任一金额配不上客人/项目、同一客人多个金额、「A还是B/或」互斥、括号多人、代词受益人（给他/替她）无括号、点名他店 → 不出草稿（澄清或拒绝）。
5. **高风险意图结构化澄清**（R2-1）：路由层对每个意图做「必填槽位」检查：报数（客人/项目+金额）、预约（客人+时间+项目）、改账（原操作+新金额，且无「其中一单」类未定指代）、查他人/跨店（对象明确，权限由入账门/查询门判）、查结果（唯一操作号）；任何互斥候选（还是/或者/或/「其中一个」）→ 澄清。不加原句关键词。
6. **D5**（R2-4）：`src/role-eval/d5-roles.ts` 已定规则 = 角色上限（员工不能查他人/汇总/排名/设目标/改他人；老板不接预约提醒；未确认提醒只发员工报单人）；`decideAccess` 增加 D5 上限层（拒绝优先）；待定项只列出。
7. **D46**（R2-5）：`src/role-eval/credential-file.ts`：`FRONT_CLAW_DATABASE_URL_FILE` / `FRONT_CLAW_MIGRATION_DATABASE_URL_FILE`；绝对路径、仓库外、非符号链接、普通文件、权限 ≤0600、属主=当前用户、所在挂载只读（/proc/self/mountinfo）、单行 postgres URL；进程内只读一次；错误信息不含值；不写入 process.env（不传给子进程）；文件模式下业务账号不跑 DDL（只核对版本），迁移用另一账号且用户名必须不同。
8. **盲测**（R2-8）：端到端 harness（合成 A/B 店、员工/店长/老板，策略模式），三个数分开报；格式明确子集与归类标准写进 REPORT；30+ 条留出集单独报。
9. 验证：tsc/typecheck/build、全量 vitest、PG17 test:pg、变异检查；产物 r2.patch、累积补丁、树 hash、SHA256SUMS、REPORT（§0 自 D77）。
