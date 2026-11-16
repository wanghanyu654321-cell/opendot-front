# Front Claw / OpenDot 代码变更与开发目的汇总（助手A侧，CODE-CHANGES.md）

> 编写：2026-11-10 北京时间（UTC+8）。全程只读：没有连接服务器，没有读 env 或凭据文件，没有 commit/push。
> 时间一律用北京时间。原始材料里标成 "Asia/Singapore" 或 `+0800` 的，与北京时间同为 UTC+8，不再换算。
> 路径简写：`E/` = `<证据目录>/`；`A/` = 私有附件目录（助手A会话保存的补丁和日志附件）。
> 口径：
> - 每一项都按 **改了什么 / 为什么改（症状或目标）/ 动了哪些文件 / 怎么验证的 / 现在的状态** 来写。
> - 找不到原始证据的，写「**未找到证据**」。只能靠时间顺序或测试名推断的，写「**推断**」。
> - 对话转录在本次任务里读不到（SearchTranscripts 返回 "no record"）。所以凡是只出现在父会话待办摘要里的数字（例如测试条数），都注明「来源：父会话摘要」。
> - 分工（`<本地路径>`）：A 段早期业务补丁由云端 agent 产出（日志路径是 `<本地路径>`、`<ARTIFACTS_DIR>`）。11-08 起，边界补丁和 step3 r 系列由 **助手B** 修复和打包，**助手A** 经用户 Windows 机 SSH 在现场执行。下文不逐项署名，除非材料里写明。

---

## 0. 总览（按时间顺序）

| # | 名称 | 时间 | 载体（sha256 前 16 位） | 主要目的 | 状态 |
|---|---|---|---|---|---|
| A1 | fix-three：报数走已打开的 store | 11-07 18:14 | A/01M6TR0YQNRJE94C1AQ6A2G9XJ.patch 29222 B `7a7651421e70aa0e` | 报数表不再被路由到「内容营销」 | 已被后续补丁吸收，随 f2a8105 推送（推断） |
| A2 | patch-review：确认幂等＋预算 | 11-07 19:20 | 01M6TVTJHVVRWMJNZVQBN6X019.patch 60165 B `f4a84d17b36abc53` | 只允许一次 claim；不越过预算写账；员工不能设目标 | 同上 |
| A3 | recovery-gaps：报数恢复 | 11-07 21:34 | 01M6V3FMXTJ6VFVRSZ7BG84NTN.patch 94628 B `53ace074150e0744` | 超时后能查到结果，崩溃或重启后能恢复，不重复入账 | 同上 |
| A4 | appointment-reliability：预约事务 | 11-07 21:45 | 01M6V436FJRPY70MB9BMB0SWYE.patch 120988 B `8bb4073f9a50bb8c` | 预约走事务、幂等、可恢复 | 同上 |
| A5 | appointment-safety：复核版导出 | 11-08 13:58 | 01M6WVSW5E794ZFSY9TWZNAC1G.patch 137780 B `08456a3dc344ecc7` | 修正旧导出漏掉的快照确认和通知状态 | 同上 |
| A6 | onsite-entry-align：现场入口对齐 | 11-08 14:11–14:18 | 143346 → 144518 → **146121 B `9907668a02cb651c`** | 现场入口把 db-attach 带进 test-support；env-file 由 Docker 客户端读取 | 已提交（f2a8105） |
| A7 | PR35 提交 | 11-08 | commit `f2a8105acf84ac0679b3a0f4b86c973d03e1781a` | 把 A1–A6 落进仓库 | **已推送**到 PR35，未合并，未部署 |
| B | 现场 stage 准备（同步＋封存） | 11-08 15:15 | E/approved-stage-preparation-20261108.zip `a51b4c925f375835` | 把 f2a8105 的 26 个源文件同步进现场 stage 并重封 | **仅现场** |
| C | 本地 Docker 门禁 v0 → v1 → v2（6 挂载） | 11-08 15:37 → 11-09 | v2 uncommitted.patch `01e154db17543dc3` | 解决 run 14d9a83c 的 LOCAL_DOCKER_BOUNDARY_UNVERIFIED | v2 **未提交**；11-09 经 v4 apply **打进现场** |
| D | observe-only 驱动 | 11-09 | E/front-claw-observe-only-20261109/observe-only.patch `5a8d05ee064ef4ed` | 只跑 observe 的入口 | 未提交，已搁置（F2 parked） |
| E | F-B host-db-endpoint r1/r2 → r3 → r4 | 11-09 18:37–19:19 | r4 `e313cd3a7cd07dd0` | 解决 run 0020232f：外层容器进 DB 网后单网校验失败 | 未提交；r4 随 r4 包**打进现场** |
| F | r4 现场脚本包（01–05）＋ r4fix | 11-09 20:35–22:40 | E/step3-live-r4-bundle-20261109 | 现场备份、应用、封存、开窗、残留核对的标准流程 | **仅现场**，窗口 e7be7b70 失败 |
| G5 | r5 store/host | 11-09 23:0x | `125d90240cde3091` | 构造期 assemble 抢在 store 打开前抛 _URL | 现场，窗口 ffdd5ee9 失败 |
| G6 | r6 vendored pg＋错误分类 | 11-10 00:xx | `e952ceadf511b8e8` | 运行包缺 `pg` | 现场，窗口 26e0d23c 已 READY，到期误报 |
| G7 | r7 到期幂等关闭 | 11-10 13:18 后 | `d12c04994bcfa6f7` | pool 被 end 两次，正常到期被判失败 | 现场，窗口 0fd35464 到期干净 |
| G8 | r8 runner 接网等待＋最终回复 | 11-10 14:xx | `c1fc7ede04562d1d` | runner 接网竞态、slot 泄漏、没有最终回复 | 现场，窗口 3704c8fb 通过 |
| G9 | r9 Front Claw 真模型 | 11-10 16:xx | `4eb90f2a7ed95462` | 进程内回复是桩「Front Claw 在。」 | 现场，窗口 6d2c609d 零流量 |
| H | r9-reopen 包（不改代码） | 11-10 18:3x | 04 `17f2ab9d…`／05 `0ee5b33f…` | 已封存的 r9 上再开新窗 | 现场，窗口 933a41ed CLEAN，真模型 ok=1 |
| I | step4 21 项验收包（不改代码） | 11-10 20:56 | 07 `f17ca00a955c8a93` | 21 项验收：分窗、PG 只读计数 | 窗口 A b58d72d3 CLEAN；窗口 B 未开 |
| J | r10 老板映射（草稿） | 11-10 17:40 后 | `0a2b87d283cb34dd` | 让测试员工A成为 owner 档 | **草稿，未上现场**，id 待填 |

现场 stage 的 marker 链（用来核对现场版本）：
- B：stage marker `dd8f43e8 → b8cfcfaf`
- C/v4：`1cb6f544…`
- r4：`19ac232e…`
- r5：`3544625f…`
- r6：`958f6166…`
- r7：`3a50f880…`
- r8：`1b8507cd…`
- r9：`d05d316c…`（r9-reopen 和 step4 都沿用 r9 的封存，没有重封）

---

## A. 早期业务补丁（11-07 至 11-08，基线 `95467af`，分支 `cursor/unified-assistant-report-02b7`）

> A1–A4 与父会话待办 id（fix-three / patch-review / recovery-gaps / appointment-reliability）的对应关系，是按交付时间和补丁里新增的测试名**推断**的。补丁文件本身没有写这些名字。A5、A6 有明确的说明文件或字节数可以对上。

### A1 fix-three（29222 B，`7a7651421e70aa0e…`，11-07 18:14）
- **改了什么：** 把报数表（sheet）及其「对/改/删」确认绑定到启动时已打开的业绩 store（`openPerformanceStore`），不再进入角色聊天。补丁注释写明：「Store echo and confirm must finish inside the inbound request. An ack is not the result.」
- **为什么：** 报数被当成「内容营销」角色的聊天处理，数据没有写进账本。这正是用户后来反馈的「3500 一直在内容营销」那一类问题。
- **文件（7 个）：** `integrations/native/frontagent-controlled-pilot.mjs`、`src/role-eval/front-claw-boot.ts`、`wecom-bot-assembly.ts`、`wecom-bot-handler.ts`、`wecom-bot-pilot.ts`、`tests/role-eval/store-entry.test.ts`、`wecom-bot-pilot.test.ts`。+222/−26 行（按行首统计）。
- **验证：** 新增测试「writes a merged sheet through the opened store and does not route it to 内容营销」「returns a sheet result from the startup store without selecting 内容营销」。父会话摘要记的是「相关 48 测试 / typecheck / build 通过」，测试日志**未找到证据**。
- **已知缺口（父会话摘要）：** 普通闲聊仍会走营销路由；真实 PG 和 15 秒业务耗时都没验。这个问题在窗口 A 里又被测出来，登记为 PR-01。
- **状态：** 单独没有提交过，后续补丁是在它的基础上累加的（推断：A2 起的补丁文件集合包含 A1 的全部文件）。

### A2 patch-review（60165 B，`f4a84d17b36abc53…`，11-07 19:20）
- **改了什么：**
  - Postgres 上只允许一个 claim 把待确认草稿推进到 confirming；
  - 请求预算用完后不再开始写账；
  - 员工拿不到店长的「设目标」命令；
  - 超过预算才完成的确认会照常返回结果，但不会再插入一次；
  - 缺 DB URL 时，live launcher 在开 socket 之前就拒绝启动；
  - 启动描述里不会出现 DB URL。
- **为什么：** 父会话待办 patch-review 记录的审查结论：仍有「超 25 秒丢回复」「confirming 崩溃卡住」的风险。本补丁是对第一轮审查的修复。
- **文件（17 个）：** 在 A1 基础上新增 `front-claw-db-attach.mjs`（及其测试）、`frontagent-controlled-live-entry.mjs`、`frontagent-controlled-live-worker.mjs`、`assistant-commands.ts`、`performance-postgres.ts`、`performance-store.ts`、`wecom-bot-unified-handler.ts`、`tests/role-eval/performance-postgres.integration.test.ts`、`wecom-bot-real-pilot.test.ts`。
- **验证：** 父会话摘要记的是「57 业务＋19 启动＋5 真实本地 PG / typecheck / build 通过」，日志**未找到证据**。
- **状态：** 同 A1，被后续补丁吸收。

### A3 recovery-gaps（94628 B，`53ace074150e0744…`，11-07 21:34）
- **改了什么：**
  - confirming 阶段的插入如果在提交前失败，回滚后在 PG 上重试一次；
  - 重启以后，或者两条回复重叠时，同一笔确认只完成一次；
  - claim 了但插入没执行的草稿，后来补完成，不会记两笔；
  - 上报人已经离店的，不替别的门店完成；
  - 超过装配预算才落定的确认，会报告结果，之后也能查到。
- **为什么：** 超时以后查不到结果，崩溃以后卡在中间状态（父会话待办 recovery-gaps：「超时可查、崩溃可恢复」）。
- **文件（21 个）：** 新增 `performance-open.ts`、`pg-pool.ts`、`wecom-bot-delivery.ts`、`tests/role-eval/sql-fixture.ts`。
- **验证：** 父会话摘要记的是「64 相关＋60 装配＋7 本地 PG / typecheck / build 通过；真实 15 秒和企微投递没验」，日志**未找到证据**。
- **状态：** 被后续补丁吸收。

### A4 appointment-reliability（120988 B，`8bb4073f9a50bb8c…`，11-07 21:45；22:03 和 11-08 13:58 又各存了一份同字节副本）
- **改了什么：**
  - 预约只提交一次，走 PG 事务，重启或两条确认重叠时也只提交一次；
  - 店长确认落在同一行上；
  - 上报人已离职或已调店时，不提交已 claim 的预约；
  - vitest 宿主路径和 controlled entry 分开处理。
- **为什么：** 预约要事务化、幂等、可恢复（父会话待办 appointment-reliability）。
- **文件：** 21 个，文件集合与 A3 相同。
- **验证：** 父会话摘要记的是「21 业务＋6 启动＋8 本地 PG / typecheck / build 通过」。遗留两个问题：用序号重试确认会确认到下一笔；通知失败会被吞掉。
- **状态：** 这份就是后来那个「旧导出」`<ARTIFACTS_DIR>/store-entry-uncommitted.patch`（A5 说明里核对过，字节数和 sha 都一致）。

### A5 appointment-safety 复核版（137780 B，`08456a3dc344ecc7…`，11-08 13:58）
- 依据：A/01M6WVSW5EGPZFFFGJT706G9ZV.txt（说明）和 A/01M6WVSW5E0C44HBAPE2CWR74P.log（测试日志 5549 B，`f193dee8…`）。
- **改了什么：** 导出里包含了 `appointment-view`（列表快照确认）、`settleOpenNotifications`、`noticeText`（通知状态 sent / not_sent / unknown）。这三样 A4 的导出里都没有。新增测试文件 `tests/role-eval/store-entry.test.ts` 用 `git add -N` 一起导出。共 21 个文件，+1432/−120。
- **为什么：** 工作区早就有快照确认和通知状态的改动，但之前报告的载体是旧导出（120988 B），里面没有这些内容，那次报告是错的。本次重新导出并更正。
- **验证：**
  - 在 95467af 的分离工作树上 `git apply --check` 通过，apply 后与工作区逐字节一致；
  - `npm run typecheck` 通过；
  - vitest（store-entry、unified-handler）2 个文件 23 例通过，用的是 MemorySql 夹具；
  - `front-claw-db-attach.test.mjs` 6 例通过；
  - `npm run test:pg` 8 例通过，用的是临时本地 PostgreSQL 16（trust 认证）；两名店长同时发「确认预约 1」时，只确认李欣；
  - `npm run build` 通过。
- **没解决的：** 现场启动路径仍是部署阻塞；「发送成功但写状态前崩溃」会被记成 unknown，不会自动重发，所以不是 exactly-once；21 项真实验收没跑。
- **状态：** 未提交，被 A6 吸收。

### A6 onsite-entry-align（143346 B `3f746821…` → 144518 B `6436efc3…` → **146121 B `9907668a02cb651c…`**，11-08 14:11–14:18）
- **改了什么：**
  - `integrations/native/verify-full-host.mjs`：controlledRealPilot 模式下，复制进 test-support 的文件清单加上 `front-claw-db-attach.mjs`；
  - `front-claw-db-attach.mjs`：144518 → 146121 这一步删掉了 `FRONT_CLAW_DB_ENV_HOST_FILE` / `frontClawDatabaseEnvHostFile`（daemon 侧路径），注释和描述改成：`--env-file` 由同一进程里的 Docker **CLI 客户端**打开，不是 daemon 的 bind 源。描述字段从 `runnerReceivesEnvFile` 改为 `dockerCliReadsEnvFile`，并加上 `envFileOpenedBy:'docker-cli-client'`。
- **为什么：** 静态核对发现，现场 verify-full-host 启动的是 test-support 里的旧入口，不是 native 新入口；DB env 跨 Docker 传递的语义也写错了（父会话待办 launch-readiness 和 onsite-entry-align：「Docker 客户端 env-file 语义纠正」）。
- **文件：** 22 个，等于 A5 的 21 个加上 `verify-full-host.mjs`。
- **验证：** 父会话摘要记的是「21 启动 / typecheck / build 通过；hash 9907668a… 核验通过」，日志**未找到证据**。
- **状态：** 进入 A7。

### A7 PR35 提交 `f2a8105`
- **事实：** `<本地路径>` 的 git log 头是 `f2a8105 fix: keep store confirms idempotent and read env-file in the client`。PLANS.md 第 2 步写的是「commit/push 完成：PR35 @ f2a8105a」。父会话摘要另记「普通推送 f2a8105acf84… 至 PR35，远端一致，工作区干净，未合并部署，CI 未见检查」。
- **f2a8105 等于 146121 B 补丁的内容：** 这是**推断**，依据是提交说明和时间顺序。两者没有逐文件比对过。
- **状态：** **已推送（PR35），未合并，未部署。** 之后 r 系列的所有改动都**没有**再提交。

---

## B. 现场 stage 准备（11-08 15:15）
- **改了什么：** 用经过审阅的同步工具 `stage-sync-plan-retain.mjs`（34523 B）把 f2a8105 的源码包（`source.tar`，26 个文件的 manifest）同步进现场 `<SERVER_APP_DIR>/frontagent-r3-20261029/input`。`stage-preparation-completed-20261108.json` 记录了 29 个动作：add 17、replace 7、keep 3、edit-verify 1、edit-preflight 1。之后重新 seal/verify，61992 个文件。
- **为什么：** 现场跑的 stage 不是 95467af，也不是 f2a8105。preparation-stop（14:30）发现 4 个文件的行数和基线不一致，所以要先把 stage 对齐到已推送的版本，才能真实启动。
- **过程中拦下来的问题（DV-15）：**
  - 同步脚本第 320–322 行的异常分支会自动删除新增文件（A/d5d7d1e0…txt）。退回云端修好后才执行；自测日志 A/01M6X05BAW1X9DWCVN4WZ9MDPX.log 记的是 `deleteOption: rejected`、`defaultRollbackRemoved: 0`。
  - preflight 会 unlink 私密配置副本，并 rm 容器和网络（A/b23dcb11…txt）。真实启动因此停下。
- **验证：** 26 个文件的 manifest 校验通过；mjs 语法和 launcher bash 语法都 OK；只读 env bind，权限 600；backup 在 `<SERVER_APP_DIR>/stage-preparation-20261108-1515/backup`；marker `dd8f43e8 → b8cfcfaf`；没有启动业务（`preflight_execution:false`）。
- **状态：** **仅现场**，不涉及仓库。

## C. 本地 Docker 边界门禁：6 挂载最小修复（v0 → v1 → v2 → 现场 v4 apply）
- **为什么：** run 14d9a83c（11-08 15:29:51）没有 READY，报 `LOCAL_DOCKER_BOUNDARY_UNVERIFIED`。根因：`full-host-local-docker.mjs:50` 要求挂载目标恰好是 5 个，现场多了一个只读的 `/srv/front-claw-private/front-claw-db.env`（DV-03）。
- **v0（11-08 15:37，A/01M6X1EJCJDW2XKNBSMEGV0PH1.patch，1123 B，`03d3fe0c…`）：** 只在 expectedTargets 里有条件地加入这个 env 路径。探针日志：当前 5 挂载通过；只读 env 在旧门禁下失败，在新门禁下通过；可写 env 和其他目标都被拒绝。
- **v1 / v2（`full-host-local-docker.mjs` 和 `.test.mjs`；v2 补丁 `patch-review-20261108-v2/input/uncommitted.patch`，`01e154db…`，250 行）：**
  - 新增 `observeFixedDbEnvFile`：固定路径，`fstat`，严格 0600（保留特殊位，04600/02600/01600 都拒绝），属主与真实进程身份一致；
  - 只接受「原 5 挂载」或「精确 6 挂载（多出的那个必须是只读 env bind）」，其他限制一律不放松。
  - v2 修好的 sha：A=`d7f8a8d0…`，B=`7a9c9e40…`。
- **验证：**
  - CLI 复核：v1 有 4 项 P2，v2 结论是「有条件」通过，没有 P0/P1（`patch-review-20261108*/final-answer.md`）；
  - 本机上的验证：Docker 隔离矩阵 32 例（3 正 29 负）；完整 observe 入口在 5 挂载和精确 6 挂载下各 exit 0；6 挂载＋受控 pilot bridge 得到 `FULL_OBSERVE_ACCEPT`。这三项见 `daemon-matrix-*`、`observe-entry-20261108-2005`、`pilot-six-observe-20261108-2202`。
  - 说明：`daemon-matrix-20261108-1944/assembly-diagnosis-and-fix.md` 只改了**测试装配**，不再用 docker exec 承载 reader，产品逻辑没动。
- **上现场：** 11-09 v4 apply。第一次 S1 因为 node hash 抄录有误停下（NOTES-apply.md），之后补完收口。新 marker 是 `1cb6f544…364d83`（复审记录）。0020232f 的 C4 核对里，现场 A 等于 `d7f8a8d0`。
- **状态：** v2 **未提交**（仓库 f2a8105 里仍是原版 blob `12b74a3b…`），**只在现场**。

## D. observe-only 驱动（11-09，`5a8d05ee…`）
- **改了什么：** 新增 3 个文件：`observe-only-driver.mjs`、`observe-only-launcher.mjs`、`observe-only.test.mjs`。容器 PID1 调用 `createRestorationSupervisorReceipt`，跑完 observe 后写证据就退出，不连库，也不进入 live-entry。
- **为什么：** 打算在真实启动前，先单独过一次现场 observe 门禁。
- **验证：** `test.log` 在本机上跑过；CLI 复核见 `front-claw-observe-only-20261109-review/`。
- **状态：** **未提交，没上现场。** 用户 11-09 17:41 决定跳过 observe 门禁，PLANS.md 把它记为旁支 F2 parked。

## E. F-B host-db-endpoint 补丁（step3，第 1 至第 4 轮）
- **为什么：** run 0020232f（11-09 17:42）启动约 90 秒后报 `LOCAL_DOCKER_BOUNDARY_UNVERIFIED`，随后 `CLEANUP_UNKNOWN`。根因是 entry:54–55 把外层容器接进 DB 网，`full-host-local-docker.mjs:46` 的 validatePilotNetwork 却只接受单网。外层 pilot 进程自己会开 PG（`performance-open.ts` 的 `new Pool`）。D1 采集显示 DB 网 Internal=true，pg 没有发布端口，所以 F-A 不可行，F-B 是必要的（DV-05）。
- **第 1 和第 2 轮**（`E/step3-fix-20261109/`，`6485c832…`，7 个文件，+307/−19）：
  - A 文件只在 receipt v3 加上调用方显式 `allowFixedDbNetwork` 时，才接受「固定 DB 网 ID＋pilot 网」双网，并要求 ID、Driver、Scope、Ingress、EndpointID、MAC 全部吻合；observe 阶段仍只允许单网；
  - boundary.ts 在双网时要求网卡恰好是 eth0、eth1、lo，且 MAC 集合与端点一致；
  - entry 新增 `withDatabaseNetwork`：只要异常能展开，就保证断网，而且原始错误优先保留。
  - 本机测试 70 例：69 通过，1 跳过；负对照 6 例失败。CLI 复核做到第 2 轮仍有 1 项 P1，按上限停下。
- **第 3 轮**（用户授权超出上限，`2f3a8306…`，+420/−20）：Docker CLI 改成固定绝对路径；模块加载时固定 `originalSpawnSync`、网络 ID、冻结的 argv 和 options；删掉 PATH 回退、existsSync 和继承的 env。81 例：80 通过，1 跳过；6 个单点变异全部被杀。复核结论是 blocked。之后补充探测**发现**：env 键做有状态类型转换时，仍能注入 `LD_PRELOAD` 一类变量（P1）。
- **第 4 轮**（`e313cd3a…`，+459/−20）：子进程 env 改成冻结的空原型空对象（DV-14）。88 例：87 通过，1 跳过；新增 7 项对抗测试。**CLI 复核 pass**，没有 P0/P1，有 7 项 P2（TOCTOU、外层能访问 DB 网全部 4 个成员、空 env 下真实 CLI 的行为没验等）。
- **状态：** **未提交**。r4 补丁放进 F 包，11-09 22:42 在现场 apply（`step3r4-02-apply.log`：`OK patch e313cd3a…`），marker 变为 `19ac232e`。

## F. r4 现场脚本包（01-backup / 02-apply / 03-seal / 04-window / 05-residue）
- **改了什么（脚本，不是业务代码）：** 这一包定下了后面每轮都沿用的现场流程：
  - 路径准入 `adm`，任何内容哈希之前先过完整路径名单门禁 `stage_gate`；
  - `noclobber`＋`newf/wr/wrt`，任何输出都不覆盖已有文件；
  - 不 `source` 任何文件，记录文件用整行白名单正则解析；
  - launcher 按原样启动；用 exe、cmdline、uid、启动时间四项确认 PID 身份；
  - 严格 30 分钟（T0+30min ≤ exp ≤ 目录创建时间+20ms+30min）；
  - 唯一判定函数 `judge`，READY 必须是完整一行；
  - 05 做残留核对（容器、网络、卷集合做差，审计 outer-audit）；
  - 允许测试的三条件：`RC=0`、`RESULT=S4_READY`、`WINDOW OPEN`。
- **为什么：** 现场脚本此前出过删除副作用、READY 子串误判、日志被覆盖等问题，需要一个可审计、只报不修的标准包。
- **验证：** 包的 CLI 复核做了 r1→r4（r3、r4 由用户授权超限）。r4 结论 fail（2 项 P1），由 r4fix 修复；用户 22:17 接受剩余风险，r4fix 没再复核。干跑 168 个以上 CASE 全部符合预期；shellcheck 和 `bash -n` 通过。
- **现场结果：** 窗口 e7be7b70（22:43）01/02/03 都 OK，04 `STOP_AT=wait-ready`，05 CLEAN。失败 token 是 `FRONT_CLAW_DATABASE_UNAVAILABLE_URL`，由 r5 定因。
- **状态：** **仅现场**和本机。r5–r9 各包都是在这个包上改出来的。

## G. r5–r9 最小修复（全部未经 CLI 复核，用户授权跳过；全部未提交）

| 轮 | 补丁 | 症状和根因 | 改动 | 验证（本机） | 现场结果 |
|---|---|---|---|---|---|
| **r5** | `step3-r5-store-host.patch` `125d9024…`（4 个文件） | e7be7b70 报 `FRONT_CLAW_DATABASE_UNAVAILABLE_URL`：构造期 `createPreparation` 同步调用 assemble，这时 storePort 还没有被 `ensureFrontClaw()` 赋值，第 181 行必然抛错。这是代码顺序问题，与 env、URL、网络都无关。另外发现现场 `frontagent-controlled-pilot.mjs` 是多角色手改版 80d590dc（DV-08），按用户要求保留 | `wecom-bot-pilot.ts`：受控真实模式下，assemble 改给一个转发的 storeAssistant；prepare 要等 store 打开后才连企微；不再回落到 memory store。`frontagent-controlled-live-worker.mjs`：注入 `FRONT_CLAW_DATABASE_HOST='legacy-shared-pg-20261008-r1'`。新增 `front-claw-pilot-store.test.mjs` | 94 例：93 通过，1 跳过；对照组复现了现场的失败 | 01 先因磁盘不足 `STOP_AT=disk`，批准删卷后重跑。窗口 ffdd5ee9（23:56）在 wait-ready 失败，由 r6 定因 |
| **r6** | `step3-r6-pg-vendor-diag.patch` `e952cead…`（122 个 diff） | ffdd5ee9 在 `pilot_prepare_start` 之后 5 ms 失败：stage 里**没有 `pg` 包**，`pg-pool.ts` 动态 import 失败；企微的「Client not connected」只是连带结果（DV-06） | 把 pg 8.13.1 及 11 个依赖（119 个纯 JS 文件，逐个核对 sha512 integrity）放进 `stage/app/node_modules`，不改业务代码。entry 新增 `classifyOriginalError`，在不打印原文的前提下输出错误类别和位置（针对 DV-24 脱敏后看不出原因）。新增 `front-claw-error-class.test.mjs` | 100 例：99 通过，1 跳过；新测试指向 r5 entry 时 6/6 失败；用现场同一个 Node 22.23.2 复现了缺 pg；嵌入式 PG 17.5 上 migration 能跑，且幂等 | 窗口 26e0d23c（00:53）**第一次 READY**，05 CLEAN；但到期时报 `CLEANUP_UNKNOWN` |
| **r7** | `step3-r7-expiry-close.patch` `d12c0499…`（4 个文件） | 到期时有 3 个计时器同时触发，受控 close 和内层 close 都没有 once 保护，`performance-open` 对同一个 pool `end()` 两次，pg-pool 3.14.0 拒绝，于是正常到期被记成 cleanup 失败（DV-07） | `wecom-bot-pilot.ts`：受控和内层 close 都改成幂等（`closing ??=`）。`performance-open.ts`：`ended ??= pool.end()`。entry 增加 `WINDOW_EXPIRED`、`STOPPED_CLEAN`、`EXIT_FORCED_AFTER_CLEAN`、`INNER_TOKEN_*` 这些 token。新增 `front-claw-expiry-close.test.mjs`。脚本包的 observe 和 05 增加 BIZ 计数和 `EXPIRY_VERDICT` | 104 例：103 通过，1 跳过；新测试在 r6 上 3 例失败；用 vendored pg-pool 实测确认重复 end 会报错 | 窗口 0fd35464：到期干净（05 CLEAN，expired_clean），但 runner 接 DB 网失败 ×3，4 条消息里只有「你好」拿到最终回复。r7 的 01–05 日志本机上**未找到证据**，结论引自 r8 RUNBOOK:7；marker 3a50f880 在 r8 的 03 日志里核对过 |
| **r8** | `step3-r8-runner-db-attach.patch` `c1fc7ede…`（5 个修改，1 个新增） | ① transport 在 `docker run` 之后几毫秒就 `network connect`，容器还没建出来，报「No such container」，并留下孤儿容器；② close handler 注册得太晚，slot 泄漏，之后所有 spawn 都被拒；③ 最终回复路径没有执行，用户什么也收不到 | transport：只在 NO_SUCH_CONTAINER 时每约 100 ms 重试，最多 15 s；失败时先 kill CLI，再 stop；close handler 提前注册。worker：新增 `onRunnerFailure`，给用户发一次兜底回复「处理失败，请稍后重试。」，并记录 `final_delivery`。pilot：新增 `notifyFailure` 和 `front_claw_handled`。脚本包：磁盘门槛 3 → 2 GiB，有 `frontclaw-*` 残留就停 | 120 例：119 通过，1 跳过；新增 16 例在 r7 上全部失败；TS 转译检查 | 窗口 3704c8fb（15:09）通过：admitted 4、runner_turns 3、final_delivery 3、fallback 0，05 CLEAN，expired_clean。但进程内回复仍是桩 |
| **r9** | `step3-r9-front-claw-model.patch` `4eb90f2a…`（4 个文件，0 个新增） | Front Claw 进程内路径（没命中正则时）的 `model` 写死成桩「Front Claw 在。」（DV-20） | `wecom-bot-pilot.ts`：新增 `createFrontClawModel`，复用现有 DeepSeek（`deepseek-flash`）凭据读取方式，不新增凭据；工具集合按 `toolsFor(tier)` 取：员工 3 个、店长 7 个、老板 8 个；超时为 min(12 s, 剩余预算−1 s)；失败分 10 类，统一兜底；日志不含正文和 key。`pilot.mjs` 和 `worker.mjs` 只是透传。测试用假 fetch | 130 例：129 通过，1 跳过；10 个新测试在 r8 上全部失败；真实 handler 集成测试 5/5；326 个干跑 CASE | 窗口 6d2c609d（17:43）CLEAN，但 inbound=0、model calls=0，属于零流量，原因定不了（DV-22，见 `step3r9-zero-analysis`） |

## H. r9-reopen 包（18:3x，不改代码）
- **为什么：** 在同一个 D 上重跑 04 会被 `S4.started` 已存在挡住；重跑 01 会按 r8 基线核对，报 `patched-files-col2`。脚本按设计拒绝重跑，不是现场坏了（DV-23）。
- **改了什么：** 只新增 `04-reopen-window.sh`（precheck/start/observe）和 `05-reopen-residue.sh`。新状态全部写进 `W=$D0/reopen-YYYYMMDD-HHMMSS`，开窗前后都跑 `sha256sum -c D0/SHA256SUMS-05.txt`，证明原证据没被改。不重打补丁，不重封，marker 仍是 d05d316c。r9 的所有安全门都保留。
- **验证：** 本机干跑（`dryrun/logs-20261110-184019`）。没有做 CLI 复核。
- **现场结果：** 窗口 933a41ed（18:50）CLEAN、expired_clean；`MODEL_REPLY calls=1 ok=1 failed=0`，admitted 4，final_delivery 2。这是**第一次确认真模型有回复**。
- **状态：** 仅现场和本机。

## I. step4 21 项验收包（20:56 修订版，不改代码）
- **改了什么：** 开窗、观察、残留核对都**原样复用** r9-reopen 包。新增的现场脚本只有 PG 只读计数 `07-pg-counts.sh`（`f17ca00a…`），另外还有 `ACCEPTANCE-21.md`、`WINDOW-A-CHECKLIST.md` 和分窗 RUNBOOK。删卷脚本 `06-volume-rm.sh` 已作废，移到 `step4-acceptance-20261110-superseded/`。
- **为什么：** 用户 20:55 的决定：认 21 项编号，第 2、4 项算不过，开两个窗口，批准 PG 只读计数。
- **验证：** dryrun `run-second-reopen.sh` 模拟「r9 → reopen1 → 05 → reopen2」，第二次开窗的拒绝条件都符合预期；另做了 secret-scan。
- **现场结果：** 窗口 A b58d72d3（21:04，用户 21:02 原话批准）CLEAN、expired_clean；admitted 13、runner_turns 6、final_delivery 6、fallback 0、`MODEL_REPLY calls=1 ok=1`；PG 计数 `COUNTS_OK` ×4。窗口 B **没开**（用户 21:43 决定不补测）。产品问题见 `issue-register-20261110/PRODUCT.md`（PR-01 到 PR-24）。
- **状态：** 仅现场和本机。

## J. r10 老板映射（草稿，未使用）
- **改了什么：** `wecom-bot-pilot.ts` 新增选项 `frontClawOwnerIds`，用 `withFrontClawOwners` 包住 `remember`：名单里的 accountId 或 memberId 提升为 `owner` 档（拿到 8 个工具，含 `stores_ranking`）。`pilot.mjs` 透传；worker 里 `FRONT_CLAW_OWNER_IDS=Object.freeze([])`，**测试员工A的 id 待现场提供**。新增 4 个测试。
- **为什么：** 用户 17:40 说「测试员工A也是老板，开跑」。但现在的角色枚举里没有 owner，tier 只按 manager/employee 两档算（`wecom-bot-handler.ts:127`），所以 owner 档永远不会出现。对应登记项 PR-06、PR-07。
- **验证：** 134 例：133 通过，1 跳过（在 r9 上，正好那 4 例失败）；集成测试 8/8；TS 诊断 0。
- **状态：** **草稿，没上现场，没提交。** step4 RUNBOOK 写明「不要用」。现场脚本在 id 和 marker 仍是 PENDING 时会主动 STOP。

---

## 3. 状态汇总

| 状态 | 内容 |
|---|---|
| **已推送（PR35 @ f2a8105，未合并，未部署）** | A1–A6 的累计结果（f2a8105 是否逐字等于 146121 B 补丁：推断，未逐文件比对） |
| **未提交，但已打进现场 stage** | C（门禁 v2，经 v4 apply）、E（F-B r4）、r5、r6（含 vendored pg）、r7、r8、r9。现场当前 marker 是 d05d316c |
| **只有现场或本机脚本，不涉及仓库** | B 的同步工具、F 的 r4 包及 r5–r9 各包脚本、H 的 r9-reopen、I 的 step4 |
| **未提交，也没上现场** | D（observe-only，已搁置）、J（r10 草稿） |

需要注意：现场 stage 与仓库已经**分叉**。仓库停在 f2a8105，现场多出 C、E、r5–r9 的全部改动，还有一个不是我们改的多角色手改版 `frontagent-controlled-pilot.mjs`（80d590dc）。迁移时要以现场 marker d05d316c 的文件清单为准，重新整理成提交，或者在 OpenDot 侧重新实现。

## 4. 证据缺口（未找到证据）
- A1–A4、A6 的测试日志原文：本机上没有，测试条数只在父会话摘要里。
- A1–A4 与待办 id 的对应关系：按时间和测试名推断，没有书面对应。
- f2a8105 与 146121 B 补丁的逐文件一致性：没比对过。
- r7 现场 01–05 日志：本机上只有 `step3r7-c11-20261110/c11-net-0fd35464.sh`。
- 窗口 A 的 run.log 原文和逐条回复时间：DV-18、DV-29 已登记。
- 删卷之前旧 SQLite 账本的实际路径：DV-19。
- 「LD_PRELOAD 降级」这个说法的原文出处：DV-14，实际对应的是 r4 的空 env。
