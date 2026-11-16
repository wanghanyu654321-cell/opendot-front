# M01 实施计划

此计划在代码修改前写入。基线、约束、非目标及依赖见 ISSUE.md。

## 步骤与目标文件

1. 只读核对 G/L/F，建立 BASELINE-ALIGN.md。聚焦 `report-parse.ts`、`directory-store.ts`、`performance-store.ts`、`performance-postgres.ts`、`assistant-tools.ts`、`wecom-bot-handler.ts`、`wecom-bot-unified-handler.ts`、`front-claw-boot.ts`、`performance-open.ts`、`wecom-bot-pilot.ts`。核对 r5 先开库、r6 pg 依赖、r7 幂等关闭、r8 资源释放/回包、r9 模型契约。验收：本地 diff/哈希/确切来源，不套整包、不联网补材料。
2. 新增 `tests/role-eval/employee-loop-m01.test.ts` 的有效失败用例，使用 `sql-fixture.ts` 的 MemorySql 与 PG store；再最小补受控员工入口。拟在统一 handler 或小型员工适配模块补完整身份/本人范围、会话草稿版本、持久消息关联和开关。`wecom-bot-handler.ts` 透传可信消息/会话/绑定信息，保留全局指纹在资源准备之前。`front-claw-boot.ts` 接线，必要时 `performance-open.ts` 增 PG 必须模式和幂等关闭。复用 PG 草稿事务，不另建账本。验收：专项红→绿，零写负例比较 entries/drafts 完整快照。
3. 补组合入口测试：合成至少三人两店及别名；原消息重放/冲突、提交后回复丢失、同一替身库重启、关闭保留账和草稿、故障不转旧 SQLite。按必要性扩展已有 store-entry 测试。验收：`npx vitest run tests/role-eval/employee-loop-m01.test.ts`。
4. 类型、回归、构建与全量。依次运行 `npx tsc --noEmit`；专项；`npx vitest run tests/role-eval/store-entry.test.ts tests/role-eval/performance-store.test.ts tests/role-eval/report-parse.test.ts tests/role-eval/wecom-bot-report-confirm.test.ts tests/role-eval/wecom-bot-unified-handler.test.ts tests/role-eval/front-claw-multi-employee.test.ts` 并追加实际改动对应测试；`npx vitest run`；`npm test`、`npm run typecheck`、`npm run build`。命令在 repo 执行，输出写本工作区 M01/test-output，每份末尾追加退出码。真实 PG 不跑；全量已知两个失败如实保留。
5. 最终差异复核与 REPORT.md：检查无依赖/lock/输入材料修改、无 node_modules 进补丁。按用户要求 `git add -N .` 后从完整 B SHA 生成 `M01/m01.patch` 并记录 SHA256。报告 M02/M03 交接和缺口，不提交。

## 开关与风险处理

实现范围以受控员工模式隔离，关闭不清草稿/账目。旧高级业务兼容留给后片。不得用内存当 PG 的故障兜底；替身只能证明 SQL 调用及业务流程，不能证明真实 PG 锁/网络/崩溃持久性。若来源缺失，局部合成入口继续验证，禁止声称替换现场。中断时完整保存文件并写续跑记录。

## 实施中核对后的具体调整

- 最小员工适配独立为 `src/role-eval/employee-loop.ts`，由原统一 handler 选择；PG schema 不变，context/版本/最终回复存原 payload_json。
- 实际新增 `employee-loop-lifecycle-m01.test.ts`；扩展 store-entry、pilot、real-pilot 测试。标准员工（无 manager）组合反例发现 assembly 和 handler 两级旧门禁仍要求 manager，均改为原可信身份校验 + M01 本人/开关判断；`wecom-bot-assembly.ts` 纳入回归。
- 增加 `wecom-bot-delivery.ts` 的受控确定结果重放，沿原底座全局指纹防跨路由重用消息 ID；不把 SQLite 回复记录当业绩账。
- 全量额外出现子进程 EPERM。为区分改动与环境，在 `M01/baseline-check` 从 git B 只导出源码/测试/配置（227 文件，排除 env/凭据类文件名和 lock），只读链接已装 node_modules；对相同 5 个失败文件做同环境对照，8 个失败名称全部复现。没有切换 repo 分支。
