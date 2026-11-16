## 目标
实现 `src/wecom-front-claw-bridge.ts`（对接 Issue #2 的 `WeComPrecheckPort`），打通 `packages/front-claw` 店务内核与 OpenDot 原生 Agent 路由，确保收包即取 `D183` 到达序号、缺失 `corpId` 唯一可信绑定识别、有挂起报单时放行营销并保留挂起项（`D175`），且同进程 Agent 无写库越权风险。

---

## 一、GitHub 仓库内容与路径（线上分支与目录）
- **统一主仓库**：`https://github.com/wanghanyu654321-cell/opendot-front`
- **工作分支**：从 `main` 切出 `feat/issue-3-front-claw-bridge`
- **仓库内全局契约文档**：`docs/OPENDOT-FRONT-MASTER-PLAN.md`（含 `WeComPrecheckPort` 精确接口定义）
- **仓库内需调用的核心模块**：
  - `packages/front-claw/src/role-eval/front-claw-boot.ts`（`bootFrontClaw`）
  - `packages/front-claw/src/role-eval/employee-entry.ts`（`createEmployeeEntry`、`MarketingPort`、`D175/D178/D179` 挂起项预检）
  - `packages/front-claw/src/role-eval/pending-order.ts`（`capturePendingArrival`）
  - `packages/front-claw/src/opendot/adapter.ts`（参考 `bindingFor` 的缺失 `corpId` 唯一绑定校验与 `employeeQueues` 同员工串行）
  - `src/runtime-config.ts`（OpenDot 模型配置读取）

## 二、本地工作区与参考资料路径（Windows 本机路径）
- **当前融合主仓本地路径**：`d:\Desktop\agent付费资料\opendot-front`
- **店务内核本地路径**：`d:\Desktop\agent付费资料\opendot-front\packages\front-claw\src\role-eval\`
- **本地只读历史参考路径（严禁修改）**：
  - `d:\Desktop\agent付费资料\qiwe-agent\src\role-eval\wecom-bot-conversations.ts`（7 岗会话路由与 Workspace 校验参考）
  - `d:\Desktop\agent付费资料\qiwe-agent\integrations\native\frontagent-controlled-pilot.mjs`（员工身份与岗位 Workspace 绑定校验参考）

---

## 三、核心桥接契约
1. **收包瞬间锁定 `D183` 到达序号**：
   - 在进入同员工串行队列或调用任何模型分类前，同步发起 `capturePendingArrival(boot.store)`。
2. **严格三态输出（`handled | pass | failed`）**：
   - 未绑定身份（含带 `corpId` 不匹配、或缺 `corpId` 但无唯一启用可信绑定）、人员档案不完整（`displayName` 或 `storeName` 为空，防 PR-03）、M03 权限拒绝、或店务执行异常，一律返回 `{ kind: 'failed', replies }`，**严禁返回 `pass` 漏进 OpenDot Agent**。
   - 模糊报数或模型分类超时/失败，一律按店务澄清返回 `{ kind: 'handled', replies: [CLARIFY_REPLY] }`，**严禁兜底丢给营销 Agent**。
3. **有挂起项（Pending）时的非店务放行与保留（`D175 / D178 / D179`）**：
   - 当员工有未过期的待确认报单草稿时，若发来明确的营销文案请求且本人经 `marketingActor` 校验具备 `marketing` 权限，通过 `employee-entry.ts` 的 `loop(input, '')` 预检保留原挂起草稿（不清空）、结算已过期项，并返回 `{ kind: 'pass', corpId, accountId, storeId, displayName, expiredReminder }`；
   - 随后员工再发「对」时，仍由店务内核准确认领并入账原挂起草稿。
4. **同进程 Agent 权限护栏（不搞嵌套容器）**：
   - 放行给 OpenDot Agent 前，校验目标岗位 Profile 未授予任意 Shell/文件写工具，且桥接器绝不向 OpenDot Agent 上下文暴露 PG `store` 实例或数据库连接串。

---

## 四、具体改动文件计划（仅限以下 3 个文件）
1. `packages/front-claw/src/role-eval/employee-entry.ts`：
   - 增加可选配置 `passthroughMarketing?: boolean`：当 `decision.target === 'marketing'` 开启该选项时，在完成 `loop(input, '')` 身份与挂起项预检及 `marketingActor` 判权后，直接返回 `{ pass: true, expiredReminder: prepared.expiredReminder, actor: grantedActor }` 供桥接器转交 OpenDot 原生 Agent。
2. `src/wecom-front-claw-bridge.ts`（新增）：
   - 实现 `createWeComFrontClawBridge`，封装 `bootFrontClaw`、缺失 `corpId` 唯一绑定识别、同员工串行队列与 `WeComPrecheckPort` 三态返回。
3. `tests/wecom-front-claw-bridge.test.ts`（新增）：
   - 验证：① 标准行报数返回 `handled`；② 有 pending 草稿时发营销请求返回 `pass` 且保留 pending 草稿，随后发「对」成功入账 1 笔；③ 分类超时返回 `handled` 澄清而非 `pass`；④ 未绑定/空 `displayName` 返回 `failed`；⑤ 撤权后拒绝放行。

---

## 五、向主对话回传格式
1. 分支名、最新 Commit SHA；
2. `git diff main..HEAD --stat`；
3. `tests/wecom-front-claw-bridge.test.ts` 与 `packages/front-claw` 相关单测的真实运行结果。
