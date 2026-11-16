# 本地端到端验收

这是隔离合成环境：独立进程运行本仓库薄适配，真实 OpenDot 宿主镜像不在本仓库，上线时按 `integrations/opendot-front-claw/opendot-hook.patch` 接入。离线入口只接受 `isolated-synthetic` 和离线通道；不读取企微凭据，不调用模型、不发送通知。测试成功只证明合成链路，不能代表真实员工闭环或手机实收。

## 先决条件

Node 满足 package.json 的版本要求，安装锁定依赖并构建：

```sh
npm ci
npm run build
node scripts/deploy/validate-compose.mjs
```

驱动不会下载 PG 或读取 env 文件。不要以 root 运行本地 PG。把用户态 PG17 的二进制目录放入 `PG_BIN`，也兼容 `FRONT_CLAW_PG_BIN`；服务端目录必须包含 postgres、initdb、pg_ctl。备份工具按 PG_DUMP / PG_RESTORE 显式变量、PG_BIN、PATH 的顺序查找，可用系统 PATH 中的 PG17 客户端；显式变量不可执行或全部找不到时明确报告工具名并失败。运行环境需要允许回环 TCP 和创建子进程。

## 无 Docker 路径

```sh
PG_BIN='<PG17_BIN>' node scripts/e2e/run.mjs --backend local --out .e2e-records/local
```

驱动用系统临时目录创建一次性数据目录，PG 只监听回环地址，随机端口，禁用 Unix socket，trust 认证；绝不连接已有 PG。所有账号口令临时随机生成，只在进程环境中传递。trust 下权限验证仍使用不同数据库身份，验证的是授权隔离。PG 日志、数据、备份和临时查询结果均在退出时清理，不入库。

可用 `--out '<RECORD_DIR>'` 指定脱敏记录目录。审查记录统一用 `.e2e-records/local`；同名文件会覆盖，运行前应保存需要保留的旧记录。不指定时默认写入 被 .gitignore 忽略的 `.e2e-records/<日期时间>/`。样例记录不放仓库，禁止把输出写到文档目录。集成测试显式指定系统临时目录，并在测试成功或失败后清理，不写仓库记录目录。首次失败即非零退出并清理；失败记录保留，不能把未执行的步骤算作通过。强制杀进程时需要审查方自行停止残余临时 PG 并清理临时目录。

## Compose 路径

```sh
node scripts/e2e/run.mjs --backend compose --out .e2e-records/compose
```

需要 Docker Engine 和 Compose 插件。使用独立离线文件 `deploy/compose.e2e.json`、同一个 `steps.mjs`、同一个 standalone 入口。仅“创建环境、启动、重启、停止”的后端不同。驱动临时生成账号变量并使用随机 Compose 项目名，构建本地镜像、起 PG，迁移后起核心；数据库、核心均无宿主端口。驱动容器在私有内部网络中访问 PG 和核心。退出只删除该次一次性项目的容器和卷，不删除镜像。离线文件不引用服务器 env_file，不与生产配置合并。

Compose 构建默认要求 main 和干净工作区，创建记录目录前先核对 Git 状态。审查尚未提交的本任务实现时，显式加 `--allow-dirty`；非 main 还需显式加 `--allow-non-main`。例外构建仅用于一次性验证，镜像虽标记当前 HEAD，却不能当作 main 已发布证明。正式部署使用 `scripts/deploy/deploy.sh` 的同样准入检查。

在有 Docker 的机器上验证当前非 main、未提交工作区的完整命令：

```sh
node scripts/e2e/run.mjs --backend compose --allow-dirty --allow-non-main --out .e2e-records/compose
```

JSON 是 YAML 的子集，此格式无须增加 YAML 依赖。静态校验：

```sh
node scripts/deploy/validate-compose.mjs
```

本环境没有 Docker，仅对两份 Compose 做静态校验：同一 PG 大版本、核心及其他服务均无宿主端口、生产无合成开关。预期输出 `{"check":"compose-static","failures":[]}`，这不代表 Compose 已实跑。有 Docker 时，驱动还会在仅进程环境提供的临时变量下运行 `docker compose -f deploy/compose.e2e.json config --quiet`。服务器使用仓库外运维 env 文件执行同样的 config 检查，不把展开后的 config 写入记录。

Compose 合成步骤全部成功时退出 0，标准输出两行 `e2e_passed` 与 `未复跑（需授权语料）`，指定目录产生带合成声明的 `steps.json` 和 `summary.json`；摘要应为 status=passed、steps=15、failures=0。门①②仍未复跑，不计作评测通过；任一步失败则退出非零，记录失败和实际已执行步骤。

## 逐项验收

| 步骤 | 实际执行 | 关键验收结果 |
| --- | --- | --- |
| prepare | local 临时 PG17 或 Compose PG17 | pgMajor=17，isolated=true |
| initialize | 管理账号执行现有版本化迁移；建应用和只读账号；写合成人员、原策略、绑定 | schemaVersion=11，migrations=[7,8,9,10,11]，people=1 |
| permissions | 只读 SELECT；三种写操作；应用账号三种 DDL | readonlyWriteDenied=3，applicationDdlDenied=3；拒绝须为 PG 42501 |
| start-core | 启动 standalone 新进程并等待 active 健康状态 | 退出码 0 |
| model-flow | 固定假模型经同一适配器与分发入口，合法草稿、坏 JSON、空回复、超时、限流、报错；实际尝试插入第二条挂起草稿 | validModelDrafts=1，fallbackAsks=5，ledgerEntries=0，sharedPendingSlot=true，uniquePendingIndex=true；冲突须为 PG 23505 |
| flow | 合成报单 → 一条待确认草稿 → 回复“对” → 入账 → 查询本人本月业绩；重放报单和确认 | entriesBeforeConfirm=0，pendingBeforeConfirm=1，confirmedEntries=1，replayEntries=1，duplicateReplies=0；查询含合成金额 |
| restart-core / replay | SIGTERM 优雅停机，另起进程，再重放相同 msgid | freshProcess=true，restartedReplayEntries=1，duplicateReplies=0，persistedOperation=true，progressEqual=true |
| quiesce / backup | 停写后逐表快照，pg_dump -Fc | 每张业务表的 rows 和 sha256；custom 格式 |
| restore | CREATE DATABASE 新库；pg_restore；逐表重新计算 | allCountsAndChecksumsEqual=true，全部表的行数和内容哈希一致 |
| start-restored-core / restored-progress | 应用账号改连恢复库，新进程查相同进度 | restoredProgressEqual=true |
| gates | 默认跳过，不读取语料 | 未复跑（需授权语料） |
| cleanup | 停核心、停临时 PG 并清理；或 down 一次性 Compose 项目和卷 | 退出码 0 |

请求实际经过 standalone 离线通道 → 现有适配器 → 原 handler / 原授权和确认逻辑 → 应用账号 PG 账本 → 回复记录器。重启和恢复后同样通过这个入口查询；没有把不同 suite 拼成端到端。回复记录器接受只代表离线接收，不是平台 ACK。核心使用现有确定性 msgid 操作身份和草稿来源唯一约束；Compose 限制一个核心，原 PG 单消费者租约继续生效。

## 迁移编号对应

issue 的“001–010”对应当前源码的历史基线与后续迁移：007 是包含早期结构的基线，008 是通知状态列，009 是金额与状态，010 是草稿来源幂等，011 是挂起序号和每员工一条待确认的部分唯一索引。执行到当前最新 011，不虚构缺失的早期独立文件，也没有 012。使用原迁移器事务和校验和，不改迁移文件或评测代码。

管理账号拥有结构；应用账号仅业务表 SELECT/INSERT/UPDATE/DELETE 和序列 USAGE/SELECT，无建库、建角色、建表或结构所有权，迁移历史和导入历史只读。只读账号只有 CONNECT、schema USAGE 和表 SELECT。核心使用单独的无 DDL 存储装配，不通过放宽应用账号权限解决启动问题。

## 门禁复跑

本轮不复跑门①②；需要授权语料，本轮不读取任何语料。驱动固定打印并记录“未复跑（需授权语料）”，不把历史准入数字作为本次结果。

由有权限的人在同一隔离环境按原评测约定执行：

```sh
scripts/eval-gates.sh --corpus '<授权语料>' --out '<仓库外摘要文件>' --model stub
```

命令参数依现有脚本用法，显式选择离线桩；须由有权限的人在同一隔离环境执行。原脚本和评测代码保持不变，不打开语料或评测摘要文件。授权执行人只另存门①②计数及与既有准入计数的比对结论，输入、原始输出、个案 ID 和语料留在仓库外。驱动记录保持“未复跑”，没有语料参数，也不会主动触发门禁。

## 集成测试与记录

```sh
npx vitest run tests/e2e tests/deploy
AUDIT_PG_ALLOW=isolated-synthetic FRONT_CLAW_PG_BIN='<PG17_BIN>' npx vitest run --config vitest.integration.config.ts tests/e2e/local.integration.test.ts
```

集成测试沿用 `AUDIT_PG_ALLOW` 准入，未授权则 skip。兼容检查 `AUDIT_PG_URL`（若提供，须指向回环合成库），但不使用它连接常驻数据库；测试总是自行创建一次性集群。测试前构建。不得用共享 PG 验证。

`steps.json` 按步骤记录脱敏命令、退出码、耗时和关键计数；`summary.json` 记录整体通过/失败与门禁跳过；两份文件均含 notice="合成数据，不代表线上"。驱动写盘前校验命令模板和字段白名单，并拒绝绝对路径、当前用户名、主机名、连接串及地址；失败只报稳定错误码，不回显违规内容。驱动不保存子进程原始 stdout/stderr、平台消息正文或外部参数。备份本体和查询正文不在记录内。实际运行记录由审查方在沙箱外的一次性本地 PG17 环境生成，见 [记录说明](records/README.md)。

本轮未运行 PG，环境没有 Docker；这里的单测、编译和静态检查不能替代上述 PG、Compose 实跑。完整 OpenDot 宿主不在本仓库，也不计作已经运行。

## 模型与入口约束

默认模型为无网络桩。standalone 额外识别固定的“合成模型”测试消息，不读任何模型或企微凭据，生产入口用独立 wecom 装配与原模型配置；离线分支不能切成真实模型服务。假模型只返回分类与原始金额槽；金额必须与原文中已校验金额一致，候选标准行仍经唯一可确认草稿闸和原挂起位。模型没有存储对象或提交工具，写账仍需随后回复“对”并通过条件迁移与实时授权。坏 JSON、未知 schema 字段、空输出、超时、限流及错误均回追问，保留当前有效挂起项；追问使用相同挂起位的读取和过期收尾，不为无效内容另建可确认草稿。

消息到达时立即申请 PG 挂起序号；同员工队列在模型调用前串行，其他员工独立运行。运行时每条入站记录一行 JSON，字段为 event、operationId（散列）、route（快通道 / 模型 / 追问）、gateReason（原因类别）、pendingSequence、modelMs、errorCategory。客户名、消息文本、金额原文和原始 msgid 不进入该日志。业务提交、回复投递及平台回执仍分别记录。单元测试还覆盖模型卡住时其他员工照常返回、同员工按到达顺序执行、装配后替换模型回调无效。

操作记录已在现有 PG performance_config 持久化，不新增迁移。已处理的同 msgid 不再次调用模型、处理业务或回复；途中退出保留 running，查询报告为 interrupted，不自动补做结果未知的请求。唯一可续办的情况是原消息为“对”、对应本人报单已经持久化到 confirming、actionMessageId 与原消息完全一致；新持有者只沿用既有条件提交与 fencing 完成该已认领确认，不重新提取、不创建新草稿。已 confirmed 的草稿和未知发送结果不进入续办路径。没有占用新的迁移号。
