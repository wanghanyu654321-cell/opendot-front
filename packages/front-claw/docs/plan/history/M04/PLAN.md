# M04 实施计划（写于代码改动前，18:59 UTC+8）

1. 工作树：`git worktree add --detach repo-m04 f2a8105` + `git apply M03/m03-cumulative.patch`；临时索引 `git add -A && git write-tree` = 793ce100 ✅（与 M03/m03-tree.txt 一致）。开工前核对：无 codex/vitest/tsc 进程，repo-m02/repo-m03 45 秒内无文件变化；只在 repo-m04 写。node_modules 从 repo-m03 复制（不联网）。
2. 冻结 M04 盲测集（27 条），改分类器前跑一次 → 留出测试集产物（12/27）。M02 盲测集不动。
3. `access-policy.ts`：CAPABILITIES 增 `target_set`、`correct_own`、`correct_store`。
4. `report-parse.ts`：`parseLooseReport`（无日期标题、每行都是标准行 → 今天营业日）。
5. 新 `ledger-commands.ts`（纯函数）：金额（5w/3万/4千/5k/30000/600元）、目标指令（谁/周期/金额）、更正指令（改金额/撤回、第N笔、可选人名）。
6. `performance-store.ts`/`performance-postgres.ts`：Draft.kind 增 `target`/`correction` 及 payload；新增
   - `commitConfirmingTarget(draft, target, expectedBefore, guard)`：事务内 策略 FOR SHARE → 草稿 confirming→confirmed → 目标行 FOR UPDATE 比对原值 → upsert；冲突整体回滚并把草稿作废（单独语句）。
   - `commitConfirmingCorrection(draft, changes, notices, guard)`：策略 FOR SHARE → 草稿条件转换 → 账目行按 ID 排序 FOR UPDATE + 原值比对 → 改账 + revisions（确定性 ID，ON CONFLICT DO NOTHING）+ 改账通知意图（pending）。
   内存实现同语义；sql-fixture 只需已支持的语法（必要时补 `ON CONFLICT DO NOTHING` 已有）。
7. `employee-loop.ts`：草稿归属泛化到 report/target/correction；「对/取消」按 kind 分派；重放（同消息号 confirming）按 kind 续跑；入账结果可查三类；新增目标/更正处理（仅策略模式），每个鉴权点沿用 M03（入口、执行、草稿创建前、确认前、提交事务内、发送前）；报数草稿创建前做重发去重/追加只记新增（确认时再查一次）；无标题清单进待确认。
8. `intent-router.ts`：`correction`、`target` 意图与优先级；`employee-entry.ts` 澄清文案补“改账/目标”提示；调参集追加 M04 句子。
9. 测试：`ledger-m04.test.ts`（MemorySql：目标/更正/增量/无标题/权限负例/旧入口不可达/重启）、`intent-m04.test.ts`（PM 4 句、M04 盲测+调参评测、营销 0）、`ledger-pg-m04.integration.test.ts`（PG17：更正并发、同确认并发、撤权×更正竞态 20 轮、撤权先持锁/更正先持锁、目标并发、重启无幽灵目标）。
10. 验证：tsc、M01–M04 专项、相关回归、全量、test:pg（start.sh → FRONT_CLAW_PG_BIN=pg-temp PG17 → stop.sh）、typecheck、build；输出到 M04/test-output。
11. 产物：m04.patch（相对 793ce100）、m04-cumulative.patch（相对 f2a8105）、m04-tree.txt、changed-files.txt、REPORT.md、SHA256SUMS。
