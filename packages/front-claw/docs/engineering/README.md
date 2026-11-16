# 工程实现

## 1. 技术栈

- Node.js ≥ 22.13，TypeScript 5.9（`strict`、`noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`），ESM（NodeNext）。
- 依赖：`@wecom/aibot-node-sdk`（企微智能机器人长连接）、`pg`、`adm-zip`；测试用 Vitest 4。
- 构建：`tsc -p tsconfig.build.json` → `dist/`。OpenDot 挂点按绝对路径动态 import `dist/opendot/index.js`。

## 2. 关键实现

| 主题 | 做法 | 位置 |
|---|---|---|
| 单消费者 | PG 租约行＋单调 epoch；消息处理前、回复前、入账事务内三处核对 | `src/opendot/consumer-lease.ts`、`src/role-eval/fencing.ts` |
| 确定性幂等 | 操作 ID、通知 ID 都由业务键确定性生成；010 唯一约束兜底 | `operation-records.ts`、`migrations/010_*` |
| 确认迁移 | `commitConfirmingDraft` 只有本次改到状态才返回 >0；入口据此决定回「已入账」还是「已处理」（D151） | `performance-postgres.ts`、`performance-store.ts`、`employee-loop.ts` |
| 单闸 | `mayCreateConfirmableReportDraft`，带标记 `R17-single-draft-gate` 便于变异测试 | `confirmable-draft-gate.ts` |
| 标准行 | 唯一一份语法；归属、客套、白名单备注在语法里剥离 | `standard-line.ts`、`config/*.json` |
| 金额 | 以分计，定点数，不经 JS 浮点；模糊金额检测 | `money.ts`、`amount-guard.ts`、`amounts.ts` |
| 模型路径 | 分类接口（D119），离线桩只会追问；超时 8 秒即追问 | `model-classify.ts`、`intent-classifier.ts`、`model-path-ask.ts` |
| 通知 | 持久化领取 / 派发 / 结果分开记录，未知结果不盲目重试 | `notification-dispatch.ts`、`notification-status.ts` |
| 迁移 | 版本表＋校验和＋advisory lock；dry-run 默认；守卫拒绝共享库 | `src/role-eval/schema-migrations.ts`、`src/migration/` |
| 凭据 | 只从仓库外的受保护文件或 env 读取；启动日志不打印连接串 | `credential-file.ts`、`protected-config.ts`、`pg-pool.ts` |

## 3. 测试与评测

### 单元与集成

- `npm test`：`tests/**/*.test.ts`（不含 `*.integration.test.ts`）。目录按里程碑（`role-eval/`、`migration/`、`opendot/`）和修复轮（`r1/`…`r17/`）组织。
- `npm run test:ci`：同上，但跳过 `tests/native/live-model-smoke.test.ts`。这个文件依赖原宿主的真实模型环境，离线有 2 条已知失败。
- `npm run test:pg`：PG 集成测试。只能指向一次性合成库，需要 `AUDIT_PG_ALLOW=isolated-synthetic` 和 `AUDIT_PG_URL`。
- `integrations/native/*.test.mjs` 是旧底座的 node:test 用例，不在 `npm test` 里。

### 变异测试

关键防线（单闸、名单取值、确认幂等、复合交模型等）都有对应变异：故意改坏代码后，测试必须失败。变异脚本在各轮的私有产物里；每轮报告写明变异数和是否全部杀死（R17 为 25/25，R18b 为 49/49）。

### 门禁评测

- `scripts/eval-gates.sh --corpus <jsonl> [--model stub|live]`：把任意同格式语料喂给员工入口，输出门①–④的数字、每条结果和延迟 p50/p95。默认用模型桩。
- `tests/r7/fixtures/r7-eval-sample.jsonl` 是脚本自测用的小样本（自编）。
- **独立留出集**由审查方每轮新写、冻结后才读开发方的代码，开发方不读原句、映射和复审原文。留出集不在本仓库。
- **锁定回归集**：从早期已公开的语料里挑出此前判为通过的标准行，按编号回归。它的测试会在运行时读取那些语料，所以没有放进公开版；结果写在各轮报告里（R17 为 48/56；R18b 为 38/56，分母里 15 条待正式实测、2 条 D130 c 产品例外、1 条按 D165 规则先问）。

### 公开版相对私有工作树少的测试

为了不公开评测语料，读取评测语料的测试文件和对应 fixture 没有导出（共 14 个用例）。其余测试与私有工作树结果一致。

## 4. 开发流程

团队分工：开发和独立复审由两个 AI 助手分别承担（M01–R17 由助手A经执行代理在隔离环境写代码、助手B复审并每轮新写留出集；R18 起两者对调），另有产品负责人和架构负责人。决策只有项目负责人 hanyu 本人能拍板。

每一轮：

1. 写 `ISSUE.md`（要修什么）和 `PLAN.md`（怎么修）。
2. 在独立工作树上改：先写会失败的测试，再做最小实现。
3. 验收：typecheck、build、全量单元、test:pg 多次、变异、锁定回归。
4. 冻结：用临时索引 `git write-tree` 得到树哈希，导出补丁和 sha256，写 `REPORT.md`。
5. 复审：审查方核对哈希后用新的留出集判准入；不准入就开下一轮。
6. 新的产品口径分配 D 号；决策文件只追加，写之前先核对磁盘上的 sha，不一致就停下重读合并。

详细过程见 [WORKFLOW-SUMMARY-20261111.md](WORKFLOW-SUMMARY-20261111.md)，提交和 PR 规范见根目录 [CONTRIBUTING.md](../../CONTRIBUTING.md)。

## 5. 背景资料

- [upstream-qiwe-agent-README.md](upstream-qiwe-agent-README.md)：上游仓库原 README。
- [background-20261110/](background-20261110/)：11-10 的代码变更与开发总结（迁移前旧版现场试点）。
