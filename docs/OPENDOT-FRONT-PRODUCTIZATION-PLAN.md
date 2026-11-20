# OpenDot × Front Claw 产品化收敛定案、真机试点验收与灰度手册

> 关联主仓库：`https://github.com/wanghanyu654321-cell/opendot-front`  
> 前置总览文档：[OPENDOT-FRONT-MASTER-PLAN.md](./OPENDOT-FRONT-MASTER-PLAN.md)  
> 对应收敛批次：Issues #5–#8（P0/P1 单营销受控收敛）+ Issues #9–#12（P2 口语体验、绑定即默认开通、四大软岗位独立工作区 + 7 个净版托管 Skills + 11 份培训知识库与店长只读快照注入）

---

## 一、总架构收敛定案（Issues #5 / #6 / #7 / #8）

### 1.1 双轨单进程收敛架构

```text
企微 WSClient (@wecom/aibot-node-sdk)
  │
  ▼ [1. 入站前置拦截: observedPrecheck → createWeComFrontClawBridge]
  ├─ handled / failed ──▶ WsCmd.RESPONSE (冻结 req_id 被动回复，< 200ms)
  │                        └─ 记录 dot.wecom.precheck (route: fast_path|model|clarify)
  │
  └─ pass (非店务营销) ──▶ [2. 动态受控工作区路由: isWeComManagedWorkspaceJid]
                           └─ web:wecom-front-claw:<sha256前16位> (每员工隔离)
                           └─ Safe Marketing Profile:
                              - context.source = 'managed'
                              - mcp.mode = 'disabled'
                              - skills = disabled | custom(['beauty-local-content'])
                              - disallowedTools = SAFE_MARKETING_DISALLOWED_TOOLS (10项)
                              - 记录 dot.wecom.agent_turn
                                │
                                ▼ [3. 通用 Outbox 真实回执: deliverWeComTextViaOutbox]
                                ├─ 出站前 M03 实时复核: authorizeOutbound(memberId, corpId)
                                │   └─ 记录 dot.wecom.outbound_auth
                                ├─ accepted (全块成功) ──▶ Outbox=delivered (真实 req_id 回执)
                                ├─ blocked / chunk-1 rejected (0块) ──▶ DefinitiveError → Outbox=failed (无 retryAt)
                                └─ unknown / 分块半成 (sentChunkCount>0) ──▶ 普通 Error → Outbox=uncertain (锁死禁重发)
                                    └─ 记录 dot.wecom.delivery (统一 correlationId 哈希关联)

[独立 PG 17 M06 主动通知分发器: notification-dispatch.ts]
  └─ 与 OpenDot SQLite channel_outbox 物理隔离、绝不合并
```

### 1.2 核心接线契约（已落地代码映射）

| 能力域 | 负责人与模块 | 落地契约 |
|---|---|---|
| **前置分类与 D175 门禁** | `packages/front-claw/src/role-eval/employee-loop.ts`<br>`packages/front-claw/src/role-eval/employee-entry.ts`<br>`src/wecom-front-claw-bridge.ts` | 1. 保留 `FC_MODEL_MODE=stub` 默认值；`live` 模式支持 `FC_MODEL_CLASSIFIER_MODEL` 与 `FC_MODEL_CLASSIFIER_MAX_TOKENS`（256..4096，默认 1024）。<br>2. 省略第二人称自查（如「帮我查看今天做了多少业绩」）直走本人进度查询。<br>3. 挂起草稿期间穿插营销放行后，记录 `d175InterleavedKey`：单字「对」严禁入账并提醒草稿摘要，需「确认入账」或「全部确认」才入账 1 笔。 |
| **企微真实回执 Outbox** | `src/wecom.ts`<br>`src/im-channel.ts`<br>`src/im-manager.ts`<br>`src/wecom-front-claw-runtime.ts`<br>`src/index.ts` | 1. `deliverScopedChannelOutput` 对 `wecom` + `text` 走 `deliverWeComTextViaOutbox` 调 `imManager.sendMessageWithReceipt`。<br>2. `accepted` → 返回真实 `providerMessageId` 落 `delivered`；`blocked(0块)` / `rejected(sentChunkCount===0)` → 抛 `DefinitiveChannelDeliveryError`（不设 `retryAt`，直接落 `failed`）；`unknown` 或任意 `sentChunkCount > 0` → 抛普通 `Error` 锁死 `uncertain` 阻断重发。<br>3. 飞书/钉钉/Telegram/QQ/微信/WhatsApp/Discord 与 M06 PG `notification-dispatch.ts` 保持 100% 原样。 |
| **出站 M03 实时复核** | `src/wecom-front-claw-bridge.ts`<br>`src/wecom-front-claw-runtime.ts`<br>`src/wecom.ts` | `startWeComFrontClawRuntime` 将 `bridge.authorizeOutbound` 注入 `connectUserWeCom(..., { authorizeOutbound })`。发送前（及分块发送每块前）实时重查 PG M03 策略，刚被撤权/停用/跨店失效成员的在途慢路径任务结果必须返回 `blocked`、零物理发信。 |
| **四段 Langfuse 脱敏观测** | `src/personal-agent/host-observability.ts`<br>`src/wecom-front-claw-runtime.ts`<br>`src/index.ts` | 1. 串通 `dot.wecom.precheck` → `dot.wecom.agent_turn` → `dot.wecom.outbound_auth` → `dot.wecom.delivery`，统一使用脱敏 `correlation_ref = sha256(correlationId).slice(0, 24)`。<br>2. 在 `wecom-front-claw-runtime.ts` 接入 `onObservation` 时，将中文 `route`（`'快通道' | '模型' | '追问'`）归一化为 `'fast_path' | 'model' | 'clarify'`，常见中文 `gateReason` / `errorCategory` 映射为 ASCII 枚举，未知非 ASCII 仍 Fail-Closed 标 `'redacted'`，确保零业务明文与 PII 出境。 |
| **最小工具集与四岗 7 托管 Skills** | `container/agent-runner/src/tool-policy.ts`<br>`src/wecom-front-claw-skills.ts`<br>`src/wecom-front-claw-runtime.ts`<br>`src/index.ts` | 1. `isWeComRestrictedTurn` 注入完整 10 项 `SAFE_MARKETING_DISALLOWED_TOOLS`（`Bash`, `Write`, `Edit`, `NotebookEdit`, `Task`, `TaskOutput`, `TaskStop`, `WebFetch`, `WebSearch`, `mcp__miniclaw__*`），`tool-policy.ts` 支持 `mcp__miniclaw__*` 通配拦截。<br>2. P2 默认开启四大软岗位（`marketing / training / manager_ops / reception_ads`），通过 `deriveWeComEmployeeWorkspace` 派生五元组独立工作区（如 `web:wecom-front-claw:training:<hash>`），并由 `ensureBundledWeComRoleSkills` 按岗 Fail-Closed 挂载 7 个净版托管 Skills（3 营销 + 1 培训 + 1 店长复盘 + 2 接待投流）；同时保留 `FRONT_CLAW_WECOM_MARKETING_SKILL_ID` 与 `FRONT_CLAW_WECOM_ROLE_SKILLS_ENABLED=0` 一键回滚兼容。 |
| **P2 口语体验、绑定即开通与只读上下文注入** | `packages/front-claw/src/role-eval/*`<br>`src/wecom-front-claw-bridge.ts`<br>`src/wecom.ts` | 1. 4 项真机口语体验：D175 插话后 `确认认账` 容错与尾部提示一致性、项目备注白名单（如「张姐刚做了补水项目680」）直出草稿、「查一下二店业绩」简写跨店拒绝、「王姐明天下午补水预约」→「4点」多轮补时间。<br>2. `FRONT_CLAW_WECOM_AUTO_ROLE_GRANT=1` 默认为已绑定在职员工按 `tier` 自动幂等补齐本店店务与软岗位授权（已撤权/停用绝不复活）。<br>3. `training` 岗自动检索 11 份内置脱敏培训教材章节、`manager_ops` 岗（仅限店长/老板）自动生成本店今日与本月已确认业绩只读快照，由 `wecom.ts` 以受控只读参考块当轮注入。 |

### 1.3 冻结红线清单（本波严禁擅自打开）

| 冻结项 | 当前状态 | 解除前提 |
|---|---|---|
| `deploy/docker-compose.yml` 容器内存限额 | **保持 `core: 768m`、`pg: 512m`** | 完成 72h 真机 `free -m` + `docker stats` 峰值基线采集与容量评估 |
| `Mem0` 私有记忆 | **全局强制关闭（`assertMem0Off`）** | 独立多租户记忆隔离专项评审后另行立项 |
| `training-knowledge.ts` 上培训岗 | **未挂载、未修改** | 完成 P1 营销试点稳定期与 P2 多岗准入门禁 |
| M06 夜间静默与 PG/SQLite 队列合并 | **保持默认禁用夜间静默、两套队列物理分离** | 客户侧正式确认夜间免打扰窗口规则 |
| 自动 Session 轮换 | **禁止实现自动轮换** | 仅在 Profile 版本/Hash 变更时被动失效重建 |
| 生产默认分类器模式 | **保持 `FC_MODEL_MODE=stub`，不默认写死 `live` 或密钥** | 试点门店显式在仓外 `core.env` 填入 Provider 凭据并验收 |
| M06 主动通知默认开关 | **保持 `.env.core.example` 默认 `FRONT_CLAW_NOTIFY_DISPATCH=0`** | 通过 P0-C 被动回复与权限门禁后再按步切换为 `1` |

---

## 二、P0-C 多角色 M04 / M05 / M06 真机验收步骤与验收表

### 2.1 验收准备（三角色测试账号）

在测试门店（如 `store-01`）通过 `admin` CLI 与数据库配置准备 3 个企微绑定的测试成员：

1. **角色 A（店长，`manager`）**：`memberId = pilot-mgr-1`，具备店长全量店务能力（`report_self`、`report_proxy`、`progress_self`、`progress_store`、`amend_store`、`appointment_receive`、`marketing`）。
2. **角色 B（有营销权限员工，`employee`）**：`memberId = pilot-emp-mk`，`capabilities = ['report_self', 'report_proxy', 'progress_self', 'appointment_submit', 'marketing']`。
3. **角色 C（无营销权限员工，`employee`）**：`memberId = pilot-emp-std`，`capabilities = ['report_self', 'progress_self', 'appointment_submit']`（无 `marketing`，无查全店）。

> 启动前确认：`core.env` 中 `FRONT_CLAW_NOTIFY_DISPATCH=0` 先完成 M04/M05 被动验收，再切 `FRONT_CLAW_NOTIFY_DISPATCH=1` 重建 `core` 完成 M06 验收。

### 2.2 真机逐项验收清单

| 编号 | 模块 | 测试角色 | 真机企微输入/操作 | 预期真机现象与日志/DB 核验 | 实测结论（PASS/FAIL） |
|---|---|---|---|---|---|
| **M04-01** | 白名单门禁 | 未绑定企微成员 | 发送任意文本（如「今日报数 300」） | 秒级被动回复未绑定拒绝提示；OpenDot `messages` 表零新增记录；`dot.wecom.precheck` 记 `failed` | `[ ]` |
| **M04-02** | 省略人称自查 | 角色 B | 发送「帮我查看今天做了多少业绩」 | **快通道直出本人进度**，不误拦截也不漏给营销 Agent | `[ ]` |
| **M04-03** | 越权与跨店拦截 | 角色 C | 发送「帮我查今天全店汇总」/「帮我查他店业绩」 | 明确返回「不能做」及权限原因，零账本写入 | `[ ]` |
| **M04-04** | 无营销权限阻断 | 角色 C | 发送「帮我写一条朋友圈补水文案」 | 返回「营销内容功能当前未开放，或你没有这项权限」，绝不放行进 OpenDot Agent | `[ ]` |
| **M04-05** | D175 穿插防误入账 | 角色 B | ① 发标准报单「12号门店\n560（本人）」出草稿<br>② 发「帮我写秋冬护肤朋友圈文案」<br>③ 仅回复单字「对」<br>④ 回复「确认入账」或「全部确认」 | ② 放行营销 Agent 并保留草稿<br>③ 单字「对」**不入账**，提醒原草稿摘要与「确认入账/全部确认/取消」<br>④ 明确指令后精准入账 1 笔，无重记 | `[ ]` |
| **M04-06** | 在途慢任务撤权拦截 | 角色 B | 发送耗时营销文案请求后，在 Agent 回复返回前由管理员从 PG M03 移除角色 B 的 `marketing` 权限 | Agent 完成后尝试外发被 `authorizeOutbound` 拦截：企微收不到任何消息；Outbox 记 `failed (wecom_blocked:capability_denied)`；`dot.wecom.outbound_auth` 记 `allowed=false` | `[ ]` |
| **M04-07** | 多员工工作区隔离 | 角色 A + 角色 B | 同时各自发送一条营销文案咨询 | 各自落在独立 `web:wecom-front-claw:<hash>` 工作区，回复严格回到各自企微私聊，零串线 | `[ ]` |
| **M05-01** | 预约提交与店长接收 | 角色 B | 发送「预约明天下午3点张小姐来做护理」→ 确认「对」 | 入库 PG `appointments`，同步生成给角色 A（店长）的待推送通知 | `[ ]` |
| **M05-02** | 预约状态查询与取消 | 角色 B / A | 发送「我的预约」查看状态；按流程核验预约状态流转 | 与 PG 账本事实一致，不出现未写入却口头确认 | `[ ]` |
| **M06-01** | 开关关闭态隔离 | 角色 B / A | `FRONT_CLAW_NOTIFY_DISPATCH=0` 下完成 M05 预约确认 | 不触发企微 `SEND_MSG` 主动外发；通知行保持 `pending` | `[ ]` |
| **M06-02** | 开关开启态送达 | 角色 A | 改 `FRONT_CLAW_NOTIFY_DISPATCH=1` 并重建 `core`，再次触发预约确认 | 角色 A 企微收到主动预约提醒，通知状态流转为 `sent` | `[ ]` |
| **M06-03** | `unknown` 诚实查询 | 角色 B / A | 模拟推送窗口断网/ACK 超时后再查「我的预约」 | 通知锁定 `unknown`、绝不自动补发骚扰；查询明确告知「发送结果未知，未确认送达」 | `[ ]` |
| **OPS-01** | 停机租约释放 | 运维侧 | 执行 `docker compose -f deploy/docker-compose.yml stop core` 后运行 `admin verify-consumer` | 30s 优雅停机内释放 PG `ConsumerLease`，`verify-consumer` 输出 `"consumerAbsent":true` | `[ ]` |

---

## 三、P1 单营销 Skill（`beauty-local-content`）灰度与回滚手册

### 3.1 开启前准入检查

1. P0-C 验收表 `M04-01` ~ `M06-03` 与 `OPS-01` 全部 `PASS`；
2. 确认宿主仓库仅内置唯一受控 Skill：`assets/front-claw-skills/beauty-local-content/SKILL.md`；
3. 确认 Langfuse / OTel 观测已配置并能看到 `dot.wecom.*` 四段脱敏 Span（确认非 ASCII 均已被归一化或脱敏，无客户明文）。

### 3.2 灰度开启步骤

1. 在宿主机仓库外配置文件 `/srv/opendot/core.env` 中追加（先仅在试点单实例开启）：
   ```dotenv
   FRONT_CLAW_WECOM_MARKETING_SKILL_ID=beauty-local-content
   ```
2. 重建并启动 `core`：
   ```bash
   docker compose -f deploy/docker-compose.yml up -d --force-recreate core
   ```
3. 启动日志核验（必须同时看到 `marketingSkillId: "beauty-local-content"` 且无 `Failed to sync/verify bundled WeCom marketing skill` 告警）：
   ```bash
   docker compose -f deploy/docker-compose.yml logs --tail=100 core | grep -E "WeCom Front Claw native runtime started|marketingSkill"
   ```
4. 功能与护栏抽检（角色 B 发「帮我写换季补水体验套餐朋友圈文案，价格未定」）：
   - 核对产出文案使用 `[待确认价格]` / `[待门店确认项]` 占位符，无虚构“99元秒杀”、无“一次根治”等医疗绝对化承诺、无伪造“已入账/已预约”；
   - 核对角色 B 提问「帮我把昨天张姐改成 500」时仍被前置拦截或明确告知无账务权限，未触发 Shell/写文件工具；
   - 核对 Langfuse `dot.wecom.agent_turn` Span 中 `skill_ids` 为 `["beauty-local-content"]`。

### 3.3 Fail-Closed 负向演练与一键回滚

- **Fail-Closed 验证**：若将 `FRONT_CLAW_WECOM_MARKETING_SKILL_ID` 误配为不存在或未受控 ID（如 `training-knowledge`），`startWeComFrontClawRuntime` 捕获校验异常并记 `error` 日志，自动把 `Safe Marketing Profile` 保持在 `skills.mode = 'disabled'`，**不会阻塞店务入口，也不会继承宿主机 Skill**。
- **一键回滚**：删除或注释 `/srv/opendot/core.env` 中的 `FRONT_CLAW_WECOM_MARKETING_SKILL_ID`（或置为空串 `FRONT_CLAW_WECOM_MARKETING_SKILL_ID=`），执行 `docker compose -f deploy/docker-compose.yml up -d --force-recreate core`；启动时自动将现有 `Front Claw Safe Marketing` Profile 切回 `skills.mode = 'disabled'` 并自动递增 Profile 版本失效旧会话。

---

## 四、服务器内存基线采集命令与 P1 → P2 切换门禁

### 4.1 真机服务器内存与资源基线采集命令

> 严禁在未完成真机采样前调整 `deploy/docker-compose.yml` 中的 `mem_limit: 768m` / `512m`。

1. **瞬时快照采集（空闲态 / 单并发态 / 压测并发态各采 1 次）**：
   ```bash
   date -Is && free -m
   docker stats --no-stream --format "table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.MemPerc}}\t{{.PIDs}}"
   ```
2. **30 分钟连续采样落盘（10s 粒度 CSV，留档至 `/var/log/opendot-mem-baseline/`）**：
   ```bash
   mkdir -p /var/log/opendot-mem-baseline
   OUT="/var/log/opendot-mem-baseline/baseline-$(date +%Y%m%d-%H%M%S).csv"
   echo "ts,host_avail_mb,name,cpu_pct,mem_usage,mem_pct,pids" > "$OUT"
   for i in $(seq 1 180); do
     TS="$(date -Is)"
     AVAIL="$(free -m | awk '/^Mem:/ {print $7}')"
     docker stats --no-stream --format "{{.Name}},{{.CPUPerc}},{{.MemUsage}},{{.MemPerc}},{{.PIDs}}" \
       | awk -v ts="$TS" -v av="$AVAIL" '{print ts","av","$0}' >> "$OUT"
     sleep 10
   done
   ```
3. **OOM 与重启审计（每次真机压测或 24h 观察后必查）**：
   ```bash
   docker inspect --format '{{.Name}} OOMKilled={{.State.OOMKilled}} RestartCount={{.RestartCount}} ExitCode={{.State.ExitCode}}' \
     $(docker compose -f deploy/docker-compose.yml ps -q core pg)
   docker compose -f deploy/docker-compose.yml exec -T pg \
     psql -U postgres -d front_dot -c "SELECT usename, state, count(*) FROM pg_stat_activity WHERE datname='front_dot' GROUP BY 1,2;"
   ```

### 4.2 P1 → P2（多岗扩展 / 指标调优）切换硬门禁

必须**全部满足**以下 5 项条件后，才允许进入 P2（多岗路由或资源参数调整）：

1. **稳定性窗口**：单容器 `core`（`768m`）+ `pg`（`512m`）在真实企微流量下连续运行 **≥ 7 天**，`OOMKilled=false`、`RestartCount=0`；
2. **内存安全水位**：连续采样期间 `core` 内存峰值持续 **≤ 576MiB（75% of 768m）**、`pg` 内存峰值持续 **≤ 384MiB（75% of 512m）**、宿主机 `available` 内存 **≥ 512MiB**；
3. **可靠性零事故**：OpenDot SQLite `channel_outbox` 与 Front Claw PG `performance_notifications` 无未处置 `uncertain` 堆积，零跨员工串话、零越权或撤权后漏发事故；
4. **观测可审计**：Langfuse 连续 7 天具备完整四段 `dot.wecom.*` Span 关联数据，且人工抽检脱敏属性 **0 条明文业务信息/密钥泄露**；
5. **模型与成本基线清晰**：若开启了 `FC_MODEL_MODE=live`，统计 7 天 `modelMs` P95 ≤ 2500ms、超时追问回退率与单条平均 Token 消耗处于门店可接受预算内。
