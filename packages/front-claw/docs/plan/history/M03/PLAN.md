# M03 实施计划（写于代码改动前）

1. 工作树：f2a8105 + M02/m02-cumulative.patch（已核对 264761c3…）；M02 树对象 b1d44021 用于生成增量补丁。✅
2. `src/role-eval/access-policy.ts`：类型、`parseAccessPolicy`（严格校验，未知能力/类型错=损坏）、`effectiveAccess(policy, person, platform?)`、`authorize(...)`、`ACCESS_POLICY_KEY`、`IMPLEMENTED_CAPABILITIES`。
3. 存储：`PerformanceStore` 增 `commitConfirmingDraft(draft, entries, guard?)`（事务内 `SELECT … FOR SHARE` 读策略行再判定）与 `updateConfigVersioned(key, expected, next, audit)`（`FOR UPDATE`）。内存实现同语义；`tests/role-eval/sql-fixture.ts` 忽略行锁子句（单线程）。
4. `employee-loop.ts`：`accessPolicy` 模式下各鉴权点；新查询（X的进度、经营/门店汇总、谁没报、门店排名）放 `store-queries.ts`，范围参数显式传入、按门店下推。
5. `intent-router.ts`：补“X的进度/谁没报/排名/排行”规则（店务意图）；重跑语料并如实报告盲测变化。
6. `employee-entry.ts`：策略模式下营销需 `marketing` 能力。
7. `unified-handler`/`front-claw-boot`/`wecom-bot-pilot`：透传 `accessPolicy`；boot 在策略模式下 remember 只核对。
8. 测试：`tests/role-eval/access-policy-m03.test.ts`（解析/交集/拒绝优先/版本）、`tests/role-eval/access-matrix-m03.test.ts`（矩阵、负例、测试员工A逐级降权、无越权读写通知）、`tests/role-eval/access-pg-m03.integration.test.ts`（PG17：降权后旧确认、入队后降权、撤权/提交并发、版本回退被拒）。
9. 验证命令同 M02（tsc、M01/M02/M03 专项、相关回归、全量、test:pg with FRONT_CLAW_PG_BIN、typecheck、build），输出 M03/test-output。
10. 产物：m03.patch（相对 M02 树）、m03-cumulative.patch（相对 f2a8105）、REPORT.md、SHA256SUMS。
