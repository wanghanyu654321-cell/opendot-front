# Front Claw / OpenDot 全部开发总结（助手B，截至 2026-11-10 22:00 UTC+8）

> 依据用户 21:54 原话（助手A转述）：「再把代码的变更开发目的也总结一下 然后让助手B也总结他那边的关于这个产品的目前全部开发总结」；21:55 补充（助手A转述）：「让助手B还要包含自己之前的总结记忆 不止是现在接入后的」。
> **全程只读**：没连服务器、没读 env、没 sudo、没改任何已有文件、没 commit/push、没开窗口。时间都是北京时间（UTC+8）。git/GitHub 的 Z 时间已换算。
> 证据路径默认相对 `<证据目录>/`（简称 `E/`）。来源标注：
> - 【文件】：本机上文件，附路径（必要时带 sha256 前 8–16 位）；
> - 【GitHub】：只读 GitHub API（PR #35 元数据、commit 文件清单）；
> - 【会话记录】：助手A会话记录（只读检索，没有时间戳）；
> - 【仅记忆】：只在助手B记忆或任务清单里，没找到文件证据。
> 「已证实」是指文件或日志能直接对上；「推断」另外标出。找不到的写「证据未找到」。
> 助手B自己的历史会话**不可检索**。早期助手B的发言只能从助手A会话里转引。

---

## 0. 一页结论

- **代码主线：** 仓库 `<PRIVATE_ORG>/qiwe-agent`。PR #35（`cursor/unified-assistant-report-02b7` → `live/front-claw-20261102`）**已推送、未合并**，head 是 `f2a8105`【GitHub】。
  - 之后的 v2 边界补丁和 step3 r1–r9 补丁**都没有提交**。它们只存在两个地方：
    - 本机上的 `.patch` 文件；
    - 现场 stage `<SERVER_APP_DIR>/frontagent-r3-20261029/input`。按顺序叠加打入并重新封存，现在封存在 r9（marker `d05d316c…`）。
  - r10 是**已暂停草稿**，没上现场。
- **现场已实证的链路（r9 代码）：**
  - 企微长连接到 READY；
  - 入站被接纳并回 ack；
  - runner 接入 DB 网络；
  - runner 最终回复送达；
  - Front Claw 进程内调用真模型 deepseek-flash；
  - 到期干净收尾；
  - 在已封存的 D 上重开窗口；
  - PG 写入草稿和目标。
  - 证据：`E/step4A-live-20261110/step4A-04-residue.log`，例如 `FINAL_REPLY admitted=13 runner_turns=6 final_delivery=6`、`MODEL_REPLY … ok=1`、`RESULT=S5_RESIDUE_CLEAN`。
- **产品层大面积不合格：** 窗口 A 的 21 项里，实测过 2 项、实测不过 5 项、因操作偏差无效 7 项、未测 7 项（`E/issue-register-20261110/ISSUE-REGISTER.md` §3）。P0 有 4 条：PR-01、PR-03、PR-06、PR-09。
- **迁移方向：** 约 11-06 已比对 OpenDot 并提出搬迁方案【会话记录】；11-07 用 gpt-6-astra 审查，补了 6 个缺口【文件】。迁移计划**还没写，也没执行**。用户 16:04 定的是「其他跑通后再做全盘迁移计划，先审阅」（任务清单 `opendot-migration-plan` 仍是 PENDING）【仅记忆】。

---

## 1. 前史与早期工作（助手B接入 step3 补丁线之前）

### 1.1 仓库前史：已推送，非助手B所写【文件：4 个本机克隆】

- **10-17 → 11-02，共 43 个提交**（`git log f81fd91`，在 `<本地路径>`）。
  - 首个提交：`2590fa5` 10-17「feat: add isolated WeCom identity bridge and shared authorization」。
  - 10-17 到 10-18：隔离版企微的身份桥接、报数确认与查询、投递恢复与去重、更正、汇总、Excel、任务取消。
  - 10-20 到 10-25：Native 宿主、对话 intake/执行、受控合成试点、本地真实企微 pilot 装配、真实 Docker transport 验证、原 Frontagent 基线文档。
  - 10-29 到 10-31：复用既有 Frontagent 状态、受控真实 pilot 交接文档，以及 `docs/handoff-20261031/`。
  - 11-01：`3818945` 做 Front Claw 命名和绑定身份的自动选岗；`c86601d` 把身份限定在 d3Runner 内。这两个提交在分支 `feat/front-claw-auto-role-20261101`。
  - 11-02 22:43：`f81fd91`「chore: snapshot live Lighthouse changes」，分支 `live/front-claw-20261102`，是 PR #35 的 base。
- **其他分支（`<本地路径>`）：** `cursor/isolated-synthetic-live-preflight-8609`、`feat/wecom-controlled-pilot` 等。最后提交是 `0a3cd64`，10-31。
- **状态：** 都是 origin 上的已推送历史。各提交的作者和来源 agent 不在本总结范围；助手B没参与，**仅 git 证据**。

### 1.2 PR #35：统一 Front Claw 助手 + Postgres【GitHub：PR #35 元数据和 commits；`<本地路径>` git show】

PR 状态：**open，未合并**。共 6 个 commit、47 个文件，+5916/−495。PR 正文自述「Not merged. Not deployed. The 21-item real acceptance was not run.」

| commit | 时间（UTC+8） | 改了什么、为什么 | 主要文件 |
|---|---|---|---|
| `941e891` | 11-02 22:09 | 所有企微消息先过同一个 Front Claw 助手，包括报数解析、口令、工具和分级 | `src/role-eval/` 下新增 `wecom-bot-handler.ts`（654 行）、`assistant-tools.ts`、`assistant-commands.ts`、`report-parse.ts`、`performance-store/postgres.ts`、`metrics.ts`、`appointments.ts`；`migrations/001_performance.sql`；5 个测试文件 |
| `6febd2c` | 11-02 22:20 | 账本落进 PG 独立 schema `front_claw_perf` | `001` 改名为 `007_front_claw_perf.sql`，`performance-open.ts`，PG 集成测试 |
| `f99a8ca` | 11-02 22:50 | 统一 handler 改名为 `wecom-bot-unified-handler.ts`，与 live 报数 handler 并存 | 改名 3 个文件 |
| `867c179` | 11-02 22:58 | 合并 live 分支，给 pilot 接上 Front Claw PG | 文档、handoff 日志等 |
| `95467af` | 11-03 17:03 | 在 live 基线上从 role-eval 打开 PG，新增 `directory-store.ts`、`front-claw-boot.ts`、`pg-pool.ts`；live-entry/worker 接 DB | 21 个文件，+735/−34 |
| `f2a8105` | 11-08 14:21 | 店务口令先走已打开的账本；草稿认领后在一个事务里完成，入账幂等；`确认预约 N` 锁定在店长看到的那份列表上；通知状态与业务提交分开记录；Docker CLI 在 entry 进程里读 `--env-file` | 22 个文件，+1494/−127，含新增 `tests/role-eval/store-entry.test.ts`（517 行） |

- **PR 正文自报的测试**（不是助手B复跑）：
  - typecheck 和 build 通过；
  - Vitest store-entry 加统一 handler 共 23 个通过；
  - launcher 21 个通过；
  - `test:pg` 8 个通过，跑在临时本地 PG16 上。
- **现场：** 11-08 15:19，云端 agent 完成 stage 同步和封存，seal/verify 61992 个文件【文件：`E/stage-preparation-completed-20261108.json`，sha 111c2ab8…】。PLANS.md 第 2 步记「PR35 @ f2a8105a … stage 已同步并 seal」【文件：`<本地路径>`】。

### 1.3 OpenDot 迁移方案与架构对齐（约 11-06 至 11-07）【会话记录】

说明：这部分是助手A与用户的讨论。助手B当时还没创建或者没参与，这里只转引。

- **代码对照：** 旧底座 198 个文件中有 167 个与 OpenDot 完全相同。OpenDot 多出 146 个文件，主要是 personal-agent、bot-groups、Mem0。`src/role-eval` 约 6000 行、51 个文件不引用底座，可以原样复用，约 55 个测试可以当回归测试。
- **要改的衔接点有 3 个：**
  - 对话 schema 的版本锚点从 69 改到 107；
  - 补一个替代 `business-execution-admission/policy` 的薄适配层；
  - 合并 claim/cancel 与 goal-run 的任务领取逻辑。
- **工作量估计：** 7–8 天；如果同时把企微改写成 IMChannel，要 12–14 天。企微先保留 SDK 长连接，IMChannel 要等备案和可信域名。
- **画布：** 「OpenDot × Front Claw 迁移对照（2026-11-06）」，canvas `af62fd39-…`，本次没有打开核对。
- **两步计划：**
  - 第一步：修好 PR #35，接上 PG，用测试员工A测试号自测，约 2–3 天；
  - 第二步：搬到 OpenDot，约 7–8 天，先影子运行，再一键回滚。
  - Mem0 本期关闭；不做真实员工试点，改成测试员工A按老板、店长、员工逐级降权自测；磁盘 85%，清理要用户批准。
- **评审：** 方案曾发到「Front Claw 产品×架构对齐」群，请产品负责人和架构负责人评审。

### 1.4 助手B创建，CLI 安装与登录（约 11-07）【会话记录】

- 助手A创建助手B，任务是「通过 CLI 调用 Codex 任务」，只准备环境，不碰业务仓库。
- `npm install -g @openai/codex` 装的是 codex-cli 0.167.0，路径 `<LOCAL_HOME>/.local/bin/codex`。本次复核 `--version` 仍是 0.167.0【文件/实测】。
- 用户在助手B桌面完成官方设备授权；`codex login status` 退出 0，显示「Logged in using ChatGPT」。
- 准确时间：证据未找到。只能推断不晚于 11-07 17:51，即 `<本地路径>` 的 mtime。

### 1.5 GPT-6-Astra 计划审查：6 项缺口（11-07 17:51–17:52）【文件：`<本地路径>`（3083a85a…）、`review.txt`（da4add23…）】

- **输入：** 群聊迁移计划，即上面 1.3 的内容，加上 21 项验收门槛的原始描述。这是后来 ACCEPTANCE-21 编号的来源。
- **审查结论：** 有 6 项缺口，按严重性排序：
  1. 影子回放没有副作用隔离；
  2. 「一键回滚」没覆盖切换后的业务一致性；
  3. 双调度测试证明不了崩溃和重试时不重复执行；
  4. 两条 DB 迁移没有中断恢复和版本兼容契约；
  5. 验收证据不可复查，权限拒绝缺执行时检查；
  6. 缺可观测性和告警阈值。
- **总结论：** 「可启动隔离副本中的接库、适配和迁移演练；目前不具备正式迁移放行条件」。
- 用的模型是 gpt-6-astra，来自任务清单 `plan-model` 和 `plan-review`【仅记忆】。本机上 `E/model-verification-20261108/model-list.jsonl` 确实列出 `gpt-6-astra`【文件】，但 review.txt 本身没有记模型名。

### 1.6 模型与通道核验（11-08 15:47 前后）【文件：`E/model-verification-20261108/`】

- CLI 的 `model/list` 列出 gpt-5.6-sol、gpt-6-astra、gpt-6-sol、gpt-6.1-sol。用 `gpt-6.1-sol` 加 high 实测，退出 0（exec.log、exit.txt）。
- 云端仓库通道要用 5.6 Sol high 启动时因额度不足被平台拒绝，没有生成任务 ID【会话记录】。之后用户批准改用另一个云端通道准备补丁，CLI 6.1 Sol high 做复核【仅记忆：任务清单 `front-boundary-entry-research` CANCELLED】。

### 1.7 11-08 现场准备与三次安全拦截【文件】

| 时间 | 事件 | 证据 |
|---|---|---|
| 14:30 | 现场准备前置检查。根盘只剩 5.0G（87%）；checkout 仍在 95467af；stage 有 4 个文件行数与基线不一致，没有盲目覆盖 | `E/preparation-stop-20261108-1430.txt`（df7c4c06） |
| 15:08 | 同步脚本审查拦截：异常分支会自动 `rmSync` 新增文件，违反「不删」 | `E/apply-safety-block-20261108-1508.txt`（d5d7d1e0） |
| 15:19 | 修正后 stage 准备完成，seal/verify 61992 个文件 | `E/stage-preparation-completed-20261108.json` |
| 15:22 | preflight 审查拦截：会 unlink 私密配置副本，并 `docker rm -f`、`network rm` | `E/live-preflight-safety-stop-20261108-1522.txt`（b23dcb11） |
| 15:29:51 | run `14d9a83c` 没到 READY，报 `LOCAL_DOCKER_BOUNDARY_UNVERIFIED` | `E/live-run-failed-20261108-152951.json`（b3b74a2b） |

### 1.8 front-boundary：挂载门禁 v1 → v2（11-08）【文件】

- **定位（助手B）：**
  - 完整调用栈是 `full-host-local-docker.mjs:8:23 → validateLocalDockerFacts :50:155 → observeLocalDockerBoundary :110 → restoration-supervisor :152 → verify-full-host :279`；
  - 第 50 行要求挂载目标正好是 5 个，现场是 6 个，多了只读的 `/srv/front-claw-private/front-claw-db.env`；
  - `volume.Options` 在历史 audit 和当前 inspect 里都是 null，所以这个分支不成立。
  - 证据：`E/front-claw-boundary-handoff-20261108.md`（任务书，**91c97dc3…**，与记忆一致）、`E/boundary-*-20261108.json`、`E/cli-incident-review-20261108/final-answer.md`（6.1 Sol high 事件复核，exit 0）。
- **v1 补丁**（`patch-review-20261108/input/uncommitted.patch`，1bb7c1c4…）：CLI 复核结论是「有条件」，有 4 项 P2：严格 0600、测试环境断言、日志口径、apply 证据（`patch-review-20261108/final-answer.md`）。
- **v2 补丁**（`01e154db…`，源码 A `d7f8a8d0…`、测试 B `7a9c9e40…`）：
  - 改动：只多接受一个固定的只读 env bind；要求严格 0600、1000:1000、O_NOFOLLOW；其余门禁一项不放松。
  - 测试：`full-host-local-docker.test` **19 pass，chain-positive=1**；pilot 回归 **8 pass**（`patch-review-20261108-v2/input/REPORT.md:33`）。
  - CLI 复核 v2（gpt-6.1-sol high，exit 0）：原 4 项 P2 闭环，没有 P0/P1；新增一项 P2「apply 证据不足」，已用 `delivery-20261108/…-v2-evidence-supplement/`（13de8936）补齐。
- **本机隔离验证：**
  - 先装 Docker 26.1.5（`docker-box-20261108-1925/REPORT-success.md`）；
  - 第一轮 daemon 矩阵：五挂载探针出现 MODULE_NOT_FOUND，按门禁停下（`daemon-matrix-20261108-1935/REPORT.md`）；
  - 第二轮矩阵：真实 reader+validator **32 例全部符合预期**，3 个正例接受、29 个反例拒绝（`daemon-matrix-20261108-1944/REPORT.md`）；
  - 六挂载加 pilot 桥接的完整 observe 达到预期（`pilot-six-observe-20261108-2202/REPORT.md`，e942bdca）；
  - 离线单因素测试（`front-claw-host-factor-20261108/REPORT.md`）；
  - pilot 桥接的静态数据流（`front-claw-pilot-flow-20261108/REPORT.md`）。
- **云端 KVM 环境只读核验：** 没有 docker、dockerd 或 containerd，出口不受限，也无法证明「无凭据」（`E/dummy-container-plan-20261108.md:68,77`）。
- **冻结 v2 的静态网络绑定：** 在 `E/operation-request-20261108.md`（18a85c7d）和 `…-preserved-before-v2.md` 里有网络绑定段落。「申请前 / 获准创建后」两层边界的原文没有逐字核对，**部分仅记忆**。
- **状态：** v2 **未提交**。11-09 经 v4 阶段 1 应用到现场 stage，见 1.9。

### 1.9 seal / Node / v3 / v4 阶段 1（11-08 22:00 – 11-09 16:33）【文件】

- **seal 规程：** copyRoot 就是 `input`，marker 只写一个 `.qiwe-linux-stage.json`；verify 只读（`front-claw-seal-procedure-20261108/REPORT.md`，52e7765b）。
- **v3 现场预检：** 22:14–22:16，ubuntu 会话里找不到 node，返回 **exit 127**，没有 verify，也没有写入（`onsite-v3-apply-20261108-2213/NOTES.md`）。
- **运行时补救申请：** `runtime-remediation-plan-20261108.md`（**14696567…**，与记忆一致）。
- **Node 评估：** 推荐便携的官方 22.23.2，只用于只读 verify；排序依赖 ICU，属于风险（`front-claw-seal-node-20261109/REPORT.md`，**622cdad8…**）。
- **Node 校验：** 第一次下载 curl rc28 超时，续传后完成，sha `d60acfe0…` 对上；verify 结果 `{"files":61992}`，RC=0（`node-verify-20261109/NOTES.md`）。
- **v4 申请：** 相对 v3 只改了 Node 的绝对路径（`operation-request-20261108-v4.md`，8478b902）。
- **v4 阶段 1 现场应用：**
  - A/B 换成 v2 的 hash，重新封存，NEW_MARKER `1cb6f544…`，verify 61992 个文件；
  - 复核结论「有条件通过」（复审记录）；
  - 收口已复核。
- 以上记忆里的各个 hash 都已对上。

### 1.10 observe 门禁与旁支 F1/F2（11-09 16:30–17:49）【文件】

- **observe 草案：** `operation-request-20261109-observe-draft.md`（**ff40c4ce…**）和 `-v2.md`（**c9be40ab…**）。
- **P1–P7 复核：** 没有全部通过，observe 不能申请（复审记录）。主因是 env 的 gid=1001，而 validator 要求 1000。
- **F1 只读核实复核：** 复审记录，内容包括 Mem0 的 3 个 systemd 单元，以及 NOTES 的转录错误。
- **F2 observe-only 驱动草稿：** 草稿 patch 5a8d05ee；已复核。状态是 parked。
- **用户决定（11-09 17:41）：** 跳过 observe 门禁，直接进第 3 步（PLANS.md 第 2 步）。

### 1.11 协作流程（2026-11-09 18:09 起）【文件：`<本地路径>`】

- **规则来源：** `PLANS.md`（主线 7 步，5f3fa4bb）、`TASK-TEMPLATE.md`（四段式任务单）、`AGENTS.md`（硬规则）、`README.md`（分工）。
- **复核工具：** `run-review.sh`（a8d84c05）固定用 gpt-6.1-sol、high、不开 fast、只读，输出按 `verdict.schema.json`。
- **用量记账：** `usage-ledger.tsv` 记了 8 次复核，单次输入 7.6 万到 14 万 token。
- **来由：** `E/codex-collab-practices-20261109.md`（75dbbb2d）。痛点包括来回规划太多、照截图抄录出错 8 次、证据靠口述。
- **约定：** 复核最多 2 轮，超了就停下报用户。实际 F-B 补丁和 r4 bundle 都超了，用户另行授权。

---

## 2. 第 3 步补丁线总表（r1 → r9、重开窗、step4）

本节「现场」一律指 stage `<SERVER_APP_DIR>/frontagent-r3-20261029/input`，各轮按顺序叠加。「状态」列的取值：
- **作废**：被后一版取代；
- **已应用**：在现场封存过，代码仍保留在现场的累积树里；
- **未提交**：没进 git；
- **草稿**：没上现场。

| 版本 | 日期（UTC+8） | 补丁和 sha256 | 开发目的（解决什么卡点） | 改动的文件或模块 | 本地测试 | CLI 复核 | 现场窗口 RUNID 与结论 | 状态 |
|---|---|---|---|---|---|---|---|---|
| 定位 0020232f | 11-09 17:53 | 无补丁；`live-20261109-174244-analysis/REPORT.md` **dd941ddf** | 首次真实窗口约 90 秒后报 `LOCAL_DOCKER_BOUNDARY_UNVERIFIED`，接着 `CLEANUP_UNKNOWN`。强推断：A:46 `validatePilotNetwork` 的单网检查，被 entry 把外层容器接进 DB 网络后打破 | — | — | cli-review 子目录 | `0020232f`（17:42），未 READY | 结论被 r1–r4 采纳 |
| F-B r1/r2 | 11-09 18:2x–18:38 | `step3-fix-20261109/step3-fb-host-db-endpoint.patch` **6485c832** | 方案 B：外层容器不再接 DB 网，改成 host-db-endpoint | entry 及其测试、`full-host-local-docker.mjs/.d.mts/.test`、`full-host-restoration-boundary.ts/.test`，共 7 个文件 | 70 项：69 通过，1 跳过 | r1 fail（3×P1）；r2 fail（1×P1）。REPORT **50920c53** | — | 作废 |
| F-B r3 | 11-09 19:07 | `…-r3.patch` **2f3a8306** | 固定 docker CLI 和 endpoint，冻结 spawn options | entry 及其测试 | 81 项：80 通过 | r3 blocked（5×P2）；补测发现 env 注入，属 P1。REPORT **b66406a9** | — | 作废 |
| F-B r4 | 11-09 19:19 | `…-r4.patch` **e313cd3a**（7 个文件，+459/−20） | 子进程 env 冻结成空原型的空对象，堵住 LD_PRELOAD 类注入 | 同上 7 个文件 | 88 项：87 通过；加 7 项对抗测试 | **r4 pass（7×P2）**。REPORT **011aaf5e** | 见下一行 | 已应用（未提交） |
| live bundle r1–r4 加 r4fix | 11-09 19:45–22:40 | `step3-live-r4-bundle-20261109/`，SHA256SUMS 08c55813 | 01 备份 / 02 应用 / 03 封存 / 04 开窗 / 05 残留检查五段式现场包，做到严格 30 分钟、不删、失败只报 | 01–05 脚本 | dryrun | r1 fail（11×P1）、r2 fail（5×P1）、r3 fail（3×P1）、r4 fail（2×P1）。r4fix 没有复核，用户 22:17 原话「先跑起来再说 别漂移一直修」（`task/CHANGES-r4fix.md`） | **`e7be7b70`**（11-09 22:43）：S1–S3 OK，NEW_MARKER 19ac232e；没到 READY（STOP_AT=wait-ready），`CLEANUP_UNKNOWN`；05 CLEAN | 已应用 |
| r5 | 11-09 23:12 | `step3-r5-store-host.patch` **125d9024** | r4 失败的根因：受控真实模式下，构造期同步执行 assemble 时 storePort 还没赋值，必然抛 `FRONT_CLAW_DATABASE_UNAVAILABLE_URL`。这是代码顺序问题。另外 worker 注入 `FRONT_CLAW_DATABASE_HOST` | `wecom-bot-pilot.ts`、`frontagent-controlled-live-worker.mjs` 及其测试、新增 `front-claw-pilot-store.test.mjs` | 94 项：93 通过；对照组复现了现场 | 未复核（`CHANGES-r5.md` 标「未经复核」） | **`ffdd5ee9`**（23:55 D）：先 STOP_AT=disk，后来 S1–S3 OK，marker 3544625f；没到 READY；05 CLEAN | 已应用 |
| r6 | 11-10 00:22 | `step3-r6-pg-vendor-diag.patch` **e952cead**（122 个 diff） | r5 失败的根因：stage 里没有 `pg` 包，`Client not connected` 只是连带现象。另外加错误分类打印 | 把纯 JS 的 pg 8.13.1 等 12 个包放进 vendor（119 个文件）；entry 加 `classifyOriginalError`；新增测试 | 100 项：99 通过；在本机上用 PG17 跑通 migration 007 | 未复核 | **`26e0d23c`**（00:51 D，到期 01:23:18）：**首次 S4_READY**，marker 958f6166；到期时 outer-audit failed（关闭两次）；05 CLEAN | 已应用 |
| r7 | 11-10 13:29 | `step3-r7-expiry-close.patch` **d12c0499** | r6 的根因：到期时 pool 被 `end()` 两次，正常到期被误判为失败。另外让 BIZ 计数可见 | `wecom-bot-pilot.ts` 和 `performance-open.ts` 的 close 改成幂等；entry 加结束 token；新增 `front-claw-expiry-close.test.mjs` | 104 项：103 通过 | 用户 13:18 授权不做 CLI 复核 | **`0fd35464`**（13:59 D，到期 14:31:48）：READY，`BIZ request_admitted=4`，`expired_clean`，outer-audit passed；但 runner 接网竞态，**没有最终回复**（截图 wangyijun-1414.jpg） | 已应用 |
| r8 | 11-10 14:26 | `step3-r8-runner-db-attach.patch` **c1fc7ede** | r7 的根因：`network connect` 抢在容器创建前执行，报「No such container」，接着 slot 泄漏、没有最终回复 | `controlled-real-container-transport.mjs` 改成有界等待后接网，slot 一定释放；worker 加 onRunnerFailure 和 fallback「处理失败，请稍后重试。」；pilot 加 notifyFailure 和 `front_claw_handled` | 120 项：119 通过 | 未复核（证据未找到复核记录） | **`3704c8fb`**（15:09 D，到期 15:40:05）：**`FINAL_REPLY admitted=4 runner_turns=3 final_delivery=3`**，fallback 0，3×DB_NETWORK_ATTACHED，passed，CLEAN。Front Claw 回复仍是桩「Front Claw 在。」 | 已应用 |
| r9 | 11-10 16:17 | `step3-r9-front-claw-model.patch` **4eb90f2a**；bundle tgz **ac56c45c** | 把进程内桩模型换成真模型 deepseek-flash，复用现有凭据接线，key 每次现读、不记录。超时 ≤12 秒，失败回 fallback；按 tier 配工具，员工 3 个、店长 7 个、老板 8 个 | `wecom-bot-pilot.ts`（`createFrontClawModel`）、`frontagent-controlled-pilot.mjs`（+2）、worker（+3），加 10 个测试 | 130 项：129 通过 | 未复核 | **`6d2c609d`**（17:42 D，到期 18:14:07）：marker **d05d316c**，READY；**零流量**，inbound=0、model_call=0；`expired_clean`（`step3r9-zero-analysis-20261110/REPORT.md`，878b8ed4） | **现场当前版本**（未提交） |
| r9-reopen | 11-10 18:44 | 包 tgz **6a5c1af8**，SHA256SUMS 300bb936 | 同一个 D 不能重开窗：04 报 `STOP_AT=init`，01 报 `patched-files-col2`。新脚本在 `D0/reopen-*` 子目录 W 里开新 RUNID，并校验 D0 原证据没被改 | `04-reopen-window.sh`、`05-reopen-residue.sh`（不改代码） | dryrun 复现两个失败点 | 未复核 | **`933a41ed`**（18:50，到期 19:20:47）：admitted=4，runner 2/2 送达，**`MODEL_REPLY real:deepseek-flash calls=1 ok=1`**，CLEAN | 现场可复用 |
| step4 验收包 | 11-10 20:4x–21:01 | tgz **7798ae20**（取代 a9657ac6，旧版在 `-superseded/`） | 21 项逐项写清发什么、预期回复、判定方法；开窗复用 r9-reopen；新增 PG 只读计数 `07-pg-counts.sh` | ACCEPTANCE-21（7e3f6dc0）、RUNBOOK（9c45e096）、WINDOW-A-CHECKLIST（438134c8） | sim/dryrun | 无 | **窗口 A `b58d72d3`**（21:04–21:34:22）：admitted=13，runner_turns=6，final_delivery=6，fallback 0，model ok=1，6×ATTACHED，`expired_clean`，passed，CLEAN。PG：drafts +1，targets +1，entries、appointments、notifications 都是 0 | 已用；窗口 B 取消 |
| r10 | 11-10 17:44 | `step3-r10-front-claw-owner.patch` 0a2b87d2 | 测试员工A=owner 映射（`frontClawOwnerIds`）；还缺她的 accountId | 与 r9 同 4 个文件 | 134 项：133 通过 | 无 | 无 | **已暂停草稿**（用户 20:28：先进入 21 项验收） |

各行证据：
- 补丁：`E/step3-fix-*/`；
- 改动说明：`E/step3-live-r*-bundle-*/task/CHANGES-r*.md`；
- 复核：`<本地路径>`；
- 现场：`E/step3r*-live-*/`、`E/step3r9reopen-live-20261110/`、`E/step4A-live-20261110/`。step4A 的 18 个文件与 zip d4fc9152 逐一 cmp 一致。

**补充说明：**
- r1 和 r2 是同一个补丁目录：两轮复核的是 6485c832 及其修订，r2 后剩 1 个 P1。记忆里「F-B 两轮 fail」与此一致。
- 记忆里「脚本包 r2/r3 fail」，对应的是上表 live bundle 复核的 r2 和 r3。
- 第 2 步 v2 和第 3 步 r4–r9 都**不在任何 git 提交里**。原补丁 r1–r5 以仓库根为基准；r6 起改以 stage 根为基准，路径前缀是 `qiwe-agent/`，所以不能直接对 f2a8105 用 `git apply`。

---

## 3. 能力现状

### 3.1 现场实证（r9 代码；窗口 A、reopen、r8）

| 能力 | 证据 |
|---|---|
| 企微长连接到 READY，入站被接纳，回 ack | `step4A-04-residue.log`：request_admitted=13、reply_send_ok=19、rejected=0 |
| runner 接入 DB 网络 | 6×`CONTROLLED_REAL_TRANSPORT_DB_NETWORK_ATTACHED`（step4A）；r8 是 3 次 |
| runner 最终回复送达 | `FINAL_REPLY … final_delivery=6 … runner_turns_without_final=0`（step4A）；r8 为 3/3 |
| 进程内真模型 | `MODEL_REPLY source=real:deepseek-flash calls=1 ok=1`（reopen 和 step4A）。截图 S7：「你好」收到真模型问候（issue-register PRODUCT.md S7） |
| 严格 30 分钟窗口，到期干净收尾 | r7 之后每窗都有 `EXPIRY_VERDICT=expired_clean`、`S5_RESIDUE_CLEAN` |
| 已封存的 D 上重开窗 | `933a41ed`、`b58d72d3` 的 W 子目录 |
| PG 写入草稿和目标 | `step4A-pg-2after.log`：since drafts 1、targets(updated) 1（库是 legacy_appointment_db） |
| 清单按行拆分；「5w」识别成 50000；朋友圈文案不编价格；「我的进度」能显示 | 截图 S1–S5，见 issue-register 第 3、9、17 项 |

### 3.2 仅离线测试

- 模型失败分类和 fallback：r9 用假 fetch 测了 10 例。现场没有发生过失败（step4A failed=0）。
- runner 失败 fallback：r8 测试覆盖；现场 fallback_sent=0。
- 草稿认领幂等、`确认预约 N` 锁定列表、通知状态分开记录：PR #35 自报 23+21+8 项，助手B没复跑。
- 挂载门禁的 32 例矩阵和六挂载 observe：本机隔离 daemon。
- 老板映射：r10 草稿测试，134 项中 133 通过。

### 3.3 仅代码存在（没有现场实证）

- 老板的 8 个工具，其中 `stores_ranking` 老板独有；预约确认后推送；30 分钟提醒；闭店作废通知。依据 `productization-issues-20261110/OWNER-CAPABILITIES.md`（6c25267d）和 ISSUES.md（4cab967c）。现场没有账号能到 owner tier；第 16、19、20 项未测。

### 3.4 缺失

| 缺什么 | 登记编号 |
|---|---|
| 白名单外的意图识别，现在全部落到内容营销 | PR-01、PR-02 |
| 身份资料完整性：displayName 为空（推断，需要一次只读 PG 核对） | PR-03 |
| 「对不上」时的引导 | PR-04 |
| 「更正」被旧命令截获 | PR-05 |
| 老板角色和跨店可见范围 | PR-06、PR-07 |
| 目标没有确认步骤 | PR-08 |
| 账本统一成一套 | PR-09 |
| 降权机制 | PR-12 |
| 推送和逐条回复日志 | PR-13、PR-17、DV-29 |
| Mem0 下线（计划 d3669097，未执行） | PR-22 |
| 出网白名单 | PR-21、DV-09 |
| OpenDot 适配层、影子回放、回滚演练（PLANS 第 5–7 步） | 全部 todo |

---

## 4. 对接迁移计划

编号取自 `E/issue-register-20261110/` 当前文件：PRODUCT.md 5e78ad82、DEV.md 1014c0da。该登记正在另行更新，以下只引用现在存在的编号。

### 4.1 值得带进迁移（可复用）

| 改动 | 理由 | 关联编号 |
|---|---|---|
| PR #35 的 `src/role-eval/` 店务核心：报数解析、PG 账本 `007_front_claw_perf`、入账幂等、预约确认锁定列表、通知状态分开记录 | 已推送，有测试；OpenDot 对照显示它不依赖底座 | PR-09（要统一账本） |
| r5：受控真实模式下先开 store、再连企微的顺序 | 通用的启动顺序修复 | DV-05、DV-06 |
| r6：pg 依赖必须进运行包，加启动自检；错误分类 token `classifyOriginalError` | 定因价值大 | DV-06、DV-24 |
| r7：close 和 pool.end 幂等 | 通用缺陷修复 | DV-07 |
| r8：runner 有界等待接网、slot 必定释放、失败 fallback、`final_delivery` 计数 | 解决了最终回复链路 | DV-05、PR-15 |
| r9：`createFrontClawModel`（按 tier 配工具、超时、失败分类、不记录 key） | 现场 ok=1；迁移时改成配置化，加费用监控 | DV-20、DV-21、PR-16 |
| v2 门禁「精确固定 bind 加严格元数据」的思路 | 新环境挂载有变化时同步更新 | DV-03、DV-04、DV-12 |
| 验收方法：PG 只读计数、BIZ/FINAL_REPLY/MODEL_REPLY 计数行 | 可以做成服务端常驻指标 | DV-29、PR-17 |
| 第 1.5 节的 6 项审查缺口 | 迁移放行门槛 | 对应 PLANS 第 5–7 步 |

### 4.2 临时试点脚手架，迁移时应丢弃或重做

| 对象 | 理由 | 关联编号 |
|---|---|---|
| 01–05 现场五段式脚本、r9-reopen、预测 marker 工具（`predict-r*.mjs`） | 为单机 stage 加人工审批定制 | DV-16、DV-23 |
| seal/verify 依赖 localeCompare 排序 | 要改成字节序 | DV-02 |
| F-B r4 的 entry 硬编码 docker CLI、DB 网 ID 和冻结空 env | 绑定在现场拓扑上；要重新设计网络 | DV-05、DV-14、PR-24 |
| vendor 进 stage 的 pg 包 | 应改由依赖清单和镜像提供 | DV-06 |
| 现场手改的多角色版 `frontagent-controlled-pilot.mjs`（80d590dc，带 `.bak-multirole`） | 来源不明 | DV-08 |
| F2 observe-only 草稿 | parked，门禁已被跳过 | — |
| r10 owner id 名单的写法 | 只是临时映射；迁移时改成正式的 tier=owner 加可见门店集合 | PR-06、PR-07 |
| 遗留网络 b419d41c、测试卷，以及测试数据（targets 1 条、drafts 1 条） | 清理要用户单独批准 | PR-23、PR-18、DV-10、DV-17 |

---

## 5. 找不到证据或只是推断的地方

1. 助手B自己的历史会话无法检索。CLI 安装、astra 审查的准确时间，只能看文件 mtime，或者助手A会话里没有时间戳的转引。
2. 「冻结 v2 静态网络绑定（申请前 / 获准创建后）」：只在 `operation-request-20261108*.md` 里找到网络绑定段落，没有逐字核对，**部分仅记忆**。
3. astra 审查用的模型名，review.txt 里没有记录（仅记忆）。
4. PR #35 的测试数是 PR 正文自报的，助手B没复跑。PR 的 CI 状态没查。
5. r5–r9 没有 CLI 复核记录：usage-ledger 最后一条是 11-09 21:58，属于「证据未找到」。r7 有用户 13:18 的授权；r5、r6、r8、r9 只在 CHANGES 里标「未复核」。
6. r8 及以后的 runner 回复正文、15 秒时延，没有服务端逐条日志，只能看截图（DV-29）。
7. 测试员工A displayName 为空的原因（PR-03）和删卷后旧 SQLite 丢失（DV-19），都是推断。
8. 窗口 A 的 PG 计数只覆盖 21:03:49–21:39:51；测试数据还没清理。
9. 「Front Claw 产品×架构对齐」群里产品负责人和架构负责人的回复：证据未找到。
10. 「云端 5.6 Sol 因额度被拒」只有助手A会话（pos 1438），没有平台日志文件。

---

## 6. 本次用到的主要依据（sha256 前 8–16 位）

- **仓库：**
  - `<本地路径>`，HEAD 867c179；
  - `<本地路径>`，浅克隆 f2a8105，只读；
  - PR #35 和 commit `f2a8105`、`95467af` 的文件清单【GitHub 只读】。
- **前史文件：**
  - `<本地路径>` 3083a85a、`review.txt` da4add23；
  - `<本地路径>` 下 PLANS.md 5f3fa4bb、AGENTS.md 7475129c、TASK-TEMPLATE.md cfc6e8c0、run-review.sh a8d84c05、usage-ledger.tsv 326f64a9。
- **现场包：**
  - r7 tar d1beff0b；
  - r8 tgz 4ef59054；
  - r9 tgz ac56c45c；
  - reopen tgz 6a5c1af8；
  - step4 tgz 7798ae20。
  - 各包 SHA256SUMS 本次 `sha256sum -c` 全部 OK，包括 r4、r5、r6、r7、r8、r9、reopen、step4、productization、issue-register。
- **现场证据：**
  - step3r8 zip a9c7d440；
  - step3r9 zip bac0b640；
  - step3r9reopen zip 1d186174；
  - step4A zip d4fc9152，与目录里 18 个文件逐一一致。
