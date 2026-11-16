# R6 报告（2026-11-12，Asia/Singapore UTC+8）

- 起点：冻结 R5 树 `04213a1dcbaa9a6de1523945698601748594a7c3`（`repo-r5` 未改）；R4 树仍为 `178685831b7caa8dec7acb961711bc6dd002b3d7`（`repo-r4` 未改）；基线 G = commit `f2a8105acf84ac0679b3a0f4b86c973d03e1781a`
- **R6 新树：`0904915a885cd4049408bb1175c7b436a9b10f6c`**（独立临时 index，`git add -A -- . ':!node_modules' && git write-tree`；未 commit、未 push；`node_modules` 符号链接未入树；508 个 index 路径，比 R5 的 502 多 6 个新文件）
- `r6.patch`（R5 `04213a1d` → R6，3112 行，46 个文件，+1727/−186，sha256 `91bef9f3fb44268641e3e8feb7fda542366413550135c4c354d74158285f3406`）
- `r6-cumulative.patch`（G `f2a8105` → R6，21420 行，sha256 `b280cad0b3b18e7582cbc04edcae5dad33552348b511f93bbb99b486cd5e1d1d`）
- 工作树：detached `repo-r6`，同 R5 做法（基线 G 上加载 R5 树），HEAD 仍为 `f2a8105`
- 收尾时 `repo-r4` / `repo-r5` 的 `git write-tree`（临时 index）仍分别是 `178685831b7caa8dec7acb961711bc6dd002b3d7`、`04213a1dcbaa9a6de1523945698601748594a7c3`；其工作树自带 index 的 mtime 未动（R4 10:23、R5 12:20，Asia/Singapore）
- 约束：无 commit/push、无真服务、无真企业微信、未碰共享 PG `legacy-shared-pg-20261008-r1`、未读凭据、无 sudo、无 docker volume/network rm 或任何服务器命令、无真模型。PG 仅用 `pg-temp`（127.0.0.1:55432）与各集成测试自建临时集群；`test:pg` 结束后已 `pg-temp/stop.sh`。
- 中途转向（架构/产品/Codex，覆盖最初「扩改单动词表 / 逐个补修饰词」的修法，并按架构建议落地三条 P1）已全部按此实现，见 §2。

## §0 本轮编号（D106–D110 标「hanyu 已定」；D111 起为本轮新增）

只有真正的默认值才标「默认」。D106–D108、D110 是已定规则，不是默认值。D109 的收件人 ID 是待填配置，不是可用的默认 ID。

| 编号 | 内容 |
|---|---|
| D106 | **hanyu 已定。** 老板不能报单：回「不能做——」+原因。设/改目标、查询、改账、撤回不算报单。 |
| D107 | **hanyu 已定。** 店长可通过同一入账门改本店单据；业绩仍记原归属人/报数人，永不改记到店长。跨店改账拒绝。修订走既有 `performance_revisions`。 |
| D108 | **hanyu 已定。** 营销默认关闭，按企业微信 ID 在 `capabilities` 里逐人开启。空数组 `[]` 全部拒绝；仅 `['marketing']` 不收窄常规能力、只打开营销；平台层 `undefined` 必须放行。 |
| D109 | **hanyu 12:12 已定。** 积压告警只发给 hanyu 一个人；名字固定 `hanyu`；企微/人员 ID 是配置项，**默认空（待填）**。ID 为空：启动打 `console.warn`，`send` 强制 false，事件 detail 为「收件人 ID 待填，填之前告警不会真发」，告警不会真发。ID 已填且未显式 `send: false` 时，`send` **默认** true。**默认**开启条件：待发通知条数 ≥ 50，或最早一条已等待 ≥ 30 分钟。 |
| D110 | **hanyu 12:38 已定（PERF-RULES v1.1）。** 完成率 = 本月已确认开单业绩 ÷ 门店月目标，**不封顶**（有 120% 用例，展示为 120%）。分子只计 `confirmed` + `consultant`（`pending` / `voided` 不计）。分配约束与 R8 基数在规则/校验层：门店份额合计 100%（容差 0.01），员工份额 >0 且不超过所属门店份额；R8 基数是折后实收，赠送不加进基数。**不建** allocation 表，**不加**耗卡。 |
| D111 | **数据兜底（P0，架构转向）。** 发出新报单草稿前，若「本店该客户今日已有入账」（任意报单人，含店长代报；触发条件纯看数据，不看改单动词），草稿不能只问「对不对」。员工必须选「新增一笔」或「改第 N 笔」（列出今日该客户已有记录）。选新增必须能成功入账（同客户当天两笔合法）；选改 N 走既有并排改单+权限（跨报单人仍走既有权限）。动词表只是快路径；表里没有的说法一律落到兜底。**兜底只用于报单草稿，不作用于查询。** |
| D112 | **金额白名单（架构转向）。** 只接受「纯数字（最多两位小数）加单位」。金额片段里出现「不到 / 多 / 左右 / 负 / 减 / 大概」等，必须澄清或交模型——绝不四舍五入、绝不丢掉负号。口语「六百八十块五」「块五毛」要么正确解析为 680.5，要么澄清，不能截成 680。 |
| D113 | **门②优先于门①。** 「该澄清却执行」必须为 0，优先级高于「格式明确报单直接出清单」。写入本 REPORT，供后续盲测（含 Codex 将在留出测试集加的第三道门）按此考核。 |
| D114 | **M08-01（Codex + 架构细化）。** 迁移源地址不接受任意 URL。主机和端口只从固定配置 `FRONT_CLAW_MIGRATE_SOURCE_HOST` / `FRONT_CLAW_MIGRATE_SOURCE_PORT` 读；连接前解析出 IP，再和 `FRONT_CLAW_MIGRATE_ALLOWED` 白名单比对；拒绝 unix socket。白名单为空失败关闭。URL 只用于用户名/密码/库名；实际连接串用配置的主机和端口重建。目标库与回退库仍走原拒绝名单（第二层，含双重解码）。 |
| D115 | **M08-02（Codex + 架构细化）。** 靠专用 PG 角色保证源库只读：源库只授 SELECT。脚本连接后校验当前角色没有任何写权限（拒绝超级用户、INSERT/UPDATE/DELETE/TRUNCATE、CREATE/DDL），否则拒绝运行。事务级 `BEGIN TRANSACTION READ ONLY` 与 `default_transaction_read_only=on` 是第二层。`requireReadonlyRole` 只用于 CLI 源库路径，不是目标库，也不替代既有 `openSql({readOnly:true})` 的超级用户测试。 |
| D116 | **M04-01（Codex + 架构细化）。** 入账幂等：唯一约束建在来源草稿身份上，写入用 `ON CONFLICT DO NOTHING`，查重在同一事务内。**绝不**建「客户+营业日」唯一约束（同客户当天两笔合法）。因为一份草稿可以有多行，约束是 **`(source_draft_id, source_ordinal)`**，不是 `draft_id` 单列。放新追加迁移 010（有 down，由 `migrateUp`/`migrateDown` 包在事务里；SQL 文件本身不含 `BEGIN`/`COMMIT`）。加约束前先检查已有重复 `(source_draft_id, source_ordinal)`，有则 `RAISE EXCEPTION 'duplicate_source_draft_id'`，不改业务数据（事务回滚，连 ADD COLUMN 一并撤销），版本停在 9。 |
| D117 | **查询直接办（为 Codex 将在留出测试集加的第三道门做准备）。** 格式明确、在权限内的查询（查本人进度、查本店业绩、查今天的单）应直接办理，目标 ≥90%。数据兜底（D111）只用于报单草稿，不能让查询类更爱追问。本轮用自编用例验证自然说法不再落入通用提示或二选一。 |

## §1 问题对照与落地

本轮测试主要在已改源码上写。修前证据取自开工探针（在落地白名单/兜底之前）：「不到两千」收成 2000、「负一百」收成 100、「六百八十块五」截成 680、「不是昨天那种补报」当成补报昨天、「（评测原句已删）」跳过称呼询问、同客户再报直接出普通「还没入账」草稿。修后证据在 `tests/r6/`。未使用留出测试集原句，也未读私有评测语料或私有评测产物评分细节；用例均为自编。

| 项 | 做法 | 修后证据 |
|---|---|---|
| P0 数据兜底（不扩动词表） | `employee-loop`：在 `can()` 之后、`splitDuplicates` 之前，按本店+客户+今日已有入账触发二选一；「对」在等待选择时不能提交；「新增一笔」带 `explicitNew` 成功入账；「改第 N 笔」走既有并排改单+权限 | `r6-product`：自编、不在动词表里的说法全部触发二选一，绝不是普通「还没入账」；「对」被拦住；选新增账上两笔；选改 1 是一笔被改；店长代报同样触发；员工改别人的单无 `correct_store` 则拒绝、零写入。变异 R6-M1 击杀 |
| 金额白名单 | `parsePureMoney`：只收纯阿拉伯数字（最多两位小数）或合法中文金额 + 单位；「不到 / 负 / 减」等不剥掉后当正数；「块五」走中文口语规则得到 680.5 | `r6-product`：不到/负/减不解析成确定金额；负号与「减」不被吞；「六百八十块五」「一千二百五十块五毛」为 680.5 / 1250.5；不清楚的金额零写入。变异 R6-M2 击杀 |
| 补报否定 | `maskNegatedPastDay`（在 `scope-refusal`，避免与 extract 循环引用） | 「不是昨天那种补报，张姐680」作为今天的单，能出草稿。变异 R6-M3 击杀 |
| 预约先问称呼 | `customerNamed` 才算已回答；「（评测原句已删）」不算；先检查 `policyMode` 与 `can(appointment_submit)` 再问；`isNoNameAnswer` 接受「就按没留名登记」。`looksLikeAppointment` 需「客人」或「称呼+来/约」 | `r6-product` 先问再「就按没留名」出草稿。既有预约测试经 `registerUnnamedAppointment` 与 `say()` 用「王姐」适配（「（评测原句已删）」现在会先问）。变异 R6-M4 击杀 |
| 查询直接办 | `isSelfProgressQuery` / `isStorePerfQuery` / 放宽的 `isManagedQueryPhrase`；员工循环与入口澄清后续把这些（以及预约、新增/改 N）送进店内循环。兜底只看报单草稿 | `r6-product`：「查一下我今天的进度」「看今天的单」「查本店业绩」直接出结果，不是通用提示、不是二选一。变异 R6-M8 击杀 |
| D109 | `DEFAULT_BACKLOG_ALERT_RECIPIENT = ''`；空 ID 警告且不发；默认触发 ≥50 条或 ≥30 分钟 | `r6-product`。变异 R6-M7 击杀 |
| PERF v1.1 | `storeCompletionRate` 不封顶；`validateAllocation`；`performanceBaseCents` = 实收；`formatScore` 用 `Math.round(rate*100)` 且不封顶 | `r6-product`：120%；pending/voided 不计；份额约束；赠送不加基数 |
| 门② > 门① | 不清楚的金额不出「还没入账」草稿；`clarifyQuestion` 对 negative / unclear 有明确问句 | `r6-product`「门②优先」两组 |
| M08-01 | `resolveSourceConnection`：主机端口只从配置读，解析 IP 对白名单，拒绝 socket；可注入 lookup | `r6-guards`：成功路径用配置主机而非 URL 主机；空名单失败关闭；共享库 IP / 别名 / 双重编码 / unix socket 拒绝；CLI 缺配置不发起连接。变异 R6-M5 击杀 |
| M08-02 | `assertReadonlyRole` + `openSql({readOnly, requireReadonlyRole})`；pg-temp 里 `createReadonlyRole()`（LOGIN NOSUPERUSER，只 GRANT SELECT，REVOKE CREATE） | `r6-pg`：只读角色正例通过；超级用户/有写权限反例拒绝；会话内 `SET` 仍写不进去 |
| M04-01 / 010 | 新迁移 010：加列 → 查重 RAISE → 存量用 `entry_id`/0 回填 → `UNIQUE (source_draft_id, source_ordinal)`。`commitConfirmingDraft` 事务内查重（只对**已存在**的 confirmed 行做多重集合，同一草稿里相同金额的两行都插入；重发已存在的 N 行跳过；`explicitNew` 跳过内容查重）+ `ON CONFLICT DO NOTHING`。advisory lock 用整型键 `SELECT pg_advisory_xact_lock($1,$2)`，便于 MemorySql | `r6-schema` 文件=String.raw、LATEST=10、约束是二元组不是客户+营业日、无嵌套 BEGIN。`r6-product` Memory 连点两次「对」只记一笔。`r6-pg` 并发同一草稿只一笔；已有重复时 RAISE、版本停在 9、数据不动。变异 R6-M6 击杀（文件对照） |
| 009 P2 | down **先**检查角分再 DROP/UPDATE，有则 RAISE、版本停在 9（若已应用 010，先 down 到 9 再测 009 down）、数据不变；升/降档 `RAISE NOTICE` 打印改写前后各状态条数。SQL 文件不含 `BEGIN;`/`COMMIT;`（由 `inTransaction` 包裹） | `r6-schema`、`r5-schema`（先检查）；`r6-pg` NOTICE 与角分原子。变异 R6-M9 击杀 |
| 007–009 兼容 | `insertEntries` / `commitConfirmingDraft` 先探测 `information_schema` 是否已有 `source_draft_id`（MemorySql 无该目录则视为支持）；未升 010 的库走 13 列 INSERT，不引用新列 | `test:pg` 在 `open()`（仅 007）上的 seed / 预约 / 通知等 95 条全绿 |

## §2 实现要点

### 2.1 数据兜底（D111），不是扩动词表

触发条件是数据：本店、该客户、今日已有入账（任意报单人）。与句子里有没有「改 / 其实是 / 弄成」无关。未识别的改口说法落到同一张二选一网。选择结果写在草稿载荷 `awaitingDuplicateChoice`；选「新增」的提交带 `explicitNew`，内容查重不会把它当重复丢掉。回复文案不得含「还没入账」（那是普通新草稿的标志）。**查询与预约不走这张网。**

### 2.2 金额白名单（D112）与门②（D113）

`expandAmountFragment` 只经过会粘在金额上的修饰（不到/负/减等会连到片段上，从而整体不纯、必须澄清；「弄成 / 其实是」不粘）。剩余未匹配字符 → `bad`。中文「块五」允许单位后跟一位小数（毛可省略）。门②（该澄清却执行 = 0）优先于门①（格式明确直接办）；金额不清时宁可追问，不可写入。查询类相反：格式明确且在权限内应直接办，不要因为兜底或澄清门变得更爱追问。

### 2.3 迁移 010 与入账幂等（D116）

- 唯一键是 `(source_draft_id, source_ordinal)`，因为一稿多行。文档与 SQL 注释写明这一点。
- **绝不**在（客户 + 营业日）上建唯一约束。
- 加约束前查已有非空重复 → `duplicate_source_draft_id`，事务回滚，版本仍 9，业务行分毫不改。
- 存量行回填 `source_draft_id = entry_id, source_ordinal = 0`，再加约束。
- 写入 `ON CONFLICT (source_draft_id, source_ordinal) DO NOTHING`，与「已存在 confirmed 行的多重集合」内容查重同在提交事务里。内容查重不会把同一草稿里尚未提交的兄弟行互相吃掉（「同金额两笔都记」仍成立）；重发已入账的 N 行则全部跳过。
- `LATEST_SCHEMA_VERSION = 10`。`migrateUp` 从 8 起先 009 再 010；第一次 down 是 10→9。009/010 的 `String.raw` 与文件字节一致。
- 010 与 009 一样**不**在进程启动时自动执行（`migratePerformance` 仍只 007）。

### 2.4 源库连接（D114、D115）

- 主机/端口只来自固定环境变量，不来自 URL 的 host。连接前 `lookup` 解析 IP，与白名单（`host:port/db` 或 IP）比对；解析失败拒绝；白名单空则失败关闭；unix socket（含 URL 与路径形式）一律拒绝。重建后的连接串使用配置主机和端口。
- 源库 CLI：`connect(..., {readOnly:true, requireReadonlyRole:true})`。角色校验失败则拒绝运行。第二层：`default_transaction_read_only=on` + `BEGIN TRANSACTION READ ONLY`。生产源库必须先建只授 SELECT 的专用角色；用 initdb 超级用户 `frontclaw` 当源会失败（这是有意的）。

### 2.5 查询（D117）与预约

数据兜底不介入查询。自然说法（「查一下我今天的进度」「看今天的单」「查本店业绩」）在规则层识别后直接办理。入口处若处于澄清后续，这些说法以及预约请求、新增/改 N，都回到店内循环，避免被当成未完成的澄清而反复追问。

预约：没写称呼先问；「就按没留名登记」可过；先鉴权/策略再问，以免未开放/拒权的请求被问成「哪位客人」。

## §3 验证（`test-output/`）

- `tsc --noEmit`、`tsc -p tsconfig.build.json`（`npm run build`）：exit 0，0 个错误。日志：`tsc.txt`、`build.txt`。
- 单元 vitest（默认配置，`tests/**/*.test.ts`，排除 integration）：**1224 总计，1220 通过、2 失败、2 跳过**；125 个文件通过、1 个失败、2 个跳过（共 128）。2 个失败即已知的 `tests/native/live-model-smoke.test.ts`（无真模型时 `startup-failed`/`import-sdk`，期望是 `query-failed`/`complete`）。**未跑真模型。** 2 个跳过仍是需环境变量的盲测文件。日志：`vitest-unit.txt`（含 live-model）。
  - **口径：** 若按 R5 把 live-model 12 条（10 通过 + 2 失败）拆开，其余为 **1212 条（1210 通过 + 2 跳过）**。R5 报告单元 1180（1178 通过 + 2 跳过），Codex 量过 1188——口径可能略有不同。本轮比 R5 多出的主要是 `tests/r6/` 自编用例以及预约测试适配，数字如实记录，不作对齐折算。
- `test:pg`（PG17，`AUDIT_PG_ALLOW=isolated-synthetic`，`AUDIT_PG_URL=postgres://frontclaw@127.0.0.1:55432/postgres`，`FRONT_CLAW_PG_BIN` 指向 pg-temp 17）：**21 个文件、95 个用例全绿**（R5 为 20 文件 / 90 用例；本轮加 `r6-pg` 5 条，既有 schema/import/appointment PG 用例按 v10 与称呼询问适配后通过）。结束后已停 pg-temp，55432 已关闭。日志：`vitest-pg.txt`。
- 变异检查 9 项，**9/9 全部按预期击杀**（`mutation-check.json` / `mutation-check.py`，每次变异后源文件已恢复）。变异跑在「007 列探测」兼容补丁之前；补丁之后单元 1220 与 `test:pg` 95 仍绿。项目：
  - **R6-M1** 关掉数据兜底 → `r6-product` 二选一用例抓住
  - **R6-M2** 负号/减被吞 → 「绝不当成正数」抓住
  - **R6-M3** 去掉「不是昨天那种补报」掩盖 → 补报否定用例抓住
  - **R6-M4** 「（评测原句已删）」不再先问 → 预约询问用例抓住
  - **R6-M5** IP 不在白名单也放行 → `r6-guards` 抓住
  - **R6-M6** 去掉 `(source_draft_id, source_ordinal)` 唯一约束声明 → `r6-schema` 文件对照抓住（比并发 PG 弱，并发证据在 `r6-pg`）
  - **R6-M7** 空 ID 仍 `send=true` → D109 用例抓住
  - **R6-M8** 自然查询说法不再直接办 → 查询用例抓住
  - **R6-M9** 009 down 去掉角分 RAISE → `r5-schema` + `r6-schema` 抓住（须改掉 `RAISE EXCEPTION 'cannot_down_fractional_amount'` 整句，只注释仍会被字符串检查看到）
- **留出测试集回归**（已污染，**不作本轮门槛**；R5 口径 + 指定私有语料）：门① 格式明确直接出清单 **39/51**（0.7647），门② 该澄清却执行 **0/13**，该拒绝却执行 **0/51**，与 R5 复审记录所记 harness 39/51、② 0/13 相同。日志：留出测试集产物。未跑真模型，未读留出测试集。

本轮新增测试：`tests/r6/r6-product.test.ts`（25）、`r6-schema.test.ts`（3）、`r6-guards.test.ts`（4）、`r6-pg.integration.test.ts`（5）。既有预约、009/010 版本号、import-pg/schema-pg、CLI 源库环境变量与只读角色等用例已适配。

## §4 Schema 对象清单（009 修订 + 010）

009（相对 R5）修订：

- 升档、降档在改写前后 `RAISE NOTICE` 打印 `recorded / void / confirmed / voided / pending` 条数。
- down：**先**检查存在角分 → `cannot_down_fractional_amount`，此时不 DROP、不 UPDATE；通过后再改数据。
- 文件不含事务 `BEGIN;`/`COMMIT;`（`DO $$ BEGIN` 是 plpgsql 块，不是事务边界）。

010 新增：

- `performance_entries.source_draft_id text`、`source_ordinal integer`
- 约束 `performance_entries_source_draft_unique UNIQUE (source_draft_id, source_ordinal)`
- **没有**「客户 + 营业日」唯一约束，**没有** `draft_id` 单列唯一
- down：先 DROP 约束再 DROP 列，不改写业务行
- 008 / 009 对象保留；010 在 009 之后。checksum 在 v10 与 v9 不同（新列与约束）。完整 down 到 9 后新列消失；再 up 到 10 与第一次升到 v10 的校验和应一致（`schema-pg` 竞态：007 基线一次应用 8+9+10，只成功一次）。

应用层：未升 010 的库（`open()` 停在 007）仍可 `insertEntries` / 确认入账（探测列后走旧 13 列 INSERT）。升到 10 的确认路径走 15 列 + `ON CONFLICT`。

## §5 剩余风险与未做

1. **M08-03（E 段 volume/network rm 爆炸半径）：待现场对象核实。** 本轮按要求只列在 REPORT，**未执行任何服务器命令**，未做 docker volume/network rm，未连共享 PG。现场需核对脚本作用对象，避免误删共享卷或网络。
2. **D109 收件人 ID 仍待填。** 填之前积压告警不会真发。上线前把企微 ID 写入配置后再验证真发路径。
3. **010 / 009 不在进程启动时自动执行。** 运维须用迁移账号显式 `migrateUp` 到 10。停在 7–9 的库，应用不会因缺少源草稿列而写崩（有列探测），但确认幂等的唯一约束要到 10 才在数据库层生效；停在 9 时只靠事务内查重，仍有并发窗口——上线步骤必须升到 10。
4. **生产源库必须准备只读角色和白名单。** 用超级用户或可写角色当 `FRONT_CLAW_MIGRATE_SOURCE_*` 会被 `requireReadonlyRole` 拒绝；白名单为空则失败关闭。目标库/回退库仍是拒绝名单模型，不是本轮白名单。
5. **静态写路径检查与最小权限演示仍不是生产 SECURITY DEFINER 屏障**（与 D46 同一思路，R4/R5 已声明，本轮仍成立）。
6. **留出测试集语料已污染，39/51 不作 R6 门槛**；门② 在该集上仍是 0/13。Codex 将在留出测试集加的第三道门（查询 ≥90%）本轮用自编用例覆盖，没有留出测试集语料，不能自报 90% 语料达标率。按要求不追盲测集、不读留出测试集。
7. **未跑真模型**；live-model-smoke 两个已知失败保留。
8. MemorySql 没有 `information_schema`，列探测走「视为已支持」；010 的 ALTER 仍只在真实 PG 上跑（与 009 相同）。内容查重的 SQL 已改成 MemorySql 可执行的形态（整型 advisory lock、`IS NOT DISTINCT FROM`、无 `LIMIT` 的内容查询），默认测试世界是 `createPostgresPerformanceStore(MemorySql)`，不是 `MemoryPerformanceStore`。
9. 009 down 仍假定 v9 的 `confirmed`/`consultant` 来自 009 up 对旧库的改写（R5 已记录的风险，未变）。

## §6 上线步骤（含 R5 REPORT-ADDENDUM）

1. **先停旧入口，再跑 009。** 旧入口仍会往 `performance_entries` 写 `recorded`，009 加上 CHECK 之后这类写入会被拒绝。
2. **从旧库导入的数据，要么在 009 之前导完，要么导入时先把状态映射成新值：** `recorded`→`confirmed`，`void`→`voided`。说明：旧系统里账本条目是员工回「对」之后由 commit-gate 写入的，本来就是已确认的单，所以 `recorded` 迁成 `confirmed`；`void` 迁成 `voided`。
3. **CHECK 只加在 `performance_entries.status` 上**（纯状态值）。带 epoch 和 f 的编码文本在 `performance_notifications.status` 里，009 没有动它，fencing 写入口不会被卡住。
4. **009 升/降档会在 NOTICE 里打印改写前后各状态条数**，运维应把这组计数留进现场记录，与预检对照。
5. **009 完成后再显式 `migrateUp` 到 10（010）。** 若预检发现已有重复 `(source_draft_id, source_ordinal)`，010 会 RAISE 且不改数据，版本停在 9——先人工处理重复再升。不要用「客户+营业日」去重。
6. **配置迁移源：** 设置 `FRONT_CLAW_MIGRATE_SOURCE_HOST` / `SOURCE_PORT` / `FRONT_CLAW_MIGRATE_ALLOWED`，源库连接使用只授 SELECT 的专用角色（非超级用户）。缺白名单或角色不对会失败关闭，这是预期。
7. **填写 D109 收件人企微 ID**，并确认默认开启条件（积压 ≥50 或最早一条 ≥30 分钟）符合现场；填之前告警不会真发。
8. **M08-03 待现场对象核实后再动清理脚本**，本轮提供的制品不包含、也不应执行 volume/network 删除。

## §7 约束遵守

- 未 commit、未 push；`repo-r6` HEAD 仍为 `f2a8105` detached。
- 未把 `node_modules` 符号链接加入树（508 个 index 路径，0 条 `node_modules`；`_probe.test.ts` 已删除且未入树；`mutation-check.py` 只在 `<本地路径>`，不在仓库树里）。
- `repo-r4` 树哈希收尾仍为 `178685831b7caa8dec7acb961711bc6dd002b3d7`；`repo-r5` 仍为 `04213a1dcbaa9a6de1523945698601748594a7c3`。
- 临时 PG 用完已停（`pg-temp/stop.sh`）；未执行任何 docker / 共享 PG / 服务器命令。
- 未读凭据、无 sudo、无真企业微信、无真模型、未读留出测试集原句或 r4r5 评分细节。
- 收尾见 `test-output/writer-check-end.txt`（2026-11-12 20:16 +0800，Asia/Singapore）。
