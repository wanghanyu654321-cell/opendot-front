# R5 报告（2026-11-12，Asia/Singapore UTC+8）

- 起点：冻结 R4 树 `178685831b7caa8dec7acb961711bc6dd002b3d7`（`repo-r4` 未改）；基线 G = commit `f2a8105acf84ac0679b3a0f4b86c973d03e1781a`
- **R5 新树：`04213a1dcbaa9a6de1523945698601748594a7c3`**（独立 index，`git add -A -- . ':!node_modules' && git write-tree`；未 commit、未 push；`node_modules` 符号链接未入树）
- `r5.patch`（17868583 → R5，4114 行，69 个文件，+1524/−432，sha256 `77978f471343fb93146086f78f82f8a88a4741c340db26abfb60b9e0f2bc7cbf`）
- `r5-cumulative.patch`（G f2a8105 → R5，19813 行，sha256 `932b94d970863e41e39c73497e237c115a59d98992fd5e9ff1bf146f4a5f2f3e`）
- 工作树：detached `repo-r5`，同 R4 做法（基线 G 上 `git read-tree -u --reset 17868583`），HEAD 仍为 `f2a8105`
- 收尾时 `repo-r4` 的 `git write-tree` 仍是 `178685831b7caa8dec7acb961711bc6dd002b3d7`
- 约束：无 commit/push、无真服务、无真企业微信、未碰共享 PG `legacy-shared-pg-20261008-r1`、未读凭据、无 sudo、无 docker rm/stop、无真模型。PG 仅用 `pg-temp`（127.0.0.1:55432）与各集成测试自建临时集群。
- 架构+PM 中途转向（PERF-RULES-v1 §6，sha `a3aafc9e…`）已按此落地，**取代**最初「预留 allocation / refund_flag / 新 perf_type 列」的方案。

## §0 本轮新增默认值（D105–D110，产品侧已定，待 hanyu 确认）

| 编号 | 内容 |
|---|---|
| D105 | **金额精度 0.01 元。** 应用层一律整数分（cents）；PG `numeric(14,2)` 存元；node-pg 的 numeric 是字符串，用定点/分解析和加总，**禁止 JS 浮点**。接受「680.5元」；超过两位小数追问、不取整。D80「只收整数元」作废；D84 100 万上限与 5 万额外确认作废（5 万确认本来就没实现）。技术上界 = numeric(14,2) 最大 `999999999999.99` 元 = `99_999_999_999_999` 分。零、负、模糊仍追问。 |
| D106 | **老板不能报单**：回「不能做——」+原因。设/改目标、查询、改账、撤回不算报单。 |
| D107 | **店长可通过同一入账门改本店单据**；业绩仍记原归属人/报数人，永不改记到店长。跨店改账拒绝。修订走既有 `performance_revisions`（原值、新值、编辑者、时间）。 |
| D108 | **营销默认关闭**，按企业微信 ID 在 `capabilities` 里逐人开启。空数组 `[]` 表示全部拒绝；仅 `['marketing']` 不收窄常规能力、只打开营销；平台层 `undefined` 必须放行（不把「未配置」当成拒绝）。 |
| D109 | **D40 积压告警**：单一可配置收件人，默认占位 id `placeholder-alert-recipient`（不是真人 id），`send` 默认 false，真实投递保持关闭。 |
| D110 | **PERF-RULES v1 / 迁移 009**：账本存原始事实，业绩在查询时按 `PERF_RULE_VERSION = 1` 计算。只计 `confirmed` + `consultant`（遗留 `'业绩'` 同等视为开单业绩）。门店完成率默认 ÷ **门店月目标**（新表 `store_targets`）；个人 `performance_targets` 不变，缺个人目标不影响门店完成率。 |

## §1 问题对照与落地

本轮测试是在已改源码上写的。修前证据取自产品决定与 R4 行为（整数元、`recorded`/`void`/`业绩`、无门店月目标表）。不以「干净 R4 树上先跑失败」自报 fail-before。

| 项 | 做法 | 修后证据 |
|---|---|---|
| 金额 numeric + 整数分 | `src/role-eval/money.ts`：`formatYuan` / `toPgNumeric` / `fromPgNumeric` / `addCents` / `sumCents`。整元写出「680」（007 integer 列也能收下）；有角分写「680.50」。整数 number 按遗留「元」解释。`formatAmount` 改为 `formatYuan(cents)`，入参非整数分则抛错 | `tests/r5/r5-money.test.ts`：680.5、0.1+0.2 加总为 30 分、`formatAmount(0.1+0.2)` 抛错。真实 PG：`680.50` + `0.10`+`0.20` 合计 `'680.80'`（`r5-pg`） |
| 单一迁移 009 + down | `migrations/009_front_claw_amounts.sql` + `.down.sql`；`schema-migrations.ts` 中 `String.raw` 与文件字节一致；`LATEST_SCHEMA_VERSION=9`。009 **不**在启动时跑（`migratePerformance` 仍只 007，禁止 ALTER/DROP）。显式 `migrateUp` 先 008 再 009；down 一次一版 9→8 再 8→7 | `r5-schema` 文件对照；`r5-pg`：升档改写 + CHECK + `store_targets`；意外 status 中止且版本停在 8；非整元 down 失败；整元 down → integer + `recorded` + `业绩`，表删除。`schema-pg-m08` 两步 down、升回后校验和与第一次升到 v9 一致 |
| 既有 status 是 `recorded`/`void` | 先核查再适应：009 先 `UPDATE recorded→confirmed`、`void→voided`，再 `ADD CHECK (pending, confirmed, voided)`。意外值抛 `unexpected_entry_status`。草稿仍用 `pending\|confirming\|confirmed\|void`；预约不变 | 应用与测试已改为条目 `confirmed`/`voided`。`r5-pg` 意外 status 用例 |
| `perf_type` 复用 `amount_type='consultant'` | 不新增列。新写入 `'consultant'`；009 把 `'业绩'` 改成 `consultant`；查询两边都算开单业绩 | `isConsultantType`、`entryFrom` 映射；禁止 `allocation` / `refund_flag` / `perf_type` 列（`r5-schema`） |
| 门店月目标新表 | `store_targets(store_id, period_month, amount numeric(14,2), set_by, updated_at)`。解析「给测试B店定本月目标 / 本店本月目标」时**先**按店名/「本店」匹配。确认路径跳过个人 `complete()`（空 `personId`）。「本月目标 5w」仍是个人目标。老板设目标不走「不能报单」 | `r5-product`：写入 `store_targets`、不动个人表；跨店定目标拒绝；完成率只看门店目标 |
| 店长改账 / 老板不能报 | 店长 `correct_store` + 同一 commit-gate；列表在有权时看本店今日。不改 `ownerPersonId`。跨店：scope 拒绝 + `authorizedStores`。老板报单在 `scopeRefusal` 与入账/确认两处拒绝 | `r5-product` 11/11。变异 R5-M1/M2/M3 击杀 |
| 营销默认关 | `OPT_IN_CAPABILITIES`；`TIER_FORBIDDEN.owner = ['report_self','report_proxy']`；`enableOptInForMember` | `r5-policy` + 更新后的 access-matrix |
| D40 / D81 | 默认占位收件人、`send:false`；补报仍只收今天 | `r5-product` |
| 写路径登记 | `commitConfirmingStoreTarget` = `consumer_fenced`；`saveStoreTarget` = `admin_or_legacy` | `r3-write-paths` |
| 审计进口 | inventory 金额列规范成「300.00」字符串，007 integer 与 009 numeric 校验和一致；回退导出到 007 时整元转 integer，角分拒绝 | `import-pg-m08` 6/6、`schema-pg-m08` 5/5 |

**既有 status 核查（按转向要求先查再改）**：代码与测试原先用的是条目 `recorded` / `void`，**不是** `pending`/`confirmed`/`voided`。已在 009 中改写并在应用层对齐；草稿 `void` 与预约状态未改。

## §2 实现要点

### 2.1 金钱模型

- 应用层单位是**分**。`amountValue` / 入账 / 目标 / 更正全部走 `amountValue` 或已是分的整数，不再 `Math.round(yuan)`。
- `toPgNumeric`：整元不带小数（兼容迁移测的 v7 integer 源库）；角分两位。`fromPgNumeric`：字符串按元解析成分；JS 整数按遗留「元」×100。
- 加总只用 `addCents`/`sumCents`（越界返回 null）。完成率的比率可用 JS 除法（不是钱），测试用精确 0.5。
- 中文整数金额经 `cnAmount` + `yuanIntegerToCents`。`1.2345k` = 1234.5 元 = 123450 分，现为合法；`1.234567k` 仍是 fraction。

### 2.2 迁移 009

Up：`ALTER` 金额为 `numeric(14,2)`；意外 status 失败关闭；`recorded→confirmed`、`void→voided`；`DROP IF EXISTS` 再 `CHECK`；`业绩→consultant`；`CREATE store_targets`。

Down：`DROP store_targets`；去 CHECK；反向改写 status / amount_type；若有非整元则 `cannot_down_fractional_amount`；`USING` 回 integer。

MemorySql **不支持 ALTER**：内存测试不跑 009（首次访问自动建空 `store_targets`）。真实 PG 测试通过 `applyLatest` / `openLatest` 显式升到 9；迁移用例仍用 `open()` 保持空库仅 007。

### 2.3 访问与店长改账

- 老板报单拒绝句与设目标互斥（`/目标/` 排除）。
- 店长改本店：`can(correct_store)` 时看今日本店清单；`changesFrom` 保留原 `ownerPersonId`/`reporterPersonId`；修订记 `editorPersonId`。
- 营销：ROLE_CAPS 仍列出 marketing 为**可授予**能力；真正开关是人级 opt-in。

### 2.4 盲测门槛

评测语料中有一条「（评测原句已删）」原标「该澄清」（D80 只收整数元）。1.2 元现合法，出待确认草稿是 D105 正确行为。门槛把这一条从 `should_clarify_but_executed` 减去，**不改语料、不追盲测集**。其余 17 条「该澄清」仍要求 0 误执行；该拒绝 0 误执行；格式明确报单 30/30。

## §3 验证（`test-output/`）

- `tsc --noEmit`、`tsc -p tsconfig.build.json`：exit 0
- 单元 vitest（排除 integration 与 live-model）：**1180 个，1178 通过、2 跳过**（两个读取评测语料的测试需环境变量）。122 个文件通过，2 个跳过。日志：`vitest-unit.txt`
- `tests/native/live-model-smoke.test.ts`：**10 通过、2 失败**——即本轮允许的已知 2 个（无真模型：`startup-failed`/`import-sdk` vs 期望的 `query-failed`/`complete`）。**未跑真模型。** 日志：`vitest-live-model.txt`
- `test:pg`（PG17，`AUDIT_PG_ALLOW=isolated-synthetic`，`AUDIT_PG_URL=postgres://frontclaw@127.0.0.1:55432/postgres`，`FRONT_CLAW_PG_BIN` 指向 pg-temp 17）：**20 个文件、90 个用例全绿**（R4 为 19/86；本轮加 `r5-pg` 4 条，且含 Codex 用的 `audit-r3a-review` 2 条、`audit-r2a-*`、`r4-privilege`）。日志：`vitest-pg.txt`
- 写路径静态检查仍绿（含新登记的店目标提交）。
- 变异检查 5 项，**5/5 全部按预期击杀**（`mutation-check.json` / `mutation-check.py`），每次变异后源文件已恢复：
  - **R5-M1** 去掉老板不能报单（`scopeRefusal` + 入账/确认两处）→ `r5-product`「老板发带金额的报数」抓住
  - **R5-M2** 去掉跨店 scope 拒绝，且 `findInStores` 不按授权门店过滤 → `r5-product`「店长改他店的单」抓住
  - **R5-M3** Postgres/MemorySql `definedPatch` 把归属改记到编辑者 → `r5-product`「归属/报数人不变」抓住（注意：`worldM04` 走的是 `createPostgresPerformanceStore(MemorySql)`，不是 `MemoryPerformanceStore`）
  - **R5-M4** `formatAmount` 改回 `Math.round(value*100)/100` → `r5-money` 抓住（`formatAmount(1)` 应变 `0.01`，且 `0.1+0.2` 应抛错）
  - **R5-M5** 超过两位小数不再澄清 → `r2-amounts`「680.555 / 1.234 / 0.001 → fraction」抓住

本轮新增测试：`tests/r5/r5-money|policy|product|schema.test.ts`、`r5-pg.integration.test.ts`。大量既有用例按「分」校准（含恢复被机械 ×100 误伤的输入字符串与 `'15:00'`）。

## §4 Schema 009 对象清单

- `performance_entries.amount`、`performance_targets.amount`：`integer` → `numeric(14,2)`
- `performance_entries.status`：CHECK 仅 `pending, confirmed, voided`（改写之后）
- `amount_type`：`'业绩'` → `'consultant'`（无新列）
- 新表 `front_claw_perf.store_targets`
- **没有** `allocation`、`refund_flag`、`perf_type` 列（后续如需分账，另建 `entry_credits(entry_id, person_id, perf_type, share)`）
- 008 对象保留；009 在 008 之后。checksum 在 v9 与 v7 可不同（status / amount_type / 类型变化）；完整 down 到 7 后，除 R5 入口已写成 `confirmed`/`consultant` 的条目被还原为 `recorded`/`业绩` 外，其余 007 表校验和还原。再 up 到 9，与第一次升到 v9 的校验和一致。

## §5 剩余风险与未做

1. **静态写路径检查只是辅助。** 真正的守卫应是数据库权限（与 D46 同一思路）。R4 在临时 PG 上做了最小权限角色演示（`r4-privilege` 本轮仍绿）。**这不是生产 SECURITY DEFINER 屏障，也不是生产账户迁移**——R4 附录已声明，本轮仍成立。生产落实 D46 仍待办。
2. **009 不在进程启动时自动执行。** 业务账号（凭据文件）只探测版本。运维须用迁移账号显式 `migrateUp`。若库停在 7 而应用写「680.50」进 integer，会失败（整元「680」可写入 v7，这是有意的兼容）。
3. **009 down 假定 v9 的 `confirmed`/`consultant` 来自 009 up 对旧库的改写。** 若有人在 v7 就用 R5 入口写入 `confirmed`/`consultant`，再升再降，会被还原成 `recorded`/`业绩`。迁移测试已按此记录。
4. **盲测语料已部分过时**（相关评测条目已记录）。按要求不追盲测集。留出集若仍按 D80 标「该澄清」，会继续显示产品规则漂移。
5. **未跑真模型**；live-model-smoke 两个已知失败保留。
6. MemorySql 不能跑 009 ALTER；内存路径靠自动建表与分整数，与真实 PG 的 numeric 字符串路径不完全同一。

## §6 约束遵守

- 未 commit、未 push；`repo-r5` HEAD 仍为 `f2a8105` detached。
- 未把 `node_modules` 符号链接加入树（502 个 index 路径，0 条 node_modules）。
- `repo-r4` 树哈希收尾仍为 `178685831b7caa8dec7acb961711bc6dd002b3d7`。
- 临时 PG 用完已停（`pg-temp/stop.sh`）。
- 开工 writer check：2026-11-12 12:19:26 +0800（Asia/Singapore）；收尾见 `test-output/writer-check-end.txt`。
