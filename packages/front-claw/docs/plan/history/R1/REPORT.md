# R1 修复轮 REPORT（M03 / M06 / M07 审计 P0/P1 + M02 路由）

- 基线 G = `f2a8105acf84ac0679b3a0f4b86c973d03e1781a`；起点 = M08 累积树 `79c86525dcf4cb01d25882871d94069f96a0f7ce`
- **R1 新树 = `6318188d4a7451121a86174015fe83203c296521`**（repo-r1 `git add -A && git write-tree`，未 commit、未 push）
- 产物：`r1.patch`（对 M08 树，39 文件，+1848/−319）、`r1-cumulative.patch`（对 G，100 文件，+11144/−130）、`changed-files.txt`、`r1-tree.txt`、`SHA256SUMS`；两份 patch 均已 `git apply --check -R` 通过。
- 未连服务器/企微/共用 PG（legacy-shared-pg-20261008-r1），未执行 M08 REPORT §5 命令，未读 env/凭据，未删数据；repo、repo-m0x、私有审查目录未改动。
- 所有 PG 证据来自本机临时 PG17 集群（pg-temp），**不是线上 PG 版本**。

## §0 本轮新增/变更默认值（自 D63 起）

| 编号 | 默认值 |
|---|---|
| D63 | 两个出口：(a) 入账门 `commit-gate.ts`，在同一事务内按序复核 fence → 提交人当前人员行（在职/tier/memberId/门店）→ 代报对象（在职、同店）→ 最新策略（版本+高水位）；营销结果发出前走同一门（生成前后各一次）。(b) 提醒发送前 `beginNotificationSend` 在事务内 FOR SHARE 重读收件人档案、草稿行、预约行，锁外预检与事务内判定共用同一个纯函数 `eligible()`。 |
| D64 | 入账门拒绝 → 回复 ACCESS_DENIED，草稿退回 pending（不作废），零入账。 |
| D65 | 策略版本单调：写入版本 ≤ 当前版本或 ≤ 高水位一律拒绝；通用 `setConfig` 拒绝写访问策略与高水位键；高水位缺失/损坏 → 读侧判 `stale_policy` 一律拒绝（fail-closed）。 |
| D66 | 配置锁序统一为 `configLockOrder`：高水位键最先，其余排序；人员行排序后 FOR SHARE。入账门、策略更新、发送门共用此锁序（修复策略更新与入账门的死锁，同时保留 M08 首次初始化修复）。 |
| D67 | 共用 fencing epoch：M07 消费租约 JSON 带 `epoch`（换主 +1，续约/释放保留）；M06 通知状态字段 `f`（每次领取 +1）；结果写回带 `{epoch, nowIso}`，不一致即拒绝。 |
| D68 | 时钟：fence/租约判定使用应用时钟（D41 仍未决，见 §5）。 |
| D69 | 008 迁移原地改写（尚无已部署的 v8）：严格触发器（与 TS 共用 STATUS_PATTERN，违规抛 `invalid_delivery_status`）、新增 `delivery_fence bigint` 列；回填遇畸形行 fail-closed 整体回滚，需先按 README 的 REPAIR 语句把畸形行改为 `not_sent|-|-|a=1|r=0|err=malformed_legacy_status` 再执行。过渡期仍以状态文本为唯一写路径。年份 0000 判非法。 |
| D70 | 旧租约持有者（stale）在处理前与回复前各查一次 PG 租约行，失守即丢弃消息（droppedStale），不写任何东西。 |
| D71 | 操作号记录持久化到 config `front-claw-op:<id>`；重启后仍为 running 的记录报 `interrupted`。暂无保留期/清理（见 §5）。 |
| D72 | OpenDot 启动超时 `FRONT_CLAW_OPENDOT_START_TIMEOUT_MS` 默认 15000（允许 1..120000）；超时告警并返回关闭态，迟到的成功会被自动关闭回收。activate 部分失败：关通道、释放租约、关 DB。 |
| D73 | 门店营业配置 `STORE_HOURS_KEY` 按门店给时区/打烊；缺省 Asia/Shanghai、23:00；配置损坏 → 不读不写（`STORE_HOURS_BROKEN`），派发器原因 `store_hours_invalid`。 |
| D74 | `paused` 非布尔值按暂停处理。并发人工补发走 `requeueNotificationWithAudit`，只记真正执行者。 |
| D75 | M02 快路径：先 NFKC；金额支持小数与 k/w/元/块 精确换算为整数；全角数字/括号；括号内姓名 = 被代报员工；括号内多个员工拒绝；回显 `姓名 金额元（原文 → 整数）`，如「1.2k → 1200」。 |
| D76 | M02 兜底分类器：仅在规则非单一命中（无信号/多意图）时调用；输出 route ∈ {act, clarify, marketing, chitchat} + fields；默认确定性桩（恒 clarify，不计为模型调用）；OpenDot 模型配置适配点 `intentClassifierFromOpenDotModel` 严格解析 JSON；分类器给出的字段不直接用于写入；多意图时只能在规则命中项中选。 |

## §1 问题表（修前 = M08 树 + 3 个仅导出 shim；修后 = R1 树）

修前证据：`test-output/before-fix-r1-final.txt`（单测 37 失败 / 2 通过）、`test-output/before-fix-r1-pg.txt`（PG 8 失败 / 1 通过）。修后证据：`test-output/r1-unit.txt`（39 通过 / 1 跳过——盲测统计用例需环境变量）、`test-output/r1-pg.txt`（9/9）。

| 问题 | 修复 | 测试 | 修前 | 修后 |
|---|---|---|---|---|
| R1-M03-P0-1 旧策略回写复活 | 高水位 + 单调版本 + setConfig 保护键（D65） | R1-M03-P0-1a/1b/1c；R1-PG-a3 | 1a/1b ×、1c ✓（M08 已有版本单调）；a3 × | 全 ✓ |
| R1-M03-P0-2 停用后仍入账 | 入账门复核提交人当前行 | R1-M03-P0-2/2b/2c/2d；R1-PG-a1、a2 | 全 ×（a2 修前失败部分源于 DENIED 未导出，属 shim 伪影） | 全 ✓ |
| R1-M03-P0-3 恢复分支跨店入账 | 恢复路径 targetsInStore + 入账门复核代报对象 | R1-M03-P0-3/3b；R1-PG-a1 | × | ✓ |
| R1-M03-P1-1 重放/缓存命中不复核 | 重放走 gateNow；缓存命中 `stillAllowed` | R1-M03-P1-1a/1b | × | ✓ |
| R1-M03-P1-2 营销生成期间撤权 | `marketingActor` 生成前后各过一次门 | R1-M03-P1-2 | × | ✓ |
| R1-M03-P1-3 首次初始化竞态 | M08 已修；R1 补回归，锁序 D66 | R1-M03-P1-3；R1-PG-c1 | ✓（M08 已修） | ✓ |
| R1-M06-P0-1 停用店长仍收提醒 | 发送门事务内重读收件人（D63b） | R1-M06-P0-1/1b/1c；R1-PG-b1 | × | ✓ |
| R1-M06-P1-1 过期领取者仍标 sent | fence `f` + 结果写回带 epoch/now（D67） | R1-M06-P1-1；R1-PG-b2 | × | ✓ |
| R1-M06-P1-2 已确认仍提醒 | 事务内重读草稿行 | R1-M06-P1-2/2b | × | ✓ |
| R1-M06-P1-3 状态文本不严格 | 严格 STATUS_PATTERN，TS 与 008 触发器共用（D69） | R1-M06-P1-3a/3b；R1-PG-b4；schema-pg-m08 | × | ✓ |
| R1-M06-P1-4 并发补发覆盖审计 | `requeueNotificationWithAudit` | R1-M06-P1-4；R1-PG-b3（10 轮） | × | ✓ |
| R1-M06-P1-5 无门店时区/营业配置 | store-hours.ts（D73） | R1-M06-P1-5a/5b/5c | × | ✓ |
| R1-M06-P2-1 paused 类型错 | 非布尔按暂停 | R1-M06-P2-1 | × | ✓ |
| R1-M07-P1-1 租约无 fencing | epoch + fenceStillHolds + 入账门 fence（D67/D70） | R1-M07-P1-1（B confirms=false/true）、P1-1b；R1-PG-a4；adapter-pg-m07 skew（5 轮） | × | ✓ |
| R1-M07-P1-2 启动挂起 | 启动超时（D72） | R1-M07-P1-2 | × | ✓ |
| R1-M07-P1-3 操作号只在内存 | operation-records.ts（D71） | R1-M07-P1-3 | × | ✓ |
| R1-M07-P1-4 真实 OpenDot 验收 | 只做了模型配置适配点；**真实入口验收未做** | R1-M02-2c（仅适配点） | — | 未决 |
| R1-M07-P2-1 activate 部分失败 | 回收通道/租约/DB | R1-M07-P2-1 | × | ✓ |
| R1-M02-1 明确代报被追问 | 快路径（D75） | R1-M02-1a/1b/1c/1d | × | ✓ |
| R1-M02-2 无兜底分类接口 | intent-classifier.ts + model-config.ts（D76） | R1-M02-2a/2b/2c | × | ✓ |
| R1-M02-3 盲测分规则/规则+桩统计 | 读取评测语料的测试 | 留出测试集产物 | — | 见 §3 |

注：修前两项通过（P0-1c、P1-3 memory-store）以及 PG-c1 通过，是因为 M08 已修过对应点，作为回归保留，并非测试无效；它们的有效性由变异 M10 证明。

## §2 验证数字（2026-11-11 23:40 SGT 开跑，`run-verify.sh`）

| 项 | 结果 |
|---|---|
| tsc / typecheck / build | 全部 exit=0 |
| 全量 vitest | 84 个文件：1 失败 / 82 通过 / 1 跳过；974 条用例：**2 失败 / 971 通过 / 1 跳过**。失败仅为 `tests/native/live-model-smoke.test.ts` 的两条已知用例 |
| test:pg（临时 PG17） | 10 个文件 / **64 条全过** |
| R1 PG 重复 3 次 | 每次 32/32 通过 |
| m01–m08 分模块 | 15/18/21/25/20/20/27/9，全过 |
| R1 单测 / R1 PG | 39 通过 + 1 跳过 / 9 通过 |
| cli-smoke | exit=0（两个守卫：共享库源 → `forbidden_source_database`、源=目标 → `source_same_as_target`，均按预期拒绝） |
| 并发 / 撤权竞态 | a1 用锁做先后，gate 确定性拒绝；a2 跑 20 轮真竞态，本次结果为入账 8 / 预检拒 12 / 门拒 0，每轮都满足「入账 1 笔」或「拒绝 + 零入账 + 草稿待确认」（上一次运行门拒为 1，入账门路径由 a1 和变异 M9 确定性覆盖）；b3 跑 10 轮补发恰一胜；c1 跑 10 轮首写恰一胜；adapter skew 跑 5 轮 |
| 变异检查 | `mutation-check.py`：11 个变异 **ALL_KILLED**（M1 提交人行、M1b 代报对象、M2 fence 恒真、M3 忽略高水位、M4 发送门沿用预检、M5 缓存不复核、M6 营销不复核、M7 无 NFKC、M8 内存写回无 fence、M9 PG 不锁人员行、M10 锁序不统一） |

## §3 盲测统计（私有评测语料，130 条）

| 指标 | M08 基线 | R1 规则 | R1 规则+桩 |
|---|---|---|---|
| 误路由 | 3/113 = 2.65% | 3/113 = 2.65% | 3/113 = 2.65% |
| 该直接办却追问 | 61.63% | 46/86 = 53.49% | 46/86 = 53.49% |
| 该澄清却直接办 | 33.33% | 5/18 = 27.78% | 5/18 = 27.78% |

**说明**：桩恒输出 clarify，所以「规则+桩」与「规则」数字相同是预期结果。**这不代表接真实模型后的效果**，真实模型的数字目前未知，要在 OpenDot 模型配置下另行测量。53.49% 的追问率仍然偏高，大部分剩余样本需要语义分类才能解决。

## §4 改动文件
见 `changed-files.txt`（对 M08 树 39 个文件；新增 commit-gate.ts、fencing.ts、protected-config.ts、store-hours.ts、intent-classifier.ts、operation-records.ts、opendot/model-config.ts、tests/r1/*）。

## §5 未决项与待用户决定
1. **M07-P1-4** 真实 OpenDot 入口与模型配置复用验收：本机做不了，需要在真实 OpenDot 环境里验收。
2. **D41 时钟来源**：本轮暂用应用时钟（D68）；是否改用 DB `now()` 待定。
3. **D5 三档能力表**：本轮沿用现有 tier 判定，最终表待用户定。
4. **D40 积压告警由谁看**：未定，本轮没有新增告警接收人。
5. **D46 凭据注入方式**：未定；模型适配点只接收注入的 `complete`，不读凭据。
6. 真实模型下的盲测数字：未知。
7. 生产 PG 版本：未知，证据都来自 PG17 临时集群。
8. 操作号记录（D71）没有保留期和清理。
9. 008 畸形行需要人工执行 REPAIR 后才能升级（D69）。

## §6 请助手B重点审查
1. `commit-gate.ts` 的复核顺序和字段是否完整（memberId 换绑、tier、门店、代报对象），以及 `configLockOrder` 在三条路径上的锁序一致性和死锁风险。
2. 营销「生成前后两次过门」与缓存命中 `stillAllowed` 是否还有能绕过门的出口（例如别的回复路径）。
3. fencing：租约 epoch 在 renew/release 时保留是否安全；通知 `f` 与租约 epoch 是两个计数器但用同一判定 `fenceHolds`，语义是否满足「同一 epoch」的要求。
4. 008 原地改写与 fail-closed 回填：前提是线上确实没有部署过 v8，需要确认。
5. M02 快路径的 TIGHT 无空格客户形式和 `amountOfTerm` 精度边界（如 1.25k、0.5w）；分类器 fields 不用于写入的约束是否在所有调用点都成立。
6. a2 真竞态本次门拒为 0，入账门的竞态覆盖主要靠 a1 加锁先后与变异 M9，请评估是否足够。
