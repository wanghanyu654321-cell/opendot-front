# M07 议题：OpenDot 薄适配与唯一任务归属（2026-11-11 20:40 UTC+8 起）

来源：MERGED.md §M07（PR-09/12/15/24，DV-05/08/20/32；诉求③④⑥）。基线：M06 树 5839f303（repo-m06）。

## 现状（实测，不是推断）
- 本机有 OpenDot 源码：`<本地路径>`（来自 `<本地路径>`，sha256 `6ad0c734…ce49`，**没有 .git，拿不到 O 的提交 SHA**；无 node_modules，不能在本机跑它的类型检查/测试）。只读使用，不改。
- OpenDot 没有企微渠道：`src/im-channel.ts` 的工厂只有飞书/Telegram/QQ/微信/钉钉/Discord/WhatsApp。MERGED 非目标也写明不改企微 IMChannel → 企微长连接留在 Front Claw。
- OpenDot 没有宿主侧插件/扩展加载点：`src/index.ts`（22427 行）`main()` 里所有宿主服务都是写死的 `startXxxService()`，关停在 `shutdown()` Phase 1 里 `close()`（例：`startBotHandoffService` 20621 行 → 20713 行 `botHandoffs.close()`）。Plugin/MCP 机制是给 Agent Runner 用的，不是宿主服务。→ 按 MERGED「未找到受支持扩展点时先评审最小底座差异，不假装纯旁路已接通」：给出最小 OpenDot 差异（新增 1 个文件 + index.ts 3 处），**不应用到任何 OpenDot 目录**，只在临时副本上验证可打上。
- OpenDot goal-run：`src/personal-agent/goal-runtime.ts:36` `requestId = goal-run:${claim.id}`，只处理 `task-scheduler` 领取的 SQLite `scheduled_tasks`（`claim.definition_snapshot.personal_goal`）。Front Claw 业务任务（报数/预约/通知出站箱）都在 Front Claw 自己的 PG 里，不进 OpenDot 调度表 → goal-run 天然领不到；需要测试证明适配器不往宿主调度器注册任何东西。
- OpenDot Mem0：`src/mem0-private-config.ts` 按主人/Dot 开关，默认全关；`docs/mem0-owner-private.md` 写明渠道来源不进 Mem0。Front Claw 不提交 OpenDot Product Input，不会触发。
- Front Claw 现有生产入口 `wecom-bot-pilot.ts` 绑死旧 Native 宿主（`initializeExecution` 队列/BootGate、`readNative` 读 Native 用户库）。OpenDot 里没有这些。M03 已在 handler 留了 `platformCapabilities`（注释“M07 接入前不传”）。
- 早期方案的 `integrations/opendot-front-claw/`（迁移总结 03 目录）是 98 行骨架：布尔准入 `admission-shim`、进程内 Map 的 `task-dedup`、`mem0-off`。MERGED 计划③要求替换布尔准入/Map 保障，只沿用目录形状、导出与 Mem0 关闭声明。

## 范围
1. 契约：适配器需要 OpenDot 提供什么（日志、生命周期 close、环境变量），每项标注 OpenDot 源码出处；没出处的标“假设”。
2. 适配器（Front Claw 侧，`integrations/opendot-front-claw/` 形状，代码在 `src/opendot/`）：默认关；开启后开 PG → 单消费者租约（PG）→ 企微长连接（注入的通道端口，生产实现复用现有 SDK 适配/发送器/帧解析）→ 现有 handler（M01–M06，含 M03 每步重判）→ 回复；M06 派发器复用同一发送器。
3. 授权取交集：OpenDot 平台层能力（配置）只作为 `platformCapabilities` 传入 M03 `decideAccess` 的最后一层，只能收窄。
4. 同一操作 ID 贯通：企微 msgid → 请求号 → 业务 operationId（草稿号）；取消只报告真实状态，不撤销已入账。
5. 唯一归属：Front Claw 操作 ID 前缀 `front-claw:`，与 `goal-run:` 不相交；单消费者 PG 租约 + 业务写入本身幂等（双调度也只一笔）。
6. Mem0 保持关闭。
7. 删除冗余：列证据后再删（只删本工作树文件）。

## 非目标
- 不改 OpenDot 目录、不改企微 IMChannel、不建 Goal、不新造公开业务 API、不恢复旧 admission 全模块；不真实连企微；不改 schema。

## 验收
- [ ] 契约测试（假 OpenDot 宿主）：默认关零副作用；开启后 入口→适配器→handler→隔离 PG→回复记录器。
- [ ] 真实 OpenDot 钩子文件（打补丁的临时副本）→ 动态加载适配器 → 同链路。
- [ ] 会话隔离、权限交集、适配器无法绕过 M03 重判（撤权后同一会话立即拒绝；平台层不能放宽）。
- [ ] 双调度（两个适配器实例同一帧）只一笔；单消费者租约（PG 竞争、到期接管、旧持有者失去后停止消费）。
- [ ] 取消：未开始/进行中/已入账三种如实报告；关停时在途请求如实收尾。
- [ ] 领取后崩溃/重启/重试：重启后同一 msgid 重放不重复入账。
- [ ] goal-run 不能领 Front Claw 任务；适配器源码不 import OpenDot/Mem0。
- [ ] tsc、M01–M07 定向、全量、typecheck、build、test:pg（PG17 临时，非线上版本）、变异检查。
