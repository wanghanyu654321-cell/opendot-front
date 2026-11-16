## 目标
净化 `packages/front-claw` 店务内核基线（基于 `front-dot@936085e`），修复 3 处实锤上线阻断缺陷，确保店务内核单测与 PostgreSQL 17 集成测试 100% 全绿通过。

---

## 一、GitHub 仓库内容与路径（线上分支与目录）
- **统一主仓库**：`https://github.com/wanghanyu654321-cell/opendot-front`
- **工作分支**：从 `main` 切出 `fix/issue-1-kernel-clean`
- **本任务工作目录**：仓库内 `packages/front-claw/`
- **仓库内全局契约文档**：`docs/OPENDOT-FRONT-MASTER-PLAN.md`
- **历史来源参考仓库**：`https://github.com/wanghanyu654321-cell/front-dot`（基线对应 commit `936085e356520614ca6efdccfdfde00ab3e5238b`）

## 二、本地工作区与参考资料路径（Windows 本机路径）
- **当前融合主仓本地路径**：`d:\Desktop\agent付费资料\opendot-front`
- **店务内核子包本地路径**：`d:\Desktop\agent付费资料\opendot-front\packages\front-claw`
- **本地只读历史参考路径（严禁修改）**：
  - `d:\Desktop\agent付费资料\qiwe-agent`（企微长连接与 7 岗前史参考）
  - `d:\Desktop\agent付费资料\claw-agent`（美业岗位与预约状态机前史参考）
  - `d:\Downloads\HYDROGEN-REVIEW-1859-final.md`（独立审查报告，核对回归根因参考）

---

## 三、反过度防御纪律与严禁触碰边界
1. **严禁引入** `front-dot` 旧 PR #18 (`e1adbe6` / `afbebea4`) 中的 `contention: 'restore_pending'`、`closeConfirming` 的 `$6` SQL 参数位移或 `upgrade-image.py`。保持 `936085e` 原有的 `commit-gate.ts`、`performance-postgres.ts`、`employee-loop.ts` 逻辑不变！
2. **严禁触碰**仓库根目录的 `src/`（OpenDot 宿主代码由 Issue #2/#3 负责）。
3. **严禁**在 git commit 或日志中写入任何个人邮箱或 `Co-authored-by` 尾部。

---

## 四、具体改动文件计划（仅限以下 4 个文件）

1. `packages/front-claw/tests/deploy/deployment.test.ts`（约第 122–127 行）：
   - **根因**：`scripts/deploy/deploy.sh` 在 `branch == main` 且工作树干净时正常 dry-run 退出 `0`，导致 `'refuses tagging a dirty tree and supports an explicit preview override'` 中的 `expect(exec('bash', ['scripts/deploy/deploy.sh'])).rejects.toThrow()` 在干净 `main` 上必败。
   - **修改**：在测试内构造一个临时未跟踪文件（例如 `scripts/deploy/.dirty-probe-tmp`）触发 dirty 拒绝，并在 `finally` 中清理该临时文件，使该测试在干净 `main` 与任意分支下均稳定通过。
2. `packages/front-claw/tests/opendot/append-evidence.integration.test.ts`：
   - **根因**：测试夹具使用了不在 `CAPABILITIES` 集合中的 `'report_for_store'`，触发 `synthetic_policy` 报错。
   - **修改**：将夹具中的 `'report_for_store'` 替换为合法的 `'report_proxy'`，保留全部 15 个场景、136 项检查断言不删减。
3. `packages/front-claw/tests/opendot/adapter-pg-m07.integration.test.ts`（约第 137–162 行）：
   - **根因**：首条真实 PG 竞态用例未将 `admin` 客户端与 `a.service.close()` 放入 `try / finally`，若中途断言失败会遗留未释放连接，触发 `57P01` 未捕获错误。
   - **修改**：用 `try / finally` 包裹 `admin` 事务回收与 `await a.service.close()`。
4. `packages/front-claw/src/standalone/main.ts`（约第 21–25 行）：
   - **根因**：生产分支（`offline === false`）将 `FRONT_CLAW_NOTIFY_DISPATCH` 硬编码为 `'0'`，导致 M06 持久通知无法通过环境变量开启。
   - **修改**：将生产分支中的 `FRONT_CLAW_NOTIFY_DISPATCH: '0'` 改为 `FRONT_CLAW_NOTIFY_DISPATCH: env.FRONT_CLAW_NOTIFY_DISPATCH ?? '0'`（离线分支保持 `'0'`）。

---

## 五、验收命令与向主对话回传格式
在 `packages/front-claw` 目录下依次执行并全部通过：
1. `npm run typecheck` -> exit 0
2. `npm run build` -> exit 0
3. `npm run test:ci` -> 0 failed
4. `npm run test:pg` -> 全量通过（含 `adapter-pg-m07`、`r2-pg`、`append-evidence`，0 failed、0 unhandled errors）

**完成后向主对话回传**：
1. 分支名、最新 Commit SHA、Tree SHA；
2. `git diff main..HEAD --stat`；
3. 上述 4 条命令的真实退出码与通过/失败统计。
