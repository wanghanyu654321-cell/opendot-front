## 目标
将企微智能机器人 SDK 长连接（`@wecom/aibot-node-sdk@1.0.7`）封装为 OpenDot 原生 `IMChannel`（`channelType: 'wecom'`），接入 `imManager.connectChannel` 统一管理，彻底取代旁路 `opendot-hook.patch`。

---

## 一、GitHub 仓库内容与路径（线上分支与目录）
- **统一主仓库**：`https://github.com/wanghanyu654321-cell/opendot-front`
- **工作分支**：从 `main` 切出 `feat/issue-2-wecom-im-channel`
- **仓库内全局契约文档**：`docs/OPENDOT-FRONT-MASTER-PLAN.md`（必读，含跨 Issue 的 `WeComPrecheckPort` 接口定义）
- **仓库内需复用的企微长连接底层模块**：
  - `packages/front-claw/src/role-eval/wecom-bot-sdk.ts`（鉴权 `authenticated` 门禁、`epoch` 代次、同步 `ws.send` 准入与 `isBotSdkNotStarted`）
  - `packages/front-claw/src/role-eval/wecom-bot-sender.ts`（有界超时、`accepted | rejected | blocked | unknown` 四态）
  - `packages/front-claw/src/role-eval/wecom-bot-transport.ts`（`normalizeBotFrame` 单聊帧解析）
  - `packages/front-claw/src/opendot/consumer-lease.ts`（PG 单消费者租约 `ConsumerLease`）
- **仓库内 OpenDot 通道对照模板**：
  - `src/im-channel.ts`、`src/im-manager.ts`、`src/dingtalk.ts`、`src/wechat.ts`

## 二、本地工作区与参考资料路径（Windows 本机路径）
- **当前融合主仓本地路径**：`d:\Desktop\agent付费资料\opendot-front`
- **企微底层模块本地路径**：`d:\Desktop\agent付费资料\opendot-front\packages\front-claw\src\role-eval\`
- **本地只读历史参考路径（严禁修改）**：
  - `d:\Desktop\agent付费资料\OpenDot-main-0689098.zip`（OpenDot 原始基准包）
  - `d:\Desktop\agent付费资料\qiwe-agent\src\role-eval\`（企微长连接早期实现参考）

---

## 三、核心架构契约（反过度防御纪律）
1. **快路径闭包 `req_id` vs 慢路径主动推送 `SEND_MSG` 一刀切（不建 Reply Ticket 数据库表，不合并物理队列）**：
   - 店务快路径（`precheck(event)` 返回 `handled` 或 `failed`）直接在 `receive(event)` 闭包内使用当前栈帧冻结的 `event.reqId` 调用 `sender.reply`（`WsCmd.RESPONSE`）并立即 `return`。
   - 放行给 OpenDot Agent 的慢路径（`precheck(event)` 返回 `pass`）以及 M06 主动通知，在回调 `IMChannel.sendMessage(chatId, text)` 时，**一律固定调用 `sender.notify(memberId, text)`（`WsCmd.SEND_MSG` 主动推送）**。慢路径永远不读取或消耗任何入站 `req_id`！
2. **`unknown` 状态不重试、不切通道**：
   - 当 `sender.reply` 或 `sender.notify` 返回 `state === 'unknown'`（已上链但等待 ACK 超时）时，只记 `logger.warn` 并正常返回，**严禁切通道补发，严禁向 `imManager` 抛异常触发二次重试**。
3. **先租约后连接，失租立即断开**：
   - 支持注入可选 `lease: ConsumerLease`：只有 `await lease.acquire()` 为 `true` 时才建立 `WSClient` 连接（`maxReconnectAttempts: 0, maxAuthFailureAttempts: 0, requestTimeout: 4000`）；失租或 `lease.held() === false` 时立即断开连接、停止收发。
4. **会话 JID 域隔离**：
   - 放行进入 OpenDot 的单聊 `rawJid` 格式固定为 `wecom:c2c:${outcome.corpId}:${event.memberId}`，经 `opts.normalizeIncomingJid` 自动加上 `#account:${botId}` 作用域后调用 `storeChatMetadata` → `opts.onNewChat` → `storeMessageDirect` → `broadcastNewMessage` → `notifyNewImMessage`。

---

## 四、具体改动文件计划（仅限以下 6 个文件）
1. `src/channel-prefixes.ts`：在 `CHANNEL_PREFIXES` 中新增 `wecom: 'wecom:'`。
2. `src/im-channel-capabilities.ts`：在 `IM_CHANNEL_CAPABILITIES` 中新增 `wecom` 通道能力声明。
3. `src/wecom.ts`（新增）：导出 `WeComInboundTextEvent`、`WeComPrecheckOutcome`、`WeComPrecheckPort`、`WeComConnectionConfig` 及 `createWeComConnection`。
4. `src/im-channel.ts`：新增并导出 `createWeComChannel(config: WeComConnectionConfig): IMChannel`。
5. `src/im-manager.ts`：新增 `connectUserWeCom`，委托现有的泛型方法 `this.connectChannel(userId, 'wecom', channel, ..., config.botId)`。
6. `tests/wecom-im-channel.test.ts`（新增）：覆盖以下 5 项核心契约单测：
   - `handled` 走当前帧 `req_id` 被动回复，不进 `storeMessageDirect`；
   - `failed` 走当前帧 `req_id` 报错拦截，绝不漏进 `storeMessageDirect`；
   - 连续双消息 A（`pass` 慢回复）+ B（`handled` 快回复）并发：B 用 `req_id(B)` 秒回，A 随后通过 `imManager.sendMessage` 走 `WsCmd.SEND_MSG` 主动推回，零串号；
   - `unknown` 超时不触发二次 `SEND_MSG`、不抛异常；
   - 失租后自动断连且拦截后续收发。

---

## 五、向主对话回传格式
1. 分支名、最新 Commit SHA；
2. `git diff main..HEAD --stat`；
3. `WeComPrecheckPort` 的完整导出类型签名；
4. `tests/wecom-im-channel.test.ts` 与类型检查的真实运行结果。
