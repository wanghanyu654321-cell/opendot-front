# ② 开发过程问题汇总（DEV.md）

> 2026-11-10，北京时间（UTC+8）。证据路径都相对于 `<证据目录>/`，另有注明的除外。
> 每条按这个顺序写：**现象 / 根因 / 怎么解决的 / 证据 / 迁移时要不要继续盯**。
> 找不到证据的，写「证据未找到」。
> 严重级是**按迁移时仍有的风险**评定的，已解决又不会复发的降级处理。
> 21:53 更新：纳入窗口 A 收尾证据 `step4A-live-20261110/`（下文 L-START / L-OBS / L-RES / L-PG 的含义同 PRODUCT.md）。新增 DV-32 至 DV-34；DV-18 改为已解决。

## 运行环境与部署

### DV-01 Node 缺失，exit 127（P1）
- **现象：** 现场入口脚本找不到 node，返回 127。
- **根因：** 服务器的 PATH 里没有可用的 Node。
- **解决（已解决）：** 在 copyRoot 外放置官方 Node 22.23.2，用绝对路径调用。第一次 curl 下载超时（rc28），续传后完成。verify 61992 个文件通过。
- **证据：**
  - onsite-v3-apply-20261108-2213/NOTES.md L6
  - node-locate-20261109-1426/NOTES*.md
  - node-verify-20261109/NOTES.md
  - operation-request-20261108-v4.md §0
- **窗口 A 新发现（L-START launcher-node，已证实）：** 现场同时存在两套 Node：
  - launcher 用的是 `<SERVER_APP_DIR>/node/bin/node`，**v24.22.2**，属主 1001:1001；
  - 封存和校验用的是认证过的 v22.23.2。
  - 两套各自 verify 62116 个文件，都是 rc=0。
  - 详见 DV-34。
- **迁移盯：** 要盯。运行时版本要锁定，并写进镜像或部署清单。

### DV-02 seal marker 的排序依赖 Node/ICU 构建（P2）
- **现象：** marker 的计算依赖排序结果。
- **根因：** localeCompare 的排序会随 ICU 构建不同而变化。
- **解决：** 部分解决。固定用同一份 Node 来封存和校验。
- **证据：** front-claw-seal-node-20261109/REPORT.md
- **迁移盯：** 要盯。改用字节序排序。

### DV-03 挂载集合是 6 个，校验要求 5 个（P1）
- **现象：** run 14d9a83c（11-08 15:29:51）未 READY，报 LOCAL_DOCKER_BOUNDARY_UNVERIFIED。
- **根因（已证实）：** `full-host-local-docker.mjs:50` 要求挂载目标精确等于 5 个，现场多了 `/srv/front-claw-private/front-claw-db.env`。
- **解决：** 最小修复门禁，只接受这一个固定的只读 env bind，其他限制不放松。之后六挂载 observe 达到 FULL_OBSERVE_ACCEPT。
- **证据：**
  - live-run-failed-20261108-152951.json
  - front-claw-boundary-handoff-20261108.md §2
  - cli-incident-review-20261108/final-answer.md
  - daemon-matrix-20261108-1935/REPORT.md（五挂载探针 exit1）
  - pilot-six-observe-20261108-2202/REPORT.md
- **迁移盯：** 要盯。新环境挂载有变化时，门禁要同步更新。

### DV-04 volume Options 必须为空（P3）
- **现象：** 同一条门禁还要求 `volume.Options` 为空或 null，否则失败。
- **根因：** 门禁规则本身的要求。
- **解决：** 现场卷的 Options 为 null，0020232f 的分析已把它排除在失败原因之外。
- **证据：**
  - front-claw-boundary-handoff-20261108.md §2（第 50 行规则）
  - live-20261109-174244-analysis/REPORT.md :56
- **迁移盯：** 要盯。新建卷时不要带 driver options。

### DV-05 runner/外层容器不在 DB 网络（P1）
- **现象：**
  - run 0020232f（11-09 17:42）约 90 秒后报 LOCAL_DOCKER_BOUNDARY_UNVERIFIED，随后报 CLEANUP_UNKNOWN。
  - r7 又出现接网竞态「No such container」、slot 泄漏、没有最终回复。
- **根因（已证实）：**
  - entry:54-55 把外层容器接进 DB 网络后，A:46 validatePilotNetwork 的单网检查失败。
  - r7 的 runner 接网没有等待重试。
- **解决（已解决）：**
  - F-B 补丁改为 host-db-endpoint。
  - r8 加了有界等待接网，并输出 DB_NETWORK_ATTACHED 标记。
- **证据：**
  - live-20261109-174244-analysis/REPORT.md
  - step3-fix-20261109/REPORT.md
  - step3-live-r8-bundle-20261110/task/CHANGES-r8.md
- **迁移盯：** 要盯。网络拓扑要重新设计，参见 PR-24。

### DV-06 缺 pg 依赖，表现为企微「Client not connected」（P1）
- **现象：** r5/r6 窗口内报 Client not connected。
- **根因（已证实）：** 运行包里缺 pg 包，PG pool 起不来。Client not connected 只是连带结果。
- **解决（已解决）：** r6 把 pg 打进运行包。
- **证据：**
  - step3-live-r6-bundle-20261110/task/CHANGES-r6.md
  - step3r5-live-20261109/step3r5-c9-1.log L40
- **迁移盯：** 要盯。依赖清单要锁定，并加启动自检。

### DV-07 到期时重复关闭 PG pool，cleanup 误报（P2）
- **现象：** 窗口到期清理时报错。
- **根因：** pool 被 end 两次。
- **解决（已解决）：** r7 修复。
- **证据：**
  - step3-r6-result-20261110/REPORT.md
  - REPORT-r7-addendum.md
  - CHANGES-r7.md
- **迁移盯：** 一般，加回归测试即可。

### DV-08 现场版本混杂（P1）
- **现象：**
  - stage 与基线有 4 个文件行数不一致（preparation-stop）。
  - r5 前发现 pilot.mjs 被手改（80d590dc），并留有 .bak-multirole。
- **根因：** 现场有人手改，且没有登记。
- **解决：** 当时没有盲目覆盖，逐个确认后再打补丁。
- **证据：**
  - preparation-stop-20261108-1430.txt
  - step3-r5-blocked-20261109/BLOCKED.md
- **迁移盯：** 要盯。现场禁止手改，一律走封存 + hash 校验。

### DV-09 出网未验证（P2）
- **现象：** 模型和企微的出网路径没有完整的审计记录。在本机上 docker 安装时 HTTPS 失败。
- **解决：** 部分解决。reopen 窗口证实 DeepSeek 可用，窗口 A 的「你好」也得到了真模型回复。出网范围仍未审计。
- **证据：**
  - onsite-readonly-20261108-2016/readout-manual-transcription.txt:33-35
  - step3-live-r9-reopen-20261110 RUNBOOK:155
  - docker-box-20261108-1925/REPORT-continued.md
- **迁移盯：** 要盯。出网改为白名单。

### DV-10 遗留网络 b419d41c（P3）
- **现象：** 11-02 创建，没有容器。
- **解决：** 未处理，去留待用户决定，不删。
- **证据：**
  - <本地路径> 旁支 F6
  - reopen RUNBOOK:30,153
- **迁移盯：** 迁移时一并决定去留。

### DV-11 远程终端会话不稳（P3）
- **现象：** OrcaTerm 会话被登出或断线，操作被迫中断。
- **证据：**
  - node-locate-20261109-1426/NOTES*.md
  - observe-precheck 相关 NOTES
  - 具体的断线次数：证据未找到
- **迁移盯：** 一般。长操作放进 tmux 或后台任务。

## 安全与审批

### DV-12 env 文件属组和权限（P1）
- **现象：** env 的 gid 是 1001，被 validator 拒绝。gid 至少变动过两次。
- **根因：** validator 要求 1000:1000、权限 0600。
- **解决（已解决）：** 经用户批准，sudo 把属组改为 1000，现为 1000:1000 600。
- **证据：**
  - 复审记录
  - observe-entry-20261108-2005/env-trust-boundary.md
  - PLANS.md 第 3 步
- **迁移盯：** 要盯。属组和权限写进部署脚本，并加校验。

### DV-13 uid 风险（P2）
- **现象：** 门禁假设外层容器以 1000:1000 运行，「ubuntu 就是 uid 1000」这一点没有核实。mem0 等服务也以 ubuntu 身份运行，可能写入 stage。
- **解决：** 未解决，只记录了风险。
- **窗口 A 证实（L-START / L-RES identity）：** `whoami=ubuntu uid=1000`，「ubuntu 就是 uid 1000」由此证实。
- **仍有混用：** docker-cli 属主是 1000:1001、权限 700；launcher 的 node 属主是 1001:1001。属组 1001 仍在现场使用。
- **证据：**
  - step4A-live-20261110/step4A-02-start.log（outer-mounts、launcher-node）
  - front-claw-pilot-flow-20261108/REPORT.md:40
  - 复审记录
- **迁移盯：** 要盯。改用专用 uid。

### DV-14 env 注入，P1（LD_PRELOAD 类键）（P1）
- **现象：** spawn 时继承了宿主 env，存在 LD_PRELOAD 类键被注入的风险。
- **解决（已解决）：** r4 把子进程 env 冻结为空对象。代价是 docker CLI 在空环境下运行。
- **说明：** 「LD_PRELOAD 降级」中「降级」二字的原文：证据未找到。实际对应的是 r4 的「冻结空 env」。
- **证据：** step3-fix-20261109-r4/task/ANALYSIS.md §1-2
- **迁移盯：** 要盯。env 用白名单显式传入。

### DV-15 现场脚本带有未经批准的删除副作用（P1）
- **现象：**
  - apply 的异常分支会自动删除新增文件（第 320-322、351-353 行）。
  - preflight 会 unlink 私密配置，并 rm 容器和网络。
- **解决：** 执行前审查时拦下，回到原云端修正后才执行。
- **证据：**
  - apply-safety-block-20261108-1508.txt
  - live-preflight-safety-stop-20261108-1522.txt
- **迁移盯：** 要盯。脚本默认不删除，删除步骤单独审批。

### DV-16 每一步都要人工批准，节奏慢（P2）
- **现象：** 批准只认用户本人 1:1 原话。几乎每个现场动作都要单独批准（v1-v4 操作申请、各轮开窗），等待时间占了主要工期。
- **证据：**
  - <本地路径>
  - codex-collab-practices-20261109.md（来回规划太多）
  - operation-request-20261108-v4.md
  - 具体的等待时长统计：证据未找到
- **迁移盯：** 要盯。迁移计划里事先把可批量批准的低风险动作列成清单。

## 存储与资源

### DV-17 磁盘 2 GiB 门槛与卷管理（P1）
- **现象：**
  - 11-08 根盘只剩 5.0G（87%）。
  - 01 和 04 start 开窗前都要求 DISK_MIN_KB=2097152，05 不检查。
  - 20:50 删除了卷。
- **证据：**
  - preparation-stop-20261108-1430.txt
  - step3-live-r9-reopen-20261110/task/CHANGES-r9-reopen.md:19
  - step4-acceptance-20261110/RUNBOOK.md §D
  - ISSUES P-12
- **窗口 A（L-START / L-RES，已证实）：**
  - 开窗前可用 5,627,912 KB；单个窗口的保留卷约 1,454,024 KB；预计窗后剩 4,173,888 KB。
  - 新卷 b58d72d3 的删除是 **PENDING_APPROVAL，没有执行**。
  - 26e0d23c（r6）、6d2c609d（r9 首窗）仍然保留，各自需要单独审批。
  - 按这个速度，再开约 2 个窗口、又不删卷，就会跌破 2 GiB 门槛。这是推断，按每窗 1.39 GiB 算。
  - 05 的卷清单有显示歧义：「gone volumes:」下面列出的是新卷的详情行。推断 gone 列表实际为空。
- **迁移盯：** 要盯。要有容量规划和卷保留策略。

### DV-18 窗口 A 收尾证据回传（P3，21:53 已解决）
- **现象：** 21:44 时收尾证据还没到。21:51 已到 `step4A-live-20261110/`，共 18 个文件，并附 zip。
  - zip 的 sha256 是 d4fc91522c65b715a33f532ff21e474b472d2c5d1d6b4bb52f2adca8597414a1，与助手A给的值一致；解包后与目录逐字节相同。
- **遗留问题：**
  - 回传仍是人工打包，从 WATCH_DONE（约 21:39:51）到落到本机（21:51），延迟约 11 分钟；
  - zip 和目录里都没有自带 SHA256SUMS。
- **证据：** ISSUE-REGISTER.md §5。
- **迁移盯：** 一般。回传时自带 SHA256SUMS，并实现自动化。

## 账本与数据

### DV-19 删卷后旧账本 SQLite 丢失（P2，推断）
- **现象：** 旧 ManagerStore 的 SQLite 很可能放在被删除的卷里。
- **根因：** 推断，没有删卷前后的 ls 证据。实际路径：证据未找到。
- **迁移盯：** 要盯。迁移前先确认旧数据是否还需要、是否还在。

## 模型

### DV-20 桥接模型 → 真模型（P1）
- **现象：** r7/r8 时 runner 用的是 stub，固定回「Front Claw 在。」。
- **解决（已解决）：** r9 接入真模型。reopen 时 MODEL_REPLY ok=1，窗口 A 的「你好」也是真模型回复（S7）。
- **证据：**
  - step3-live-r7-bundle-20261110/task/CHANGES-r7.md:54
  - step3-live-r9-bundle-20261110/task/CHANGES-r9.md
- **迁移盯：** 要盯。模型配置和费用需要监控。

### DV-21 模型失败即 STOP（P2）
- **现象：** 模型调用失败时，整个窗口 STOP。
- **证据：** step3-live-r9-reopen-20261110 RUNBOOK:155；ISSUES P-14。
- **迁移盯：** 要盯。改为降级回复加重试。

## 消息通道

### DV-22 r9 首窗零流量（P2）
- **现象：** r9 第一个窗口 inbound=0，reopen 时 admitted=0。没有 alive/connected 字段，分不清是没人发消息，还是消息没到。
- **证据：**
  - step3r9-zero-analysis-20261110/REPORT.md
  - step3r9reopen-live-20261110/step3r9reopen-02-start.log:232
- **窗口 A 对比（L-RES）：** 业务事件里已经有 connected=1、alive=27、inbound=13，可以区分「没人发」和「消息没到」。21:08 和 21:13 两次 observe 都是 admitted=0、alive 在增长，说明连接在线，只是还没人发消息。
- **迁移盯：** 要盯。保留心跳和入站计数，并做成告警。

## 测试与验收流程

### DV-23 同一个 D 不能重开窗口（P2）
- **现象：** 对同一个 D 再次 start，报 `STOP_AT=init`（S4.started 已存在）。01 按 r8 基线核对 col2，报 `STOP_AT=patched-files-col2`。
- **解决（已解决）：** reopen 包把新状态写进子目录 W，并 sha 校验 D0 根下的原证据未改。
- **证据：** step3-live-r9-reopen-20261110/task/CHANGES-r9-reopen.md:9-26
- **迁移盯：** 一般。窗口状态机支持重开。

### DV-24 错误被统一脱敏，定因困难（P2）
- **现象：** 错误信息被替换为 UNSAFE_MESSAGE_REDACTED，看不到原因。
- **证据：** step3-r5-fail-20261110/REPORT.md §1.1
- **迁移盯：** 要盯。分级脱敏，保留错误码。

### DV-25 r4 CLEANUP_UNKNOWN 时证据没采回（P2）
- **现象：** run.log、outer-audit 等没有收集。
- **证据：** step3-cleanup-unknown-20261109/REPORT.md §0
- **迁移盯：** 要盯。失败时自动打包证据。

### DV-26 CLI 复核轮数超过上限（P2）
- **现象：**
  - 复核轮数上限是 2，0020232f 修复时达到上限。
  - r3、r4 由用户另行授权追加。
  - r4 bundle 复核到第 4 轮。
- **证据：**
  - step3-fix-20261109/REPORT.md
  - step3-fix-20261109-r3/task/TASK.md:4
  - <本地路径>（8 次复核，单次 7.6 万-14 万输入 token）
- **迁移盯：** 要盯。补丁一次做小，复核规则事先写清楚。

### DV-27 执行器中断（P2）
- **现象：** 执行器中断的直接记录：**证据未找到**。
- **相关旁证：** CLI 复核 r3 出现 websocket 断线重连两次（`Reconnecting... 2/5`、`3/5`），最终仍产出 verdict。
- **证据：** <本地路径>
- **迁移盯：** 一般。长任务要能断点续跑。

### DV-28 测试原文偏差：占位符原样发出、测试者改写原文（P1）〔窗口 A〕
- **现象（截图已证实）：**
  - `<名字>` 被原样发出。
  - 门店排行、无空格的预约、无序号的确认预约、更正 1800、3800、改写的朋友圈请求。
  - 21 项中有 7 项因此无效（见 ISSUE-REGISTER §3）。
- **根因：** 清单里留有占位符，测试者凭理解改写原文。
- **解决：** 未解决。用户 21:43 决定不补测。
- **迁移盯：** 要盯。清单只给可以直接复制的原文，不留占位符。产品侧也要容错，参见 PR-01、PR-04。

### DV-29 推送和回复只能靠截图观测（P1）
- **现象：** 没有服务端的逐条回复和推送日志，结果只能看手机截图。截图上没有逐条时间，无法判断 15 秒门槛。
- **证据：**
  - step4A-screens-20261110/
  - ISSUES P-09、P-16
- **窗口 A 收尾日志（21:53）：** 只有事件名计数，没有逐条时间戳和内容，仍然要靠截图把 13 条消息逐条对应到去向，15 秒门槛无法判定。
- **迁移盯：** 要盯。服务端逐条落日志，记录入站时间、出站时间和内容 hash。

### DV-30 手工转录出错（P2）
- **现象：** 照截图抄录出错 8 次，f1 的 label 键名也抄错了（D2）。
- **证据：**
  - codex-collab-practices-20261109.md
  - 复审记录
- **迁移盯：** 要盯。证据一律走文件 + sha256，不手抄。

### DV-31 本机侧工具链问题（P3）
- **现象：** ChatGPT 桌面回调被 nft 规则 reset，未修复。
- **证据：** chatgpt-loopback-root-cause-20261108.md
- **迁移盯：** 不影响迁移本身。

## 21:53 新增（来自窗口 A 收尾证据）

### DV-32 最后一个 runner 容器空转到窗口结束（P2｜运行环境与部署）
- **现象（已证实，L-OBS）：**
  - runner 容器 `frontclaw-flow-mv9ly10r-aw86-1794316623144` 于 21:17:03 创建（按名字里的毫秒时间换算）。
  - 21:17:30 时已经是 final_delivery=6、runner_exit=5。此后该容器一直处于 Up 状态，21:33:38 时已运行 16 分钟。
  - 第 6 个 runner_exit 直到 L-RES（21:39）才出现。
- **根因：** 推断。runner 回完最终回复后，会等会话空闲超时或窗口拆除才退出。
- **影响：** 多人并发时，runner 槽位和内存会被空闲容器占住。参见 r7 的 slot 泄漏（DV-05）。
- **迁移盯：** 要盯。最终回复送出后，runner 应及时退出，或者有空闲上限。

### DV-33 observe 的 READY 判定反复跳变（P2｜测试与验收流程）
- **现象（已证实，L-OBS / watch-summary）：**
  - judged 依次是 ready、ready、waiting(21:17)、ready、waiting(21:23)、ready、waiting(21:33)。
  - 同一份日志里 token 计数「1 CONTROLLED_REAL_READY」始终都在。
- **根因：** 推断。`04-reopen-window.sh:456` 用 `grep -x` 精确匹配整行，而 `docker logs 2>&1` 把 stdout 和 stderr 交织在一起，READY 那一行有时被拼进了其他输出。token 计数用的不是整行匹配，所以不受影响。
- **影响：** 只是观测假阴性，没有触发 STOP；但会误导人工判断窗口是否在线。
- **迁移盯：** 要盯。用结构化状态文件或健康检查端点，不要 grep 日志。

### DV-34 现场有两套 Node 版本（P2｜运行环境与部署）
- **现象（已证实，L-START / 01-precheck）：**
  - launcher 用 `<SERVER_APP_DIR>/node/bin/node` v24.22.2（1001:1001，sha256 904a6d34…）。
  - 封存和校验用 `<SERVER_APP_DIR>/node-v22.23.2-verify-20261109/…` v22.23.2（3517c2df…）。
  - 两套都对 62116 个文件 verify rc=0。
- **根因：** DV-01 解决时只新增了认证 Node，没有替换 launcher 的 Node（推断）。
- **影响：** 同一份封存在两个 Node 主版本下运行。DV-02 提到的 ICU 排序风险，在这里有现实的触发条件。
- **迁移盯：** 要盯。统一成一个锁定版本。

