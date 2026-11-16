# M03 完成报告：三档权限、功能配置与撤权

日期：2026-11-11 18:50（UTC+8）。编写：助手A侧；待助手B审查。未 commit / push / PR；未连服务器、未碰企微、未读 env/凭据、未删除任何文件；未联网装依赖；未调用 Codex CLI。
基线：f2a8105 + M02 累计补丁（工作树 <本地路径>；repo-m02 未动，其 diff sha 仍为 264761c3…）。

## 0. 默认值（未拍板，均按默认实现，可改）

| # | 默认 | 位置 |
|---|---|---|
| D1 | 被代报人只要求“同店在职、档案完整”，不要求其本人有策略授权 | employee-loop `targetsInStore`（M02 原样） |
| D2 | B 店首批不开营销：测试策略的门店层 s-b 不含 `marketing` | 测试 `access-fixture-m03.ts` 的 `policy()`；真实配置未写 |
| D3 | 意图分类仅规则（不装语义分类器） | M02 原样；M03 只加规则 |
| D4 | 试点按 B 店 + 测试员工A测试账号 老板→店长→员工 逐级降级，只在合成数据里验证，不写真实配置 | `access-matrix-m03` “逐级降级” |
| D5 | 角色能力表（测试用，非真实配置）：员工=本人报数/同店代报/本人进度；店长=+他人进度/本店汇总/谁没报；老板=本人进度/他人进度/汇总/谁没报/门店排名/营销（老板默认不报数） | fixture `ROLE_CAPS` |
| D6 | 能力被收窄但授权仍有效的人，可以“取消”自己的待确认草稿（不入账）；整体停用/撤销后连取消也在入口拒绝 | employee-loop 确认分支 |
| D7 | “查不到”和“没权限查他人/他店”回同一句话，不泄露对象是否存在 | `NOT_FOUND_OR_DENIED` |

## 1. 改动

**新文件**
- `src/role-eval/access-policy.ts`：策略唯一来源 = PG config 键 `front-claw-access`（JSON，无 schema 变更）。
  - 结构：`version` / `enterprise` / `stores{storeId:[cap]}` / `roles{employee,manager,owner}` / `members{personId:{role,storeIds,status,capabilities?}}`。
  - 严格解析：多余字段、未知能力、类型不符、重复门店 → 整份视为损坏 → 全拒。
  - `decideAccess`：拒绝优先。有效能力 = 已实现 ∩ 企业 ∩ 门店 ∩ 角色 ∩ 成员收窄（若有）∩ 平台层（若传，M07 前不传）。显式空列表就是空；缺门店层 = 空。
  - 身份与门店规则：角色只看授权，且必须等于 people.tier，否则 `role_mismatch`。老板门店集合必须显式非空（空 ≠ 全部）。员工、店长的门店集合必须正好是本人所在店。status 只认 active。
  - `standing`：入口判定，确认策略可用、有授权、在职、角色一致。
  - `authorize` 和 `authorizedStores` 每次都读库，没有缓存。
  - `updateAccessPolicy`：在事务里用 `FOR UPDATE` 锁住策略行和高水位，校验 expectedVersion，要求版本 > max(高水位, 当前)。同一事务写入新策略、高水位和审计键 `front-claw-access:audit:<v>`（操作人、原因、时间、前后版本、成员摘要）。旧配置回写不能复活已撤权身份。
- `src/role-eval/store-queries.ts`：门店汇总、谁没报、门店排名。门店由调用方按策略算好后显式传入，每次读取都是 `listEntries({storeId})`。

**修改**
- `performance-store.ts` 和 `performance-postgres.ts`：
  - `commitConfirmingDraft(draft, entries, guard?)`：PG 在提交事务内先 `SELECT … FOR SHARE` 读策略行再判定。拒绝时，同一事务把草稿从 confirming 退回 pending，不写 entries，返回 -1。
  - 新增 `updateConfigLocked(key, extraKeys, mutate)`（PG 用 `FOR UPDATE`），内存实现语义相同。
- `employee-loop.ts`（仅在 `accessPolicy: true` 时生效）。鉴权点：
  - ① 入口：解析身份后先过 `standing`，策略缺失或损坏时在任何业务读之前拒绝。
  - ② 执行：每条命令按能力和门店判定。
  - ③ 草稿创建前。
  - ④ 草稿确认（状态转换前）。
  - ⑤ 事务提交：在提交事务内锁读策略。
  - ⑥ 查询发送前：结果生成后重新解析身份并重判。
  - 新查询：「X的进度」「经营汇总/门店汇总 [店名]」「谁没报 [店名]」「门店排名/排行」。查他人时先算可查门店，只在这些门店里匹配名字；无权者不读目录、不读账本。
  - 未开策略模式时：只保留 M01/M02 能力（本人、同店代报、本人进度），不开放任何管理查询。
- `employee-entry.ts`：策略模式下营销还要 `marketing` 能力（五层交集）。
- `intent-router.ts`：规则新增「X的进度」→progress，「谁没报/排名/排行」→summary（都是店务，交给 loop）。
- `wecom-bot-unified-handler.ts`、`front-claw-boot.ts`、`wecom-bot-pilot.ts`：透传 `accessPolicy`。`accessPolicy` 必须和 `employeeLoop` 同开，否则装配时抛错（`invalid_access_policy_assembly`）。
- `tests/role-eval/sql-fixture.ts`：单线程替身忽略行尾的 `FOR SHARE/UPDATE`，真实锁序由 PG 测试覆盖。

**“临时 owner 名单覆盖正式授权”路径**
- 本仓库实际存在的路径是旧入口 `remember()` 按 SDK 岗位角色改写 people.tier。
- 策略模式强制走 employeeLoop，在那里 `remember()` 只核对，不写人员档案。
- 即使档案 tier 被其他途径改成 owner，授权角色不一致也会被拒（`role_mismatch`，测试“伪造老板”）。
- F 的 `ownerAccountIds` 不在本仓库，未引入。
- 旧入口本身（非 employeeLoop）的 SDK 改写，以及 assistant-tools 里“老板 = 全部门店”的逻辑保持原样未改，策略模式不经过它们（见 §4）。

**与 PLAN 的偏差**
- PLAN 写的 `updateConfigVersioned` 实现为通用的 `updateConfigLocked` 加 `updateAccessPolicy`。
- `effectiveAccess` 实现为 `decideAccess` 和 `standing`。
- 多了共享夹具 `access-fixture-m03.ts`。

## 2. 权限表（测试策略 D5，合成数据）

| 操作 | A店员工 | A店店长 | B店店长(测试员工A) | 老板(只授权A店) | 老板(门店空集合) |
|---|---|---|---|---|---|
| 本人进度 | ✅ 只读A | ✅ | ✅ | ✅ | ❌ |
| 本人报数/同店代报 | 受 M01 开关限制（仅B店开） | 同左 | ✅ 代报确认入账 | ❌（D5） | ❌ |
| 他人进度（同店） | ❌ 查不到/无权 | ✅ 只读A | ✅ 只读B | ✅ 只读A | ❌ |
| 他人进度（他店） | ❌ | ❌ 零读B | ❌ 零读A | ❌ | ❌ |
| 门店汇总（本店/他店） | ❌/❌ | ✅/❌ | ✅/❌ | ✅A / ❌B | ❌ |
| 谁没报 | ❌ | ✅ A | ✅ B | ✅ A | ❌ |
| 门店排名 | ❌ | ❌ | ❌ | ✅ 只含A | ❌ |
| 营销 | — | — | ❌ B店未开（D2） | ✅ A店 | — |

每条 ❌ 都断言了五件事：回复文案正确，`listEntries` 零调用，entries 和 drafts 不变，`send` 未调用，模型未调用。每条 ✅ 都断言了读取的门店集合精确等于授权门店。

## 3. 测试表

| 套件 | 结果 | 要点 |
|---|---|---|
| access-policy-m03（7） | 7/7 | 缺失与损坏区分、严格解析 12 种坏配置、三档矩阵、老板空集合、员工/店长门店锁本店、五层空列表、伪造老板/停用/无授权、版本冲突/不递增/旧配置回写被拒、审计内容 |
| access-matrix-m03（14） | 14/14 | 四角色矩阵，老板空集合，伪造老板（档案改 owner、正文自称老板），空配置，坏配置 3 种，旧模式不开放，旧缓存（撤权下一条即生效），旧草稿（降权后确认被拒、草稿留待、可取消），查询发送前被撤权 4 种查询，测试员工A 老板→店长→员工→停用 逐级，以及“中间态授权与档案不一致即拒”，确认排队后在 transition 前和 commit 前两个窗口被撤权 |
| access-pg-m03（5，PG17） | 5/5，重复 5 次全过 | ① 撤权事务先持 FOR UPDATE，确认在提交事务里等锁（pg_stat_activity 观测到 Lock 等待），撤权提交后确认拒绝、零入账、草稿退回 pending。② 提交先持 FOR SHARE，`updateAccessPolicy` 等待（观测到等待）直到提交结束。③ 两个独立连接池上确认和撤权并发 20 轮，两种顺序都出现（每次 17–18 先提交 / 2–3 先撤权），每轮回复与账本一致。④ 确认排队后、提交前被降级 → 拒绝、零入账。⑤ 真实 PG 上的矩阵抽样，以及空/坏配置全拒零业务读 |
| M01 / M02 专项 | 15/15、18/18 | 语料指标不变：两集宏F1 1.00，店务→营销 0。盲测集未改（哈希不变） |
| 相关回归（15 文件） | 200/200 | |
| 全量 vitest | 833 中 831 过 | 只有 live-model-smoke 2 项失败，基线已知 |
| test:pg（PG17） | 16/16 | 原 8 + M02 3 + M03 5 |
| test:pg 默认（不设变量） | initdb ENOENT（/usr/lib/postgresql/16/bin），exit=1 | 证明默认路径原样；本机无 PG16 |
| tsc / typecheck / build | 0 / 0 / 0 | |
| 变异 11 项 | 10 项被抓到 | M9（查他人时去掉逐店鉴权）没被抓：前面 `authorizedStores` 已按店过滤，M9 那一层是冗余防线，删掉它由 M10 的测试兜住。如实列出 |

PG17 是本机用户态临时集群，**不是线上版本**。时延只有本地桩数据下的测试耗时（例如 PG 用例 76–451ms），不作“达标”结论。

## 4. 未验证 / 已知局限

1. 线上 PG 版本、真实组织结构和账号映射、真实策略内容都未验证，也没有写真实配置。B 店和测试员工A只在合成数据里出现。
2. **人员档案（tier）的变更没有和提交串行化**，有确定先后的只有“策略变更”。降级流程必须先改策略再改档案；中间态是授权和档案不一致，会被拒（已测）。如果只改档案、不改策略，正在提交的那一笔仍按提交前读到的档案判定。
3. 策略**首次创建**时还没有行可锁，两个管理员同时初始化可能后写覆盖先写；版本校验和审计在这种情况下不保证。建议首次初始化由单一操作人完成，或由助手B决定是否预置空行。
4. 旧入口（非 employeeLoop）未改：SDK 角色改写 tier、assistant-tools 里“老板 = 全部门店”仍在。策略模式在装配层禁止与旧入口组合，但旧入口单独运行时行为同 M02 前。
5. 平台层（OpenDot）只留了参数，没有接线（M07）。
6. 审计以 config 键累积，没有清理和查看入口；也没有管理员改策略的命令或 CLI，目前只有 `updateAccessPolicy` 函数。
7. 被提交 guard 拒绝时，草稿退回 pending，但 payload 里保留了这次确认的 actionMessageId（不影响入账；同号重发会得到“还没入账”）。
8. 分类器：“小林的进度怎么样”仍走澄清；“他们的进度”会进入查询并回“查不到”（见 probe-m03.txt）。

## 5. 待拍板

- D1–D7 是否确认。重点是 D5 角色能力表（老板是否能报数、店长能否查排名）和 D2（B 店营销）。
- 真实策略的落地方式：谁有权调用 `updateAccessPolicy`，以及首次初始化流程（见 §4.3）。
- 旧入口是否在后续里程碑下线，或同样接入策略（§4.4）。
- 档案变更是否也要纳入策略锁（§4.2）。

## 6. 给助手B的审查重点

- 提交 guard 的锁序：`FOR SHARE`（提交）对 `FOR UPDATE`（撤权），以及拒绝时在同一事务里退回草稿（performance-postgres.ts）。
- `decideAccess` 的拒绝优先、空 ≠ 全部、角色一致性。
- employee-loop 六个鉴权点是否有遗漏，特别是 replay（重发确认）分支和“入账结果”。
- 旧模式（`accessPolicy` 未开）是否仍完全等于 M02 行为：M01/M02 专项和回归全过。

## 7. 产物（<本地路径>，sha256 见 SHA256SUMS）

- ISSUE.md、PLAN.md（写于改动前）、REPORT.md
- m03.patch：相对 M02 树 b1d44021，15 文件 +956/−13
- m03-cumulative.patch：相对 f2a8105
- 结果树 793ce100…：“f2a8105 + m02-cumulative + m03.patch” 和 “f2a8105 + m03-cumulative” 两种重放都得到同一棵树
- changed-files.txt、m02-tree.txt、m03-tree.txt、probe-m03.txt、test-output/（含 COMMANDS.md、mutation.txt）
