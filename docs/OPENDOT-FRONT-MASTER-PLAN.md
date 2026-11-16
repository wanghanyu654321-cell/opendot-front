# OpenDot × Front Claw 原生融合总计划与分对话开发契约

> 仓库地址：`https://github.com/wanghanyu654321-cell/opendot-front`  
> 本地工作区路径：`d:\Desktop\agent付费资料\opendot-front`  
> 关联历史参考路径（只读参考，禁止修改）：
> - `d:\Desktop\agent付费资料\qiwe-agent`（企微 7 岗会话与受控试点前史参考）
> - `d:\Desktop\agent付费资料\claw-agent`（美业岗位与 PG 预约状态机前史参考）
> - `d:\Desktop\agent付费资料\OpenDot-main-0689098.zip`（OpenDot 原始压缩包，`sha256: 6ad0c734...`）

---

## 一、仓库目录结构与基准说明

本仓库将 **OpenDot 通用 Agent 底座** 与 **Front Claw 确定性店务账本内核** 统一在同一个干净的代码树中，消除旁路 `opendot-hook.patch`：

```text
opendot-front/
├── src/                                  # OpenDot 原生宿主源码
│   ├── channel-prefixes.ts               # [Issue #2] 注册 wecom: 前缀
│   ├── im-channel-capabilities.ts        # [Issue #2] 注册 wecom 通道能力
│   ├── im-channel.ts                     # [Issue #2] 导出 createWeComChannel
│   ├── im-manager.ts                     # [Issue #2] 新增 connectUserWeCom 委托 connectChannel
│   ├── wecom.ts                          # [Issue #2 新增] 企微长连接原生 IMChannel 实现
│   ├── wecom-front-claw-bridge.ts        # [Issue #3 新增] 店务前置三态拦截与 OpenDot 桥接器
│   └── index.ts                          # [Issue #4] 启动与 Phase 1 关停总装接线
├── web/                                  # OpenDot React Web 管理台
├── container/                            # OpenDot Agent Runner (Pi Coding Agent 0.84.2)
├── packages/
│   └── front-claw/                       # Front Claw 店务内核（基于 front-dot@936085e 干净提取）
│       ├── src/role-eval/                # R23 确定性店务状态机、单闸、M03 权限、M06 通知、企微 SDK 适配
│       ├── src/opendot/                  # 租约 (consumer-lease) 与适配器基础组件
│       ├── src/standalone/               # 独立验证入口与兼容模型分类器
│       ├── migrations/                   # 007..011 PostgreSQL 17 账本 schema 迁移
│       └── tests/                        # 店务单元与 PG 17 集成测试
└── docs/
    └── OPENDOT-FRONT-MASTER-PLAN.md      # 本总计划与跨 Issue 接口契约
```

---

## 二、核心架构原则（反过度防御纪律）

1. **原生 `IMChannel` 集成、零旁路**：
   - 废除 `opendot-hook.patch` 动态外部加载旁路；
   - 将 `@wecom/aibot-node-sdk@1.0.7` 的 `WSClient` 封装为 OpenDot 原生 `IMChannel`（`channelType: 'wecom'`），交由 `imManager.connectChannel` 统一管理凭据唯一锁（`claimCredential`）、重连锁（`withChannelLock`）、优雅停机门禁（`pauseInbound`）与 `#account:` JID 作用域。
2. **快路径闭包 `req_id` vs 慢路径主动推送 `SEND_MSG` 一刀切（不建 Reply Ticket 表、不合并物理队列）**：
   - **店务快路径（`handled` / `failed`）**：在 `wecom.ts` 入站 `receive(event)` 闭包内同步执行完毕（< 200ms），直接使用当前栈帧冻结的 `event.reqId` 调 `sender.reply`（`WsCmd.RESPONSE` 流式帧），随后直接 `return`。
   - **OpenDot Agent 慢路径（`pass`）与 M06 主动提醒**：当消息放行进 OpenDot `storeMessageDirect` → `processGroupMessages` 后，Agent 完成回答调用 `imManager.sendMessage('wecom:c2c:...', text)` 时，`WeComChannel.sendMessage` **固定只调 `sender.notify`（即 `WsCmd.SEND_MSG` 主动推送，生成新 UUID 请求号）**。
   - **收益**：慢路径与定时通知永远不碰入站 `req_id`，物理上杜绝连续消息 A/B 串 `req_id`，无需新建 Reply Ticket 数据库表，也无需合并 M06 PG Outbox 与 OpenDot SQLite Outbox。
3. **`unknown` 状态严禁切换补发或触发外层重试**：
   - 底层 `wecom-bot-sender.ts` 返回 `state === 'unknown'`（已写入 WebSocket 但等待 ACK 超时）时，只记告警日志并正常结束，严禁切 `SEND_MSG` 补发，也严禁向 `imManager` 抛错触发二次重试。
4. **有挂起项（Pending）时的非店务放行与保留（`D175 / D178 / D179 / D183`）**：
   - 收包瞬间调用 `capturePendingArrival(store)` 锁定 `D183` 到达序号；
   - 有未过期报单草稿时，明确的营销/岗位对话经 `employee-entry.ts` 的 `loop(input, '')` 预检保留原挂起项并放行（`pass`），后续「对」仍只由店务状态机确认；
   - 模型分类失败或超时一律保守追问（`handled`），绝不兜底丢给营销 Agent；店务失败/未绑定/越权一律返回 `failed`，绝不漏进通用 Agent。
5. **同进程 Agent 权限护栏（不搞嵌套容器）**：
   - 放行给 OpenDot Agent 的岗位 Profile 禁用高危 Shell/文件写工具，且不注入 PG 账本写凭据；账本写入仅由宿主进程内 `bootFrontClaw` 持有。

---

## 三、跨 Issue 共享接口契约（Issue #2 与 Issue #3 共同遵守）

在 `src/wecom.ts` 中定义并导出以下前置拦截接口，由 `src/wecom-front-claw-bridge.ts` 实现：

```ts
export interface WeComInboundTextEvent {
  readonly reqId: string;
  readonly botId: string;
  readonly corpId?: string;
  readonly memberId: string;
  readonly messageId: string;
  readonly text: string;
  readonly createTime?: number;
}

export type WeComPrecheckOutcome =
  | {
      readonly kind: 'handled' | 'failed';
      readonly replies: readonly string[];
    }
  | {
      readonly kind: 'pass';
      readonly corpId: string;
      readonly accountId: string;
      readonly storeId: string;
      readonly displayName: string;
      readonly workspaceJid?: string;
      readonly expiredReminder?: string;
    };

export type WeComPrecheckPort = (
  event: WeComInboundTextEvent,
) => Promise<WeComPrecheckOutcome>;
```

---

## 四、四个分对话 Issue 边界总表

| Issue | 负责分对话 | 允许修改的目录/文件 | 严禁触碰的目录/文件 |
|---|---|---|---|
| **Issue #1**：店务内核基线净化与 3 处实锤阻断修复 | 分对话 A | `packages/front-claw/tests/deploy/deployment.test.ts`<br>`packages/front-claw/tests/opendot/append-evidence.integration.test.ts`<br>`packages/front-claw/tests/opendot/adapter-pg-m07.integration.test.ts`<br>`packages/front-claw/src/standalone/main.ts` | 严禁触碰根目录 `src/`；严禁引入 `e1adbe6` 的 `restore_pending` 或 `$6` SQL 位移 |
| **Issue #2**：OpenDot 原生企微长连接 `IMChannel` 封装 | 分对话 B | `src/channel-prefixes.ts`<br>`src/im-channel-capabilities.ts`<br>`src/wecom.ts`<br>`src/im-channel.ts`<br>`src/im-manager.ts`<br>`tests/wecom-im-channel.test.ts` | 严禁修改 `packages/front-claw/` 内部业务逻辑 |
| **Issue #3**：店务前置三态桥接器与 OpenDot 挂起项/权限打通 | 分对话 C | `packages/front-claw/src/role-eval/employee-entry.ts`<br>`src/wecom-front-claw-bridge.ts`<br>`tests/wecom-front-claw-bridge.test.ts` | 严禁修改 `packages/front-claw/src/role-eval/performance-postgres.ts` 或 `commit-gate.ts` |
| **Issue #4**：总装接线、Node 22 + PG 17 统一 CI 与单容器部署 | 分对话 D | `src/index.ts`<br>`deploy/`<br>`.github/workflows/ci.yml`<br>`tests/wecom-opendot-e2e.test.ts` | 在 #1、#2、#3 合入后执行 |
