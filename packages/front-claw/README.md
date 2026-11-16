# front-dot

Front Claw（美业门店企微助手）迁入 OpenDot 的工程仓库：复用原 Front Claw 代码，以**薄适配**挂进 OpenDot 宿主，保留企微智能机器人长连接和 PostgreSQL 业绩账本，Mem0 保持关闭。

> 当前状态（2026-11-15，北京时间）：**离线开发阶段，未上线。** 最新冻结版本是 R23（树 `d71b9872`），2026-11-15 通过离线准入：门②（该问的不执行）全部留出集为 0，门①（D144 纯标准行）全部 100%，与 R18b 相比没有退步。离线准入不等于可以上线，门③、门④ 只在正式实测判定。没有部署，没有连接真实企微、真实模型或线上数据库。详见 [docs/plan/status.md](docs/plan/status.md)。

## 它做什么

员工、店长、老板在企微里私聊机器人完成日常业务，主要功能：

- **报单**：员工用一行「客户：金额（员工）」报今天的单，机器人回一份待确认草稿，员工回「对」才入账；
- **查进度**：本人当天、本月业绩和完成率；
- **店长管理**：改本店的单、看本店汇总、设目标，接收提醒；
- **预约**：登记即成立，并提醒指定店长；
- **通知**：持久化通知、草稿提醒、积压告警，故障后可恢复。

报单入账前必须经过确认。拿不准的说法一律先问，不猜测、不执行（门②）。业绩口径参考门店常用的第三方美业系统：只计开单业绩，按折后实收，精确到分，不封顶。完整规则见 [docs/product](docs/product/README.md)。

## 目录

| 路径 | 内容 |
|---|---|
| `src/role-eval/` | 业务核心：意图路由、标准行解析、单闸草稿、账本（内存/PG）、权限、预约、通知 |
| `src/opendot/` | OpenDot 薄适配：宿主契约、单消费者租约、企微通道、Mem0 关闭守卫 |
| `src/migration/` | 两库迁移 CLI（默认 dry-run，守卫禁止连接共享库） |
| `migrations/` | PG 表结构迁移（007–011，含 down），见 `migrations/README-m08.md` |
| `config/` | 产品配置：客户名策略、备注白名单、客套语、固定否定补报说法 |
| `integrations/opendot-front-claw/` | OpenDot 侧挂点补丁与说明 |
| `integrations/native/` | 原 Native 宿主、受控容器边界等底座（历史资产；node:test 用例已归档到 `archived-tests/`，不维护） |
| `tests/` | Vitest 单元测试与 PG 集成测试（按里程碑 / 修复轮分目录） |
| `scripts/eval-gates.sh` | 门禁评测脚本（喂入任意同格式 jsonl 语料） |
| `docs/architecture/` | 架构 |
| `docs/product/` | 产品规则、业绩口径、决策记录（D 号） |
| `docs/plan/` | 迁移计划、里程碑 M01–M08、修复轮 R1–R23、门禁状态、待批准事项 |
| `docs/engineering/` | 实现说明、测试与评测方法、开发流程 |
| `docs/legacy-qiwe-agent/` | 上游仓库原有文档（T0–T7、D1–D5 验收等，背景资料） |

## 如何运行

需要 Node.js ≥ 22.13。

```bash
npm ci
npm run typecheck
npm run build
npm run test:ci   # 单元测试，跳过需要真实模型环境的 live-model-smoke
npm test          # 全量单元测试（live-model-smoke 有 2 条已知失败）
```

PG 集成测试需要一个**一次性的本地合成库**，绝不能指向共享或线上库：

```bash
AUDIT_PG_ALLOW=isolated-synthetic AUDIT_PG_URL=postgres://<user>@127.0.0.1:<port>/postgres npm run test:pg
```

OpenDot 挂点测试 `tests/opendot/opendot-hook-m07.test.ts` 需要一份 OpenDot 源码副本，用 `OPENDOT_SRC=<路径>` 指定；不指定或路径不存在时会自动跳过。

本仓库代码默认关闭，不读任何真实凭据。在 OpenDot 中开启的方式见 `integrations/opendot-front-claw/README.md`（`FRONT_CLAW_OPENDOT_ADAPTER=1` 等环境变量）；凭据只能放在仓库外、权限 600 的文件里。

## 未完成事项（摘要）

- R23 之后按 D184 收口：只修会记错账或卡住员工的问题，文案类改动放到上线后（上线后清单见 [docs/plan/status.md](docs/plan/status.md)）。
- 公开决策记录目前只同步到 D173；R19–R23 用到的 D174–D185 摘要见 [docs/plan/status.md](docs/plan/status.md)。
- `integrations/native` 的 node:test 用例按 hanyu 的决定归档，不纳入 CI（#12）。
- 门③（查询直接办）和门④（延迟）要接入真实模型、在正式实测中判定，离线阶段只记录数字。
- 接入企微、迁移到腾讯云、正式实测、OpenDot 隔离迁移与切换都还没开始，需要 hanyu 逐项批准，见 [docs/plan/approvals.md](docs/plan/approvals.md)。

## 公开版说明

- 本仓库是从私有工作区整理出的公开版，按 [docs/engineering/publishing.md](docs/engineering/publishing.md) 做了脱敏：服务器、容器、数据库名、路径和测试账号人名都换成了占位符；评测留出集及依赖它们的测试没有放进来。
- 测试里的人名、店名都是虚构的合成数据。
- **不放 LICENSE，保留所有权利**（hanyu 2026-11-14 定）。
