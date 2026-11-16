## 目标
在 Issue #1、#2、#3 完成后，完成 OpenDot 启动入口总装接线、移除旧旁路补丁 `opendot-hook.patch`，并打通 Node 22 + PostgreSQL 17 统一 CI 门禁与单容器部署配置，通过 6 大停止开发硬门槛。

---

## 一、GitHub 仓库内容与路径（线上分支与目录）
- **统一主仓库**：`https://github.com/wanghanyu654321-cell/opendot-front`
- **工作分支**：在合并 Issue #1、#2、#3 后切出 `feat/issue-4-unified-release`
- **仓库内全局契约文档**：`docs/OPENDOT-FRONT-MASTER-PLAN.md`
- **涉及核心路径**：
  - `src/index.ts`（OpenDot 主入口与 `shutdown()` Phase 1）
  - `src/wecom.ts` & `src/wecom-front-claw-bridge.ts`（Issue #2/#3 产物）
  - `packages/front-claw/`（Issue #1 净化后的店务内核）
  - `.github/workflows/ci.yml`

## 二、本地工作区与参考资料路径（Windows 本机路径）
- **当前融合主仓本地路径**：`d:\Desktop\agent付费资料\opendot-front`
- **店务部署配置本地路径**：`d:\Desktop\agent付费资料\opendot-front\packages\front-claw\deploy\`

---

## 三、具体改动文件计划
1. **删除旧旁路补丁**：移除 `packages/front-claw/integrations/opendot-front-claw/opendot-hook.patch`。
2. **`src/index.ts`（总装接线）**：
   - 当 `FRONT_CLAW_WECOM_ENABLED=1` 时，启动 `createWeComFrontClawBridge`（连接 PG 17 并持有 `ConsumerLease`），并通过 `imManager.connectUserWeCom` 注册原生企微通道；
   - 在 `shutdown()` Phase 1（`imManager.pauseInbound()` 之后、`imManager.disconnectAll()` 之前）优雅关闭桥接器、等待在途店务收尾并释放 PG 租约。
3. **`.github/workflows/ci.yml`（统一 Node 22 + PG 17 门禁）**：
   - 跑通店务内核 `typecheck`、`build`、`test:ci`、全量 `test:pg`（含 `adapter-pg-m07`、`r2-pg`、`append-evidence` 及 5 次并发重复确认测试）；
   - 跑通根仓库 `tests/wecom-im-channel.test.ts`、`tests/wecom-front-claw-bridge.test.ts` 与端到端合流测试 `tests/wecom-opendot-e2e.test.ts`。

---

## 四、六个停止开发的硬门槛核验（必须全部给出实测结果）
1. 最新主分支标准 CI 与全量 PG 17 测试 0 失败、0 unhandled error，记录精确 Commit SHA；
2. 企微普通消息（无 `from.corpid`）通过唯一可信绑定校验；
3. 单消费者 PG 租约抢占、失租立停与 `epoch` 围栏生效；
4. 同消息重放、双消息并发（A 慢 B 快）、回「对」并发，零重复入账、零串 `req_id`；
5. 非店务请求放行进入 OpenDot Agent 时保留有效挂起草稿（`D175`），且 Agent 无写库/Shell 越权能力；
6. 被动回复与主动推送的 `unknown` 状态不触发重复发送，且结果可查回。

---

## 五、向主对话回传格式
1. 最终发布候选分支名、Commit SHA、Tree SHA；
2. 全量单测与 PG 17 集成测试的完整统计表；
3. 单容器真机联调启动说明与环境变量核对表。
