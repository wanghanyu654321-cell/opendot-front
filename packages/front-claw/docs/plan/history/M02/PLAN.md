# M02 实施计划

写于代码改动前；范围、非目标见 ISSUE.md。工作树 `<本地路径>`（detached f2a8105 + m01.patch，`git add -N` 新文件）。不 commit。

## 步骤

1. **快照**：`M02/m01-snapshot/`（m01-working.diff、git-status、15 个文件副本及 sha256）。验收：diff sha256 = 7819d48e…a31e。✅ 已完成。
2. **语料先行**：私有评测语料（≥50 条，先写并记录 sha256 到校验文件，之后不改），再写调参语料（≥50 条）。标签：report / followup / progress / result / appointment / summary / chitchat / marketing / clarify。包含：“帮我写今天报数清单”、无空格预约、无序号确认、客户名+员工名、复合意图。
3. **分类器** `src/role-eval/intent-router.ts`：`classifyIntent(text,{businessDay})` 纯函数；`decideRoute(c,{marketingEnabled,marketingGranted})`；`classifyWithSemantic(text,port,{signal,deadline})` 至多一次、带截止、畸形→澄清。仅用调参集迭代。
4. **预算与日志** `src/role-eval/request-budget.ts`、`src/role-eval/route-log.ts`。
5. **员工入口** `src/role-eval/employee-entry.ts`：包裹 M01 `createEmployeeLoop`；分类→店务交 M01；闲聊本地回复；营销仅显式+启用+获权调用可选 `marketing` 端口；其余澄清。接到 `wecom-bot-unified-handler.ts` 的 employeeLoop 分支（新增可选 options：`router`）。
6. **代报** `employee-loop.ts`：括号员工须为本店在职完整人员；草稿记录 `itemsDigest`；确认时校验摘要与本店人员，无摘要的旧草稿保持仅本人。
7. **岗位对话纠偏** `wecom-bot-conversations.ts`：`pickAutoRole` 不回落 marketing；route 中营销岗位仅在明确营销或当前上下文已是营销的未知跟进时提交；店务/闲聊不提交营销。更新断言旧缺陷的 auto-role 测试（在报告中逐条列出）。
8. **测试**：`tests/role-eval/intent-router-m02.test.ts`（规则/决策/语义端口超时与畸形）、`tests/role-eval/employee-entry-m02.test.ts`（路由+预算+日志+代报，MemorySql）、读取评测语料的测试（指标与门槛，输出 JSON）、`tests/role-eval/employee-loop-pg-m02.integration.test.ts`（真实 PG17 临时集群）。
9. **验证命令**（repo-m02，TMPDIR=M02/tmp，输出到 M02/test-output，末尾 exit=）：
   - `npm exec --offline -- tsc --noEmit`
   - `npm exec --offline -- vitest run tests/role-eval/employee-loop-m01.test.ts tests/role-eval/employee-loop-lifecycle-m01.test.ts`
   - `npm exec --offline -- vitest run <M02 测试文件>`
   - `npm exec --offline -- vitest run`（全量）
   - `FRONT_CLAW_PG_BIN=<本地路径> npm run test:pg`
   - `npm run build`
10. **产物**：m02.patch（相对 base+M01 的增量）、m02-cumulative.patch（相对 f2a8105）、REPORT.md、SHA256SUMS。

## 风险

- 语料与规则同一作者：盲测集先冻结，但不等于独立盲测；交助手B补独立语料。
- 内存请求登记仅进程内；跨重启的最终回复去重仍依赖 M01 全局指纹与 PG 草稿。
- PG17 ≠ 线上版本。
